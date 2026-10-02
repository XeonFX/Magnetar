//! Checks GitHub Releases every 6 hours, tells once per new version (an OS notification with an
//! Install button, and the notification channels), and installs in place: the macOS .app bundle is
//! swapped by a helper after this process exits (with rollback), the Windows/Linux executable is
//! renamed aside and replaced. Every install needs the manifest signature to verify against the key
//! built into this binary, so a swapped asset *and* manifest are still refused. The releases' notes
//! are kept for the dashboard's changelog.

mod version;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use ed25519_dalek::{Signature, VerifyingKey};
use futures::future::BoxFuture;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

pub use self::version::{Version, is_outdated};
use crate::config::{ARCH, COMMIT, DEFAULT_PORT, GITHUB_REPO, IS_DEV, PLATFORM, RELEASE_PUBLIC_KEY, VERSION};
use crate::db::KeyValue;
use crate::downloads::DownloadManager;
use crate::events::EventBus;
use crate::notifications::NotificationDispatcher;
use crate::paths::mac_app_bundle;
use crate::protocol::encoding::{from_base64url, now_iso, random_id};
use crate::protocol::{AvailableUpdateDto, ReleaseDto, ReleasesDto, UpdateStatusDto};
use crate::system::notify::{self, Choice, Notice};
use crate::system::open_in_browser;

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);
const FIRST_CHECK: Duration = Duration::from_secs(60);
const MANIFEST: &str = "SHA256SUMS.txt";
const SIGNATURE: &str = "SHA256SUMS.txt.sig";
const MAC_INSTALL_SCRIPT: &str = include_str!("mac-install.sh");
/// The newest releases the changelog shows.
const RELEASES_PER_PAGE: usize = 20;
/// Longer notes are cut: no release says more, and they cross the relay to the dashboard.
const MAX_NOTES: usize = 64 * 1024;
/// The version people were last told about, so a restart doesn't tell them again.
const NOTIFIED_KEY: &str = "updates.notified_version";

#[derive(Clone)]
struct Release {
    version: String,
    tag: String,
    name: String,
    notes: String,
    published_at: Option<String>,
    prerelease: bool,
    release_url: String,
    asset_name: Option<String>,
    asset_url: Option<String>,
    manifest_url: Option<String>,
    signature_url: Option<String>,
}

impl Release {
    fn dto(&self) -> ReleaseDto {
        ReleaseDto {
            version: self.version.clone(),
            tag: self.tag.clone(),
            name: self.name.clone(),
            notes: self.notes.clone(),
            published_at: self.published_at.clone(),
            prerelease: self.prerelease,
            url: self.release_url.clone(),
        }
    }
}

/// Why a check failed, for the dashboard to say in the person's language.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Problem {
    /// No answer from GitHub: no network, DNS, a timeout.
    Offline,
    /// GitHub's rate limit for this network; `retry_at` says when it lifts.
    RateLimited,
    /// GitHub refused or answered something unreadable.
    Unavailable,
    /// The update could not be installed.
    Install,
}

impl Problem {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Offline => "offline",
            Self::RateLimited => "rate-limited",
            Self::Unavailable => "unavailable",
            Self::Install => "install",
        }
    }
}

#[derive(Debug)]
struct CheckError {
    problem: Problem,
    message: String,
    retry_at: Option<String>,
}

impl CheckError {
    fn new(problem: Problem, message: impl Into<String>) -> Self {
        Self { problem, message: message.into(), retry_at: None }
    }
}

#[derive(Default)]
struct State {
    /// Published releases, newest version first.
    releases: Vec<Release>,
    /// GitHub's tag for `releases`: an unchanged list answers 304, which costs no rate limit.
    etag: Option<String>,
    available: Option<Release>,
    checking: bool,
    installing: bool,
    last_checked_at: Option<String>,
    last_check_error: Option<String>,
    last_check_problem: Option<Problem>,
    retry_at: Option<String>,
    notified_version: Option<String>,
}

pub type QuitHook = Box<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>;

/// The asset for this platform: `Magnetar-<version>-<platform>-<arch>.<ext>`.
pub fn asset_suffix() -> String {
    let extension = match PLATFORM {
        "macos" => ".zip",
        "windows" => ".exe",
        _ => "",
    };
    format!("-{PLATFORM}-{ARCH}{extension}")
}

/// Reads one `<sha256>  <file>` line of a sha256sum manifest.
pub fn find_checksum(manifest: &str, asset: &str) -> Option<String> {
    manifest.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let (hash, name) = (parts.next()?, parts.next()?);
        (name.trim_start_matches('*') == asset).then(|| hash.to_lowercase())
    })
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

fn cut(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// The releases GitHub listed, newest version first: drafts, tags that are not versions and
/// entries that are not releases left out.
fn read_releases(list: Vec<serde_json::Value>) -> Vec<Release> {
    let mut releases: Vec<(Version, Release)> = list
        .into_iter()
        .filter_map(|item| serde_json::from_value::<GithubRelease>(item).ok())
        .filter(|release| !release.draft)
        .filter_map(|release| {
            let version = Version::parse(&release.tag_name)?;
            let url_of = |name: &str| release.assets.iter().find(|a| a.name == name).map(|a| a.browser_download_url.clone());
            let asset = release.assets.iter().find(|a| a.name.ends_with(&asset_suffix()));
            let parsed = Release {
                version: release.tag_name.trim().trim_start_matches(['v', 'V']).to_owned(),
                name: release.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&release.tag_name).to_owned(),
                notes: cut(release.body.as_deref().unwrap_or_default(), MAX_NOTES),
                published_at: release.published_at.clone(),
                prerelease: release.prerelease || version.is_prerelease(),
                release_url: release.html_url.clone(),
                asset_name: asset.map(|a| a.name.clone()),
                asset_url: asset.map(|a| a.browser_download_url.clone()),
                manifest_url: url_of(MANIFEST),
                signature_url: url_of(SIGNATURE),
                tag: release.tag_name,
            };
            Some((version, parsed))
        })
        .collect();
    releases.sort_by(|(a, _), (b, _)| b.cmp(a));
    releases.into_iter().map(|(_, release)| release).collect()
}

/// The release to offer someone running `running`: the newest that is not a pre-release, when newer.
fn newer_release<'a>(releases: &'a [Release], running: &str) -> Option<&'a Release> {
    releases.iter().find(|r| !r.prerelease).filter(|latest| is_outdated(running, &latest.version))
}

/// What a notice about `release` says in a line: its first changes, from notes like the release
/// workflow writes (`- Title (#12)`).
fn summary(release: &Release) -> String {
    let changes: Vec<String> = release
        .notes
        .lines()
        .filter_map(|line| line.trim().strip_prefix("- ").or_else(|| line.trim().strip_prefix("* ")))
        .map(|item| {
            let item = item.trim();
            match item.rfind(" (#") {
                Some(at) if item.ends_with(')') => item[..at].to_owned(),
                _ => item.to_owned(),
            }
        })
        .filter(|item| !item.is_empty())
        .take(2)
        .collect();
    let running = format!("You have {VERSION}.");
    if changes.is_empty() { running } else { format!("{running} New: {}", changes.join("; ")) }
}

/// When GitHub's rate limit lifts, from its headers, if it said.
fn retry_at(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    if header("x-ratelimit-remaining").as_deref() == Some("0")
        && let Some(reset) = header("x-ratelimit-reset").and_then(|v| v.parse::<i64>().ok())
    {
        return chrono::DateTime::from_timestamp(reset, 0).map(crate::protocol::encoding::iso);
    }
    let after = header("retry-after")?.parse::<i64>().ok()?;
    Some(crate::protocol::encoding::iso(chrono::Utc::now() + chrono::Duration::seconds(after)))
}

pub struct UpdateService {
    events: EventBus,
    notifications: Arc<NotificationDispatcher>,
    downloads: Arc<DownloadManager>,
    http: reqwest::Client,
    kv: KeyValue,
    state: Mutex<State>,
    cancel: CancellationToken,
    /// Stops the app cleanly before an install replaces it; set by main.
    pub on_quit: OnceLock<QuitHook>,
    /// Where a click on the notice opens the dashboard; set by main once the server listens.
    pub dashboard_url: OnceLock<String>,
    /// GitHub's API, `https://api.github.com` unless set first (a test's own GitHub).
    pub github_api: OnceLock<String>,
}

impl UpdateService {
    pub fn new(
        events: EventBus,
        notifications: Arc<NotificationDispatcher>,
        downloads: Arc<DownloadManager>,
        http: reqwest::Client,
        kv: KeyValue,
    ) -> Self {
        let notified_version = kv.get(NOTIFIED_KEY);
        Self {
            events,
            notifications,
            downloads,
            http,
            kv,
            state: Mutex::new(State { notified_version, ..State::default() }),
            cancel: CancellationToken::new(),
            on_quit: OnceLock::new(),
            dashboard_url: OnceLock::new(),
            github_api: OnceLock::new(),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn start(self: &Arc<Self>) {
        cleanup_previous_executable();
        if *IS_DEV {
            return;
        }
        let service = self.clone();
        tokio::spawn(async move {
            let mut delay = FIRST_CHECK;
            loop {
                tokio::select! {
                    _ = service.cancel.cancelled() => return,
                    _ = tokio::time::sleep(delay) => {}
                }
                if let Some(release) = service.run_check().await {
                    service.tell(&release);
                }
                delay = CHECK_INTERVAL;
            }
        });
    }

    pub fn stop(&self) {
        self.cancel.cancel();
    }

    fn can_self_install(&self, available: Option<&Release>) -> bool {
        if available.and_then(|r| r.asset_url.as_ref()).is_none() || RELEASE_PUBLIC_KEY.is_empty() {
            return false;
        }
        if PLATFORM == "macos" { mac_app_bundle().is_some() } else { !*IS_DEV }
    }

    pub fn status(&self) -> UpdateStatusDto {
        let state = self.state();
        UpdateStatusDto {
            current_version: VERSION.into(),
            current_commit: COMMIT.into(),
            available: state.available.as_ref().map(|r| AvailableUpdateDto {
                version: r.version.clone(),
                tag: r.tag.clone(),
                name: r.name.clone(),
                release_url: r.release_url.clone(),
                published_at: r.published_at.clone(),
            }),
            can_self_install: self.can_self_install(state.available.as_ref()),
            checking: state.checking,
            installing: state.installing,
            last_checked_at: state.last_checked_at.clone(),
            last_check_error: state.last_check_error.clone(),
            last_check_problem: state.last_check_problem.map(Problem::as_str),
            retry_at: state.retry_at.clone(),
        }
    }

    fn changed(&self) {
        self.events.emit("updates.changed", self.status());
    }

    /// Checks now, for someone who asked (the dashboard, the menu): they see the answer, so no OS
    /// notification; the notification channels still hear of a version once.
    pub async fn check(&self) -> UpdateStatusDto {
        if let Some(release) = self.run_check().await {
            self.notify_channels(&release);
        }
        self.status()
    }

    /// One check, unless one is running: the release to tell people about, the first time it is seen.
    async fn run_check(&self) -> Option<Release> {
        {
            let mut state = self.state();
            if state.checking {
                return None;
            }
            state.checking = true;
        }
        self.changed();
        let outcome = self.fetch_releases().await;
        let news = {
            let mut state = self.state();
            state.checking = false;
            state.last_checked_at = Some(now_iso());
            match &outcome {
                Ok(()) => {
                    state.last_check_error = None;
                    state.last_check_problem = None;
                    state.retry_at = None;
                }
                Err(error) => {
                    state.last_check_error = Some(error.message.clone());
                    state.last_check_problem = Some(error.problem);
                    state.retry_at = error.retry_at.clone();
                }
            }
            state.available = newer_release(&state.releases, VERSION).cloned();
            match state.available.clone() {
                Some(release) if state.notified_version.as_deref() != Some(release.version.as_str()) => {
                    state.notified_version = Some(release.version.clone());
                    Some(release)
                }
                _ => None,
            }
        };
        match &outcome {
            Err(error) => tracing::warn!("Update check failed: {}", error.message),
            Ok(()) => {
                if let Some(release) = &news {
                    tracing::info!("Update available: {} (running {VERSION})", release.tag);
                    self.kv.set(NOTIFIED_KEY, Some(&release.version));
                }
            }
        }
        self.changed();
        news
    }

    async fn fetch_releases(&self) -> Result<(), CheckError> {
        let mut request = self
            .http
            .get(format!(
                "{}/repos/{}/releases?per_page={RELEASES_PER_PAGE}",
                self.github_api.get_or_init(|| "https://api.github.com".into()),
                *GITHUB_REPO
            ))
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .timeout(Duration::from_secs(30));
        if let Some(etag) = self.state().etag.clone() {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }
        let response =
            request.send().await.map_err(|e| CheckError::new(Problem::Offline, format!("GitHub did not answer: {e}")))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(());
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            let mut state = self.state();
            state.releases.clear();
            state.etag = None;
            return Ok(());
        }
        let headers = response.headers();
        let limited = status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || (status == reqwest::StatusCode::FORBIDDEN
                && (headers.get("x-ratelimit-remaining").is_some_and(|v| v == "0") || headers.contains_key("retry-after")));
        if limited {
            let retry_at = retry_at(headers);
            return Err(CheckError {
                problem: Problem::RateLimited,
                message: "GitHub's rate limit for this network is reached".into(),
                retry_at,
            });
        }
        if !status.is_success() {
            return Err(CheckError::new(Problem::Unavailable, format!("GitHub answered HTTP {}", status.as_u16())));
        }
        let etag = headers.get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let list: Vec<serde_json::Value> = response
            .json()
            .await
            .map_err(|e| CheckError::new(Problem::Unavailable, format!("GitHub's answer could not be read: {e}")))?;
        let mut state = self.state();
        state.releases = read_releases(list);
        state.etag = etag;
        Ok(())
    }

    /// The releases for the changelog, newest first; read from GitHub when none were yet.
    pub async fn releases(&self) -> ReleasesDto {
        let unread = {
            let state = self.state();
            state.releases.is_empty() && state.etag.is_none()
        };
        if unread {
            self.check().await;
        }
        let state = self.state();
        ReleasesDto {
            releases: state.releases.iter().map(Release::dto).collect(),
            problem: if state.releases.is_empty() { state.last_check_problem.map(Problem::as_str) } else { None },
        }
    }

    fn notify_channels(&self, release: &Release) {
        self.notifications.notify(
            "update",
            format!("Magnetar {} is available", release.tag),
            format!(
                "You are running {VERSION}. Install it from Settings or the menu-bar icon, or download it from {}",
                release.release_url
            ),
        );
    }

    /// Tells about a new version found in the background: the channels, and an OS notification
    /// whose button installs it (or downloads it where this copy can't install itself).
    fn tell(self: &Arc<Self>, release: &Release) {
        self.notify_channels(release);
        let installs = self.can_self_install(Some(release));
        let (action, label) = if installs { ("install", "Install and Restart") } else { ("download", "Download") };
        let notice = Notice {
            kind: "update",
            title: format!("Magnetar {} is available", release.version),
            body: summary(release),
            actions: vec![(action, label.to_owned())],
        };
        let (service, page, runtime) = (self.clone(), release.release_url.clone(), tokio::runtime::Handle::current());
        notify::show(notice, move |choice| match choice {
            Choice::Action("install") => {
                let service = service.clone();
                runtime.spawn(async move {
                    if let Some(page) = service.install().await {
                        open_in_browser(&page);
                    }
                });
            }
            Choice::Action(_) => open_in_browser(&page),
            Choice::Open => {
                let dashboard =
                    service.dashboard_url.get().cloned().unwrap_or_else(|| format!("http://localhost:{DEFAULT_PORT}"));
                open_in_browser(&format!("{dashboard}/settings/about"));
            }
        });
    }

    /// Installs the available update and exits, or returns the release page to open where that
    /// isn't possible.
    pub async fn install(&self) -> Option<String> {
        let update = {
            let mut state = self.state();
            let update = state.available.clone()?;
            if state.installing {
                return None;
            }
            if !self.can_self_install(Some(&update)) {
                return Some(update.release_url);
            }
            state.installing = true;
            update
        };
        self.changed();
        let staging = std::env::temp_dir().join(format!("magnetar-update-{}", random_id(6)));
        match self.stage(&update, &staging).await {
            Ok(()) => {
                tracing::info!("Update {} staged; restarting", update.tag);
                if let Some(quit) = self.on_quit.get() {
                    quit().await;
                }
                std::process::exit(0);
            }
            Err(error) => {
                tracing::error!("Update install failed: {error:#}");
                {
                    let mut state = self.state();
                    state.last_check_error = Some(format!("Update failed: {error:#}"));
                    state.last_check_problem = Some(Problem::Install);
                    state.installing = false;
                }
                self.changed();
                let _ = std::fs::remove_dir_all(&staging);
                None
            }
        }
    }

    /// Downloads and checks the new version, pauses the active downloads, then swaps it in (on macOS
    /// a helper swaps once this app has exited). The new version resumes those downloads on start;
    /// if the swap fails, this one resumes them.
    async fn stage(&self, update: &Release, staging: &Path) -> anyhow::Result<()> {
        std::fs::create_dir_all(staging)?;
        let asset_name = update.asset_name.as_deref().expect("checked by can_self_install");
        let asset = self.download(update.asset_url.as_deref().unwrap_or_default(), Duration::from_secs(600)).await?;
        self.verify(&asset, asset_name, update).await?;
        let asset_path = staging.join(asset_name);
        std::fs::write(&asset_path, &asset)?;
        let mac_installer = if PLATFORM == "macos" { Some(MacInstaller::prepare(&asset_path, staging).await?) } else { None };
        self.downloads.pause_for_update().await;
        let swapped = match mac_installer {
            Some(installer) => installer.launch(),
            None => install_executable(&asset_path),
        };
        if swapped.is_err() {
            self.downloads.resume_after_update();
        }
        swapped
    }

    async fn download(&self, url: &str, timeout: Duration) -> anyhow::Result<Vec<u8>> {
        let response = self.http.get(url).timeout(timeout).send().await?;
        anyhow::ensure!(response.status().is_success(), "Download failed: HTTP {}", response.status().as_u16());
        Ok(response.bytes().await?.to_vec())
    }

    /// The asset's SHA-256 must be in the manifest, and the manifest signed by the release key.
    async fn verify(&self, asset: &[u8], asset_name: &str, update: &Release) -> anyhow::Result<()> {
        let (Some(manifest_url), Some(signature_url)) = (&update.manifest_url, &update.signature_url) else {
            anyhow::bail!("Release {} is not signed; update refused.", update.tag);
        };
        let manifest = self.download(manifest_url, Duration::from_secs(30)).await?;
        let signature = self.download(signature_url, Duration::from_secs(30)).await?;
        verify_manifest(&manifest, String::from_utf8_lossy(&signature).trim(), RELEASE_PUBLIC_KEY)?;
        let expected = find_checksum(&String::from_utf8_lossy(&manifest), asset_name)
            .ok_or_else(|| anyhow::anyhow!("{MANIFEST} has no entry for {asset_name}"))?;
        let actual: String = Sha256::digest(asset).iter().map(|b| format!("{b:02x}")).collect();
        anyhow::ensure!(actual == expected, "Checksum mismatch for {asset_name}; update refused.");
        Ok(())
    }
}

pub fn verify_manifest(manifest: &[u8], signature: &str, public_key: &str) -> anyhow::Result<()> {
    let key: [u8; 32] = from_base64url(public_key)?.try_into().map_err(|_| anyhow::anyhow!("Invalid release key"))?;
    let signature = Signature::from_slice(&from_base64url(signature)?)?;
    VerifyingKey::from_bytes(&key)?
        .verify_strict(manifest, &signature)
        .map_err(|_| anyhow::anyhow!("The release signature does not match; update refused."))
}

async fn run(program: &str, args: &[&std::ffi::OsStr]) -> anyhow::Result<()> {
    let output = tokio::process::Command::new(program).args(args).output().await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("{program} failed: {}", stderr.trim().chars().take(300).collect::<String>());
    }
    Ok(())
}

/// The macOS bundle swap: prepared while this app still runs, carried out by a helper once it exits.
struct MacInstaller {
    script: PathBuf,
    bundle: PathBuf,
    work: PathBuf,
}

impl MacInstaller {
    async fn prepare(zip: &Path, staging: &Path) -> anyhow::Result<Self> {
        let bundle = mac_app_bundle().expect("checked by can_self_install");
        run("/usr/bin/ditto", &["-x".as_ref(), "-k".as_ref(), zip.as_os_str(), staging.as_os_str()]).await?;
        let new_app = staging.join("Magnetar.app");
        anyhow::ensure!(new_app.join("Contents/MacOS/Magnetar").exists(), "The downloaded bundle has no Magnetar executable");
        // Copy beside the destination and validate it while this app still runs; the helper only
        // renames bundles once we have exited.
        let work = bundle.parent().unwrap_or(Path::new("/Applications")).join(format!(".Magnetar-update-{}", random_id(6)));
        std::fs::create_dir_all(&work)?;
        let script = work.join("install.sh");
        crate::db::write_private(&script, MAC_INSTALL_SCRIPT.as_bytes(), false)?;
        #[cfg(unix)]
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
        run("/bin/bash", &[script.as_os_str(), "prepare".as_ref(), bundle.as_os_str(), new_app.as_os_str(), work.as_os_str()])
            .await?;
        Ok(Self { script, bundle, work })
    }

    /// Starts the helper, which waits for this process to exit before swapping the bundles.
    fn launch(self) -> anyhow::Result<()> {
        std::process::Command::new("/usr/bin/nohup")
            .arg("/bin/bash")
            .arg(&self.script)
            .arg("install")
            .arg(&self.bundle)
            .arg("")
            .arg(&self.work)
            .arg(std::process::id().to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        Ok(())
    }
}

fn previous_executable_path(current: &Path) -> PathBuf {
    let name = current.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let previous = match name.strip_suffix(".exe") {
        Some(stem) => format!("{stem}.previous.exe"),
        None => format!("{name}.previous"),
    };
    current.with_file_name(previous)
}

/// Windows and Linux: a running executable can be renamed but not overwritten. Move it aside, put
/// the new one in its place, start it, and let it delete the old one on start-up.
fn install_executable(new_path: &Path) -> anyhow::Result<()> {
    let current = std::env::current_exe()?;
    let previous = previous_executable_path(&current);
    let _ = std::fs::remove_file(&previous);
    std::fs::rename(&current, &previous)?;
    // Staging may be on another volume: copy when a rename can't.
    if std::fs::rename(new_path, &current).is_err() {
        std::fs::copy(new_path, &current)?;
    }
    #[cfg(unix)]
    std::fs::set_permissions(&current, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
    crate::system::hidden_command(&current)
        .env("MAGNETAR_WAIT_FOR_PID", std::process::id().to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    Ok(())
}

/// Removes the executable an update left behind, once we are the new one.
fn cleanup_previous_executable() {
    if PLATFORM == "macos" {
        return;
    }
    if let Ok(current) = std::env::current_exe() {
        // Still locked by the exiting process on Windows: the next start tries again.
        let _ = std::fs::remove_file(previous_executable_path(&current));
    }
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;
    use crate::protocol::encoding::to_base64url;

    fn release(notes: &str) -> Release {
        Release {
            version: "9.0.0".into(),
            tag: "v9.0.0".into(),
            name: "Magnetar 9.0.0".into(),
            notes: notes.into(),
            published_at: None,
            prerelease: false,
            release_url: String::new(),
            asset_name: None,
            asset_url: None,
            manifest_url: None,
            signature_url: None,
        }
    }

    #[test]
    fn a_notice_says_the_first_changes_without_their_numbers() {
        let notes = "## New\n\n- Build version in About (#30)\n* Changelog panel (#31)\n- Third (#32)\n\n**Full changelog**: x";
        assert_eq!(summary(&release(notes)), format!("You have {VERSION}. New: Build version in About; Changelog panel"));
        // A title that ends in parentheses of its own keeps them.
        assert_eq!(summary(&release("- Faster search (Nyaa)")), format!("You have {VERSION}. New: Faster search (Nyaa)"));
        assert_eq!(summary(&release("")), format!("You have {VERSION}."));
        assert_eq!(summary(&release("Just a paragraph.")), format!("You have {VERSION}."));
    }

    #[test]
    fn notes_are_cut_on_a_character_boundary() {
        assert_eq!(cut("zażółć", 3), "za");
        assert_eq!(cut("zażółć", 4), "zaż");
        assert_eq!(cut("abc", 10), "abc");
    }

    #[test]
    fn reads_sha256sum_manifests() {
        let manifest = "abc123  Magnetar-2.1.0-macos-arm64.zip\nDEF456 *Magnetar-2.1.0-windows-x64.exe\n";
        assert_eq!(find_checksum(manifest, "Magnetar-2.1.0-windows-x64.exe").as_deref(), Some("def456"));
        assert_eq!(find_checksum(manifest, "missing"), None);
        assert_eq!(previous_executable_path(Path::new("/x/Magnetar.exe")), Path::new("/x/Magnetar.previous.exe"));
    }

    #[test]
    fn manifest_signatures_must_match_the_release_key() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let public = to_base64url(signing.verifying_key().as_bytes());
        let manifest = b"abc  Magnetar-2.1.0-linux-x64\n";
        let signature = to_base64url(&signing.sign(manifest).to_bytes());
        verify_manifest(manifest, &signature, &public).unwrap();
        assert!(verify_manifest(b"tampered", &signature, &public).is_err());
        let other = to_base64url(SigningKey::from_bytes(&[8; 32]).verifying_key().as_bytes());
        assert!(verify_manifest(manifest, &signature, &other).is_err());
    }
}
