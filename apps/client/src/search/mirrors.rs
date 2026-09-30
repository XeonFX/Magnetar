use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::StreamExt;
use futures::stream::FuturesUnordered;
use tokio_util::sync::CancellationToken;

use super::http::FetchError;

/// Fetches from a list of mirror hosts, starting with whichever last succeeded.
///
/// Attempts overlap rather than run one after another: the preferred host goes first, and the next
/// one starts when the previous has failed or has not answered within `stagger`. The first success
/// wins and the rest are cancelled. One after another burned the full timeout on a slow host before
/// trying the next (apibay.org takes ~16s on an uncached query while a mirror answers in 0.4s), and
/// a fixed stagger kept a host that refuses at once (a Cloudflare challenge) waiting for nothing.
pub struct MirrorRotator<H> {
    hosts: Vec<H>,
    preferred: AtomicUsize,
    stagger: Duration,
}

impl<H: Clone> MirrorRotator<H> {
    pub fn new(hosts: Vec<H>, stagger: Duration) -> Self {
        assert!(!hosts.is_empty(), "At least one host is required");
        Self { hosts, preferred: AtomicUsize::new(0), stagger }
    }

    pub async fn fetch<T, F, Fut>(&self, attempt: F, cancel: &CancellationToken) -> anyhow::Result<T>
    where
        F: Fn(H, CancellationToken) -> Fut,
        Fut: Future<Output = anyhow::Result<T>>,
    {
        let count = self.hosts.len();
        let start = self.preferred.load(Ordering::Relaxed);
        let attempts = cancel.child_token();
        let _cancel_the_rest = attempts.clone().drop_guard();
        let launch = |offset: usize| {
            let index = (start + offset) % count;
            let outcome = attempt(self.hosts[index].clone(), attempts.clone());
            async move { (index, outcome.await) }
        };
        let mut pending = FuturesUnordered::new();
        pending.push(launch(0));
        let mut launched = 1;
        let mut last_error = None;
        loop {
            let finished = tokio::select! {
                _ = cancel.cancelled() => return Err(FetchError::Cancelled.into()),
                finished = pending.next() => finished,
                _ = tokio::time::sleep(self.stagger), if launched < count => None,
            };
            match finished {
                Some((index, Ok(value))) => {
                    self.preferred.store(index, Ordering::Relaxed);
                    return Ok(value);
                }
                Some((_, Err(error))) => last_error = Some(error),
                None => {}
            }
            if launched < count {
                pending.push(launch(launched));
                launched += 1;
            } else if pending.is_empty() {
                return Err(last_error.unwrap_or_else(|| FetchError::Cancelled.into()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[tokio::test]
    async fn staggers_takes_the_first_success_and_remembers_it() {
        let rotator = MirrorRotator::new(vec!["slow", "fast"], Duration::from_millis(20));
        let calls = Mutex::new(Vec::new());
        let attempt = |host: &'static str, token: CancellationToken| {
            calls.lock().unwrap().push(host);
            async move {
                if host == "slow" {
                    tokio::select! {
                        _ = token.cancelled() => anyhow::bail!("aborted"),
                        _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                    }
                }
                Ok(host)
            }
        };
        let cancel = CancellationToken::new();
        assert_eq!(rotator.fetch(attempt, &cancel).await.unwrap(), "fast");
        calls.lock().unwrap().clear();
        assert_eq!(rotator.fetch(attempt, &cancel).await.unwrap(), "fast");
        assert_eq!(calls.lock().unwrap()[0], "fast");
    }

    #[tokio::test]
    async fn a_host_that_fails_at_once_hands_over_without_waiting_for_the_stagger() {
        let rotator = MirrorRotator::new(vec!["refuses", "works"], Duration::from_secs(30));
        let attempt =
            |host: &'static str, _| async move { if host == "refuses" { Err(anyhow::anyhow!("HTTP 403")) } else { Ok(host) } };
        let answer = tokio::time::timeout(Duration::from_secs(1), rotator.fetch(attempt, &CancellationToken::new())).await;
        assert_eq!(answer.expect("did not wait for the stagger").unwrap(), "works");
    }

    #[tokio::test]
    async fn cancelling_answers_cancelled_without_waiting_for_the_hosts() {
        let rotator = MirrorRotator::new(vec!["a", "b"], Duration::from_millis(1));
        let cancel = CancellationToken::new();
        let attempt = |_, _| async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(())
        };
        let canceller = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel.cancel();
        };
        let (outcome, _) =
            tokio::time::timeout(Duration::from_secs(1), async { tokio::join!(rotator.fetch(attempt, &cancel), canceller) })
                .await
                .expect("cancellation was not prompt");
        assert!(super::super::http::is_cancelled(&outcome.unwrap_err()));
    }

    #[tokio::test]
    async fn returns_the_last_error_when_every_host_fails() {
        let rotator = MirrorRotator::new(vec!["a", "b"], Duration::from_millis(1));
        let error = rotator
            .fetch(|host, _| async move { Err::<(), _>(anyhow::anyhow!("down {host}")) }, &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.to_string().starts_with("down"));
    }
}
