//! Starts the app when the user signs in: a per-user LaunchAgent that `open`s the installed .app
//! bundle on macOS, the per-user Run key on Windows. Development runs and other platforms report
//! `unavailable`.

#[cfg(any(target_os = "macos", windows))]
use super::run_captured;
use crate::error::{ApiError, ApiResult};
use crate::protocol::LoginStartupStatus;

#[cfg(target_os = "macos")]
const MAC_LABEL: &str = "cc.codefusion.magnetar.start-at-login";
#[cfg(windows)]
const WINDOWS_VALUE: &str = "Magnetar";
#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(target_os = "macos")]
fn plist() -> std::path::PathBuf {
    crate::paths::home_dir().join(format!("Library/LaunchAgents/{MAC_LABEL}.plist"))
}

#[cfg(target_os = "macos")]
fn gui_domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}

pub fn status() -> LoginStartupStatus {
    #[cfg(target_os = "macos")]
    {
        if crate::paths::mac_app_bundle().is_none() {
            return LoginStartupStatus::Unavailable;
        }
        if !plist().exists() {
            return LoginStartupStatus::Disabled;
        }
        let overrides = run_captured("/bin/launchctl", &["print-disabled", &gui_domain()]).unwrap_or_default();
        let disabled = overrides
            .lines()
            .any(|line| line.contains(&format!("\"{MAC_LABEL}\"")) && (line.contains("=> true") || line.contains("=> disabled")));
        if disabled { LoginStartupStatus::RequiresApproval } else { LoginStartupStatus::Enabled }
    }
    #[cfg(windows)]
    {
        let installed = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
        if !installed.is_some_and(|name| name.starts_with("magnetar") && name.ends_with(".exe")) {
            return LoginStartupStatus::Unavailable;
        }
        let exists = run_captured("reg", &["query", RUN_KEY, "/v", WINDOWS_VALUE]).is_ok();
        if exists { LoginStartupStatus::Enabled } else { LoginStartupStatus::Disabled }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    LoginStartupStatus::Unavailable
}

pub fn set(enabled: bool) -> ApiResult<LoginStartupStatus> {
    if status() == LoginStartupStatus::Unavailable {
        return Err(ApiError::bad("Open the installed app to change login startup."));
    }
    #[cfg(target_os = "macos")]
    set_mac(enabled)?;
    #[cfg(windows)]
    set_windows(enabled)?;
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = enabled;
    Ok(status())
}

#[cfg(target_os = "macos")]
fn set_mac(enabled: bool) -> ApiResult<()> {
    let plist_path = plist();
    if !enabled {
        // Keeps a recoverable copy; the one-shot `open` agent never owns the running app.
        if plist_path.exists() {
            std::fs::rename(&plist_path, plist_path.with_extension("plist.disabled"))?;
        }
        return Ok(());
    }
    let bundle = crate::paths::mac_app_bundle().expect("checked by status");
    let xml = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let contents = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/open</string><string>-g</string><string>{}</string></array>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
"#,
        xml(&bundle.to_string_lossy())
    );
    if let Some(parent) = plist_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = plist_path.with_extension(format!("{}.tmp", std::process::id()));
    crate::db::write_private(&temporary, contents.as_bytes(), false)?;
    let _ = run_captured("/bin/launchctl", &["enable", &format!("{}/{MAC_LABEL}", gui_domain())]);
    std::fs::rename(&temporary, &plist_path)?;
    Ok(())
}

#[cfg(windows)]
fn set_windows(enabled: bool) -> ApiResult<()> {
    let exe = std::env::current_exe()?;
    let quoted = format!("\"{}\"", exe.display());
    let done = if enabled {
        run_captured("reg", &["add", RUN_KEY, "/v", WINDOWS_VALUE, "/t", "REG_SZ", "/d", &quoted, "/f"])
    } else {
        run_captured("reg", &["delete", RUN_KEY, "/v", WINDOWS_VALUE, "/f"])
    };
    match done {
        Err(message) if enabled => {
            Err(ApiError::bad(if message.is_empty() { "Could not update the Run key.".to_owned() } else { message }))
        }
        _ => Ok(()),
    }
}
