//! The BitTorrent engine (librqbit), reduced to what the download manager needs: resolve a magnet's
//! metadata, run a torrent into a folder, read its progress, pause it, and remove it.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::num::NonZeroU32;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use librqbit::dht::{DhtPersistenceConfig, Id20};
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, ListenerMode, ListenerOptions, ManagedTorrent,
    ManagedTorrentState, Session, SessionOptions, SessionPersistenceConfig, TorrentStatsState,
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
    /// Each file's length, in the same order.
    pub file_sizes: Vec<u64>,
    pub seen_peers: Vec<SocketAddr>,
}

impl Metadata {
    /// Parses a cached .torrent file.
    pub fn from_torrent(bytes: Vec<u8>) -> anyhow::Result<Self> {
        let parsed = librqbit::torrent_from_bytes(&bytes)?;
        let info = parsed.info.data.validate()?;
        let (name, total_bytes, files, file_sizes) = describe(&info);
        Ok(Self { torrent_bytes: bytes, name, total_bytes, files, file_sizes, seen_peers: Vec::new() })
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

type Description = (Option<String>, u64, Vec<PathBuf>, Vec<u64>);

fn describe<B: AsRef<[u8]>>(info: &librqbit::ValidatedTorrentMetaV1Info<B>) -> Description {
    let (files, sizes) = info.iter_file_details().map(|f| (f.filename.to_pathbuf(), f.len)).unzip();
    (info.name().map(|n| n.into_owned()), info.lengths().total_length(), files, sizes)
}

/// Live numbers for one running torrent.
pub struct EngineStats {
    /// 0–1
    pub progress: f64,
    pub total_bytes: u64,
    pub download_speed: u64,
    pub upload_speed: u64,
    /// Since the engine started this torrent (it restarts from zero with the app).
    pub uploaded_bytes: u64,
    pub peers: u32,
    pub finished: bool,
    pub error: Option<String>,
}

/// How the engine reaches the network. Changing it means starting the engine again.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NetworkOptions {
    /// Every peer, tracker and DHT socket is bound to this interface (a VPN's, say), so nothing
    /// leaves any other way. macOS and Linux only.
    pub interface: Option<String>,
}

/// The engine's download and upload caps in bytes per second; 0 is no cap.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpeedLimits {
    pub download: u64,
    pub upload: u64,
}

/// The engine meters in 16 KiB blocks and refuses a cap below one block per second; a cap is
/// raised to twice that so a block never waits more than half a second for its allowance.
pub const MIN_SPEED_LIMIT: u64 = 32 * 1024;

fn to_bps(limit: u64) -> Option<NonZeroU32> {
    NonZeroU32::new(limit.clamp(if limit == 0 { 0 } else { MIN_SPEED_LIMIT }, u32::MAX as u64) as u32)
}

/// The engine keeps its own list of torrents, with the pieces each has verified, so a restart
/// resumes without re-reading every file; it brings them back on start, paused or running as they
/// were. The download manager's database stays the source of truth: `reconcile` drops the rest.
pub struct Engine {
    session: Arc<Session>,
}

impl Engine {
    pub async fn start(paths: &Paths, network: &NetworkOptions, limits: SpeedLimits) -> anyhow::Result<Self> {
        let options = SessionOptions {
            bind_device_name: network.interface.clone(),
            ratelimits: librqbit::limits::LimitsConfig {
                download_bps: to_bps(limits.download),
                upload_bps: to_bps(limits.upload),
            },
            dht: Some(DhtSessionConfig {
                bootstrap_addrs: Some(DHT_BOOTSTRAP.iter().map(|s| s.to_string()).collect()),
                port: None,
                persistence: Some(DhtPersistenceConfig { dump_interval: None, config_filename: Some(paths.dht_state.clone()) }),
            }),
            // Asks the router (UPnP) to forward the peer port, so peers can connect to us too.
            listen: Some(ListenerOptions {
                mode: ListenerMode::TcpOnly,
                enable_upnp_port_forwarding: true,
                ..Default::default()
            }),
            fastresume: true,
            persistence: Some(SessionPersistenceConfig::Json { folder: Some(paths.torrent_session.clone()) }),
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
                let (name, total_bytes, files, file_sizes) = describe(&listed.info);
                Ok(Metadata {
                    torrent_bytes: listed.torrent_bytes.to_vec(),
                    name,
                    total_bytes,
                    files,
                    file_sizes,
                    seen_peers: listed.seen_peers,
                })
            }
            _ => anyhow::bail!("The engine did not return the torrent's metadata"),
        }
    }

    /// Starts a torrent into its folder, or unpauses it when the engine already has it. A torrent
    /// the engine has not seen before is first checked against what is on disk. `only_files`
    /// (indexes into `Metadata::files`) limits it to those files; None downloads all.
    pub async fn add(
        &self,
        metadata: &Metadata,
        save_path: &Path,
        only_files: Option<&[usize]>,
    ) -> anyhow::Result<TorrentHandle> {
        let options = AddTorrentOptions {
            overwrite: true,
            only_files: only_files.map(<[usize]>::to_vec),
            output_folder: Some(metadata.output_folder(save_path).to_string_lossy().into_owned()),
            initial_peers: Some(metadata.seen_peers.clone()),
            ..Default::default()
        };
        let added = self.session.add_torrent(AddTorrent::from_bytes(metadata.torrent_bytes.clone()), Some(options)).await?;
        let handle = added.into_handle().ok_or_else(|| anyhow::anyhow!("The engine did not start the torrent"))?;
        if handle.is_paused() {
            // One restored paused may still be checking its files, and an unpause during that check
            // is lost: the torrent ends up paused anyway.
            handle.wait_until_initialized().await?;
            self.session.unpause(&handle).await?;
        }
        if let Some(files) = only_files {
            // A torrent the engine restored keeps the selection it had; bring it up to date.
            let wanted: HashSet<usize> = files.iter().copied().collect();
            if handle.only_files().is_none_or(|current| current.into_iter().collect::<HashSet<_>>() != wanted) {
                self.session.update_only_files(&handle, &wanted).await?;
            }
        }
        Ok(handle)
    }

    /// The torrent the engine has for this info hash, running or paused.
    pub fn handle(&self, info_hash: &str) -> Option<TorrentHandle> {
        self.session.get(Id20::from_str(info_hash).ok()?.into())
    }

    /// Downloads only these files of a running torrent from now on.
    pub async fn select_files(&self, handle: &TorrentHandle, files: &[usize]) -> anyhow::Result<()> {
        self.session.update_only_files(handle, &files.iter().copied().collect()).await
    }

    /// Bytes of each file the torrent has verified, in `Metadata::files` order.
    pub fn file_progress(handle: &TorrentHandle) -> Vec<u64> {
        handle.stats().file_progress
    }

    /// Reads one file of a torrent from any position, fetching the pieces it reaches first.
    pub async fn stream(
        handle: &TorrentHandle,
        file: usize,
    ) -> anyhow::Result<impl tokio::io::AsyncRead + tokio::io::AsyncSeek + Send + Unpin + 'static> {
        handle.clone().stream(file).await
    }

    pub fn set_limits(&self, limits: SpeedLimits) {
        self.session.ratelimits.set_download_bps(to_bps(limits.download));
        self.session.ratelimits.set_upload_bps(to_bps(limits.upload));
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
            uploaded_bytes: stats.uploaded_bytes,
            peers: live.map_or(0, |l| l.snapshot.peer_stats.live),
            finished: stats.finished,
            error: match stats.state {
                TorrentStatsState::Error => Some(stats.error.unwrap_or_else(|| "The torrent stopped with an error".into())),
                _ => None,
            },
        }
    }

    /// Pauses a torrent but keeps it, and the pieces it has verified, for a quick resume. A torrent
    /// that has failed can't pause, so it is removed instead.
    pub async fn pause(&self, handle: &TorrentHandle) {
        if handle.is_paused() || handle.with_state(|s| matches!(s, ManagedTorrentState::Paused(_))) {
            return;
        }
        if let Err(error) = self.session.pause(handle).await {
            let hash = handle.info_hash().as_string();
            tracing::warn!("Could not pause {hash} ({error:#}); removing it instead");
            self.remove(&hash).await;
        }
    }

    /// Stops and forgets a torrent, leaving its files. The engine's own file deletion also removes
    /// the output folder once empty, which can be the user's download folder, so files go through
    /// `delete_files` instead.
    pub async fn remove(&self, info_hash: &str) {
        let Ok(hash) = Id20::from_str(info_hash) else { return };
        if self.session.get(hash.into()).is_none() {
            return;
        }
        if let Err(error) = self.session.delete(hash.into(), false).await {
            tracing::warn!("Removing {info_hash} reported an error: {error:#}");
        }
    }

    /// Brings the torrents the engine restored in line with the download list: `wanted` maps each
    /// info hash (lowercase hex) to whether it should run. The rest are removed, and those that
    /// should not run are paused.
    pub async fn reconcile(&self, wanted: &HashMap<String, bool>) {
        let handles: Vec<TorrentHandle> = self.session.with_torrents(|torrents| torrents.map(|(_, h)| h.clone()).collect());
        for handle in handles {
            let hash = handle.info_hash().as_string();
            match wanted.get(&hash) {
                None => self.remove(&hash).await,
                Some(false) => self.pause(&handle).await,
                Some(true) => {}
            }
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
