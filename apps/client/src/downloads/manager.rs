use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;

use rusqlite::{Row, params};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::engine::{Engine, Metadata, NetworkOptions, SpeedLimits, TorrentHandle, bytes_in_pieces, delete_files};
use super::transfer::{current_limits, free_space, interface_index, wanted_interface};
use crate::db::{Db, KeyValue};
use crate::error::{ApiError, ApiResult};
use crate::events::EventBus;
use crate::notifications::NotificationDispatcher;
use crate::paths::Paths;
use crate::protocol::encoding::now_iso;
use crate::protocol::{
    DownloadDto, DownloadFileDto, DownloadStatus, EngineState, FileSelectionDto, PostDownloadAction, TransferStatusDto,
};
use crate::search::magnet::{build_magnet, extract_info_hash, magnet_name, normalize_info_hash};
use crate::settings::{AppSettings, SettingsService};

/// A dead torrent otherwise sits on "Fetching metadata" forever with no feedback.
pub const METADATA_TIMEOUT: Duration = Duration::from_secs(3 * 60);
/// How a download that found nobody to fetch it from fails; series replace those with another release.
pub const NO_PEERS: &str = "No peers found";
const TICK: Duration = Duration::from_secs(1);
const METADATA_CACHE: usize = 64;
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
    /// The series episode this download is, so a dead torrent can be replaced by another release.
    episode: Option<i64>,
    uploaded_bytes: u64,
    /// Indexes of the torrent's files to download; None is all of them.
    selected_files: Option<Vec<usize>>,
    // Runtime only
    /// How many files the torrent has, once its metadata is known.
    file_count: Option<usize>,
    download_speed: u64,
    upload_speed: u64,
    peers: u32,
    /// The engine's upload counter for this torrent when last read; it restarts from zero.
    upload_seen: u64,
    /// The live numbers last broadcast, to send only what changed.
    sent: (u64, u64, u64, u32, u64, u64),
    handle: Option<TorrentHandle>,
    /// Set while metadata is fetched and the torrent started; cancelled by pause/delete.
    attaching: Option<CancellationToken>,
    /// Bumped on every attach and detach, so a slow attach can tell it has been superseded.
    attempt: u64,
}

impl Item {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let status: String = row.get("status")?;
        let selected: Option<String> = row.get("selected_files")?;
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
            episode: row.get("episode")?,
            uploaded_bytes: row.get::<_, i64>("uploaded_bytes")?.max(0) as u64,
            selected_files: selected.and_then(|json| serde_json::from_str(&json).ok()),
            file_count: None,
            download_speed: 0,
            upload_speed: 0,
            peers: 0,
            upload_seen: 0,
            sent: Default::default(),
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
            uploaded_bytes: self.uploaded_bytes,
            partial_files: match (&self.selected_files, self.file_count) {
                (Some(selected), Some(total)) if selected.len() < total => {
                    Some(FileSelectionDto { selected: selected.len() as u32, total: total as u32 })
                }
                _ => None,
            },
        }
    }

    fn live_numbers(&self) -> (u64, u64, u64, u32, u64, u64) {
        (
            (self.progress * 100.0) as u64,
            self.download_speed,
            self.upload_speed,
            self.peers,
            self.total_bytes,
            self.uploaded_bytes,
        )
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

    /// Should be in the engine: not finished, failed or paused.
    fn wants_engine(&self) -> bool {
        !matches!(self.status, DownloadStatus::Completed | DownloadStatus::Error | DownloadStatus::Paused)
    }

    fn ratio(&self) -> f64 {
        if self.total_bytes == 0 { 0.0 } else { self.uploaded_bytes as f64 / self.total_bytes as f64 }
    }
}

pub struct AddDownload {
    pub name: String,
    pub magnet_uri: String,
    pub source: String,
    pub series_task_id: Option<i64>,
    pub episode: Option<i64>,
    pub save_folder: Option<String>,
}

/// Where the download manager's torrent engine comes from.
#[allow(clippy::large_enum_variant, reason = "one per app, never moved around")]
pub enum EngineSource {
    /// None at all: everything above the engine runs without peer or DHT sockets (tests).
    Off,
    /// One engine for the manager's lifetime.
    Fixed(Arc<Engine>),
    /// Started, stopped and restarted as the network settings and the chosen interface require.
    Managed(Paths),
}

/// A file of a download, to read from wherever it is now.
pub enum FileSource {
    /// Still in the engine: pieces are fetched as the reader reaches them.
    Engine(TorrentHandle, usize),
    /// Only on disk.
    Disk(PathBuf),
}

pub struct DownloadFile {
    pub name: String,
    pub size: u64,
    pub source: FileSource,
}

/// Owns every download: persists them, drives the torrent engine, resumes unfinished ones on start,
/// and publishes live progress.
pub struct DownloadManager {
    db: Db,
    source: EngineSource,
    engine: RwLock<Option<Arc<Engine>>>,
    settings: Arc<SettingsService>,
    notifications: Arc<NotificationDispatcher>,
    events: EventBus,
    torrent_cache: PathBuf,
    /// The engine's saved state: which pieces each torrent has, also while it is out of the engine.
    torrent_session: PathBuf,
    items: Mutex<BTreeMap<i64, Item>>,
    /// Parsed .torrent files, by info hash: the file list is read every few seconds while shown.
    metadata: Mutex<HashMap<String, Arc<Metadata>>>,
    transfer: Mutex<TransferStatusDto>,
    changed: Notify,
    shutting_down: AtomicBool,
    stop: CancellationToken,
}

impl DownloadManager {
    pub fn new(
        db: Db,
        source: EngineSource,
        settings: Arc<SettingsService>,
        notifications: Arc<NotificationDispatcher>,
        events: EventBus,
        paths: &Paths,
    ) -> Arc<Self> {
        let engine = match &source {
            EngineSource::Fixed(engine) => Some(engine.clone()),
            _ => None,
        };
        let state = match source {
            EngineSource::Off => EngineState::Off,
            EngineSource::Fixed(_) => EngineState::Running,
            EngineSource::Managed(_) => EngineState::Starting,
        };
        Arc::new(Self {
            db,
            source,
            engine: RwLock::new(engine),
            settings,
            notifications,
            events,
            torrent_cache: paths.torrent_files.clone(),
            torrent_session: paths.torrent_session.clone(),
            items: Mutex::default(),
            metadata: Mutex::default(),
            transfer: Mutex::new(TransferStatusDto {
                engine: state,
                message: None,
                network_interface: None,
                alt_speed_active: false,
                download_limit: 0,
                upload_limit: 0,
                free_bytes: None,
            }),
            changed: Notify::new(),
            shutting_down: AtomicBool::new(false),
            stop: CancellationToken::new(),
        })
    }

    fn items(&self) -> MutexGuard<'_, BTreeMap<i64, Item>> {
        self.items.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn engine(&self) -> Option<Arc<Engine>> {
        self.engine.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn load_rows(&self) -> Vec<Item> {
        let db = self.db.lock();
        let mut statement = db.prepare("SELECT * FROM downloads").expect("downloads table");
        let mut rows: Vec<Item> =
            statement.query_map([], Item::from_row).map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default();
        drop(statement);
        drop(db);
        // Only partial downloads need their file count now; the rest learn it with their metadata.
        for item in rows.iter_mut().filter(|i| i.selected_files.is_some()) {
            item.file_count = self.metadata(&item.info_hash).map(|m| m.files.len());
        }
        rows
    }

    pub fn start(self: &Arc<Self>) {
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
        }
        let manager = self.clone();
        tokio::spawn(async move { manager.publish_changes().await });
        match &self.source {
            EngineSource::Off => {}
            EngineSource::Fixed(engine) => {
                self.engage_all(engine.clone());
                self.spawn_tick_loop();
            }
            EngineSource::Managed(paths) => {
                let (manager, paths) = (self.clone(), paths.clone());
                tokio::spawn(async move { manager.supervise_engine(paths).await });
                self.spawn_tick_loop();
            }
        }
    }

    fn spawn_tick_loop(self: &Arc<Self>) {
        let manager = self.clone();
        tokio::spawn(async move { manager.tick_loop().await });
    }

    /// Hands every download that should run to a (new) engine, and drops what the engine brought
    /// back that the list no longer wants.
    fn engage_all(self: &Arc<Self>, engine: Arc<Engine>) {
        let mut items = self.items();
        let wanted: HashMap<String, bool> = items
            .values()
            .filter(|i| !matches!(i.status, DownloadStatus::Completed | DownloadStatus::Error))
            .map(|i| (i.info_hash.to_lowercase(), i.status != DownloadStatus::Paused))
            .collect();
        let reconciling = engine.clone();
        tokio::spawn(async move { reconciling.reconcile(&wanted).await });
        let mut resumed = 0;
        for item in items.values_mut().filter(|i| i.wants_engine()) {
            self.attach(item);
            resumed += 1;
        }
        drop(items);
        self.changed();
        tracing::info!("Resumed {resumed} downloads");
    }

    /// Takes every download out of an engine that is going away. Those that were running wait,
    /// queued, for the next engine.
    fn disengage_all(&self) {
        let mut items = self.items();
        for item in items.values_mut().filter(|i| i.is_engaged()) {
            item.detach();
            if item.wants_engine() {
                item.status = DownloadStatus::Queued;
            }
            item.clear_stats();
            self.persist(item);
        }
        drop(items);
        self.changed();
    }

    /// Keeps an engine running as the settings want it: bound to the chosen interface and only
    /// while it exists (a VPN kill switch), restarted when the interface or the choice changes,
    /// with the speed caps of the moment. Retries a failed start.
    async fn supervise_engine(self: Arc<Self>, paths: Paths) {
        const CHECK: Duration = Duration::from_secs(5);
        const RETRY: Duration = Duration::from_secs(30);
        let mut settings_changed = self.events.subscribe();
        // The options and interface index the current engine was started with.
        let mut running: Option<(NetworkOptions, Option<u32>)> = None;
        let mut retry_at: Option<tokio::time::Instant> = None;
        // Set only on a change: a new rate limiter starts with a full allowance, so setting the same
        // cap every few seconds would let through more than it.
        let mut applied: Option<SpeedLimits> = None;
        loop {
            let settings = self.settings.get();
            let network = NetworkOptions { interface: wanted_interface(&settings) };
            let index = network.interface.as_deref().and_then(interface_index);
            let (limits, alt) = current_limits(&settings);
            let missing = network.interface.is_some() && index.is_none();
            let stale = running.as_ref().is_some_and(|current| *current != (network.clone(), index));
            if (missing || stale) && running.is_some() {
                tracing::info!("Stopping the torrent engine: the network settings or interface changed");
                self.replace_engine(None).await;
                running = None;
            }
            if missing {
                self.set_transfer(|t| {
                    t.engine = EngineState::WaitingForNetwork;
                    t.message = None;
                });
            } else if running.is_none() && retry_at.is_none_or(|at| tokio::time::Instant::now() >= at) {
                self.set_transfer(|t| t.engine = EngineState::Starting);
                match Engine::start(&paths, &network, limits).await {
                    Ok(engine) => {
                        let engine = Arc::new(engine);
                        *self.engine.write().unwrap_or_else(|e| e.into_inner()) = Some(engine.clone());
                        if self.stop.is_cancelled() {
                            return;
                        }
                        self.engage_all(engine);
                        running = Some((network.clone(), index));
                        applied = Some(limits);
                        retry_at = None;
                        self.set_transfer(|t| {
                            t.engine = EngineState::Running;
                            t.message = None;
                        });
                    }
                    Err(error) => {
                        tracing::error!("The torrent engine could not start: {error:#}");
                        retry_at = Some(tokio::time::Instant::now() + RETRY);
                        self.set_transfer(|t| {
                            t.engine = EngineState::Failed;
                            t.message = Some(format!("{error:#}"));
                        });
                    }
                }
            }
            if let Some(engine) = self.engine()
                && applied != Some(limits)
            {
                engine.set_limits(limits);
                applied = Some(limits);
            }
            let free = free_space(Path::new(&settings.download_folder));
            self.set_transfer(|t| {
                t.network_interface = network.interface.clone();
                t.alt_speed_active = alt;
                t.download_limit = limits.download;
                t.upload_limit = limits.upload;
                // Coarse, so a running download doesn't re-send this every few seconds.
                t.free_bytes = free.map(|f| f / (64 << 20) * (64 << 20));
            });
            tokio::select! {
                _ = self.stop.cancelled() => return,
                _ = tokio::time::sleep(CHECK) => {}
                event = settings_changed.recv() => {
                    if !matches!(event, Ok(event) if event.name == "settings.changed") {
                        continue;
                    }
                }
            }
        }
    }

    /// Swaps the engine: every download leaves the old one, which stops.
    async fn replace_engine(&self, next: Option<Arc<Engine>>) {
        self.disengage_all();
        let old = std::mem::replace(&mut *self.engine.write().unwrap_or_else(|e| e.into_inner()), next);
        if let Some(old) = old {
            let _ = tokio::time::timeout(Duration::from_secs(5), old.stop()).await;
        }
    }

    fn set_transfer(&self, change: impl FnOnce(&mut TransferStatusDto)) {
        let mut transfer = self.transfer.lock().unwrap_or_else(|e| e.into_inner());
        let before = transfer.clone();
        change(&mut transfer);
        if *transfer != before {
            self.events.emit("transfer.changed", transfer.clone());
        }
    }

    pub fn transfer_status(&self) -> TransferStatusDto {
        self.transfer.lock().unwrap_or_else(|e| e.into_inner()).clone()
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
        if let Some(engine) = self.engine() {
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

    /// Series downloads that died for want of peers: (download id, episode, info hash).
    pub fn dead_episodes(&self, series_task_id: i64) -> Vec<(i64, i64, String)> {
        self.items()
            .values()
            .filter(|i| i.series_task_id == Some(series_task_id) && i.status == DownloadStatus::Error)
            .filter(|i| i.error.as_deref().is_some_and(|e| e.starts_with(NO_PEERS)))
            .filter_map(|i| Some((i.id, i.episode?, i.info_hash.clone())))
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
            "INSERT INTO downloads (name, name_is_placeholder, magnet_uri, info_hash, save_path, source, status, added_at,
               series_task_id, episode)
             VALUES (?, ?, ?, ?, ?, ?, 'Queued', ?, ?, ?) RETURNING *",
            params![
                display_name,
                display_name == hash,
                input.magnet_uri,
                hash,
                save_path,
                input.source,
                now_iso(),
                input.series_task_id,
                input.episode
            ],
            Item::from_row,
        )?;
        self.attach(&mut item);
        let dto = item.to_dto();
        items.insert(item.id, item);
        drop(items);
        self.changed();
        Ok(dto)
    }

    /// Adds a download from a .torrent file: no metadata to fetch, it starts right away.
    pub fn add_torrent_file(
        self: &Arc<Self>,
        bytes: Vec<u8>,
        source: &str,
        save_folder: Option<String>,
    ) -> ApiResult<DownloadDto> {
        if bytes.len() > MAX_TORRENT_FILE {
            return Err(ApiError::bad("That .torrent file is larger than 4 MB."));
        }
        let (hash, trackers) = torrent_identity(&bytes).ok_or_else(|| ApiError::bad("That is not a valid .torrent file."))?;
        let metadata =
            Metadata::from_torrent(bytes).map_err(|e| ApiError::bad(format!("That .torrent file is not usable: {e:#}")))?;
        let cached = self.cached_torrent_path(&hash);
        if !cached.exists() {
            std::fs::create_dir_all(&self.torrent_cache)?;
            std::fs::write(&cached, &metadata.torrent_bytes)?;
        }
        let name = metadata.name.clone().unwrap_or_default();
        let trackers: Vec<&str> = trackers.iter().map(String::as_str).collect();
        self.add(AddDownload {
            magnet_uri: build_magnet(&hash, &name, &trackers),
            name,
            source: source.to_owned(),
            series_task_id: None,
            episode: None,
            save_folder,
        })
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
        if let (Some(handle), Some(engine)) = (handle, self.engine()) {
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
            if !item.is_engaged() {
                item.status = DownloadStatus::Queued;
                self.attach(item);
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
        let metadata = self.metadata(&item.info_hash);
        // By hash: a paused download has no handle, but the engine still keeps it.
        if let Some(engine) = self.engine() {
            engine.remove(&item.info_hash).await;
        }
        if delete_files_too && let Some(metadata) = &metadata {
            delete_files(metadata, &save_path);
            if let Some(content) = metadata.content_directory(&save_path) {
                remove_empty_tree(&content, &save_path);
            }
        }
        self.db.lock().execute("DELETE FROM downloads WHERE id = ?", [id])?;
        let _ = std::fs::remove_file(self.cached_torrent_path(&item.info_hash));
        self.metadata.lock().unwrap_or_else(|e| e.into_inner()).remove(&item.info_hash.to_lowercase());
        Ok(())
    }

    /// The torrent's files with what each has so far. Needs the metadata, so not while it is
    /// still being fetched.
    pub fn files(&self, id: i64) -> ApiResult<Vec<DownloadFileDto>> {
        let (metadata, done, selected) = {
            let items = self.items();
            let item = items.get(&id).ok_or_else(|| not_found(id))?;
            let metadata = self
                .metadata(&item.info_hash)
                .ok_or_else(|| ApiError::bad("The file list arrives with the torrent's details."))?;
            let (done, _) = self.files_done(item, &metadata);
            (metadata, done, item.selected_files.clone())
        };
        Ok(metadata
            .files
            .iter()
            .zip(&metadata.file_sizes)
            .zip(done)
            .enumerate()
            .map(|(index, ((path, &size), done))| DownloadFileDto {
                index,
                path: path.iter().map(|part| part.to_string_lossy()).collect::<Vec<_>>().join("/"),
                size,
                done,
                selected: selected.as_ref().is_none_or(|s| s.contains(&index)),
                playable: is_playable(path),
            })
            .collect())
    }

    /// Downloads only these files from now on. Choosing a file that is not there yet sends a
    /// finished download back to work.
    pub async fn select_files(self: &Arc<Self>, id: i64, mut files: Vec<usize>) -> ApiResult<DownloadDto> {
        files.sort_unstable();
        files.dedup();
        let hash = self.items().get(&id).map(|i| i.info_hash.clone()).ok_or_else(|| not_found(id))?;
        let metadata = self.metadata(&hash).ok_or_else(|| ApiError::bad("The file list arrives with the torrent's details."))?;
        let count = metadata.files.len();
        if files.is_empty() {
            return Err(ApiError::bad("Choose at least one file, or delete the download."));
        }
        if files.iter().any(|&f| f >= count) {
            return Err(ApiError::bad(format!("The torrent has {count} files.")));
        }
        let selection = (files.len() < count).then_some(files);
        let handle = {
            let mut items = self.items();
            let item = items.get_mut(&id).ok_or_else(|| not_found(id))?;
            let (done, _) = self.files_done(item, &metadata);
            let chosen = |index: &usize| selection.as_ref().is_none_or(|s| s.contains(index));
            let was_chosen = |index: &usize| item.selected_files.as_ref().is_none_or(|s| s.contains(index));
            // A finished download only goes back to work for a newly chosen file it doesn't have.
            let missing = (0..count).any(|i| chosen(&i) && !was_chosen(&i) && done[i] < metadata.file_sizes[i]);
            item.total_bytes = (0..count).filter(chosen).map(|i| metadata.file_sizes[i]).sum();
            item.selected_files = selection.clone();
            item.file_count = Some(count);
            if item.status == DownloadStatus::Completed && missing {
                let have: u64 = (0..count).filter(chosen).map(|i| done[i]).sum();
                item.progress = (have as f64 * 10_000.0 / item.total_bytes.max(1) as f64).floor() / 100.0;
                item.completed_at = None;
                item.status = DownloadStatus::Queued;
                self.attach(item);
            }
            self.persist(item);
            item.handle.clone()
        };
        if let (Some(handle), Some(engine)) = (handle, self.engine()) {
            let all: Vec<usize> = (0..count).collect();
            engine.select_files(&handle, selection.as_deref().unwrap_or(&all)).await?;
        }
        self.changed();
        self.get(id)
    }

    /// One file of a download, to stream: from the engine while it has the torrent, else from disk.
    pub fn open_file(&self, id: i64, index: usize) -> ApiResult<DownloadFile> {
        let (metadata, save_path, handle, settled, done) = {
            let items = self.items();
            let item = items.get(&id).ok_or_else(|| not_found(id))?;
            let metadata = self
                .metadata(&item.info_hash)
                .ok_or_else(|| ApiError::bad("The file list arrives with the torrent's details."))?;
            let (done, settled) = self.files_done(item, &metadata);
            (metadata, PathBuf::from(&item.save_path), item.handle.clone(), settled, done)
        };
        let path = metadata.files.get(index).ok_or_else(|| ApiError::not_found(format!("No file {index} in download {id}.")))?;
        let size = metadata.file_sizes[index];
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let on_disk = metadata.output_folder(&save_path).join(path);
        // Unfinished, only a running torrent fetches what the player reaches; a paused one would
        // leave it waiting forever.
        let source = match handle {
            _ if !settled => return Err(ApiError::bad("The download is starting. Try again in a moment.")),
            _ if done[index] == size => FileSource::Disk(on_disk),
            Some(handle) => FileSource::Engine(handle, index),
            None => return Err(ApiError::bad("Resume the download to play what it has so far.")),
        };
        Ok(DownloadFile { name, size, source })
    }

    /// Where a download's files are on disk, for "Show in Finder".
    pub fn location(&self, id: i64) -> ApiResult<PathBuf> {
        let (hash, save_path) = {
            let items = self.items();
            let item = items.get(&id).ok_or_else(|| not_found(id))?;
            (item.info_hash.clone(), PathBuf::from(&item.save_path))
        };
        Ok(match self.metadata(&hash) {
            Some(metadata) if metadata.files.len() == 1 => metadata.output_folder(&save_path).join(&metadata.files[0]),
            Some(metadata) => metadata.output_folder(&save_path),
            None => save_path,
        })
    }

    /// How much of each file is really there, and whether that is settled. The engine sets every
    /// chosen file to its full length when a torrent starts, so the length on disk says nothing: the
    /// engine's count does, or the pieces it saved, or else the download's own state. While the
    /// engine takes a torrent up and checks it, its saved pieces may be out of date.
    fn files_done(&self, item: &Item, metadata: &Metadata) -> (Vec<u64>, bool) {
        let handle = item.handle.clone().or_else(|| self.engine().and_then(|e| e.handle(&item.info_hash)));
        let progress = handle.as_ref().map(Engine::file_progress).unwrap_or_default();
        if progress.len() == metadata.file_sizes.len() {
            return (progress, true);
        }
        if item.status == DownloadStatus::Completed {
            // Every chosen file is there. One left out may be too, if it was fetched before; the
            // engine no longer keeps pieces for a finished download, so its length has to do.
            let chosen = |index: usize| item.selected_files.as_ref().is_none_or(|s| s.contains(&index));
            let folder = metadata.output_folder(Path::new(&item.save_path));
            let done = (metadata.files.iter().zip(&metadata.file_sizes).enumerate())
                .map(|(i, (path, &size))| match chosen(i) {
                    true => size,
                    false => std::fs::metadata(folder.join(path)).map_or(0, |m| m.len().min(size)),
                })
                .collect();
            return (done, true);
        }
        let saved = std::fs::read(self.torrent_session.join(format!("{}.bitv", item.info_hash.to_lowercase())));
        (bytes_in_pieces(&saved.unwrap_or_default(), metadata.piece_length, &metadata.file_sizes), !item.is_engaged())
    }

    fn cached_torrent_path(&self, hash: &str) -> PathBuf {
        self.torrent_cache.join(format!("{}.torrent", hash.to_lowercase()))
    }

    fn metadata(&self, hash: &str) -> Option<Arc<Metadata>> {
        let key = hash.to_lowercase();
        if let Some(found) = self.metadata.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            return Some(found.clone());
        }
        let parsed =
            Arc::new(std::fs::read(self.cached_torrent_path(hash)).ok().and_then(|bytes| Metadata::from_torrent(bytes).ok())?);
        let mut cache = self.metadata.lock().unwrap_or_else(|e| e.into_inner());
        // Small, and emptied rather than managed: parsing again is cheap, holding every torrent isn't.
        if cache.len() >= METADATA_CACHE {
            cache.clear();
        }
        cache.insert(key, parsed.clone());
        Some(parsed)
    }

    /// Starts following a download in the engine: metadata from the cache or the swarm, then the
    /// torrent itself, on a task of its own. Without an engine (waiting for the network) it stays
    /// queued.
    fn attach(self: &Arc<Self>, item: &mut Item) {
        let Some(engine) = self.engine() else {
            if item.wants_engine() {
                item.status = DownloadStatus::Queued;
            }
            return;
        };
        if item.is_engaged() {
            return;
        }
        let _ = std::fs::create_dir_all(&item.save_path);
        let cached = self.cached_torrent_path(&item.info_hash);
        item.status = if cached.exists() { DownloadStatus::Downloading } else { DownloadStatus::FetchingMetadata };
        item.error = None;
        item.attempt += 1;
        item.upload_seen = 0;
        let token = CancellationToken::new();
        item.attaching = Some(token.clone());
        self.send_start_notification(item);
        let (manager, id, attempt, magnet, save_path, only_files) = (
            self.clone(),
            item.id,
            item.attempt,
            item.magnet_uri.clone(),
            PathBuf::from(&item.save_path),
            item.selected_files.clone(),
        );
        tokio::spawn(async move {
            let run = manager.run_attach(&engine, id, attempt, &magnet, &cached, &save_path, only_files.as_deref());
            tokio::select! {
                _ = token.cancelled() => {}
                outcome = run => if let Err(error) = outcome {
                    manager.fail(id, attempt, format!("{error:#}"));
                },
            }
        });
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_attach(
        &self,
        engine: &Engine,
        id: i64,
        attempt: u64,
        magnet: &str,
        cached: &Path,
        save_path: &Path,
        only_files: Option<&[usize]>,
    ) -> anyhow::Result<()> {
        let metadata = match std::fs::read(cached).ok().and_then(|bytes| Metadata::from_torrent(bytes).ok()) {
            Some(metadata) => metadata,
            None => match tokio::time::timeout(METADATA_TIMEOUT, engine.resolve(magnet)).await {
                Ok(resolved) => resolved?,
                Err(_) => {
                    tracing::info!("Gave up fetching metadata for download {id} after 3 min (no peers)");
                    anyhow::bail!("{NO_PEERS} — the torrent may be dead or have no seeders.");
                }
            },
        };
        self.on_metadata(id, attempt, &metadata, cached);
        let only_files = only_files.filter(|files| files.iter().all(|&f| f < metadata.files.len()));
        let handle = engine.add(&metadata, save_path, only_files).await?;
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
        item.file_count = Some(metadata.files.len());
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
        if let (Some(handle), Some(engine)) = (handle, self.engine()) {
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
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => return,
                _ = interval.tick() => {}
            }
            ticks += 1;
            self.tick();
            if ticks.is_multiple_of(PERSIST_EVERY_TICKS) {
                self.persist_all(false);
            }
        }
    }

    /// Reads every running torrent's numbers, acts on finished and failed ones, and sends the rows
    /// whose numbers changed (`downloads.updated`), rather than the whole list every second.
    fn tick(&self) {
        let settings = self.settings.get();
        let mut finished = Vec::new();
        let mut seeded = Vec::new();
        let mut failed = Vec::new();
        let mut updated = Vec::new();
        let mut status_changed = false;
        {
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
                let delta = if stats.uploaded_bytes >= item.upload_seen {
                    stats.uploaded_bytes - item.upload_seen
                } else {
                    stats.uploaded_bytes
                };
                item.upload_seen = stats.uploaded_bytes;
                item.uploaded_bytes += delta;
                if stats.finished && item.status != DownloadStatus::Seeding {
                    finished.push(item.id);
                } else if !stats.finished && item.status == DownloadStatus::Seeding {
                    // More files were chosen: back to downloading.
                    item.status = DownloadStatus::Downloading;
                    status_changed = true;
                } else if item.status == DownloadStatus::Seeding && seeded_enough(&settings, item) {
                    seeded.push(item.id);
                }
                if item.live_numbers() != item.sent {
                    item.sent = item.live_numbers();
                    updated.push(item.to_dto());
                }
            }
        }
        for (id, attempt, error) in failed {
            self.fail(id, attempt, error);
        }
        for id in finished {
            self.on_done(id);
        }
        for id in seeded {
            self.stop_seeding(id);
        }
        if status_changed {
            self.changed();
        } else if !updated.is_empty() {
            self.events.emit("downloads.updated", updated);
        }
    }

    fn on_done(&self, id: i64) {
        if self.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let settings = self.settings.get();
        let handle = {
            let mut items = self.items();
            let Some(item) = items.get_mut(&id) else { return };
            item.progress = 100.0;
            if !item.complete_notification_sent {
                item.complete_notification_sent = true;
                item.completed_at = Some(now_iso());
                self.notifications.notify("completed", "Download finished", item.name.clone());
            }
            let handle = if settings.post_download_action == PostDownloadAction::StopSeeding || seeded_enough(&settings, item) {
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

    /// A seeding download that has given back what the settings ask for.
    fn stop_seeding(&self, id: i64) {
        let handle = {
            let mut items = self.items();
            let Some(item) = items.get_mut(&id) else { return };
            tracing::info!("Download {id} reached a ratio of {:.2}; it stops seeding", item.ratio());
            item.status = DownloadStatus::Completed;
            item.clear_stats();
            self.persist(item);
            item.detach()
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

fn seeded_enough(settings: &AppSettings, item: &Item) -> bool {
    ratio_reached(settings.post_download_action, settings.seed_ratio, item.uploaded_bytes, item.total_bytes)
}

/// Only "seed to a ratio" stops by ratio, and a size not known yet never counts as reached.
fn ratio_reached(action: PostDownloadAction, target: f64, uploaded: u64, total: u64) -> bool {
    action == PostDownloadAction::SeedToRatio && total > 0 && uploaded as f64 / total as f64 >= target
}

/// Big enough for any real .torrent (a large season pack's is ~1 MB), small enough to refuse junk.
pub const MAX_TORRENT_FILE: usize = 4 * 1024 * 1024;

/// A .torrent file's info hash (lowercase hex) and its tracker URLs.
fn torrent_identity(bytes: &[u8]) -> Option<(String, Vec<String>)> {
    let parsed = librqbit::torrent_from_bytes(bytes).ok()?;
    let mut trackers: Vec<String> =
        parsed.iter_announce().filter_map(|t| std::str::from_utf8(t.as_ref()).ok().map(str::to_owned)).collect();
    trackers.dedup();
    Some((parsed.info_hash.as_string(), trackers))
}

const PLAYABLE: [&str; 14] =
    ["mp4", "m4v", "mkv", "webm", "mov", "avi", "ts", "m2ts", "mp3", "m4a", "flac", "ogg", "opus", "wav"];

fn is_playable(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| PLAYABLE.contains(&e.to_ascii_lowercase().as_str()))
}

fn write_item(db: &rusqlite::Connection, item: &Item) -> rusqlite::Result<usize> {
    db.execute(
        "UPDATE downloads SET name = ?, name_is_placeholder = ?, status = ?, progress = ?, total_bytes = ?,
         completed_at = ?, error = ?, start_notification_sent = ?, complete_notification_sent = ?, uploaded_bytes = ?,
         selected_files = ? WHERE id = ?",
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
            item.uploaded_bytes as i64,
            item.selected_files.as_ref().map(|f| serde_json::to_string(f).unwrap_or_default()),
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
            file_sizes: vec![1; files.len()],
            piece_length: 1,
            seen_peers: Vec::new(),
        }
    }

    #[test]
    fn seeding_stops_at_the_ratio_and_only_when_asked_to() {
        use PostDownloadAction::*;
        assert!(!ratio_reached(SeedToRatio, 1.0, 999, 1000));
        assert!(ratio_reached(SeedToRatio, 1.0, 1000, 1000));
        assert!(ratio_reached(SeedToRatio, 0.5, 600, 1000));
        assert!(!ratio_reached(SeedToRatio, 1.0, 5000, 0), "an unknown size is never reached");
        assert!(!ratio_reached(KeepSeeding, 1.0, 5000, 1000));
        assert!(!ratio_reached(StopSeeding, 1.0, 5000, 1000));
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
