//! The BitTorrent engine (librqbit), reduced to what the download manager needs: resolve a magnet's
//! metadata, run a torrent into a folder, read its progress, and remove it.

use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use librqbit::dht::DhtPersistenceConfig;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, ListenerMode, ListenerOptions, ManagedTorrent, Session,
    SessionOptions, TorrentStatsState,
};

use crate::config::VERSION;
use crate::paths::Paths;
use crate::search::magnet::DEFAULT_TRACKERS;

/// `dht.libtorrent.org` comes first on purpose: on some filtered networks the classic routers answer
/// find_node with one node repeated eight times, which stalls the DHT lookup. libtorrent's router
/// returns distinct nodes.
pub const DHT_BOOTSTRAP: [&str; 4] =
    ["dht.libtorrent.org:25401", "router.bittorrent.com:6881", "dht.transmissionbt.com:6881", "router.utorrent.com:6881"];

pub type TorrentHandle = Arc<ManagedTorrent>;

/// What a torrent is, known once its metadata has been fetched (or read from the cache).
pub struct Metadata {
    pub torrent_bytes: Vec<u8>,
    pub name: Option<String>,
    pub total_bytes: u64,
    /// Relative paths of every file, as the torrent lays them out below its folder.
    pub files: Vec<PathBuf>,
    pub seen_peers: Vec<SocketAddr>,
}

impl Metadata {
    /// Parses a cached .torrent file.
    pub fn from_torrent(bytes: Vec<u8>) -> anyhow::Result<Self> {
        let parsed = librqbit::torrent_from_bytes(&bytes)?;
        let info = parsed.info.data.validate()?;
        let (name, total_bytes, files) = describe(&info);
        Ok(Self { torrent_bytes: bytes, name, total_bytes, files, seen_peers: Vec::new() })
    }

    /// A multi-file torrent gets a folder of its own, named after it, inside the save folder;
    /// a single file goes straight into the save folder (as every other client does).
    pub fn content_directory(&self, save_path: &Path) -> Option<PathBuf> {
        let name = self.name.as_deref().filter(|n| !n.is_empty())?;
        let folder = Path::new(name);
        let safe = folder.components().all(|c| matches!(c, Component::Normal(_)));
        (self.files.len() > 1 && safe).then(|| save_path.join(folder))
    }

    pub fn output_folder(&self, save_path: &Path) -> PathBuf {
        self.content_directory(save_path).unwrap_or_else(|| save_path.to_path_buf())
    }
}

fn describe<B: AsRef<[u8]>>(info: &librqbit::ValidatedTorrentMetaV1Info<B>) -> (Option<String>, u64, Vec<PathBuf>) {
    let files = info.iter_file_details().map(|f| f.filename.to_pathbuf()).collect();
    (info.name().map(|n| n.into_owned()), info.lengths().total_length(), files)
}

/// Live numbers for one running torrent.
pub struct EngineStats {
    /// 0–1
    pub progress: f64,
    pub total_bytes: u64,
    pub download_speed: u64,
    pub upload_speed: u64,
    pub peers: u32,
    pub finished: bool,
    pub error: Option<String>,
}

pub struct Engine {
    session: Arc<Session>,
}

impl Engine {
    pub async fn start(paths: &Paths) -> anyhow::Result<Self> {
        let options = SessionOptions {
            dht: Some(DhtSessionConfig {
                bootstrap_addrs: Some(DHT_BOOTSTRAP.iter().map(|s| s.to_string()).collect()),
                port: None,
                persistence: Some(DhtPersistenceConfig { dump_interval: None, config_filename: Some(paths.dht_state.clone()) }),
            }),
            listen: Some(ListenerOptions { mode: ListenerMode::TcpOnly, ..Default::default() }),
            trackers: DEFAULT_TRACKERS.iter().filter_map(|t| t.parse().ok()).collect(),
            client_name_and_version: Some(format!("MediaDownloader {VERSION}")),
            ..Default::default()
        };
        let session = Session::new_with_opts(paths.data_dir.join("downloads"), options).await?;
        Ok(Self { session })
    }

    /// Fetches a magnet's metadata from peers. Can take minutes, or forever for a dead torrent.
    pub async fn resolve(&self, magnet: &str) -> anyhow::Result<Metadata> {
        let options = AddTorrentOptions { list_only: true, ..Default::default() };
        match self.session.add_torrent(AddTorrent::from_url(magnet), Some(options)).await? {
            AddTorrentResponse::ListOnly(listed) => {
                let (name, total_bytes, files) = describe(&listed.info);
                Ok(Metadata {
                    torrent_bytes: listed.torrent_bytes.to_vec(),
                    name,
                    total_bytes,
                    files,
                    seen_peers: listed.seen_peers,
                })
            }
            _ => anyhow::bail!("The engine did not return the torrent's metadata"),
        }
    }

    /// Starts (or resumes, re-checking what is on disk) a torrent into its folder.
    pub async fn add(&self, metadata: &Metadata, save_path: &Path) -> anyhow::Result<TorrentHandle> {
        let options = AddTorrentOptions {
            overwrite: true,
            output_folder: Some(metadata.output_folder(save_path).to_string_lossy().into_owned()),
            initial_peers: Some(metadata.seen_peers.clone()),
            ..Default::default()
        };
        let added = self.session.add_torrent(AddTorrent::from_bytes(metadata.torrent_bytes.clone()), Some(options)).await?;
        added.into_handle().ok_or_else(|| anyhow::anyhow!("The engine did not start the torrent"))
    }

    pub fn stats(handle: &TorrentHandle) -> EngineStats {
        let stats = handle.stats();
        let live = stats.live.as_ref();
        let speed = |mbps: f64| (mbps * 1024.0 * 1024.0).round().max(0.0) as u64;
        EngineStats {
            progress: if stats.total_bytes > 0 { stats.progress_bytes as f64 / stats.total_bytes as f64 } else { 0.0 },
            total_bytes: stats.total_bytes,
            download_speed: live.map_or(0, |l| speed(l.download_speed.mbps)),
            upload_speed: live.map_or(0, |l| speed(l.upload_speed.mbps)),
            peers: live.map_or(0, |l| l.snapshot.peer_stats.live),
            finished: stats.finished,
            error: match stats.state {
                TorrentStatsState::Error => Some(stats.error.unwrap_or_else(|| "The torrent stopped with an error".into())),
                _ => None,
            },
        }
    }

    /// Stops a torrent, leaving its files. The engine's own file deletion also removes the output
    /// folder once empty, which can be the user's download folder, so files go through
    /// `delete_files` instead.
    pub async fn remove(&self, handle: &TorrentHandle) {
        if let Err(error) = self.session.delete(handle.id().into(), false).await {
            tracing::warn!("Removing {} reported an error: {error:#}", handle.info_hash().as_string());
        }
    }

    pub async fn stop(&self) {
        self.session.stop().await;
    }
}

/// Deletes a stopped torrent's files, listed by its metadata, and only below its folder.
pub fn delete_files(metadata: &Metadata, save_path: &Path) {
    let folder = metadata.output_folder(save_path);
    for relative in &metadata.files {
        if !relative.components().all(|c| matches!(c, Component::Normal(_))) {
            continue;
        }
        let path = folder.join(relative);
        // symlink_metadata: a link planted in place of a file is removed, never followed.
        if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_dir())
            && let Err(error) = std::fs::remove_file(&path)
        {
            tracing::warn!("Could not delete {}: {error}", path.display());
        }
    }
}
