//! The dashboard's file browser: which folders of the device it may see, and reading them.
//!
//! Only what lies inside a root is ever read: the download folder, and the folders the owner added on the device
//! itself (`fs.addRoot`, which the relay never reaches). A requested path is matched to a root by its words alone:
//! no `..`, no name starting with a dot, no Windows device, verbatim or stream spellings. The folder is then opened
//! from a handle on the root with cap-std, which follows a link only while it stays inside the root, so a link out of
//! it, even one swapped in after the check, is refused while opening rather than by a check made beforehand.
//!
//! Browsing only reads: names, kinds, sizes and dates. Creating a folder is the one change, and only inside a root.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::{Component, MAIN_SEPARATOR_STR, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use cap_std::ambient_authority;
use cap_std::fs::Dir;

use crate::downloads::DownloadManager;
use crate::downloads::manager::media_kind;
use crate::downloads::transfer::free_space;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::protocol::{FolderEntryDto, FolderEntryKind, FolderPageDto, FolderRootDto, FolderRootKind, FolderRootsDto};
use crate::settings::{AppSettings, SettingsService};

/// Entries one page holds at most, and when the dashboard doesn't say.
pub const MAX_PAGE: usize = 200;
pub const DEFAULT_PAGE: usize = 100;
/// Entries read from one folder at most: sorting needs all of them, and a folder can hold millions.
pub const MAX_ENTRIES: usize = 50_000;
/// Folders that can be added besides the download folder.
pub const MAX_ADDED: usize = 32;
/// A path longer than any file system takes is refused before it is looked at.
const MAX_PATH_BYTES: usize = 32 * 1024;
/// The longest name file systems take (bytes on Linux and macOS, UTF-16 units on Windows; bytes is the stricter).
const MAX_NAME_BYTES: usize = 255;
/// A folder on a disk that sleeps, or a network share that went away, can keep a read waiting for minutes.
const DISK_TIMEOUT: Duration = Duration::from_secs(20);

/// A folder the dashboard may browse, everything below it included.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Root {
    pub path: PathBuf,
    pub kind: FolderRootKind,
}

/// The download folder and the added folders, as saved.
pub fn root_texts(settings: &AppSettings) -> Vec<&str> {
    std::iter::once(settings.download_folder.as_str()).chain(settings.browse_folders.iter().map(String::as_str)).collect()
}

/// The roots: the download folder first, then the added ones; each once, and only absolute ones.
pub fn roots(settings: &AppSettings) -> Vec<Root> {
    let mut roots: Vec<Root> = Vec::new();
    for (index, text) in root_texts(settings).into_iter().enumerate() {
        let kind = if index == 0 { FolderRootKind::Downloads } else { FolderRootKind::Added };
        if let Some(path) = normalize(text)
            && !roots.iter().any(|r| r.path == path)
        {
            roots.push(Root { path, kind });
        }
    }
    roots
}

/// An absolute path in plain words: `.` dropped, `..` taken back, a trailing separator gone, and on Windows the
/// verbatim spelling (`\\?\C:\…`) written as people do (`C:\…`). None for a relative or empty path.
pub fn normalize(text: &str) -> Option<PathBuf> {
    let text = without_verbatim(text.trim());
    let path = Path::new(text.as_ref());
    if text.is_empty() || text.contains('\0') || !path.is_absolute() {
        return None;
    }
    let mut plain = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => plain.push(component),
            Component::CurDir => {}
            Component::ParentDir => {
                plain.pop();
            }
            Component::Normal(name) => plain.push(name),
        }
    }
    Some(plain)
}

#[cfg(windows)]
fn without_verbatim(text: &str) -> std::borrow::Cow<'_, str> {
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{share}").into();
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.into(),
        _ => text.into(),
    }
}

#[cfg(not(windows))]
fn without_verbatim(text: &str) -> std::borrow::Cow<'_, str> {
    text.into()
}

/// How the device writes a path for the dashboard.
pub fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn outside() -> ApiError {
    ApiError::new(
        ErrorCode::Forbidden,
        "That folder can't be browsed. Files shows the download folder and the folders added on the computer running Magnetar.",
    )
}

/// The root `requested` is in, the outermost when roots nest (so the breadcrumb starts there), and the names that
/// lead from it to `requested`. Refused, the same way whether or not it exists, unless it is an absolute path in
/// plain words below a root, each name one the browser shows (`browsable`).
pub fn locate<'r>(roots: &'r [Root], requested: &str) -> ApiResult<(&'r Root, PathBuf)> {
    let path = Path::new(requested);
    if requested.is_empty() || requested.len() > MAX_PATH_BYTES || requested.contains('\0') || !path.is_absolute() {
        return Err(outside());
    }
    if let Some(Component::Prefix(prefix)) = path.components().next()
        && !matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::UNC(..))
    {
        return Err(outside());
    }
    roots
        .iter()
        .filter_map(|root| {
            let relative = path.strip_prefix(&root.path).ok()?;
            relative.components().all(|c| matches!(c, Component::Normal(name) if browsable(name))).then_some((root, relative))
        })
        .min_by_key(|(root, _)| root.path.components().count())
        .map(|(root, relative)| (root, relative.to_path_buf()))
        .ok_or_else(outside)
}

/// A name the browser shows and opens: text (the dashboard gets paths as text), not hidden (a leading dot), and on
/// Windows nothing it would read as something else (`windows_plain`).
pub fn browsable(name: &OsStr) -> bool {
    name.to_str()
        .is_some_and(|name| !name.is_empty() && !name.starts_with('.') && !name.contains('\0') && (!cfg!(windows) || windows_plain(name)))
}

/// Not a name Windows reads as something else: an alternate data stream (`name:stream`), a name it shortens
/// (a trailing dot or space), or a device (`CON`, `NUL.txt`, `COM1`…).
pub fn windows_plain(name: &str) -> bool {
    const DEVICES: [&str; 6] = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];
    let stem = name.split('.').next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
    let numbered = ["COM", "LPT"].iter().any(|device| {
        stem.strip_prefix(device).is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"))
    });
    !name.contains(':') && !name.ends_with(['.', ' ']) && !DEVICES.contains(&stem.as_str()) && !numbered
}

/// A new folder's name, trimmed: one that every file system takes and that the browser will show.
pub fn new_folder_name(name: &str) -> ApiResult<&str> {
    let name = name.trim();
    let fine = !name.is_empty()
        && name.len() <= MAX_NAME_BYTES
        && !name.starts_with('.')
        && !name.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        && windows_plain(name);
    if fine {
        Ok(name)
    } else {
        Err(ApiError::bad(
            "Choose another name: up to 255 bytes, not starting with a dot, without < > : \" / \\ | ? * and not a name Windows keeps for itself.",
        ))
    }
}

/// Names in the order people expect: case aside, and numbers by their value ("Episode 2" before "Episode 10").
/// Names that only differ in case or leading zeros still get one order, so sorting is the same every time.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut left, mut right) = (a.chars().peekable(), b.chars().peekable());
    loop {
        let order = match (left.peek(), right.peek()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let (x, y) = (digits(&mut left), digits(&mut right));
                let (x, y) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                x.len().cmp(&y.len()).then_with(|| x.cmp(y))
            }
            _ => {
                let (x, y) = (left.next().unwrap_or_default(), right.next().unwrap_or_default());
                x.to_lowercase().cmp(y.to_lowercase())
            }
        };
        if order != Ordering::Equal {
            return order;
        }
    }
}

fn digits(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut run = String::new();
    while let Some(digit) = chars.next_if(char::is_ascii_digit) {
        run.push(digit);
    }
    run
}

/// Opens `relative` below the root through a handle on it: cap-std refuses a path that leads out of the root, links
/// included, at the moment it opens it.
fn open(root: &Root, relative: &Path) -> std::io::Result<Dir> {
    let dir = Dir::open_ambient_dir(&root.path, ambient_authority())?;
    if relative.as_os_str().is_empty() { Ok(dir) } else { dir.open_dir(relative) }
}

/// What people are told when the disk says no. Their surroundings, not Magnetar's failures: nothing is reported.
/// Never the system's own message, which can name paths outside the root.
fn disk_error(error: &std::io::Error, at_root: bool) -> ApiError {
    match error.kind() {
        ErrorKind::NotFound if at_root => ApiError::not_found(
            "This folder can't be reached. If it is on a disk that isn't connected, connect it and try again.",
        ),
        ErrorKind::NotFound => ApiError::not_found("This folder isn't there anymore."),
        ErrorKind::PermissionDenied if cfg!(target_os = "macos") => ApiError::new(
            ErrorCode::Forbidden,
            "Magnetar isn't allowed to open this folder. Allow it in System Settings › Privacy & Security › Files and Folders.",
        ),
        ErrorKind::PermissionDenied => ApiError::new(ErrorCode::Forbidden, "Magnetar isn't allowed to open this folder."),
        ErrorKind::NotADirectory => ApiError::bad("That is a file, not a folder."),
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => ApiError::bad("The disk is full."),
        ErrorKind::ReadOnlyFilesystem => ApiError::bad("This disk can only be read."),
        kind => ApiError::bad(format!("This folder can't be read right now ({kind}).")),
    }
}

/// Runs disk work off the async workers, and stops waiting for it after a while.
async fn on_disk<T: Send + 'static>(work: impl FnOnce() -> ApiResult<T> + Send + 'static) -> ApiResult<T> {
    match tokio::time::timeout(DISK_TIMEOUT, tokio::task::spawn_blocking(work)).await {
        Ok(Ok(result)) => result,
        Ok(Err(failed)) => Err(ApiError::internal_from("The folder could not be read.", failed)),
        Err(_) => Err(ApiError::bad("The folder took too long to answer. Its disk may be asleep, busy or disconnected.")),
    }
}

/// One page of a folder, without the downloads its entries belong to.
#[derive(Debug)]
pub struct Listing {
    pub entries: Vec<FolderEntryDto>,
    pub total: usize,
    pub truncated: bool,
}

/// Lists `relative` below `root`: folders first, then files, by `natural_cmp`, `limit` from `offset` on, out of the
/// first `max_entries` the folder gives. Hidden entries, names that aren't text, links that lead out of the root or
/// nowhere, and anything that is neither a file nor a folder are left out.
pub fn list(root: &Root, relative: &Path, offset: usize, limit: usize, folders_only: bool, max_entries: usize) -> ApiResult<Listing> {
    let at_root = relative.as_os_str().is_empty();
    let dir = open(root, relative).map_err(|e| disk_error(&e, at_root))?;
    let mut found: Vec<(FolderEntryKind, String)> = Vec::new();
    let mut truncated = false;
    for entry in dir.entries().map_err(|e| disk_error(&e, at_root))? {
        // One entry that can't be read (removed meanwhile, a permission) doesn't hide the others.
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        if !browsable(OsStr::new(&name)) || hidden_on_windows(&entry) {
            continue;
        }
        let Some(kind) = kind_of(&dir, &entry, &name) else { continue };
        if folders_only && kind == FolderEntryKind::File {
            continue;
        }
        if found.len() == max_entries {
            truncated = true;
            break;
        }
        found.push((kind, name));
    }
    found.sort_by(|(a_kind, a), (b_kind, b)| {
        (*a_kind == FolderEntryKind::File).cmp(&(*b_kind == FolderEntryKind::File)).then_with(|| natural_cmp(a, b))
    });
    let total = found.len();
    let entries = found.into_iter().skip(offset).take(limit).map(|(kind, name)| describe(&dir, kind, name)).collect();
    Ok(Listing { entries, total, truncated })
}

/// A folder or a file; a link counts as what it leads to, if that is inside the root.
fn kind_of(dir: &Dir, entry: &cap_std::fs::DirEntry, name: &str) -> Option<FolderEntryKind> {
    let mut file_type = entry.file_type().ok()?;
    if file_type.is_symlink() {
        file_type = dir.metadata(name).ok()?.file_type();
    }
    if file_type.is_dir() {
        Some(FolderEntryKind::Folder)
    } else if file_type.is_file() {
        Some(FolderEntryKind::File)
    } else {
        None
    }
}

#[cfg(windows)]
fn hidden_on_windows(entry: &cap_std::fs::DirEntry) -> bool {
    use cap_std::fs::MetadataExt;
    const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;
    entry.metadata().is_ok_and(|m| m.file_attributes() & HIDDEN_OR_SYSTEM != 0)
}

#[cfg(not(windows))]
fn hidden_on_windows(_: &cap_std::fs::DirEntry) -> bool {
    false
}

/// An entry with its size and date, read only for the page shown.
fn describe(dir: &Dir, kind: FolderEntryKind, name: String) -> FolderEntryDto {
    let metadata = dir.metadata(&name).ok();
    let modified = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|time| time.into_std().duration_since(UNIX_EPOCH).ok())
        .and_then(|since| i64::try_from(since.as_millis()).ok());
    let file = kind == FolderEntryKind::File;
    FolderEntryDto {
        size: metadata.filter(|_| file).map(|m| m.len()),
        modified,
        media: if file { media_kind(Path::new(&name)) } else { None },
        name,
        kind,
        download: None,
    }
}

/// `fs.browse`: a page of the folder at `path`, with the downloads its entries belong to.
pub async fn browse(
    settings: &SettingsService,
    downloads: Arc<DownloadManager>,
    path: String,
    offset: usize,
    limit: Option<usize>,
    folders_only: bool,
) -> ApiResult<FolderPageDto> {
    let roots = roots(&settings.get());
    let limit = limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
    on_disk(move || {
        let (root, relative) = locate(&roots, &path)?;
        let Listing { mut entries, total, truncated } = list(root, &relative, offset, limit, folders_only, MAX_ENTRIES)?;
        let folder = root.path.join(&relative);
        let names: HashSet<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        let owners = downloads.in_folder(&folder, &names);
        for entry in &mut entries {
            entry.download = owners.get(&entry.name).copied();
        }
        Ok(FolderPageDto {
            path: display(&folder),
            root: display(&root.path),
            separator: MAIN_SEPARATOR_STR,
            entries,
            offset,
            total,
            truncated,
        })
    })
    .await
}

/// `fs.createFolder`: makes `name` in the folder at `parent`; its path. A folder already there is fine.
pub async fn create_folder(settings: &SettingsService, parent: String, name: String) -> ApiResult<String> {
    let roots = roots(&settings.get());
    on_disk(move || {
        let (root, relative) = locate(&roots, &parent)?;
        let name = new_folder_name(&name)?;
        let dir = open(root, &relative).map_err(|e| disk_error(&e, relative.as_os_str().is_empty()))?;
        match dir.create_dir(name) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if !dir.metadata(name).is_ok_and(|m| m.is_dir()) {
                    return Err(ApiError::bad("Something that isn't a folder already has that name."));
                }
            }
            Err(error) => return Err(disk_error(&error, false)),
        }
        Ok(display(&root.path.join(relative).join(name)))
    })
    .await
}

/// `fs.roots`: every root, whether it can be read now, and the free space on its disk.
pub async fn describe_roots(settings: &SettingsService, local: bool) -> ApiResult<FolderRootsDto> {
    let roots = roots(&settings.get());
    let roots = on_disk(move || {
        Ok(roots
            .into_iter()
            .map(|root| {
                let available = open(&root, Path::new("")).is_ok();
                FolderRootDto {
                    path: display(&root.path),
                    kind: root.kind,
                    available,
                    free_bytes: if available { free_space(&root.path) } else { None },
                }
            })
            .collect())
    })
    .await?;
    Ok(FolderRootsDto { roots, can_add: local })
}

/// `fs.addRoot`, on the device itself only: lets the dashboard browse `path` too.
pub async fn add_root(settings: Arc<SettingsService>, path: String) -> ApiResult<FolderRootsDto> {
    let Some(folder) = normalize(&path) else {
        return Err(ApiError::bad("Enter the folder's full path, as the computer running Magnetar writes it."));
    };
    let checked = folder.clone();
    on_disk(move || match std::fs::metadata(&checked) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(ApiError::bad("That is a file, not a folder.")),
        Err(error) => Err(disk_error(&error, true)),
    })
    .await?;
    let current = settings.get();
    if !roots(&current).iter().any(|root| root.path == folder) {
        if current.browse_folders.len() >= MAX_ADDED {
            return Err(ApiError::bad(format!("Files can show up to {MAX_ADDED} added folders. Remove one first.")));
        }
        let text = display(&folder);
        settings
            .update(|s| {
                if !s.browse_folders.contains(&text) {
                    s.browse_folders.push(text);
                }
            })
            .map_err(crate::settings::saving_failed)?;
    }
    describe_roots(&settings, true).await
}

/// `fs.removeRoot`: the dashboard no longer browses an added folder. Only narrows what it sees, so a relayed browser may.
pub async fn remove_root(settings: Arc<SettingsService>, path: String, local: bool) -> ApiResult<FolderRootsDto> {
    let folder = normalize(&path);
    settings
        .update(|s| s.browse_folders.retain(|added| *added != path && (folder.is_none() || normalize(added) != folder)))
        .map_err(crate::settings::saving_failed)?;
    describe_roots(&settings, local).await
}

/// Shows the macOS folder chooser via `osascript`: the dashboard runs in a browser, but on the
/// local dashboard the server is the user's own machine. None when cancelled or unsupported.
pub async fn pick_folder_natively(start: Option<&str>, prompt: &str) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let quote = super::applescript_string;
    let mut script = format!("POSIX path of (choose folder with prompt {}", quote(prompt));
    if let Some(start) = start.filter(|s| Path::new(s).exists()) {
        script.push_str(&format!(" default location POSIX file {}", quote(start)));
    }
    script.push(')');
    let output = tokio::process::Command::new("/usr/bin/osascript").args(["-e", &script]).output().await.ok()?;
    let chosen = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || chosen.is_empty() {
        return None;
    }
    Some(if chosen.len() > 1 { chosen.trim_end_matches('/').to_owned() } else { chosen })
}
