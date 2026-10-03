//! One app per user: two engines on one database would fight over it and over the same files. The
//! owner holds an exclusive lock on `instance.lock` for as long as it runs; the system releases it
//! when the process ends, however it ends, so a crash leaves nothing stale. Where the owner's
//! dashboard is goes in `instance.json` beside it, for a second start to open instead.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::db::replace_file;
use crate::paths::Paths;
use crate::system::process_alive;

/// How long a second start waits for the owner to answer, or to exit (an update hands over this way).
const WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(250);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstanceInfo {
    pid: u32,
    dashboard_url: Option<String>,
}

pub enum Acquired {
    Owner(InstanceLock),
    /// Another instance runs and answers at this dashboard URL.
    Running(String),
    /// Another instance holds the lock and has not said where its dashboard is.
    Held,
}

/// The lock, held until this is dropped or the process ends.
pub struct InstanceLock {
    _file: File,
    info: PathBuf,
}

impl InstanceLock {
    fn write(&self, dashboard_url: Option<&str>) {
        let info = InstanceInfo { pid: std::process::id(), dashboard_url: dashboard_url.map(str::to_owned) };
        if let Err(error) = replace_file(&self.info, &serde_json::to_vec(&info).expect("JSON"), false) {
            tracing::warn!("Could not write where this instance's dashboard is: {error}");
        }
    }

    pub fn publish(&self, dashboard_url: &str) {
        self.write(Some(dashboard_url));
    }

    /// Before exiting: the dashboard is going away. The lock file stays: another start may be
    /// waiting on it, and a new file under the same name would let a third one in beside it.
    pub fn release(&self) {
        let _ = std::fs::remove_file(&self.info);
    }
}

fn info_path(lock: &Path) -> PathBuf {
    lock.with_extension("json")
}

/// The lock, if no other process holds it.
fn try_lock(path: &Path) -> std::io::Result<Option<File>> {
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

async fn answers(url: &str) -> bool {
    let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_millis(1500)).build();
    match client {
        Ok(client) => client.get(format!("{url}/health")).send().await.is_ok_and(|r| r.status().is_success()),
        Err(_) => false,
    }
}

/// The dashboard of the instance holding the lock, if it has said where it is.
fn owner_dashboard(info: &Path) -> Option<String> {
    let info: InstanceInfo = serde_json::from_slice(&std::fs::read(info).ok()?).ok()?;
    process_alive(info.pid).then_some(info.dashboard_url).flatten()
}

pub async fn acquire(paths: &Paths) -> std::io::Result<Acquired> {
    acquire_within(&paths.lock, WAIT).await
}

/// Takes the lock, or finds the instance that has it. Waits up to `wait` while that one is starting,
/// exiting or not answering; a lock held by a live process is never taken over.
pub async fn acquire_within(path: &Path, wait: Duration) -> std::io::Result<Acquired> {
    let info = info_path(path);
    let deadline = Instant::now() + wait;
    loop {
        if let Some(file) = try_lock(path)? {
            let lock = InstanceLock { _file: file, info };
            // What a crashed owner left says nothing now.
            lock.write(None);
            return Ok(Acquired::Owner(lock));
        }
        let dashboard = owner_dashboard(&info);
        if let Some(url) = &dashboard
            && answers(url).await
        {
            return Ok(Acquired::Running(url.clone()));
        }
        if Instant::now() >= deadline {
            // Alive but slow to answer: its dashboard is still the one to show.
            return Ok(dashboard.map_or(Acquired::Held, Acquired::Running));
        }
        tokio::time::sleep(POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHORT: Duration = Duration::from_millis(600);

    fn owner(acquired: std::io::Result<Acquired>) -> InstanceLock {
        match acquired.unwrap() {
            Acquired::Owner(lock) => lock,
            _ => panic!("expected to own the lock"),
        }
    }

    fn describe(acquired: &Acquired) -> String {
        match acquired {
            Acquired::Owner(_) => "owner".into(),
            Acquired::Running(url) => format!("running at {url}"),
            Acquired::Held => "held".into(),
        }
    }

    /// A dashboard on a free port answering `/health` with `status`.
    async fn dashboard(status: u16) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = axum::Router::new()
            .route("/health", axum::routing::get(move || async move { axum::http::StatusCode::from_u16(status).unwrap() }));
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        url
    }

    #[tokio::test]
    async fn of_starts_at_the_same_moment_exactly_one_owns_the_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("instance.lock");
        let starts = (0..8).map(|_| acquire_within(&path, SHORT));
        let results = futures::future::join_all(starts).await;
        let outcomes: Vec<String> = results.iter().map(|r| describe(r.as_ref().unwrap())).collect();
        assert_eq!(outcomes.iter().filter(|o| *o == "owner").count(), 1, "{outcomes:?}");
        assert_eq!(outcomes.iter().filter(|o| *o == "held").count(), 7, "{outcomes:?}");
    }

    #[tokio::test]
    async fn a_live_owner_is_never_taken_over_whether_it_answers_or_not() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("instance.lock");
        let lock = owner(acquire_within(&path, SHORT).await);

        // Still starting: no dashboard yet.
        assert_eq!(describe(&acquire_within(&path, SHORT).await.unwrap()), "held");
        // A dashboard that doesn't answer: shown anyway once the wait is over, never replaced.
        let failing = dashboard(503).await;
        lock.publish(&failing);
        let started = Instant::now();
        assert_eq!(describe(&acquire_within(&path, SHORT).await.unwrap()), format!("running at {failing}"));
        assert!(started.elapsed() >= SHORT, "it waited for an answer first");
        // A dashboard that answers: opened at once.
        let healthy = dashboard(200).await;
        lock.publish(&healthy);
        let started = Instant::now();
        assert_eq!(describe(&acquire_within(&path, Duration::from_secs(30)).await.unwrap()), format!("running at {healthy}"));
        assert!(started.elapsed() < Duration::from_secs(5));
        drop(lock);
    }

    #[tokio::test]
    async fn an_owner_that_exits_hands_over_to_one_that_waits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("instance.lock");
        let lock = owner(acquire_within(&path, SHORT).await);
        lock.publish("http://127.0.0.1:9");
        let waiting = tokio::spawn({
            let path = path.clone();
            async move { acquire_within(&path, Duration::from_secs(30)).await }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        lock.release();
        drop(lock);
        let next = owner(waiting.await.unwrap());
        let info: InstanceInfo = serde_json::from_slice(&std::fs::read(info_path(&path)).unwrap()).unwrap();
        assert_eq!((info.pid, info.dashboard_url), (std::process::id(), None));
        drop(next);
    }

    /// Run by `a_crashed_owner_in_another_process_leaves_nothing_in_the_way`: holds the lock until killed.
    #[tokio::test]
    #[ignore = "a helper process, started by another test"]
    async fn hold_the_lock_until_killed() {
        let Some(path) = std::env::var_os("MAGNETAR_TEST_HOLD_LOCK") else { return };
        let _lock = owner(acquire_within(Path::new(&path), SHORT).await);
        println!("holding");
        std::thread::sleep(Duration::from_secs(60));
    }

    #[tokio::test]
    async fn a_crashed_owner_in_another_process_leaves_nothing_in_the_way() {
        use std::io::BufRead;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("instance.lock");
        /// Killed however the test ends, so a failure doesn't leave it holding the lock.
        struct Holder(std::process::Child);
        impl Drop for Holder {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut holder = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "instance::tests::hold_the_lock_until_killed", "--nocapture", "--test-threads=1"])
            .env("MAGNETAR_TEST_HOLD_LOCK", &path)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .map(Holder)
            .unwrap();
        let mut lines = std::io::BufReader::new(holder.0.stdout.take().unwrap()).lines();
        assert!(lines.any(|line| line.unwrap().contains("holding")), "the other process took the lock");

        // Another process holds it: this one may not, however long it waits.
        assert_eq!(describe(&acquire_within(&path, SHORT).await.unwrap()), "held");

        drop(holder);
        // The system may take a moment to release a dead process's lock (Windows).
        let lock = owner(acquire_within(&path, Duration::from_secs(10)).await);
        drop(lock);
    }
}
