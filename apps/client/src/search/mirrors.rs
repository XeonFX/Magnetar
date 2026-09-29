use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::StreamExt;
use futures::stream::FuturesUnordered;
use tokio_util::sync::CancellationToken;

use super::http::FetchError;

/// Fetches from a list of mirror hosts, starting with whichever last succeeded.
///
/// Attempts are staggered rather than sequential: the preferred host goes first and each later one
/// starts only if nothing has answered within `stagger`. The first success wins and the rest are
/// cancelled. Sequential rotation burned the full timeout on a slow host before trying the next —
/// apibay.org takes ~16s on an uncached query while a mirror answers in 0.4s.
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
        let start = self.preferred.load(Ordering::Relaxed);
        let attempts = cancel.child_token();
        let mut pending: FuturesUnordered<_> = (0..self.hosts.len())
            .map(|offset| {
                let index = (start + offset) % self.hosts.len();
                let host = self.hosts[index].clone();
                let token = attempts.clone();
                let delay = self.stagger * offset as u32;
                let attempt = &attempt;
                async move {
                    if offset > 0 {
                        tokio::select! {
                            _ = token.cancelled() => return (index, Err(FetchError::Cancelled.into())),
                            _ = tokio::time::sleep(delay) => {}
                        }
                    }
                    (index, attempt(host, token).await)
                }
            })
            .collect();
        let mut last_error = None;
        while let Some((index, outcome)) = pending.next().await {
            match outcome {
                Ok(value) => {
                    self.preferred.store(index, Ordering::Relaxed);
                    attempts.cancel();
                    return Ok(value);
                }
                Err(error) if cancel.is_cancelled() => return Err(error),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| FetchError::Cancelled.into()))
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
    async fn returns_the_last_error_when_every_host_fails() {
        let rotator = MirrorRotator::new(vec!["a", "b"], Duration::from_millis(1));
        let error = rotator
            .fetch(|host, _| async move { Err::<(), _>(anyhow::anyhow!("down {host}")) }, &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.to_string().starts_with("down"));
    }
}
