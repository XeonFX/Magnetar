use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{Row, params};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::engine::{Engine, Metadata, TorrentHandle, delete_files};
use crate::db::{Db, KeyValue};
use crate::error::{ApiError, ApiResult};
use crate::events::EventBus;
use crate::notifications::NotificationDispatcher;
use crate::protocol::encoding::now_iso;
use crate::protocol::{DownloadDto, DownloadStatus, PostDownloadAction};
use crate::search::magnet::{extract_info_hash, magnet_name, normalize_info_hash};
use crate::settings::SettingsService;

/// A dead torrent otherwise sits on "Fetching metadata" forever with no feedback.
pub const METADATA_TIMEOUT: Duration = Duration::from_secs(3 * 60);
const TICK: Duration = Duration::from_secs(1);
const PERSIST_EVERY_TICKS: u64 = 20;
/// Ids of the downloads an update paused, for the next start to resume.
const PAUSED_FOR_UPDATE_KEY: &str = "downloads.pausedForUpdate";

struct Item {
    id: i64,
    name: String,
    name_is_placeholder: bool,
    magnet_uri: String,
    info_hash: String,
    save_path: String,
    source: String,
    status: DownloadStatus,
    progress: f64,
    total_bytes: u64,
    added_at: String,
    completed_at: Option<String>,
    error: Option<String>,
    start_notification_sent: bool,
    complete_notification_sent: bool,
    series_task_id: Option<i64>,
    // Runtime only
    download_speed: u64,
    upload_speed: u64,
    peers: u32,
    handle: Option<TorrentHandle>,
    /// Set while metadata is fetched and the torrent started; cancelled by pause/delete.
    attaching: Option<CancellationToken>,
    /// Bumped on every attach and detach, so a slow attach can tell it has been superseded.
    attempt: u64,
}

impl Item {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let status: String = row.get("status")?;
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            name_is_placeholder: row.get("name_is_placeholder")?,
            magnet_uri: row.get("magnet_uri")?,
            info_hash: row.get("info_hash")?,
            save_path: row.get("save_path")?,
            source: row.get("source")?,
            status: DownloadStatus::parse(&status).unwrap_or(DownloadStatus::Paused),
            progress: row.get("progress")?,
            total_bytes: row.get::<_, i64>("total_bytes")?.max(0) as u64,
            added_at: row.get("added_at")?,
            completed_at: row.get("completed_at")?,
            error: row.get("error")?,
            start_notification_sent: row.get("start_notification_sent")?,
            complete_notification_sent: row.get("complete_notification_sent")?,
            series_task_id: row.get("series_task_id")?,
            download_speed: 0,
            upload_speed: 0,
            peers: 0,
            handle: None,
            attaching: None,
            attempt: 0,
        })
    }

    fn to_dto(&self) -> DownloadDto {
        DownloadDto {
            id: self.id,
            name: self.name.clone(),
            status: self.status,
            progress: self.progress,
            total_bytes: self.total_bytes,
            download_speed: self.download_speed,
            upload_speed: self.upload_speed,
            peers: self.peers,
            source: self.source.clone(),
            save_path: self.save_path.clone(),
            added_at: self.added_at.clone(),
            completed_at: self.completed_at.clone(),
            error: self.error.clone(),
            series_task_id: self.series_task_id,
        }
    }

    fn clear_stats(&mut self) {
        self.download_speed = 0;
        self.upload_speed = 0;
        self.peers = 0;
    }

    /// Stops following the engine: cancels a pending attach and hands back the running torrent.
    fn detach(&mut self) -> Option<TorrentHandle> {
        self.attempt += 1;
        if let Some(token) = self.attaching.take() {
            token.cancel();
        }
        self.handle.take()
    }

    fn is_engaged(&self) -> bool {
        self.handle.is_some() || self.attaching.is_some()
    }
}

pub struct AddDownload {
    pub name: String,
    pub magnet_uri: String,
    pub source: String,
    pub series_task_id: Option<i64>,
    pub save_folder: Option<String>,
}

/// Owns every download: persists them, drives the torrent engine, resumes unfinished ones on start,
/// and publishes live progress. The engine is optional so tests can run everything above it
/// without opening peer or DHT sockets.
pub struct DownloadManager {
    db: Db,
    engine: Option<Arc<Engine>>,
    settings: Arc<SettingsService>,
    notifications: Arc<NotificationDispatcher>,
    events: EventBus,
    torrent_cache: PathBuf,
    items: Mutex<BTreeMap<i64, Item>>,
    changed: Notify,
    shutting_down: AtomicBool,
    stop: CancellationToken,
}

impl DownloadManager {
    pub fn new(
        db: Db,
        engine: Option<Arc<Engine>>,
        settings: Arc<SettingsService>,
        notifications: Arc<NotificationDispatcher>,
        events: EventBus,
        torrent_cache: PathBuf,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            engine,
            settings,
            notifications,
            events,
            torrent_cache,
            items: Mutex::default(),
            changed: Notify::new(),
            shutting_down: AtomicBool::new(false),
            stop: CancellationToken::new(),
        })
    }

    fn items(&self) -> MutexGuard<'_, BTreeMap<i64, Item>> {
        self.items.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn load_rows(&self) -> Vec<Item> {
        let db = self.db.lock();
        let mut statement = db.prepare("SELECT * FROM downloads").expect("downloads table");
        statement.query_map([], Item::from_row).map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    pub fn start(self: &Arc<Self>) {
        let mut resumed = 0;
        let paused_for_update = self.take_paused_for_update();
        {
            let mut items = self.items();
            for mut item in self.load_rows() {
                if item.status == DownloadStatus::Paused && paused_for_update.contains(&item.id) {
                    item.status = DownloadStatus::Queued;
                } else if item.progress >= 100.0 && !matches!(item.status, DownloadStatus::Completed | DownloadStatus::Seeding) {
                    item.status = DownloadStatus::Completed;
                    item.completed_at.get_or_insert_with(now_iso);
                    self.persist(&item);
                }
                items.insert(item.id, item);
            }
            if let Some(engine) = self.engine.clone() {
                let wanted: HashMap<String, bool> = items
                    .values()
                    .filter(|i| !matches!(i.status, DownloadStatus::Completed | DownloadStatus::Error))
                    .map(|i| (i.info_hash.to_lowercase(), i.status != DownloadStatus::Paused))
                    .collect();
                tokio::spawn(async move { engine.reconcile(&wanted).await });
                for item in items.values_mut() {
                    if !matches!(item.status, DownloadStatus::Completed | DownloadStatus::Error | DownloadStatus::Paused) {
                        self.attach(item);
                        resumed += 1;
                    }
                }
            }
        }
        let manager = self.clone();
        tokio::spawn(async move { manager.publish_changes().await });
        if self.engine.is_some() {
            let manager = self.clone();
            tokio::spawn(async move { manager.tick_loop().await });
        }
        tracing::info!("Download manager started, resumed {resumed} downloads");
    }

    /// Picks up rows written behind the manager's back (the legacy importer).
    pub fn load_new(&self) {
        let mut items = self.items();
        for item in self.load_rows() {
            items.entry(item.id).or_insert(item);
        }
        drop(items);
        self.changed();
    }

    pub async fn stop(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.stop.cancel();
        self.persist_all(true);
        // Closing every peer and DHT socket can take seconds; progress is already saved.
        if let Some(engine) = &self.engine {
            let _ = tokio::time::timeout(Duration::from_secs(3), engine.stop()).await;
        }
    }

    pub fn list(&self) -> Vec<DownloadDto> {
        let mut list: Vec<DownloadDto> = self.items().values().map(Item::to_dto).collect();
        list.sort_by(|a, b| b.added_at.cmp(&a.added_at));
        list
    }

    pub fn get(&self, id: i64) -> ApiResult<DownloadDto> {
        self.items().get(&id).map(Item::to_dto).ok_or_else(|| not_found(id))
    }

    /// Rows the tray lists: downloading, seeding or fetching metadata.
    pub fn active(&self) -> Vec<DownloadDto> {
        self.list()
            .into_iter()
            .filter(|d| {
                matches!(d.status, DownloadStatus::Downloading | DownloadStatus::Seeding | DownloadStatus::FetchingMetadata)
            })
            .collect()
    }

    /// Adds a magnet, or returns the download already tracking that torrent.
    pub fn add(self: &Arc<Self>, input: AddDownload) -> ApiResult<DownloadDto> {
        let hash = extract_info_hash(&input.magnet_uri)
            .and_then(|h| normalize_info_hash(&h))
            .ok_or_else(|| ApiError::bad("That magnet link has no valid info hash."))?;
        let mut items = self.items();
        if let Some(existing) = items.values().find(|i| i.info_hash.eq_ignore_ascii_case(&hash)) {
            return Ok(existing.to_dto());
        }
        let save_path = input
            .save_folder
            .map(|f| f.trim().to_owned())
            .filter(|f| !f.is_empty())
            .unwrap_or_else(|| self.settings.get().download_folder);
        std::fs::create_dir_all(&save_path)
            .map_err(|e| ApiError::bad(format!("Could not create the folder '{save_path}': {e}")))?;
        let display_name = [input.name.trim().to_owned(), magnet_name(&input.magnet_uri).unwrap_or_default()]
            .into_iter()
            .find(|n| !n.is_empty())
            .unwrap_or_else(|| hash.clone());
        let mut item = self.db.lock().query_row(
            "INSERT INTO downloads (name, name_is_placeholder, magnet_uri, info_hash, save_path, source, status, added_at, series_task_id)
             VALUES (?, ?, ?, ?, ?, ?, 'Queued', ?, ?) RETURNING *",
            params![display_name, display_name == hash, input.magnet_uri, hash, save_path, input.source, now_iso(), input.series_task_id],
            Item::from_row,
        )?;
        if self.engine.is_some() {
            self.attach(&mut item);
            self.send_start_notification(&mut item);
        }
        let dto = item.to_dto();
        items.insert(item.id, item);
        drop(items);
        self.changed();
        Ok(dto)
    }

    pub async fn pause(&self, id: i64) -> ApiResult<DownloadDto> {
        let (handle, dto) = {
            let mut items = self.items();
            let item = items.get_mut(&id).ok_or_else(|| not_found(id))?;
            let handle = item.detach();
            item.status = DownloadStatus::Paused;
            item.clear_stats();
            self.persist(item);
            (handle, item.to_dto())
        };
        self.changed();
        if let (Some(handle), Some(engine)) = (handle, &self.engine) {
            engine.pause(&handle).await;
        }
        Ok(dto)
    }

    /// Pauses every active download before an update replaces the app, and remembers which, so the
    /// new version resumes them on start — or this one does, if the update fails.
    pub async fn pause_for_update(&self) {
        let active: Vec<i64> = self.items().values().filter(|i| i.is_engaged()).map(|i| i.id).collect();
        let ids = active.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
        KeyValue(self.db.clone()).set(PAUSED_FOR_UPDATE_KEY, Some(&ids));
        for id in active {
            let _ = self.pause(id).await;
        }
        tracing::info!("Paused downloads [{ids}] for the update");
    }

    /// Undoes `pause_for_update` when the update did not go ahead.
    pub fn resume_after_update(self: &Arc<Self>) {
        for id in self.take_paused_for_update() {
            let _ = self.resume(id);
        }
    }

    fn take_paused_for_update(&self) -> Vec<i64> {
        let kv = KeyValue(self.db.clone());
        let ids = kv.get(PAUSED_FOR_UPDATE_KEY).unwrap_or_default();
        kv.set(PAUSED_FOR_UPDATE_KEY, None);
        ids.split(',').filter_map(|id| id.parse().ok()).collect()
    }

    /// Resume a paused download, or retry a failed one.
    pub fn resume(self: &Arc<Self>, id: i64) -> ApiResult<DownloadDto> {
        let dto = {
            let mut items = self.items();
            let item = items.get_mut(&id).ok_or_else(|| not_found(id))?;
            item.error = None;
            if self.engine.is_none() {
                item.status = DownloadStatus::Queued;
            } else if !item.is_engaged() {
                self.attach(item);
                self.send_start_notification(item);
            }
            self.persist(item);
            item.to_dto()
        };
        self.changed();
        Ok(dto)
    }

    /// Removes a download; `delete_files` also erases what it downloaded, leaving other files alone.
    pub async fn delete(&self, id: i64, delete_files_too: bool) -> ApiResult<()> {
        // Drop it from the live list first so the tick and attach tasks leave it alone.
        let mut item = self.items().remove(&id).ok_or_else(|| not_found(id))?;
        self.changed();
        item.detach();
        let save_path = PathBuf::from(&item.save_path);
        let cached = self.cached_torrent_path(&item.info_hash);
        let metadata = std::fs::read(&cached).ok().and_then(|bytes| Metadata::from_torrent(bytes).ok());
        // By hash: a paused download has no handle, but the engine still keeps it.
        if let Some(engine) = &self.engine {
            engine.remove(&item.info_hash).await;
        }
        if delete_files_too && let Some(metadata) = &metadata {
            delete_files(metadata, &save_path);
            if let Some(content) = metadata.content_directory(&save_path) {
                remove_empty_tree(&content, &save_path);
            }
        }
        self.db.lock().execute("DELETE FROM downloads WHERE id = ?", [id])?;
        let _ = std::fs::remove_file(cached);
        Ok(())
    }

    fn cached_torrent_path(&self, hash: &str) -> PathBuf {
        self.torrent_cache.join(format!("{}.torrent", hash.to_lowercase()))
    }

    /// Starts following a download in the engine: metadata from the cache or the swarm, then the
    /// torrent itself, on a task of its own.
    fn attach(self: &Arc<Self>, item: &mut Item) {
        let Some(engine) = self.engine.clone() else { return };
        if item.is_engaged() {
            return;
        }
        let _ = std::fs::create_dir_all(&item.save_path);
        let cached = self.cached_torrent_path(&item.info_hash);
        item.status = if cached.exists() { DownloadStatus::Downloading } else { DownloadStatus::FetchingMetadata };
        item.error = None;
        item.attempt += 1;
        let token = CancellationToken::new();
        item.attaching = Some(token.clone());
        let (manager, id, attempt, magnet, save_path) =
            (self.clone(), item.id, item.attempt, item.magnet_uri.clone(), PathBuf::from(&item.save_path));
        tokio::spawn(async move {
            let run = manager.run_attach(&engine, id, attempt, &magnet, &cached, &save_path);
            tokio::select! {
                _ = token.cancelled() => {}
                outcome = run => if let Err(error) = outcome {
                    manager.fail(id, attempt, format!("{error:#}"));
                },
            }
        });
    }

    async fn run_attach(
        &self,
        engine: &Engine,
        id: i64,
        attempt: u64,
        magnet: &str,
        cached: &Path,
        save_path: &Path,
    ) -> anyhow::Result<()> {
        let metadata = match std::fs::read(cached).ok().and_then(|bytes| Metadata::from_torrent(bytes).ok()) {
            Some(metadata) => metadata,
            None => match tokio::time::timeout(METADATA_TIMEOUT, engine.resolve(magnet)).await {
                Ok(resolved) => resolved?,
                Err(_) => {
                    tracing::info!("Gave up fetching metadata for download {id} after 3 min (no peers)");
                    anyhow::bail!("No peers found — the torrent may be dead or have no seeders.");
                }
            },
        };
        self.on_metadata(id, attempt, &metadata, cached);
        let handle = engine.add(&metadata, save_path).await?;
        let shutting_down = self.shutting_down.load(Ordering::SeqCst);
        let still_listed = {
            let mut items = self.items();
            match items.get_mut(&id) {
                Some(item) if item.attempt == attempt && !shutting_down => {
                    item.handle = Some(handle);
                    item.attaching = None;
                    if item.status == DownloadStatus::FetchingMetadata {
                        item.status = DownloadStatus::Downloading;
                    }
                    self.persist(item);
                    drop(items);
                    self.changed();
                    return Ok(());
                }
                other => other.is_some(),
            }
        };
        // Paused, failed or deleted while it was starting. On shutdown the engine keeps it as it is.
        if !still_listed {
            engine.remove(&handle.info_hash().as_string()).await;
        } else if !shutting_down {
            engine.pause(&handle).await;
        }
        Ok(())
    }

    fn on_metadata(&self, id: i64, attempt: u64, metadata: &Metadata, cached: &Path) {
        if !cached.exists() {
            let written =
                std::fs::create_dir_all(&self.torrent_cache).and_then(|_| std::fs::write(cached, &metadata.torrent_bytes));
            if let Err(error) = written {
                tracing::warn!("Could not cache metadata for download {id}: {error}");
            }
        }
        let mut items = self.items();
        let Some(item) = items.get_mut(&id).filter(|i| i.attempt == attempt) else { return };
        item.total_bytes = metadata.total_bytes;
        if let Some(name) = metadata.name.as_deref().filter(|n| !n.is_empty())
            && (item.name_is_placeholder || item.name.is_empty())
        {
            item.name = name.to_owned();
            item.name_is_placeholder = false;
        }
        self.persist(item);
        drop(items);
        self.changed();
    }

    fn fail(&self, id: i64, attempt: u64, message: String) {
        let handle = {
            let mut items = self.items();
            let Some(item) = items.get_mut(&id).filter(|i| i.attempt == attempt) else { return };
            let handle = item.detach();
            item.status = DownloadStatus::Error;
            item.error = Some(message);
            item.clear_stats();
            self.persist(item);
            handle
        };
        self.changed();
        self.remove_in_background(handle);
    }

    /// Drops a failed or finished torrent from the engine, so a retry starts from a full check.
    fn remove_in_background(&self, handle: Option<TorrentHandle>) {
        if let (Some(handle), Some(engine)) = (handle, self.engine.clone()) {
            tokio::spawn(async move { engine.remove(&handle.info_hash().as_string()).await });
        }
    }

    fn send_start_notification(&self, item: &mut Item) {
        if item.start_notification_sent {
            return;
        }
        item.start_notification_sent = true;
        self.persist(item);
        self.notifications.notify("started", "Download started", item.name.clone());
    }

    async fn tick_loop(self: Arc<Self>) {
        let mut interval = tokio::time::interval(TICK);
        let mut ticks: u64 = 0;
        let mut last_stats = String::new();
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => return,
                _ = interval.tick() => {}
            }
            ticks += 1;
            self.tick(&mut last_stats);
            if ticks.is_multiple_of(PERSIST_EVERY_TICKS) {
                self.persist_all(false);
            }
        }
    }

    fn tick(&self, last_stats: &mut String) {
        let mut finished = Vec::new();
        let mut failed = Vec::new();
        let stats = {
            let mut items = self.items();
            for item in items.values_mut() {
                let Some(handle) = &item.handle else { continue };
                let stats = Engine::stats(handle);
                if let Some(error) = stats.error {
                    failed.push((item.id, item.attempt, error));
                    continue;
                }
                item.progress = (stats.progress * 10_000.0).round() / 100.0;
                item.download_speed = stats.download_speed;
                item.upload_speed = stats.upload_speed;
                item.peers = stats.peers;
                if stats.total_bytes > 0 {
                    item.total_bytes = stats.total_bytes;
                }
                if stats.finished && item.status != DownloadStatus::Seeding {
                    finished.push(item.id);
                }
            }
            items
                .values()
                .filter(|i| i.handle.is_some())
                .map(|i| format!("{}:{}:{}:{}:{}:{}", i.id, i.progress, i.download_speed, i.upload_speed, i.peers, i.total_bytes))
                .collect::<Vec<_>>()
                .join(",")
        };
        for (id, attempt, error) in failed {
            self.fail(id, attempt, error);
        }
        for id in finished {
            self.on_done(id);
        }
        if stats != *last_stats {
            *last_stats = stats;
            self.changed();
        }
    }

    fn on_done(&self, id: i64) {
        if self.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let stop_seeding = self.settings.get().post_download_action == PostDownloadAction::StopSeeding;
        let handle = {
            let mut items = self.items();
            let Some(item) = items.get_mut(&id) else { return };
            item.progress = 100.0;
            if !item.complete_notification_sent {
                item.complete_notification_sent = true;
                item.completed_at = Some(now_iso());
                self.notifications.notify("completed", "Download finished", item.name.clone());
            }
            let handle = if stop_seeding {
                item.status = DownloadStatus::Completed;
                item.clear_stats();
                item.detach()
            } else {
                item.status = DownloadStatus::Seeding;
                None
            };
            self.persist(item);
            handle
        };
        self.changed();
        self.remove_in_background(handle);
    }

    /// Asks for a `downloads.changed` broadcast; bursts of changes are sent once.
    fn changed(&self) {
        self.changed.notify_one();
    }

    async fn publish_changes(self: Arc<Self>) {
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => return,
                _ = self.changed.notified() => {}
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
            self.events.emit("downloads.changed", self.list());
        }
    }

    /// One transaction, so a periodic save is one commit rather than one per download.
    fn persist_all(&self, everything: bool) {
        let items = self.items();
        let mut db = self.db.lock();
        let saved = db.transaction().and_then(|tx| {
            for item in items.values().filter(|i| everything || i.handle.is_some()) {
                write_item(&tx, item)?;
            }
            tx.commit()
        });
        drop(db);
        if let Err(error) = saved {
            tracing::error!("Could not save downloads: {error}");
        }
    }

    fn persist(&self, item: &Item) {
        let saved = write_item(&self.db.lock(), item);
        if let Err(error) = saved {
            tracing::error!("Could not save download {}: {error}", item.id);
        }
    }
}

fn write_item(db: &rusqlite::Connection, item: &Item) -> rusqlite::Result<usize> {
    db.execute(
        "UPDATE downloads SET name = ?, name_is_placeholder = ?, status = ?, progress = ?, total_bytes = ?,
         completed_at = ?, error = ?, start_notification_sent = ?, complete_notification_sent = ? WHERE id = ?",
        params![
            item.name,
            item.name_is_placeholder,
            item.status.as_str(),
            item.progress,
            item.total_bytes as i64,
            item.completed_at,
            item.error,
            item.start_notification_sent,
            item.complete_notification_sent,
            item.id
        ],
    )
}

fn not_found(id: i64) -> ApiError {
    ApiError::not_found(format!("No download with id {id}."))
}

/// Removes a torrent's leftover folder once its files are gone — but only empty directories, only
/// strictly inside the save root, never the root itself. A user may have put other files there, or
/// another torrent may share it.
pub fn remove_empty_tree(content_dir: &Path, save_root: &Path) {
    let (Ok(content), Ok(root)) = (std::path::absolute(content_dir), std::path::absolute(save_root)) else { return };
    if content == root || !content.starts_with(&root) {
        return;
    }
    fn prune(dir: &Path) -> std::io::Result<bool> {
        let mut empty = true;
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            // file_type does not follow links: a symlink is content to keep, never a directory to walk into.
            if entry.file_type()?.is_dir() && prune(&entry.path())? {
                continue;
            }
            empty = false;
        }
        if empty {
            std::fs::remove_dir(dir)?;
        }
        Ok(empty)
    }
    if content.exists()
        && let Err(error) = prune(&content)
    {
        tracing::warn!("Could not remove leftover folder {}: {error}", content.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(name: &str, files: &[&str]) -> Metadata {
        Metadata {
            torrent_bytes: Vec::new(),
            name: Some(name.into()),
            total_bytes: 0,
            files: files.iter().map(PathBuf::from).collect(),
            seen_peers: Vec::new(),
        }
    }

    #[test]
    fn deleting_files_never_removes_the_save_folder_or_anything_else_in_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Downloads");
        std::fs::create_dir_all(root.join("Show/Subs")).unwrap();
        std::fs::write(root.join("Show/e01.mkv"), "x").unwrap();
        std::fs::write(root.join("Show/Subs/e01.srt"), "x").unwrap();
        std::fs::write(root.join("single.iso"), "x").unwrap();
        std::fs::write(root.join("keep.txt"), "mine").unwrap();

        let single = metadata("single.iso", &["single.iso"]);
        assert_eq!(single.content_directory(&root), None);
        delete_files(&single, &root);
        assert!(!root.join("single.iso").exists());

        let multi = metadata("Show", &["e01.mkv", "Subs/e01.srt", "../keep.txt"]);
        let content = multi.content_directory(&root).unwrap();
        delete_files(&multi, &root);
        remove_empty_tree(&content, &root);
        assert!(!root.join("Show").exists());
        assert!(root.join("keep.txt").exists(), "a path escaping the torrent's folder is ignored");

        std::fs::remove_file(root.join("keep.txt")).unwrap();
        remove_empty_tree(&root, &root);
        assert!(root.exists(), "the save folder itself stays, even when empty");
    }
}
