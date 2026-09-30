//! One app per user: two engines on one database would fight over it and over the same files. A
//! lock file records the owner's pid and dashboard URL; it is stale when that process is gone or
//! no longer answers.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::system::process_alive;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockContents {
    pid: u32,
    dashboard_url: Option<String>,
}

pub enum Acquired {
    Owner(InstanceLock),
    /// Another instance runs and answers at this dashboard URL.
    Running(String),
}

pub struct InstanceLock {
    path: PathBuf,
}

impl InstanceLock {
    fn write(&self, dashboard_url: Option<&str>) {
        let contents = LockContents { pid: std::process::id(), dashboard_url: dashboard_url.map(str::to_owned) };
        if let Err(error) = std::fs::write(&self.path, serde_json::to_vec(&contents).expect("JSON")) {
            tracing::warn!("Could not write the instance lock: {error}");
        }
    }

    pub fn publish(&self, dashboard_url: &str) {
        self.write(Some(dashboard_url));
    }

    pub fn release(&self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn answers(url: &str) -> bool {
    let client = reqwest::Client::builder().timeout(Duration::from_millis(1500)).build();
    match client {
        Ok(client) => client.get(format!("{url}/health")).send().await.is_ok_and(|r| r.status().is_success()),
        Err(_) => false,
    }
}

pub async fn acquire(path: PathBuf) -> Acquired {
    // An owner that is alive but hasn't published its URL yet is still starting: give it a moment.
    for _ in 0..20 {
        let Ok(bytes) = std::fs::read(&path) else { break };
        // Unreadable: stale.
        let Ok(other) = serde_json::from_slice::<LockContents>(&bytes) else { break };
        if other.pid == std::process::id() || !process_alive(other.pid) {
            break;
        }
        if let Some(url) = other.dashboard_url {
            if answers(&url).await {
                return Acquired::Running(url);
            }
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let lock = InstanceLock { path };
    lock.write(None);
    Acquired::Owner(lock)
}
