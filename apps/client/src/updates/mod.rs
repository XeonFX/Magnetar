//! Checks GitHub Releases every 6 hours, tells once per new version (an OS notification with an
//! Install button, and the notification channels), and installs in place: the macOS .app bundle is
//! swapped by a helper after this process exits (with rollback), the Windows/Linux executable is
//! renamed aside and replaced (put back if that or starting the new one fails). Every install needs
//! the manifest signature to verify against the key built into this binary, so a swapped asset *and*
//! manifest are still refused. The releases' notes are kept for the dashboard's changelog.

mod version;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use ed25519_dalek::{Signature, VerifyingKey};
use futures::future::BoxFuture;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use self::version::{is_outdated, parse as parse_version, precedence};
use crate::config::{ARCH, COMMIT, DEFAULT_PORT, GITHUB_REPO, IS_DEV, PLATFORM, RELEASE_PUBLIC_KEY, VERSION};
use crate::db::KeyValue;
use crate::downloads::DownloadManager;
use crate::events::EventBus;
use crate::notifications::NotificationDispatcher;
use crate::paths::mac_app_bundle;
use crate::protocol::encoding::{from_base64url, now_iso, random_id};
use crate::protocol::{AvailableUpdateDto, Problem, ReleaseDto, ReleasesDto, UpdateStatusDto};
use crate::system::notify::{self, Choice, Notice};
use crate::system::open_in_browser;

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);
const FIRST_CHECK: Duration = Duration::from_secs(60);
const MANIFEST: &str = "SHA256SUMS.txt";
const SIGNATURE: &str = "SHA256SUMS.txt.sig";
const MAC_INSTALL_SCRIPT: &str = include_str!("mac-install.sh");
/// The newest releases the changelog shows.
const RELEASES_PER_PAGE: usize = 20;
/// Longer notes are cut: no release says more.
const MAX_NOTES: usize = 64 * 1024;
/// All the notes the changelog sends at once: it crosses the relay, whose frames hold 1 MiB.
const MAX_CHANGELOG: usize = 256 * 1024;
/// The version people were last told about, so a restart doesn't tell them again.
const NOTIFIED_KEY: &str = "updates.notified_version";
/// Far more than a release's file (about 20 MB), so a server that never stops sending is cut off.
const MAX_ASSET: u64 = 256 * 1024 * 1024;
/// The checksums and their signature: a few lines each.
const MAX_MANIFEST: u64 = 64 * 1024;

/// A release as the changelog shows it, and where its files are.
#[derive(Clone)]
struct Release {
    info: ReleaseDto,
    asset_name: Option<String>,
    asset_url: Option<String>,
    manifest_url: Option<String>,
    signature_url: Option<String>,
}

/// The buttons an update notice may carry: install where this copy can, else download.
const UPDATE_BUTTONS: [(&str, &str); 2] = [("install", "Install and Restart"), ("download", "Download")];

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
    let mut releases: Vec<(version::Version, Release)> = list
        .into_iter()
        .filter_map(|item| serde_json::from_value::<GithubRelease>(item).ok())
        .filter(|github| !github.draft)
        .filter_map(|github| {
            let version = parse_version(&github.tag_name)?;
            let url_of = |name: &str| github.assets.iter().find(|a| a.name == name).map(|a| a.browser_download_url.clone());
            let asset = github.assets.iter().find(|a| a.name.ends_with(&asset_suffix()));
            let release = Release {
                asset_name: asset.map(|a| a.name.clone()),
                asset_url: asset.map(|a| a.browser_download_url.clone()),
                manifest_url: url_of(MANIFEST),
                signature_url: url_of(SIGNATURE),
                info: ReleaseDto {
                    version: github.tag_name.trim().trim_start_matches(['v', 'V']).to_owned(),
                    name: github.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&github.tag_name).to_owned(),
                    notes: cut(github.body.as_deref().unwrap_or_default(), MAX_NOTES),
                    published_at: github.published_at.clone(),
                    prerelease: github.prerelease || !version.pre.is_empty(),
                    url: github.html_url.clone(),
                    tag: github.tag_name.clone(),
                },
            };
            Some((version, release))
        })
        .collect();
    releases.sort_by(|(a, _), (b, _)| precedence(b, a));
    releases.into_iter().map(|(_, release)| release).collect()
}

/// The release to offer someone running `running`: the newest that is not a pre-release, when newer.
fn newer_release<'a>(releases: &'a [Release], running: &str) -> Option<&'a Release> {
    releases.iter().find(|r| !r.info.prerelease).filter(|latest| is_outdated(running, &latest.info.version))
}

/// What a notice about `release` says in a line: its first changes, from notes like the release
/// workflow writes (`- Title (#12)`).
fn summary(release: &Release) -> String {
    let changes: Vec<String> = release
        .info
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
    /// One read of GitHub at a time: the changelog, asked for while a check runs, waits for it.
    reading: tokio::sync::Mutex<()>,
    /// For a click on a notice, which arrives on the system's thread.
    runtime: OnceLock<tokio::runtime::Handle>,
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
            reading: tokio::sync::Mutex::new(()),
            runtime: OnceLock::new(),
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
        let _ = self.runtime.set(tokio::runtime::Handle::current());
        // Before any notice: one left from the last run is answered too.
        let me = Arc::downgrade(self);
        notify::listen("update", &UPDATE_BUTTONS, move |choice| {
            if let Some(service) = me.upgrade() {
                service.chose(choice);
            }
        });
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
                version: r.info.version.clone(),
                tag: r.info.tag.clone(),
                name: r.info.name.clone(),
                release_url: r.info.url.clone(),
                published_at: r.info.published_at.clone(),
            }),
            can_self_install: self.can_self_install(state.available.as_ref()),
            checking: state.checking,
            installing: state.installing,
            last_checked_at: state.last_checked_at.clone(),
            last_check_error: state.last_check_error.clone(),
            last_check_problem: state.last_check_problem,
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
        let outcome = {
            let _reading = self.reading.lock().await;
            self.fetch_releases().await
        };
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
                Some(release) if state.notified_version.as_deref() != Some(release.info.version.as_str()) => {
                    state.notified_version = Some(release.info.version.clone());
                    Some(release)
                }
                _ => None,
            }
        };
        match &outcome {
            Err(error) => tracing::warn!("Update check failed: {}", error.message),
            Ok(()) => {
                if let Some(release) = &news {
                    tracing::info!("Update available: {} (running {VERSION})", release.info.tag);
                    self.kv.set(NOTIFIED_KEY, Some(&release.info.version));
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

    /// The releases for the changelog, newest first, at most `MAX_CHANGELOG` of notes; read from
    /// GitHub when none were yet, after a check under way. Reading them tells nobody of a new
    /// version: that stays the checks' (`check`, the background one with its notice).
    pub async fn releases(&self) -> ReleasesDto {
        let unread = |state: &State| state.releases.is_empty() && state.etag.is_none();
        let mut problem = None;
        if unread(&self.state()) {
            let _reading = self.reading.lock().await;
            if unread(&self.state()) {
                match self.fetch_releases().await {
                    Ok(()) => {
                        let mut state = self.state();
                        state.available = newer_release(&state.releases, VERSION).cloned();
                    }
                    Err(error) => problem = Some(error.problem),
                }
                self.changed();
            }
        }
        let state = self.state();
        let mut budget = MAX_CHANGELOG;
        let releases = state
            .releases
            .iter()
            .map(|release| {
                let ReleaseDto { version, tag, name, notes, published_at, prerelease, url } = &release.info;
                let notes = cut(notes, budget);
                budget -= notes.len();
                ReleaseDto {
                    version: version.clone(),
                    tag: tag.clone(),
                    name: name.clone(),
                    notes,
                    published_at: published_at.clone(),
                    prerelease: *prerelease,
                    url: url.clone(),
                }
            })
            .collect::<Vec<_>>();
        let problem = if releases.is_empty() { problem.or(state.last_check_problem) } else { None };
        ReleasesDto { releases, problem }
    }

    fn notify_channels(&self, release: &Release) {
        self.notifications.notify(
            "update",
            format!("Magnetar {} is available", release.info.tag),
            format!(
                "You are running {VERSION}. Install it from Settings or the menu-bar icon, or download it from {}",
                release.info.url
            ),
        );
    }

    /// Tells about a new version found in the background: the channels, and an OS notification
    /// whose button installs it (or downloads it where this copy can't install itself).
    fn tell(&self, release: &Release) {
        self.notify_channels(release);
        let installs = self.can_self_install(Some(release));
        let (action, label) = UPDATE_BUTTONS[if installs { 0 } else { 1 }];
        notify::show(Notice {
            kind: "update",
            title: format!("Magnetar {} is available", release.info.version),
            body: summary(release),
            actions: vec![(action, label.to_owned())],
        });
    }

    /// A click on an update notice, this run's or one left from before: install what is available
    /// now, or show where things stand (About) when nothing is; a download opens its page.
    fn chose(self: &Arc<Self>, choice: Choice) {
        let about = || {
            let dashboard = self.dashboard_url.get().cloned().unwrap_or_else(|| format!("http://localhost:{DEFAULT_PORT}"));
            open_in_browser(&format!("{dashboard}/settings/about"));
        };
        let available = self.state().available.clone();
        match (choice, available) {
            (Choice::Action("install"), Some(_)) => {
                let (Some(runtime), service) = (self.runtime.get(), self.clone()) else { return };
                runtime.spawn(async move {
                    if let Some(page) = service.install().await {
                        open_in_browser(&page);
                    }
                });
            }
            (Choice::Action(_), Some(release)) => open_in_browser(&release.info.url),
            _ => about(),
        }
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
                return Some(update.info.url);
            }
            state.installing = true;
            update
        };
        self.changed();
        let staging = std::env::temp_dir().join(format!("magnetar-update-{}", random_id(6)));
        match self.stage(&update, &staging).await {
            Ok(()) => {
                tracing::info!("Update {} staged; restarting", update.info.tag);
                if let Some(quit) = self.on_quit.get() {
                    quit().await;
                }
                std::process::exit(0);
            }
            Err(error) => {
                crate::log_failure!(error.as_ref(), "Update install failed: {error:#}");
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
        let asset_path = fetch_verified(&self.http, update, staging, RELEASE_PUBLIC_KEY, MAX_ASSET).await?;
        let mac_installer = if PLATFORM == "macos" { Some(MacInstaller::prepare(&asset_path, staging).await?) } else { None };
        self.downloads.pause_for_update().await;
        let swapped = match mac_installer {
            Some(installer) => installer.launch(),
            // Copies across volumes and waits for the new version to start: off the async workers.
            None => tokio::task::spawn_blocking(move || install_executable(&asset_path)).await?,
        };
        if swapped.is_err() {
            self.downloads.resume_after_update();
        }
        swapped
    }
}

/// `name` if it is a bare file name, the same on every system: no folders, `..`, drive or other punctuation.
fn plain_file_name(name: &str) -> Option<&str> {
    let plain = !name.is_empty()
        && name != "."
        && name != ".."
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b));
    plain.then_some(name)
}

/// Downloads `url` into memory, refusing more than `max` bytes.
async fn download_small(http: &reqwest::Client, url: &str, max: u64) -> anyhow::Result<Vec<u8>> {
    let mut response = http.get(url).timeout(Duration::from_secs(30)).send().await?.error_for_status()?;
    anyhow::ensure!(response.content_length().is_none_or(|length| length <= max), "{url} is too large");
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        body.extend_from_slice(&chunk);
        anyhow::ensure!(body.len() as u64 <= max, "{url} is too large");
    }
    Ok(body)
}

/// Downloads `url` to `path`, at most `max` bytes, and returns its SHA-256 in hex.
async fn download_to(http: &reqwest::Client, url: &str, path: &Path, max: u64) -> anyhow::Result<String> {
    use tokio::io::AsyncWriteExt;
    let mut response = http.get(url).timeout(Duration::from_secs(600)).send().await?.error_for_status()?;
    anyhow::ensure!(
        response.content_length().is_none_or(|length| length <= max),
        "The update is larger than any release; refused."
    );
    let mut file = tokio::fs::File::create(path).await?;
    let (mut hash, mut written) = (Sha256::new(), 0u64);
    while let Some(chunk) = response.chunk().await? {
        written += chunk.len() as u64;
        anyhow::ensure!(written <= max, "The update is larger than any release; refused.");
        hash.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Downloads `release`'s asset into `staging` and returns where it is, once it is known to be what the release key
/// signed: the manifest's signature is checked first, then the asset's SHA-256 against it, before anything uses it.
/// Nothing is left in `staging` when that fails.
async fn fetch_verified(
    http: &reqwest::Client,
    release: &Release,
    staging: &Path,
    public_key: &str,
    max_asset: u64,
) -> anyhow::Result<PathBuf> {
    let tag = &release.info.tag;
    let asset_name = release.asset_name.as_deref().unwrap_or_default();
    let asset_name = plain_file_name(asset_name)
        .ok_or_else(|| anyhow::anyhow!("Release {tag} names its file {asset_name:?}; update refused."))?;
    let (Some(asset_url), Some(manifest_url), Some(signature_url)) =
        (&release.asset_url, &release.manifest_url, &release.signature_url)
    else {
        anyhow::bail!("Release {tag} is not signed; update refused.");
    };
    let manifest = download_small(http, manifest_url, MAX_MANIFEST).await?;
    let signature = download_small(http, signature_url, MAX_MANIFEST).await?;
    verify_manifest(&manifest, String::from_utf8_lossy(&signature).trim(), public_key)?;
    let expected = find_checksum(&String::from_utf8_lossy(&manifest), asset_name)
        .ok_or_else(|| anyhow::anyhow!("{MANIFEST} has no entry for {asset_name}"))?;
    let path = staging.join(asset_name);
    let checked = download_to(http, asset_url, &path, max_asset).await.and_then(|actual| {
        (actual == expected).then_some(()).ok_or_else(|| anyhow::anyhow!("Checksum mismatch for {asset_name}; update refused."))
    });
    if let Err(error) = checked {
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(path)
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
    sibling_executable_path(current, "previous")
}

/// `Magnetar.<tag>.exe` / `magnetar.<tag>` beside the executable `current`.
fn sibling_executable_path(current: &Path, tag: &str) -> PathBuf {
    let name = current.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let sibling = match name.strip_suffix(".exe") {
        Some(stem) => format!("{stem}.{tag}.exe"),
        None => format!("{name}.{tag}"),
    };
    current.with_file_name(sibling)
}

/// The filesystem calls of an executable swap, so a test can fail any one of them.
trait SwapFs {
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn copy(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn make_executable(&self, path: &Path) -> std::io::Result<()>;
    fn remove(&self, path: &Path) -> std::io::Result<()>;
}

struct RealFs;

impl SwapFs for RealFs {
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::rename(from, to)
    }
    fn copy(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::copy(from, to).map(|_| ())
    }
    fn make_executable(&self, _path: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        std::fs::set_permissions(_path, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
        Ok(())
    }
    fn remove(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }
}

/// Windows and Linux: a running executable can be renamed but not overwritten. Install the new one
/// beside it, swap them, start the new one and let it delete the old one on start-up.
fn install_executable(new_path: &Path) -> anyhow::Result<()> {
    swap_executable(&RealFs, &std::env::current_exe()?, new_path, |installed| {
        let mut child = crate::system::hidden_command(installed)
            .env("MAGNETAR_WAIT_FOR_PID", std::process::id().to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        confirm_started(&mut child, STARTED_WITHIN)
    })
}

/// How long a just-started new version must keep running for its start to count. It waits for this process to exit,
/// so it only ends sooner when it cannot run at all (a library the loader can't find, a wrong architecture).
const STARTED_WITHIN: Duration = Duration::from_secs(1);

/// Fails if `child` ends unsuccessfully within `within`. Ending successfully is not a failure: that is a new version
/// that found another Magnetar running and handed over to it.
fn confirm_started(child: &mut std::process::Child, within: Duration) -> std::io::Result<()> {
    let deadline = std::time::Instant::now() + within;
    loop {
        if let Some(status) = child.try_wait()? {
            return if status.success() { Ok(()) } else { Err(std::io::Error::other(format!("it exited at once ({status})"))) };
        }
        if std::time::Instant::now() >= deadline {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Swaps the executable at `current` for `new_path` and starts it, so that launching Magnetar keeps working whatever
/// fails: the new version is first put beside the installed one (on its volume) and made executable while nothing has
/// moved; only then is the installed one moved aside to `.previous` and the new one renamed into its place. If that, or
/// starting the new version, fails, the installed one is put back.
fn swap_executable(
    fs: &dyn SwapFs,
    current: &Path,
    new_path: &Path,
    start: impl FnOnce(&Path) -> std::io::Result<()>,
) -> anyhow::Result<()> {
    let previous = previous_executable_path(current);
    let staged = sibling_executable_path(current, "new");
    let _ = fs.remove(&staged);
    // Staging may be on another volume: copy when a rename can't.
    let staging = fs.rename(new_path, &staged).or_else(|_| fs.copy(new_path, &staged)).and_then(|()| fs.make_executable(&staged));
    if let Err(error) = staging {
        let _ = fs.remove(&staged);
        return Err(anyhow::Error::new(error).context(format!("Could not put the new version beside {}", current.display())));
    }
    let _ = fs.remove(&previous);
    if let Err(error) = fs.rename(current, &previous) {
        let _ = fs.remove(&staged);
        return Err(anyhow::Error::new(error).context(format!("Could not move {} aside", current.display())));
    }
    let installed = fs
        .rename(&staged, current)
        .map_err(|e| anyhow::Error::new(e).context(format!("Could not put the new version at {}", current.display())))
        .and_then(|()| start(current).map_err(|e| anyhow::Error::new(e).context("Could not start the new version")));
    let Err(error) = installed else { return Ok(()) };
    // Put the installed version back: what is at `current` now (if anything) is the new one that did not start.
    let _ = fs.remove(&staged);
    let _ = fs.remove(current);
    if let Err(restore) = fs.rename(&previous, current) {
        return Err(anyhow::anyhow!(
            "{error:#}, and the installed version could not be put back ({restore}): it is at {}, rename it to {}",
            previous.display(),
            current.display()
        ));
    }
    Err(error)
}

/// Removes the executables an update left behind (the old one, a copy a crash left mid-swap), once we are the new one.
fn cleanup_previous_executable() {
    if PLATFORM == "macos" {
        return;
    }
    if let Ok(current) = std::env::current_exe() {
        // Still locked by the exiting process on Windows: the next start tries again.
        let _ = std::fs::remove_file(previous_executable_path(&current));
        let _ = std::fs::remove_file(sibling_executable_path(&current, "new"));
    }
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use std::collections::{BTreeMap, HashMap};
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::protocol::encoding::to_base64url;

    fn release(notes: &str) -> Release {
        Release {
            info: ReleaseDto {
                version: "9.0.0".into(),
                tag: "v9.0.0".into(),
                name: "Magnetar 9.0.0".into(),
                notes: notes.into(),
                published_at: None,
                prerelease: false,
                url: String::new(),
            },
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

    /// The real filesystem, failing the `nth` (from 1) call of each listed `op`.
    struct FailAt {
        failures: Vec<(&'static str, usize)>,
        calls: std::cell::RefCell<HashMap<&'static str, usize>>,
    }

    impl FailAt {
        fn new(failures: &[(&'static str, usize)]) -> Self {
            Self { failures: failures.to_vec(), calls: Default::default() }
        }
        fn check(&self, op: &'static str) -> std::io::Result<()> {
            let mut calls = self.calls.borrow_mut();
            let count = calls.entry(op).or_default();
            *count += 1;
            if self.failures.contains(&(op, *count)) {
                return Err(std::io::Error::other(format!("{op} failed on purpose")));
            }
            Ok(())
        }
    }

    impl SwapFs for FailAt {
        fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            self.check("rename")?;
            RealFs.rename(from, to)
        }
        fn copy(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            self.check("copy")?;
            RealFs.copy(from, to)
        }
        fn make_executable(&self, path: &Path) -> std::io::Result<()> {
            self.check("make_executable")?;
            RealFs.make_executable(path)
        }
        fn remove(&self, path: &Path) -> std::io::Result<()> {
            self.check("remove")?;
            RealFs.remove(path)
        }
    }

    /// An installed `Magnetar` ("old"), a downloaded new version ("new") in another folder, and what the folder holds.
    struct Install {
        _dir: tempfile::TempDir,
        current: PathBuf,
        new: PathBuf,
    }

    impl Install {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(dir.path().join("bin")).unwrap();
            std::fs::create_dir_all(dir.path().join("staging")).unwrap();
            let current = dir.path().join("bin/Magnetar");
            let new = dir.path().join("staging/Magnetar-2.0.0-linux-x64");
            std::fs::write(&current, "old").unwrap();
            std::fs::write(&new, "new").unwrap();
            Self { _dir: dir, current, new }
        }
        /// The installed folder: file name → content.
        fn installed(&self) -> BTreeMap<String, String> {
            std::fs::read_dir(self.current.parent().unwrap())
                .unwrap()
                .map(|entry| {
                    let entry = entry.unwrap();
                    (entry.file_name().to_string_lossy().into_owned(), std::fs::read_to_string(entry.path()).unwrap())
                })
                .collect()
        }
        fn swap(&self, fs: &dyn SwapFs, start_fails: bool) -> (anyhow::Result<()>, Vec<String>) {
            let mut started = Vec::new();
            let result = swap_executable(fs, &self.current, &self.new, |exe| {
                started.push(std::fs::read_to_string(exe).unwrap());
                if start_fails { Err(std::io::Error::other("spawn failed on purpose")) } else { Ok(()) }
            });
            (result, started)
        }
    }

    fn files(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(name, content)| (name.to_string(), content.to_string())).collect()
    }

    #[test]
    fn an_update_puts_the_new_executable_in_place_starts_it_and_keeps_the_old_one_aside() {
        let install = Install::new();
        std::fs::write(install.current.with_file_name("Magnetar.previous"), "older").unwrap();
        let (result, started) = install.swap(&RealFs, false);
        result.unwrap();
        assert_eq!(started, ["new"]);
        assert_eq!(install.installed(), files(&[("Magnetar", "new"), ("Magnetar.previous", "old")]));
        #[cfg(unix)]
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&install.current).unwrap().permissions()) & 0o111,
            0o111
        );
    }

    #[test]
    fn an_update_from_another_volume_is_copied_beside_the_installed_one_and_made_executable() {
        let install = Install::new();
        // The first rename (the download beside the installed one) fails as it does across volumes.
        let (result, started) = install.swap(&FailAt::new(&[("rename", 1)]), false);
        result.unwrap();
        assert_eq!(started, ["new"]);
        assert_eq!(install.installed(), files(&[("Magnetar", "new"), ("Magnetar.previous", "old")]));
        #[cfg(unix)]
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&install.current).unwrap().permissions()) & 0o111,
            0o111
        );
    }

    #[test]
    fn a_failed_update_always_leaves_the_installed_executable_runnable_in_place() {
        // Every step that can fail. Renames, in order: the download beside the installed one (fails across volumes, then
        // it is copied), the installed one aside, the new one in place.
        type Failures = &'static [(&'static str, usize)];
        let cases: [(&str, Failures, bool); 5] = [
            ("the new version cannot be put beside it", &[("rename", 1), ("copy", 1)], false),
            ("the copied new version cannot be made executable", &[("rename", 1), ("make_executable", 1)], false),
            ("moving the running version aside fails", &[("rename", 2)], false),
            ("putting the new version in place fails", &[("rename", 3)], false),
            ("the new version does not start", &[], true),
        ];
        for (what, failures, start_fails) in cases {
            let install = Install::new();
            let (result, _) = install.swap(&FailAt::new(failures), start_fails);
            assert!(result.is_err(), "{what}: reported");
            assert_eq!(install.installed(), files(&[("Magnetar", "old")]), "{what}: the installed folder is as before");
        }
    }

    #[test]
    fn when_even_putting_the_old_version_back_fails_it_is_kept_and_named() {
        let install = Install::new();
        // Starting fails, then the rename that would restore the old version (the fourth) fails too.
        let fs = FailAt::new(&[("rename", 4)]);
        let (result, started) = install.swap(&fs, true);
        let error = format!("{:#}", result.unwrap_err());
        assert_eq!(started, ["new"]);
        assert!(error.starts_with("Could not start the new version"), "the message starts with what failed: {error}");
        assert!(error.contains("rename failed on purpose"), "the message says why the old version stayed aside: {error}");
        assert!(error.contains("Magnetar.previous"), "the message says where the old version is: {error}");
        // The new version that did not start is gone, so nothing half-working is left at the installed path.
        assert_eq!(install.installed(), files(&[("Magnetar.previous", "old")]));
    }

    #[cfg(unix)]
    fn shell(script: &str) -> std::process::Child {
        std::process::Command::new("/bin/sh").args(["-c", script]).spawn().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn a_new_version_that_dies_at_once_is_a_failed_start() {
        let error = confirm_started(&mut shell("exit 127"), Duration::from_secs(5)).unwrap_err();
        assert!(error.to_string().contains("127"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn a_new_version_still_running_or_handing_over_has_started() {
        let mut waiting = shell("sleep 5");
        let begun = std::time::Instant::now();
        confirm_started(&mut waiting, Duration::from_millis(200)).unwrap();
        assert!(begun.elapsed() < Duration::from_secs(2), "returns once the window is over, not when the process ends");
        let _ = waiting.kill();
        let _ = waiting.wait();
        confirm_started(&mut shell("exit 0"), Duration::from_secs(5)).unwrap();
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

    type Files = Arc<HashMap<String, Vec<u8>>>;
    type Asked = Arc<Mutex<Vec<String>>>;

    /// A release server of the test's own: its files by path, and the paths asked for.
    struct Server {
        url: String,
        asked: Arc<Mutex<Vec<String>>>,
    }

    async fn server(files: Vec<(&'static str, Vec<u8>)>) -> Server {
        use axum::extract::{Path as UrlPath, State};
        use axum::response::IntoResponse;
        let asked = Arc::new(Mutex::new(Vec::new()));
        let files: Files = Arc::new(files.into_iter().map(|(n, b)| (n.to_owned(), b)).collect());
        let router = axum::Router::new()
            .route(
                "/{name}",
                axum::routing::get(|State((files, asked)): State<(Files, Asked)>, UrlPath(name): UrlPath<String>| async move {
                    asked.lock().unwrap().push(name.clone());
                    match files.get(&name) {
                        // `stream`: sent in pieces, without saying its length first.
                        Some(body) if name == "stream" => {
                            let pieces: Vec<Result<Vec<u8>, std::io::Error>> =
                                body.chunks(1000).map(|c| Ok(c.to_vec())).collect();
                            axum::body::Body::from_stream(futures::stream::iter(pieces)).into_response()
                        }
                        Some(body) => body.clone().into_response(),
                        None => axum::http::StatusCode::NOT_FOUND.into_response(),
                    }
                }),
            )
            .with_state((files, asked.clone()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Server { url, asked }
    }

    const ASSET: &str = "Magnetar-9.0.0-linux-x64";

    /// A signed release of `asset` whose manifest lists `listed` (its name, its content).
    async fn signed_release(name: &str, asset: &[u8], listed: (&str, &[u8]), key: [u8; 32]) -> (Release, Server, String) {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let digest: String = Sha256::digest(listed.1).iter().map(|b| format!("{b:02x}")).collect();
        let manifest = format!("{digest}  {}\n", listed.0).into_bytes();
        let signature = to_base64url(&SigningKey::from_bytes(&key).sign(&manifest).to_bytes()).into_bytes();
        let server = server(vec![("asset", asset.to_vec()), ("manifest", manifest), ("signature", signature)]).await;
        let mut release = release("");
        release.asset_name = Some(name.to_owned());
        release.asset_url = Some(format!("{}/asset", server.url));
        release.manifest_url = Some(format!("{}/manifest", server.url));
        release.signature_url = Some(format!("{}/signature", server.url));
        (release, server, to_base64url(signing.verifying_key().as_bytes()))
    }

    fn staged(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()
    }

    #[tokio::test]
    async fn an_update_is_downloaded_only_once_its_signed_manifest_checks_out() {
        let http = reqwest::Client::new();
        let staging = tempfile::tempdir().unwrap();

        let (good, _, key) = signed_release(ASSET, b"new version", (ASSET, b"new version"), [7; 32]).await;
        let path = fetch_verified(&http, &good, staging.path(), &key, 1024).await.unwrap();
        assert_eq!((path.clone(), std::fs::read(&path).unwrap()), (staging.path().join(ASSET), b"new version".to_vec()));
        std::fs::remove_file(path).unwrap();

        // Signed with another key: refused before the asset is even asked for.
        let (forged, server, key) = signed_release(ASSET, b"evil", (ASSET, b"evil"), [8; 32]).await;
        let error = fetch_verified(&http, &forged, staging.path(), &key, 1024).await.unwrap_err();
        assert!(error.to_string().contains("signature does not match"), "{error}");
        assert_eq!(*server.asked.lock().unwrap(), ["manifest", "signature"]);

        // Signed, but the file is not the one listed: nothing is left behind.
        let (swapped, _, key) = signed_release(ASSET, b"evil", (ASSET, b"new version"), [7; 32]).await;
        let error = fetch_verified(&http, &swapped, staging.path(), &key, 1024).await.unwrap_err();
        assert!(error.to_string().contains("Checksum mismatch"), "{error}");
        // Listed under another name.
        let (other, _, key) =
            signed_release(ASSET, b"new version", ("Magnetar-9.0.0-linux-arm64", b"new version"), [7; 32]).await;
        assert!(fetch_verified(&http, &other, staging.path(), &key, 1024).await.is_err());
        // Unsigned.
        let mut unsigned = good.clone();
        unsigned.signature_url = None;
        assert!(
            fetch_verified(&http, &unsigned, staging.path(), &key, 1024).await.unwrap_err().to_string().contains("not signed")
        );
        assert_eq!(staged(staging.path()), Vec::<String>::new());
    }

    #[tokio::test]
    async fn an_update_larger_than_any_release_is_cut_off_and_removed() {
        let http = reqwest::Client::new();
        let staging = tempfile::tempdir().unwrap();
        let big = vec![b'x'; 4096];
        let (release, _, key) = signed_release(ASSET, &big, (ASSET, &big), [7; 32]).await;
        assert!(fetch_verified(&http, &release, staging.path(), &key, 4096).await.is_ok());
        std::fs::remove_file(staging.path().join(ASSET)).unwrap();
        let error = fetch_verified(&http, &release, staging.path(), &key, 4095).await.unwrap_err();
        assert!(error.to_string().contains("larger than any release"), "{error}");
        assert_eq!(staged(staging.path()), Vec::<String>::new());
        // Without a length up front, it is cut off as it arrives.
        let streamed = server(vec![("stream", big.clone())]).await;
        let path = staging.path().join(ASSET);
        let url = format!("{}/stream", streamed.url);
        assert_eq!(download_to(&http, &url, &path, 4096).await.unwrap().len(), 64);
        assert!(download_to(&http, &url, &path, 4095).await.unwrap_err().to_string().contains("larger than any release"));

        // A manifest past what one could be is not read in whole.
        let server = server(vec![("manifest", vec![b'a'; MAX_MANIFEST as usize + 1])]).await;
        assert!(download_small(&http, &format!("{}/manifest", server.url), MAX_MANIFEST).await.is_err());
    }

    #[tokio::test]
    async fn a_release_naming_its_file_as_a_path_is_refused_before_anything_is_downloaded() {
        let http = reqwest::Client::new();
        let parent = tempfile::tempdir().unwrap();
        let staging = parent.path().join("staging");
        std::fs::create_dir(&staging).unwrap();
        for name in [
            "../Magnetar-9.0.0-linux-x64",
            "/tmp/Magnetar-linux-x64",
            "C:\\Windows\\Magnetar-windows-x64.exe",
            "C:Magnetar.exe",
            "a/b",
            "a\\b",
            "..",
            ".",
            "",
            "Magnetar\0.exe",
        ] {
            let (release, server, key) = signed_release(name, b"new", (name, b"new"), [7; 32]).await;
            let error = fetch_verified(&http, &release, &staging, &key, 1024).await.unwrap_err();
            assert!(error.to_string().contains("update refused"), "{name}: {error}");
            assert!(server.asked.lock().unwrap().is_empty(), "{name}: nothing downloaded");
        }
        assert_eq!(staged(parent.path()), ["staging"]);
        assert_eq!(staged(&staging), Vec::<String>::new());
    }

    proptest::proptest! {
        #[test]
        fn a_plain_file_name_stays_in_its_folder(name in "\\PC{0,40}") {
            if let Some(name) = plain_file_name(&name) {
                let joined = Path::new("staging").join(name);
                proptest::prop_assert_eq!(joined.parent(), Some(Path::new("staging")));
                proptest::prop_assert_eq!(joined.file_name().and_then(|n| n.to_str()), Some(name));
            }
        }
    }

    #[test]
    fn release_file_names_are_plain() {
        for name in ["Magnetar-1.2.0-macos-arm64.zip", "Magnetar-1.2.0-rc.1+build.5-windows-x64.exe", "Magnetar-1.2.0-linux-x64"]
        {
            assert_eq!(plain_file_name(name), Some(name));
        }
    }
}
