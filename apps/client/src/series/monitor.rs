use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::episode::{episode_queries, matches_episode};
use super::store::{SeriesStore, SeriesTask};
use crate::api::actions::start_from_result;
use crate::downloads::DownloadManager;
use crate::error::ApiResult;
use crate::protocol::encoding::{now_iso, parse_iso};
use crate::search::SearchService;
use crate::search::types::TorrentSearchResult;

const POLL: Duration = Duration::from_secs(60);
const STARTUP_DELAY: Duration = Duration::from_secs(10);
/// Bounds the work of one check if a loose rule matches many episodes at once.
const MAX_EPISODES_PER_CHECK: usize = 25;

/// Periodically checks due series tasks and queues their new episodes.
pub struct SeriesMonitor {
    store: Arc<SeriesStore>,
    search: Arc<SearchService>,
    downloads: Arc<DownloadManager>,
    cancel: CancellationToken,
    running: Mutex<HashSet<i64>>,
}

impl SeriesMonitor {
    pub fn new(store: Arc<SeriesStore>, search: Arc<SearchService>, downloads: Arc<DownloadManager>) -> Arc<Self> {
        Arc::new(Self { store, search, downloads, cancel: CancellationToken::new(), running: Mutex::default() })
    }

    pub fn start(self: &Arc<Self>) {
        let monitor = self.clone();
        tokio::spawn(async move {
            let mut delay = STARTUP_DELAY;
            loop {
                tokio::select! {
                    _ = monitor.cancel.cancelled() => return,
                    _ = tokio::time::sleep(delay) => {}
                }
                monitor.check_due().await;
                delay = POLL;
            }
        });
    }

    pub fn stop(&self) {
        self.cancel.cancel();
    }

    async fn check_due(&self) {
        let now = chrono::Utc::now();
        for task in self.store.all() {
            if !task.enabled {
                continue;
            }
            let due = task
                .last_checked_at
                .as_deref()
                .and_then(parse_iso)
                .is_none_or(|last| last + chrono::Duration::minutes(task.check_interval_minutes) <= now);
            if !due {
                continue;
            }
            // One task failing (a provider bug) must not stop the others from being checked.
            if let Err(error) = self.check(task.clone()).await {
                if self.cancel.is_cancelled() {
                    return;
                }
                tracing::error!("Series check failed for '{}': {error}", task.name);
            }
        }
    }

    /// Runs one check immediately (the "Check now" button and the agent tool).
    pub async fn check_now(&self, id: i64) -> ApiResult<SeriesTask> {
        self.check(self.store.get(id)?).await?;
        self.store.get(id)
    }

    async fn check(&self, mut task: SeriesTask) -> ApiResult<()> {
        if !self.running.lock().unwrap().insert(task.id) {
            return Ok(());
        }
        let outcome = self.find_and_queue(&mut task).await;
        let mut latest = self.fresh(&task);
        if latest.is_finished() {
            latest.enabled = false;
        }
        latest.last_checked_at = Some(now_iso());
        let saved = self.store.save(&latest);
        self.running.lock().unwrap().remove(&task.id);
        outcome.and(saved)
    }

    async fn find_and_queue(&self, task: &mut SeriesTask) -> ApiResult<()> {
        // A blank query would match arbitrary torrents: never auto-download for one.
        if task.query.trim().is_empty() {
            return Ok(());
        }
        tracing::info!("Checking series '{}' for episode {}", task.name, task.next_episode());
        // Catching up asks the same broad query for every episode; ask each site once per check.
        let mut searches: HashMap<String, Vec<TorrentSearchResult>> = HashMap::new();
        for _ in 0..MAX_EPISODES_PER_CHECK {
            if task.is_finished() {
                break;
            }
            let episode = task.next_episode();
            let Some(result) = self.find_episode(task, episode, &mut searches).await? else { break };
            let title = result.title.clone();
            start_from_result(
                &self.search,
                &self.downloads,
                Arc::new(Mutex::new(result)),
                Some(task.id),
                task.download_folder.clone(),
                &self.cancel,
            )
            .await?;
            task.last_downloaded_episode = episode;
            // Saved per episode: a failure hunting the next one must not lose the record that this
            // one was queued, or the next pass could add a second download of it.
            self.store.save(&self.fresh(task))?;
            tracing::info!("Series '{}': queued episode {episode} ({title})", task.name);
        }
        Ok(())
    }

    /// Re-reads the task and applies what this check changed. The user may edit the rule from the
    /// dashboard while a slow check runs; those edits must not be overwritten by the check's copy.
    fn fresh(&self, task: &SeriesTask) -> SeriesTask {
        match self.store.get(task.id) {
            Ok(mut current) => {
                current.last_downloaded_episode = current.last_downloaded_episode.max(task.last_downloaded_episode);
                current
            }
            Err(_) => task.clone(),
        }
    }

    async fn find_episode(
        &self,
        task: &SeriesTask,
        episode: i64,
        searches: &mut HashMap<String, Vec<TorrentSearchResult>>,
    ) -> ApiResult<Option<TorrentSearchResult>> {
        for query in episode_queries(&task.rule(), episode) {
            if !searches.contains_key(&query) {
                // No relevance filter: episode matching below is stricter. Results come seeder-sorted.
                let found = self.search.collect(&query, task.provider.as_deref(), &self.cancel, false).await?;
                searches.insert(query.clone(), found.results);
            }
            if let Some(hit) = searches[&query].iter().find(|r| matches_episode(&r.title, &task.rule(), episode)) {
                return Ok(Some(hit.clone()));
            }
        }
        Ok(None)
    }
}
