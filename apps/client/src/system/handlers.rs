//! Magnetar as the system's app for magnet links and .torrent files. Clicking one opens the
//! dashboard with the add dialog filled in, so the user sees what is being added and where it goes
//! before anything starts.
//!
//! macOS declares both in the app's Info.plist and asks Launch Services to make it the default;
//! Windows registers per-user classes; Linux installs a desktop entry and sets it with xdg-mime.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{ApiError, ApiResult};
use crate::protocol::encoding::encode_uri_component;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HandlerStatus {
    /// Not from the installed app (a development build, or the bare macOS executable).
    Unavailable,
    Default,
    NotDefault,
}

/// What the app was asked to open: a magnet link, or a .torrent file.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenTarget {
    Magnet(String),
    TorrentFile(PathBuf),
}

impl OpenTarget {
    /// A command-line argument, or a URL macOS hands over.
    pub fn parse(argument: &str) -> Option<Self> {
        if argument.len() > 64 * 1024 {
            return None;
        }
        if argument.get(..8).is_some_and(|scheme| scheme.eq_ignore_ascii_case("magnet:?")) {
            return Some(Self::Magnet(argument.to_owned()));
        }
        let path = match url::Url::parse(argument) {
            Ok(url) if url.scheme() == "file" => url.to_file_path().ok()?,
            _ => PathBuf::from(argument),
        };
        let is_torrent = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("torrent"));
        (is_torrent && path.is_file()).then_some(Self::TorrentFile(path))
    }

    /// The first thing worth opening among the process's arguments.
    pub fn from_args(args: impl IntoIterator<Item = String>) -> Option<Self> {
        args.into_iter().skip(1).find_map(|a| Self::parse(&a))
    }

    /// The dashboard, opened on the add dialog for this.
    pub fn dashboard_link(&self, dashboard_url: &str) -> String {
        match self {
            Self::Magnet(magnet) => format!("{dashboard_url}/?add={}", encode_uri_component(magnet)),
            Self::TorrentFile(path) => format!("{dashboard_url}/?torrent={}", encode_uri_component(&path.to_string_lossy())),
        }
    }
}

const BUNDLE_ID: &str = "cc.codefusion.magnetar";

pub fn status() -> HandlerStatus {
    platform::status()
}

/// Makes the app the default for magnet links and .torrent files. macOS asks the user to confirm.
pub fn register() -> ApiResult<HandlerStatus> {
    if status() == HandlerStatus::Unavailable {
        return Err(ApiError::bad("Open the installed app to change which app opens magnet links."));
    }
    platform::register()?;
    Ok(status())
}

#[cfg(not(target_os = "macos"))]
fn installed_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = exe.file_name()?.to_string_lossy().to_lowercase();
    (name.starts_with("magnetar") && !cfg!(debug_assertions)).then_some(exe)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{CString, c_char, c_void};

    use super::{BUNDLE_ID, HandlerStatus};
    use crate::error::{ApiError, ApiResult};

    type CFStringRef = *const c_void;
    const UTF8: u32 = 0x0800_0100;
    const ROLE_ALL: u32 = 0xFFFF_FFFF;
    const TORRENT_TYPE: &str = "org.bittorrent.torrent";

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(allocator: *const c_void, text: *const c_char, encoding: u32) -> CFStringRef;
        fn CFStringGetCString(text: CFStringRef, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
        fn CFRelease(value: *const c_void);
    }

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSCopyDefaultHandlerForURLScheme(scheme: CFStringRef) -> CFStringRef;
        fn LSSetDefaultHandlerForURLScheme(scheme: CFStringRef, bundle: CFStringRef) -> i32;
        fn LSSetDefaultRoleHandlerForContentType(content_type: CFStringRef, role: u32, bundle: CFStringRef) -> i32;
    }

    /// A CFString that is released when dropped.
    struct CfString(CFStringRef);

    impl CfString {
        fn new(text: &str) -> Self {
            let text = CString::new(text).expect("no NUL");
            // SAFETY: a valid C string; the result is owned and released in Drop.
            Self(unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) })
        }
    }

    impl Drop for CfString {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: created by a CF "Create"/"Copy" call, released once.
                unsafe { CFRelease(self.0) }
            }
        }
    }

    fn default_for_magnet() -> Option<String> {
        let scheme = CfString::new("magnet");
        // SAFETY: a valid CFString; the result follows the Copy rule and is released by CfString.
        let handler = CfString(unsafe { LSCopyDefaultHandlerForURLScheme(scheme.0) });
        if handler.0.is_null() {
            return None;
        }
        let mut buffer = [0 as c_char; 256];
        // SAFETY: the buffer outlives the call and its size is passed.
        let ok = unsafe { CFStringGetCString(handler.0, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) };
        // SAFETY: CFStringGetCString NUL-terminated the buffer on success.
        (ok != 0).then(|| unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }.to_string_lossy().into_owned())
    }

    pub fn status() -> HandlerStatus {
        if crate::paths::mac_app_bundle().is_none() {
            return HandlerStatus::Unavailable;
        }
        match default_for_magnet() {
            Some(bundle) if bundle.eq_ignore_ascii_case(BUNDLE_ID) => HandlerStatus::Default,
            _ => HandlerStatus::NotDefault,
        }
    }

    pub fn register() -> ApiResult<()> {
        let bundle = CfString::new(BUNDLE_ID);
        // SAFETY: valid CFStrings for the duration of the calls.
        let url = unsafe { LSSetDefaultHandlerForURLScheme(CfString::new("magnet").0, bundle.0) };
        // SAFETY: as above.
        let _ = unsafe { LSSetDefaultRoleHandlerForContentType(CfString::new(TORRENT_TYPE).0, ROLE_ALL, bundle.0) };
        if url != 0 {
            return Err(ApiError::bad(format!("macOS did not change the app for magnet links (error {url}).")));
        }
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use super::{HandlerStatus, installed_exe};
    use crate::error::{ApiError, ApiResult};

    const CLASSES: &str = r"HKCU\Software\Classes";

    fn reg(args: &[&str]) -> Result<String, String> {
        crate::system::run_captured("reg", args)
    }

    fn command(exe: &std::path::Path) -> String {
        format!("\"{}\" \"%1\"", exe.display())
    }

    pub fn status() -> HandlerStatus {
        let Some(exe) = installed_exe() else { return HandlerStatus::Unavailable };
        match reg(&["query", &format!(r"{CLASSES}\magnet\shell\open\command"), "/ve"]) {
            Ok(out) if out.to_lowercase().contains(&exe.display().to_string().to_lowercase()) => HandlerStatus::Default,
            _ => HandlerStatus::NotDefault,
        }
    }

    pub fn register() -> ApiResult<()> {
        let exe = installed_exe().expect("checked by status");
        let open = command(&exe);
        let icon = format!("\"{}\",0", exe.display());
        let magnet = format!(r"{CLASSES}\magnet");
        let torrent = format!(r"{CLASSES}\Magnetar.torrent");
        let steps: Vec<Vec<String>> = vec![
            vec![magnet.clone(), "/ve".into(), "/d".into(), "URL:Magnet link".into()],
            vec![magnet.clone(), "/v".into(), "URL Protocol".into(), "/d".into(), String::new()],
            vec![format!(r"{magnet}\DefaultIcon"), "/ve".into(), "/d".into(), icon.clone()],
            vec![format!(r"{magnet}\shell\open\command"), "/ve".into(), "/d".into(), open.clone()],
            vec![torrent.clone(), "/ve".into(), "/d".into(), "Torrent file".into()],
            vec![format!(r"{torrent}\DefaultIcon"), "/ve".into(), "/d".into(), icon],
            vec![format!(r"{torrent}\shell\open\command"), "/ve".into(), "/d".into(), open],
            vec![format!(r"{CLASSES}\.torrent"), "/ve".into(), "/d".into(), "Magnetar.torrent".into()],
        ];
        for step in steps {
            let args: Vec<&str> =
                std::iter::once("add").chain(step.iter().map(String::as_str)).chain(std::iter::once("/f")).collect();
            reg(&args).map_err(|e| ApiError::bad(format!("Could not register for magnet links: {e}")))?;
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::{HandlerStatus, installed_exe};
    use crate::error::{ApiError, ApiResult};
    use crate::system::hidden_command;

    const DESKTOP_FILE: &str = "magnetar.desktop";
    const TYPES: [&str; 2] = ["x-scheme-handler/magnet", "application/x-bittorrent"];

    fn applications() -> std::path::PathBuf {
        crate::paths::xdg_data_home().join("applications")
    }

    pub fn status() -> HandlerStatus {
        if installed_exe().is_none() {
            return HandlerStatus::Unavailable;
        }
        match hidden_command("xdg-mime").args(["query", "default", TYPES[0]]).output() {
            Ok(out) if String::from_utf8_lossy(&out.stdout).trim() == DESKTOP_FILE => HandlerStatus::Default,
            Ok(_) => HandlerStatus::NotDefault,
            Err(_) => HandlerStatus::Unavailable,
        }
    }

    pub fn register() -> ApiResult<()> {
        let exe = installed_exe().expect("checked by status");
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName=Magnetar\nExec={} %u\nTerminal=false\nNoDisplay=true\nMimeType={};\n",
            super::exec_argument(&exe.display().to_string()),
            TYPES.join(";")
        );
        let folder = applications();
        std::fs::create_dir_all(&folder)?;
        std::fs::write(folder.join(DESKTOP_FILE), entry)?;
        for mime in TYPES {
            let done = hidden_command("xdg-mime").args(["default", DESKTOP_FILE, mime]).status();
            if !done.is_ok_and(|s| s.success()) {
                return Err(ApiError::bad("Could not set the default with xdg-mime. Is xdg-utils installed?"));
            }
        }
        let _ = hidden_command("update-desktop-database").arg(&folder).status();
        Ok(())
    }
}

/// A path as one quoted argument of a desktop entry's Exec key. Inside the quotes `"` `` ` `` `$`
/// and `\` are escaped; the string rule, applied before quoting, then doubles every backslash; and
/// `%` is doubled so it isn't read as a field code.
#[cfg(any(target_os = "linux", test))]
fn exec_argument(path: &str) -> String {
    let quoted: String =
        path.chars().flat_map(|c| if matches!(c, '"' | '`' | '$' | '\\') { vec!['\\', c] } else { vec![c] }).collect();
    format!("\"{}\"", quoted.replace('\\', "\\\\").replace('%', "%%"))
}

/// A .torrent file the dashboard on this computer asked to add, read with the size limit applied.
pub fn read_torrent_file(path: &Path) -> ApiResult<Vec<u8>> {
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("torrent")) {
        return Err(ApiError::bad("Only .torrent files can be added this way."));
    }
    let metadata = std::fs::metadata(path).map_err(|e| ApiError::bad(format!("Could not read {}: {e}", path.display())))?;
    if metadata.len() > crate::downloads::manager::MAX_TORRENT_FILE as u64 {
        return Err(crate::downloads::manager::torrent_too_large());
    }
    Ok(std::fs::read(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_desktop_entry_launches_the_app_from_any_path() {
        // The spec's own forms: a literal `$` is `\\$` and a literal backslash four of them.
        assert_eq!(exec_argument("/usr/bin/magnetar"), r#""/usr/bin/magnetar""#);
        assert_eq!(exec_argument(r#"/opt/My Apps/50%/a"b$c\d`e"#), r#""/opt/My Apps/50%%/a\\"b\\$c\\\\d\\`e""#);
    }

    #[test]
    fn launch_arguments_become_what_to_open() {
        let magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=A+B";
        assert_eq!(OpenTarget::parse(magnet), Some(OpenTarget::Magnet(magnet.into())));
        assert_eq!(OpenTarget::parse("MAGNET:?xt=urn:btih:x"), Some(OpenTarget::Magnet("MAGNET:?xt=urn:btih:x".into())));
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Show S01.torrent");
        std::fs::write(&file, b"d4:infode").unwrap();
        assert_eq!(OpenTarget::parse(&file.to_string_lossy()), Some(OpenTarget::TorrentFile(file.clone())));
        let url = url::Url::from_file_path(&file).unwrap().to_string();
        assert_eq!(OpenTarget::parse(&url), Some(OpenTarget::TorrentFile(file.clone())), "macOS hands over file URLs");
        for nothing in
            ["", "--flag", "https://example.com/a.torrent", "magnet:", "/no/such/file.torrent", &dir.path().to_string_lossy()]
        {
            assert_eq!(OpenTarget::parse(nothing), None, "{nothing}");
        }
        let args = ["/Applications/x".to_owned(), "-psn_0_1".to_owned(), magnet.to_owned()];
        assert_eq!(OpenTarget::from_args(args), Some(OpenTarget::Magnet(magnet.into())), "the program name is skipped");
    }

    #[test]
    fn links_open_the_add_dialog_with_everything_escaped() {
        let link =
            OpenTarget::Magnet("magnet:?xt=urn:btih:ab&dn=A B&tr=udp://t:1".into()).dashboard_link("http://localhost:47820");
        assert_eq!(link, "http://localhost:47820/?add=magnet%3A%3Fxt%3Durn%3Abtih%3Aab%26dn%3DA%20B%26tr%3Dudp%3A%2F%2Ft%3A1");
        let file = OpenTarget::TorrentFile(PathBuf::from("/tmp/a&b #1.torrent")).dashboard_link("http://localhost:47820");
        assert_eq!(file, "http://localhost:47820/?torrent=%2Ftmp%2Fa%26b%20%231.torrent");
    }

    #[test]
    fn only_small_torrent_files_are_read() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_torrent_file(&dir.path().join("x.txt")).is_err());
        assert!(read_torrent_file(&dir.path().join("missing.torrent")).is_err());
        let big = dir.path().join("big.torrent");
        std::fs::write(&big, vec![0u8; crate::downloads::manager::MAX_TORRENT_FILE + 1]).unwrap();
        assert!(read_torrent_file(&big).is_err());
        let small = dir.path().join("ok.TORRENT");
        std::fs::write(&small, b"d4:infode").unwrap();
        assert_eq!(read_torrent_file(&small).unwrap(), b"d4:infode");
    }
}
