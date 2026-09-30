use std::path::{Path, PathBuf};

/// Per-user writable data. Separate from the legacy .NET app's folder, so both can run side by side
/// and the legacy database is only ever read (by the importer).
#[derive(Clone, Debug)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub database: PathBuf,
    pub secret_key: PathBuf,
    pub torrent_files: PathBuf,
    pub logs: PathBuf,
    pub endpoint: PathBuf,
    pub lock: PathBuf,
    pub dht_state: PathBuf,
    /// The torrent engine's own list of torrents and the pieces each has verified.
    pub torrent_session: PathBuf,
    /// Series posters from TVmaze.
    pub posters: PathBuf,
}

impl Paths {
    pub fn new(data_dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&data_dir)?;
        Ok(Self {
            database: data_dir.join("magnetar.db"),
            secret_key: data_dir.join("secret.key"),
            torrent_files: data_dir.join("torrents"),
            logs: data_dir.join("logs"),
            endpoint: data_dir.join("endpoint.json"),
            lock: data_dir.join("instance.lock"),
            dht_state: data_dir.join("dht.json"),
            torrent_session: data_dir.join("session"),
            posters: data_dir.join("posters"),
            data_dir,
        })
    }

    /// `MAGNETAR_DATA_DIRECTORY`, or the platform's per-user application data folder.
    pub fn from_environment() -> std::io::Result<Self> {
        Self::new(match std::env::var_os("MAGNETAR_DATA_DIRECTORY") {
            Some(configured) => std::path::absolute(configured)?,
            None => default_data_dir(),
        })
    }
}

pub fn home_dir() -> PathBuf {
    std::env::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home_dir().join("AppData").join("Local"))
}

fn default_data_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir().join("Library/Application Support/cc.codefusion.magnetar")
    } else if cfg!(windows) {
        local_app_data().join("CodeFusion").join("Magnetar")
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home_dir().join(".local/share")).join("magnetar")
    }
}

/// `MAGNETAR_DOWNLOAD_FOLDER` (test and scratch runs keep out of the user's folder), or
/// ~/Downloads/Magnetar.
pub fn default_download_folder() -> PathBuf {
    match std::env::var_os("MAGNETAR_DOWNLOAD_FOLDER") {
        Some(configured) => std::path::absolute(configured).unwrap_or_else(|_| PathBuf::from("Magnetar")),
        None => home_dir().join("Downloads").join("Magnetar"),
    }
}

/// Where the legacy .NET MediaDownloader kept its database.
pub fn legacy_database_path() -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("MAGNETAR_LEGACY_DATABASE") {
        return std::path::absolute(configured).ok();
    }
    if cfg!(target_os = "macos") {
        Some(home_dir().join("Library/Application Support/MediaDownloader/mediadownloader.db"))
    } else if cfg!(windows) {
        Some(local_app_data().join("MediaDownloader").join("mediadownloader.db"))
    } else {
        None
    }
}

/// The enclosing `.app` bundle when running from one on macOS.
pub fn mac_app_bundle() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos.ends_with(Path::new("Contents/MacOS")) && bundle.extension().is_some_and(|e| e == "app");
    is_bundle.then(|| bundle.to_path_buf())
}
