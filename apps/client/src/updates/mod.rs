//! Checks GitHub Releases every 6 hours, notifies once per new version, and installs in place: the
//! macOS .app bundle is swapped by a helper after this process exits (with rollback), the
//! Windows/Linux executable is renamed aside and replaced. Every install needs the manifest
//! signature to verify against the key built into this binary, so a swapped asset *and* manifest
//! are still refused.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use ed25519_dalek::{Signature, VerifyingKey};
use futures::future::BoxFuture;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::config::{ARCH, GITHUB_REPO, IS_DEV, PLATFORM, RELEASE_PUBLIC_KEY, VERSION};
use crate::downloads::DownloadManager;
use crate::events::EventBus;
use crate::notifications::NotificationDispatcher;
use crate::paths::mac_app_bundle;
use crate::protocol::encoding::{from_base64url, now_iso, random_id};
use crate::protocol::{AvailableUpdateDto, UpdateStatusDto};

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);
const FIRST_CHECK: Duration = Duration::from_secs(60);
const MANIFEST: &str = "SHA256SUMS.txt";
const SIGNATURE: &str = "SHA256SUMS.txt.sig";
const MAC_INSTALL_SCRIPT: &str = include_str!("mac-install.sh");

#[derive(Clone)]
struct Release {
    version: String,
    tag: String,
    release_url: String,
    asset_name: Option<String>,
    asset_url: Option<String>,
    manifest_url: Option<String>,
    signature_url: Option<String>,
}

#[derive(Default)]
struct State {
    available: Option<Release>,
    checking: bool,
    installing: bool,
    last_checked_at: Option<String>,
    last_check_error: Option<String>,
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

pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches(['v', 'V'])
            .split(['.', '-'])
            .take(3)
            .map(|n| n.chars().take_while(char::is_ascii_digit).collect::<String>().parse().unwrap_or(0))
            .collect()
    };
    let (x, y) = (parse(a), parse(b));
    (0..3).map(|i| x.get(i).unwrap_or(&0).cmp(y.get(i).unwrap_or(&0))).find(|o| o.is_ne()).unwrap_or(std::cmp::Ordering::Equal)
}

/// Reads one `<sha256>  <file>` line of a sha256sum manifest.
pub fn find_checksum(manifest: &str, asset: &str) -> Option<String> {
    manifest.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let (hash, name) = (parts.next()?, parts.next()?);
        (name.trim_start_matches('*') == asset).then(|| hash.to_lowercase())
    })
}

pub struct UpdateService {
    events: EventBus,
    notifications: Arc<NotificationDispatcher>,
    downloads: Arc<DownloadManager>,
    http: reqwest::Client,
    state: Mutex<State>,
    cancel: CancellationToken,
    /// Stops the app cleanly before an install replaces it; set by main.
    pub on_quit: OnceLock<QuitHook>,
}

impl UpdateService {
    pub fn new(
        events: EventBus,
        notifications: Arc<NotificationDispatcher>,
        downloads: Arc<DownloadManager>,
        http: reqwest::Client,
    ) -> Self {
        Self {
            events,
            notifications,
            downloads,
            http,
            state: Mutex::default(),
            cancel: CancellationToken::new(),
            on_quit: OnceLock::new(),
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
                service.check().await;
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
            available: state.available.as_ref().map(|r| AvailableUpdateDto {
                version: r.version.clone(),
                tag: r.tag.clone(),
                release_url: r.release_url.clone(),
            }),
            can_self_install: self.can_self_install(state.available.as_ref()),
            checking: state.checking,
            installing: state.installing,
            last_checked_at: state.last_checked_at.clone(),
            last_check_error: state.last_check_error.clone(),
        }
    }

    fn changed(&self) {
        self.events.emit("updates.changed", self.status());
    }

    pub async fn check(&self) -> UpdateStatusDto {
        {
            let mut state = self.state();
            if state.checking {
                drop(state);
                return self.status();
            }
            state.checking = true;
        }
        self.changed();
        let outcome = self.fetch_latest().await;
        {
            let mut state = self.state();
            state.checking = false;
            state.last_checked_at = Some(now_iso());
            state.last_check_error = outcome.as_ref().err().map(|e| format!("{e:#}"));
        }
        if let Err(error) = outcome {
            tracing::warn!("Update check failed: {error:#}");
        }
        self.changed();
        self.status()
    }

    async fn fetch_latest(&self) -> anyhow::Result<()> {
        #[derive(Deserialize)]
        struct Asset {
            name: String,
            browser_download_url: String,
        }
        #[derive(Deserialize)]
        struct GithubRelease {
            tag_name: String,
            html_url: String,
            assets: Vec<Asset>,
        }
        let response = self
            .http
            .get(format!("https://api.github.com/repos/{}/releases/latest", *GITHUB_REPO))
            .header("user-agent", "Magnetar")
            .header("accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        anyhow::ensure!(response.status().is_success(), "GitHub answered HTTP {}", response.status().as_u16());
        let release: GithubRelease = response.json().await?;
        let version = release.tag_name.trim_start_matches(['v', 'V']).to_owned();
        let looks_like_version = version.split('.').take(3).filter(|p| p.starts_with(|c: char| c.is_ascii_digit())).count() == 3;
        if !looks_like_version || compare_versions(&version, VERSION).is_le() {
            self.state().available = None;
            return Ok(());
        }
        let url_of = |name: &str| release.assets.iter().find(|a| a.name == name).map(|a| a.browser_download_url.clone());
        let asset = release.assets.iter().find(|a| a.name.ends_with(&asset_suffix()));
        let available = Release {
            version: version.clone(),
            tag: release.tag_name.clone(),
            release_url: release.html_url.clone(),
            asset_name: asset.map(|a| a.name.clone()),
            asset_url: asset.map(|a| a.browser_download_url.clone()),
            manifest_url: url_of(MANIFEST),
            signature_url: url_of(SIGNATURE),
        };
        tracing::info!("Update available: {} (running {VERSION})", release.tag_name);
        let first_notice = {
            let mut state = self.state();
            state.available = Some(available);
            state.notified_version.replace(version.clone()).as_deref() != Some(version.as_str())
        };
        if first_notice {
            self.notifications.notify(
                "update",
                format!("Magnetar {} is available", release.tag_name),
                format!(
                    "You are running {VERSION}. Install it from Settings or the menu-bar icon, or download it from {}",
                    release.html_url
                ),
            );
        }
        Ok(())
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
        let response = self.http.get(url).header("user-agent", "Magnetar").timeout(timeout).send().await?;
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
    use std::cmp::Ordering;

    use ed25519_dalek::{Signer, SigningKey};

    use super::*;
    use crate::protocol::encoding::to_base64url;

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(compare_versions("2.10.0", "2.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("v2.0.1", "2.0.1-dev"), Ordering::Equal);
        assert_eq!(compare_versions("1.0.7", "2.0.0"), Ordering::Less);
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
