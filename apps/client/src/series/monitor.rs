use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::episode::{EpisodeRule, episode_queries, matches_episode, parse_episode};
use super::store::{SeriesStore, SeriesTask};
use super::tvmaze;
use super::watch::{self, WatchStore};
use crate::api::actions::start_from_result;
use crate::downloads::AddDownload;
use crate::downloads::DownloadManager;
use crate::error::{ApiError, ApiResult};
use crate::notifications::NotificationDispatcher;
use crate::protocol::encoding::{now_iso, parse_iso};
use crate::protocol::{FoundReleaseDto, WatchDto};
use crate::search::SearchService;
use crate::search::types::TorrentSearchResult;

const POLL: Duration = Duration::from_secs(60);
const STARTUP_DELAY: Duration = Duration::from_secs(10);
/// Bounds the work of one check if a loose rule matches many episodes at once.
const MAX_EPISODES_PER_CHECK: usize = 25;
/// Show details (next air date) are looked up again this often.
const SHOW_REFRESH: chrono::Duration = chrono::Duration::hours(12);

/// Periodically checks due series tasks and queues their new episodes: the best release each task's
/// quality rules allow, replacing one that turned out dead with the next best.
pub struct SeriesMonitor {
    store: Arc<SeriesStore>,
    pub watches: Arc<WatchStore>,
    notifications: Arc<NotificationDispatcher>,
    search: Arc<SearchService>,
    downloads: Arc<DownloadManager>,
    http: reqwest::Client,
    /// Where posters go; None skips TVmaze altogether.
    posters: Option<PathBuf>,
    cancel: CancellationToken,
    running: Mutex<HashSet<i64>>,
}

impl SeriesMonitor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: Arc<SeriesStore>,
        watches: Arc<WatchStore>,
        notifications: Arc<NotificationDispatcher>,
        search: Arc<SearchService>,
        downloads: Arc<DownloadManager>,
        http: reqwest::Client,
        posters: Option<PathBuf>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            watches,
            notifications,
            search,
            downloads,
            http,
            posters,
            cancel: CancellationToken::new(),
            running: Mutex::default(),
        })
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
                monitor.check_due_watches().await;
                monitor.refresh_stale_shows().await;
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
            if !is_due(task.last_checked_at.as_deref(), chrono::Duration::minutes(task.check_interval_minutes), now) {
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
        // Catching up asks the same broad query for every episode; ask each site once per check.
        let mut searches = HashMap::new();
        let outcome = match self.replace_dead(&task, &mut searches).await {
            Ok(()) => self.find_and_queue(&mut task, &mut searches).await,
            Err(error) => Err(error),
        };
        let mut latest = self.fresh(&task);
        if latest.is_finished() {
            latest.enabled = false;
        }
        latest.last_checked_at = Some(now_iso());
        let saved = self.store.save(&latest);
        self.running.lock().unwrap().remove(&task.id);
        outcome.and(saved)
    }

    /// Episodes whose release nobody seeded get another one: the dead release is never picked
    /// again, and its download (which has no files) makes way for the new one.
    async fn replace_dead(&self, task: &SeriesTask, searches: &mut Searches) -> ApiResult<()> {
        let dead = self.downloads.dead_episodes(task.id);
        if dead.is_empty() {
            return Ok(());
        }
        for (_, _, hash) in &dead {
            self.store.reject(task.id, hash);
        }
        let rejected = self.store.rejected(task.id);
        for (download, episode, _) in dead {
            let Some(result) = self.find_episode(task, episode, searches, &rejected).await? else { continue };
            let title = result.title.clone();
            self.queue(task, episode, result).await?;
            self.downloads.delete(download, false).await?;
            tracing::info!("Series '{}': episode {episode} had no seeders; trying {title}", task.name);
        }
        Ok(())
    }

    async fn find_and_queue(&self, task: &mut SeriesTask, searches: &mut Searches) -> ApiResult<()> {
        // A blank query would match arbitrary torrents: never auto-download for one.
        if task.query.trim().is_empty() {
            return Ok(());
        }
        tracing::info!("Checking series '{}' for episode {}", task.name, task.next_episode());
        let rejected = self.store.rejected(task.id);
        for _ in 0..MAX_EPISODES_PER_CHECK {
            if task.is_finished() {
                break;
            }
            let episode = task.next_episode();
            let Some(result) = self.find_episode(task, episode, searches, &rejected).await? else { break };
            let title = result.title.clone();
            self.queue(task, episode, result).await?;
            task.last_downloaded_episode = episode;
            // Saved per episode: a failure hunting the next one must not lose the record that this
            // one was queued, or the next pass could add a second download of it.
            self.store.save(&self.fresh(task))?;
            tracing::info!("Series '{}': queued episode {episode} ({title})", task.name);
        }
        Ok(())
    }

    async fn queue(&self, task: &SeriesTask, episode: i64, result: TorrentSearchResult) -> ApiResult<()> {
        start_from_result(
            &self.search,
            &self.downloads,
            Arc::new(Mutex::new(result)),
            Some((task.id, episode)),
            task.download_folder.clone(),
            &self.cancel,
        )
        .await?;
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

    async fn results<'a>(
        &self,
        query: &str,
        provider: Option<&str>,
        searches: &'a mut Searches,
    ) -> ApiResult<&'a [TorrentSearchResult]> {
        if !searches.contains_key(query) {
            // No relevance filter: episode matching is stricter.
            let found = self.search.collect(query, provider, &self.cancel, false).await?;
            searches.insert(query.to_owned(), found.results);
        }
        Ok(&searches[query])
    }

    /// The best release of one episode: it must be that episode, pass the quality rules and not
    /// have failed before. Targeted queries are tried first.
    async fn find_episode(
        &self,
        task: &SeriesTask,
        episode: i64,
        searches: &mut Searches,
        rejected: &HashSet<String>,
    ) -> ApiResult<Option<TorrentSearchResult>> {
        let quality = task.quality();
        for query in episode_queries(&task.rule(), episode) {
            let results = self.results(&query, task.provider.as_deref(), searches).await?;
            let candidates = results
                .iter()
                .filter(|r| matches_episode(&r.title, &task.rule(), episode) && !rejected.contains(&r.info_hash.to_lowercase()));
            if let Some(best) = quality.best(candidates) {
                return Ok(Some(best.clone()));
            }
        }
        Ok(None)
    }

    /// The newest episode already released for a rule, for tasks that start from the latest or
    /// only take new episodes. Errors rather than guess: guessing low would download a backlog.
    pub async fn latest_episode(&self, rule: &EpisodeRule<'_>, provider: Option<&str>) -> ApiResult<i64> {
        let found = self.search.collect(rule.query, provider, &self.cancel, false).await?;
        if found.outcomes.iter().all(|o| o.status != "ok") {
            return Err(ApiError::bad(
                "No source answered, so the latest episode is unknown. Try again, or start from an episode number.",
            ));
        }
        Ok(found
            .results
            .iter()
            .filter_map(|r| {
                let parsed = parse_episode(&r.title)?;
                matches_episode(&r.title, rule, parsed.episode).then_some(parsed.episode)
            })
            .max()
            .unwrap_or(0))
    }

    /// Looks the show up on TVmaze again: after a rename, and twice a day for air dates.
    pub async fn refresh_show(&self, id: i64) -> ApiResult<()> {
        let Some(posters) = &self.posters else { return Ok(()) };
        let task = self.store.get(id)?;
        let name = task.name.trim();
        let found = if name.is_empty() { None } else { tvmaze::lookup(&self.http, name).await? };
        let mut latest = self.store.get(id)?;
        latest.show_checked_at = Some(now_iso());
        latest.show = match found {
            Some((mut show, poster)) => {
                let path = tvmaze::poster_path(posters, show.tvmaze_id);
                if let Some(url) = poster
                    && let Err(error) = tvmaze::save_poster(&self.http, &url, &path).await
                {
                    tracing::warn!("Could not save the poster for '{name}': {error:#}");
                }
                show.has_poster = path.exists();
                Some(show)
            }
            None => None,
        };
        self.store.save(&latest)
    }

    async fn refresh_stale_shows(&self) {
        if self.posters.is_none() {
            return;
        }
        let now = chrono::Utc::now();
        for task in self.store.all() {
            if is_due(task.show_checked_at.as_deref(), SHOW_REFRESH, now)
                && !self.cancel.is_cancelled()
                && let Err(error) = self.refresh_show(task.id).await
            {
                tracing::debug!("TVmaze lookup for '{}' failed: {error}", task.name);
            }
        }
    }

    async fn check_due_watches(&self) {
        let now = chrono::Utc::now();
        for watch in self.watches.all() {
            let due = is_due(watch.last_checked_at.as_deref(), chrono::Duration::minutes(watch.check_interval_minutes), now);
            if watch.enabled
                && due
                && !self.cancel.is_cancelled()
                && let Err(error) = self.check_watch(watch.id).await
            {
                tracing::warn!("Watch '{}' could not be checked: {error}", watch.query);
            }
        }
    }

    /// Looks for a release a watch allows. The first one found is reported (and downloaded, when
    /// the watch says so); the watch then rests until armed again.
    pub async fn check_watch(&self, id: i64) -> ApiResult<WatchDto> {
        let watch = self.watches.get(id)?;
        let found = self.search.collect(&watch.query, None, &self.cancel, true).await?;
        let Some(best) = watch::quality(&watch).best(&found.results).cloned() else {
            self.watches.checked(id);
            return self.watches.get(id);
        };
        // Lazy sources only have the magnet on the release's own page.
        let best = self.search.with_magnet(&Arc::new(Mutex::new(best)), &self.cancel).await;
        if best.magnet_uri.is_empty() {
            self.watches.checked(id);
            return Err(ApiError::bad(format!("Found \"{}\", but {} did not give its magnet link.", best.title, best.source)));
        }
        let release = FoundReleaseDto {
            title: best.title.clone(),
            magnet_uri: best.magnet_uri.clone(),
            size_bytes: best.size_bytes,
            seeders: best.seeders,
            source: best.source.clone(),
            found_at: now_iso(),
        };
        let download = if watch.auto_download { Some(self.download_found(&release)?) } else { None };
        self.watches.found(id, &release, download);
        let title = if download.is_some() { "Watched release found and downloading" } else { "Watched release found" };
        self.notifications.notify("found", title, release.title.clone());
        tracing::info!("Watch '{}' found {}", watch.query, release.title);
        self.watches.get(id)
    }

    /// Starts the download of what a watch found.
    pub fn download_found(&self, release: &FoundReleaseDto) -> ApiResult<i64> {
        let added = self.downloads.add(AddDownload {
            name: release.title.clone(),
            magnet_uri: release.magnet_uri.clone(),
            source: release.source.clone(),
            series_task_id: None,
            episode: None,
            save_folder: None,
        })?;
        Ok(added.id)
    }

    /// The show's poster, when TVmaze had one.
    pub fn poster(&self, id: i64) -> ApiResult<Option<Vec<u8>>> {
        let task = self.store.get(id)?;
        let (Some(show), Some(posters)) = (task.show, &self.posters) else { return Ok(None) };
        Ok(std::fs::read(tvmaze::poster_path(posters, show.tvmaze_id)).ok())
    }
}

type Searches = HashMap<String, Vec<TorrentSearchResult>>;

/// Whether something last done `at` (never, if None) is due again, `every` later.
fn is_due(at: Option<&str>, every: chrono::Duration, now: chrono::DateTime<chrono::Utc>) -> bool {
    at.and_then(parse_iso).is_none_or(|at| at + every <= now)
}
