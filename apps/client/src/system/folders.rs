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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

/// The roots: the download folder first, then the added ones; each once, and only absolute ones.
pub fn roots(settings: &AppSettings) -> Vec<Root> {
    let mut roots: Vec<Root> = Vec::new();
    let saved = std::iter::once(&settings.download_folder).chain(&settings.browse_folders);
    for (index, text) in saved.enumerate() {
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
    name.to_str().is_some_and(|name| {
        !name.is_empty() && !name.starts_with('.') && !name.contains('\0') && (!cfg!(windows) || windows_plain(name))
    })
}

/// Not a name Windows reads as something else: an alternate data stream (`name:stream`), a name it shortens
/// (a trailing dot or space), or a device (`CON`, `NUL.txt`, `COM1`…).
pub fn windows_plain(name: &str) -> bool {
    const DEVICES: [&str; 6] = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];
    let stem = name.split('.').next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
    let numbered = ["COM", "LPT"].iter().any(|device| {
        stem.strip_prefix(device)
            .is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"))
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

/// A folder opened inside a root: the handle it is read through, and where it and its root really are on disk.
struct Opened {
    dir: Dir,
    root: PathBuf,
    here: PathBuf,
}

/// What an entry is, a link counting as what it leads to.
struct Facts {
    kind: Option<FolderEntryKind>,
    size: u64,
    modified: Option<SystemTime>,
}

impl Facts {
    fn of(is_dir: bool, is_file: bool, size: u64, modified: Option<SystemTime>) -> Self {
        let kind = if is_dir {
            Some(FolderEntryKind::Folder)
        } else if is_file {
            Some(FolderEntryKind::File)
        } else {
            None
        };
        Self { kind, size, modified }
    }
}

/// Opens `relative` below the root. Links along it are resolved first only to learn where they lead: what is outside
/// the root is refused, and the folder is then opened from the root's handle by its real names, so cap-std refuses a
/// way out (a link swapped in meanwhile) at the moment it opens it.
fn open(root: &Root, relative: &Path) -> std::io::Result<Opened> {
    let real_root = std::fs::canonicalize(&root.path)?;
    let dir = Dir::open_ambient_dir(&real_root, ambient_authority())?;
    if relative.as_os_str().is_empty() {
        return Ok(Opened { dir, here: real_root.clone(), root: real_root });
    }
    let here = std::fs::canonicalize(real_root.join(relative))?;
    let inside = here.strip_prefix(&real_root).map_err(|_| std::io::Error::from(ErrorKind::PermissionDenied))?;
    let dir = if inside.as_os_str().is_empty() { dir } else { dir.open_dir(inside)? };
    Ok(Opened { dir, here, root: real_root })
}

impl Opened {
    /// What `name` here is. cap-std follows a relative link that stays inside the root itself, but refuses every link
    /// by an absolute path: one of those counts when it leads inside the root. A link out of it, or nowhere, is None.
    fn facts(&self, name: &str) -> Option<Facts> {
        if let Ok(m) = self.dir.metadata(name) {
            return Some(Facts::of(m.is_dir(), m.is_file(), m.len(), m.modified().ok().map(|t| t.into_std())));
        }
        let real = std::fs::canonicalize(self.here.join(name)).ok().filter(|real| real.starts_with(&self.root))?;
        let m = std::fs::metadata(real).ok()?;
        Some(Facts::of(m.is_dir(), m.is_file(), m.len(), m.modified().ok()))
    }
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
pub fn list(
    root: &Root,
    relative: &Path,
    offset: usize,
    limit: usize,
    folders_only: bool,
    max_entries: usize,
) -> ApiResult<Listing> {
    let at_root = relative.as_os_str().is_empty();
    let opened = open(root, relative).map_err(|e| disk_error(&e, at_root))?;
    let mut found: Vec<(FolderEntryKind, String)> = Vec::new();
    let mut truncated = false;
    for entry in opened.dir.entries().map_err(|e| disk_error(&e, at_root))? {
        // One entry that can't be read (removed meanwhile, a permission) doesn't hide the others.
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        if !browsable(OsStr::new(&name)) || hidden_on_windows(&entry) {
            continue;
        }
        let Some(kind) = kind_of(&opened, &entry, &name) else { continue };
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
    let entries = found.into_iter().skip(offset).take(limit).map(|(kind, name)| describe(&opened, kind, name)).collect();
    Ok(Listing { entries, total, truncated })
}

/// A folder or a file, from what reading the folder told (no look at each entry), except for links.
fn kind_of(opened: &Opened, entry: &cap_std::fs::DirEntry, name: &str) -> Option<FolderEntryKind> {
    let file_type = entry.file_type().ok()?;
    if file_type.is_symlink() {
        opened.facts(name)?.kind
    } else {
        Facts::of(file_type.is_dir(), file_type.is_file(), 0, None).kind
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
fn describe(opened: &Opened, kind: FolderEntryKind, name: String) -> FolderEntryDto {
    let facts = opened.facts(&name);
    let modified = facts
        .as_ref()
        .and_then(|f| f.modified)
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|since| i64::try_from(since.as_millis()).ok());
    let file = kind == FolderEntryKind::File;
    FolderEntryDto {
        size: facts.filter(|_| file).map(|f| f.size),
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
    on_disk(move || make_folder(&roots, &parent, &name)).await
}

fn make_folder(roots: &[Root], parent: &str, name: &str) -> ApiResult<String> {
    let (root, relative) = locate(roots, parent)?;
    let name = new_folder_name(name)?;
    let Opened { dir, .. } = open(root, &relative).map_err(|e| disk_error(&e, relative.as_os_str().is_empty()))?;
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
}

/// `fs.roots`: every root, whether it can be read now, and the free space on its disk.
pub async fn describe_roots(settings: &SettingsService, local: bool) -> ApiResult<FolderRootsDto> {
    let roots = roots(&settings.get());
    let roots = on_disk(move || {
        Ok(roots
            .into_iter()
            .map(|root| {
                if root.kind == FolderRootKind::Downloads {
                    make_download_folder(&root.path);
                }
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

/// Makes the download folder when it isn't there yet (a new install's `~/Downloads/Magnetar`), as the first download
/// would. Only the folder itself, inside a folder that exists: a download folder on a disk that isn't connected is not
/// made again on the startup disk (`/Volumes` and `/media` take no new folders from users either).
fn make_download_folder(path: &Path) {
    if !path.exists() && path.parent().is_some_and(Path::is_dir) {
        let _ = std::fs::create_dir(path);
    }
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

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::protocol::FolderRootKind::{Added, Downloads};

    /// An absolute path written with `/`, as this platform writes it (`C:\…` on Windows).
    fn abs(path: &str) -> String {
        if cfg!(windows) { format!("C:{}", path.replace('/', "\\")) } else { path.to_owned() }
    }

    fn root(path: &str, kind: FolderRootKind) -> Root {
        Root { path: PathBuf::from(abs(path)), kind }
    }

    fn settings(download_folder: &str, added: &[&str]) -> AppSettings {
        AppSettings {
            download_folder: download_folder.into(),
            browse_folders: added.iter().map(|f| f.to_string()).collect(),
            ..AppSettings::default()
        }
    }

    #[test]
    fn the_download_folder_comes_first_and_every_root_once() {
        let s = settings(&abs("/m/dl/"), &[&abs("/m/dl"), "relative/x", "", "  ", &abs("/m/shows/./x/.."), &abs("/m")]);
        assert_eq!(roots(&s), [root("/m/dl", Downloads), root("/m/shows", Added), root("/m", Added)]);
        assert_eq!(roots(&settings("", &[])), []);
    }

    #[test]
    fn a_path_belongs_to_the_outermost_root_that_holds_it() {
        let roots = [root("/m/dl", Downloads), root("/m", Added), root("/m/.cache/dl", Added)];
        let found = |p: &str| locate(&roots, &abs(p)).map(|(root, relative)| (root.path.clone(), relative)).unwrap();
        assert_eq!(found("/m/dl"), (PathBuf::from(abs("/m")), PathBuf::from("dl")));
        assert_eq!(found("/m"), (PathBuf::from(abs("/m")), PathBuf::new()));
        assert_eq!(found("/m/dl/Show S01/E01.mkv").1, Path::new("dl").join("Show S01").join("E01.mkv"));
        // Below a hidden folder of the outer root, the inner root still holds it.
        assert_eq!(found("/m/.cache/dl/x"), (PathBuf::from(abs("/m/.cache/dl")), PathBuf::from("x")));
        // Doubled and trailing separators name the same folder.
        assert_eq!(found("/m/a//b/").1, Path::new("a").join("b"));
    }

    #[test]
    fn anything_but_plain_names_below_a_root_is_refused_alike() {
        let roots = [root("/m/dl", Downloads)];
        let absolute = [
            "/",
            "/m",
            "/m/d",
            "/m/dl-other",
            "/m/dl/../x",
            "/m/dl/x/../../etc",
            "/m/dl/.ssh",
            "/m/dl/x/.git/config",
            "/m/dl/x\0y",
            "/etc/passwd",
        ];
        let long = abs(&format!("/m/dl/{}", "a/".repeat(MAX_PATH_BYTES / 2)));
        let requests = absolute.iter().map(|p| abs(p)).chain(["", "dl", "m/dl/x", "./x"].map(str::to_owned)).chain([long]);
        for requested in requests {
            let error = locate(&roots, &requested).unwrap_err();
            assert_eq!((error.code, error.message), (ErrorCode::Forbidden, outside().message), "{requested:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_spellings_that_name_something_else_are_refused() {
        let roots = [root("/dl", Downloads)];
        for requested in [
            r"\\?\C:\dl\x",
            r"\\.\C:\dl\x",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\dl\x",
            r"C:dl\x",
            r"\dl\x",
            r"D:\dl\x",
            r"C:\dl\x:secret",
            r"C:\dl\x::$DATA",
            r"C:\dl\NUL",
            r"C:\dl\com1.txt",
            r"C:\dl\x.",
            r"C:\dl\x ",
        ] {
            assert!(locate(&roots, requested).is_err(), "{requested}");
        }
        assert_eq!(locate(&roots, "C:/dl/x").unwrap().1, PathBuf::from("x"));
        let share = [Root { path: PathBuf::from(r"\\nas\media"), kind: Added }];
        assert_eq!(locate(&share, r"\\nas\media\shows").unwrap().1, PathBuf::from("shows"));
        assert!(locate(&share, r"\\nas\other\x").is_err());
        assert_eq!(normalize(r"\\?\C:\dl\x"), Some(PathBuf::from(r"C:\dl\x")));
        assert_eq!(normalize(r"\\?\UNC\nas\media"), Some(PathBuf::from(r"\\nas\media")));
    }

    #[test]
    fn windows_device_stream_and_shortened_names_are_not_plain() {
        for name in ["CON", "con", "Nul.txt", "AUX .txt", "COM1", "lpt9.log", "COM²", "CONIN$", "a:b", "a.", "a ", "..."] {
            assert!(!windows_plain(name), "{name}");
        }
        for name in ["CONSOLE", "COM10", "COM0", "nul-x", "a.b", "Ünïcödé 😀", "LPT"] {
            assert!(windows_plain(name), "{name}");
        }
    }

    #[test]
    fn a_new_folder_name_fits_every_file_system() {
        let accepted = ["New", "  Trimmed  ", "Ünïcödé 😀", &"a".repeat(255), &"é".repeat(127), "a.b", "x-y_z (1)"];
        for name in accepted {
            assert_eq!(new_folder_name(name).unwrap(), name.trim(), "{name}");
        }
        let refused = [
            "",
            "   ",
            ".",
            "..",
            ".hidden",
            "a/b",
            r"a\b",
            "a:b",
            "a*",
            "a?",
            "a|b",
            "<a>",
            "\"a\"",
            "a\0",
            "a\nb",
            "CON",
            "nul.txt",
            "a.",
            &"a".repeat(256),
            &"é".repeat(128),
        ];
        for name in refused {
            assert_eq!(new_folder_name(name).unwrap_err().code, ErrorCode::BadRequest, "{name:?}");
        }
    }

    #[test]
    fn names_sort_as_people_read_them() {
        let mut names = vec![
            "Episode 10",
            "episode 2",
            "Episode 1",
            "b",
            "A",
            "a",
            "x007",
            "x7",
            "x10",
            "",
            "10",
            "9",
            "Ä",
            "f100000000000000000000000",
            "f99999999999999999999999",
        ];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            names,
            [
                "",
                "9",
                "10",
                "A",
                "a",
                "b",
                "Episode 1",
                "episode 2",
                "Episode 10",
                "f99999999999999999999999",
                "f100000000000000000000000",
                "x007",
                "x7",
                "x10",
                "Ä",
            ]
        );
    }

    #[test]
    fn errors_never_repeat_what_the_system_said() {
        let leaky = |kind| std::io::Error::new(kind, "/Users/someone/secret/path");
        for kind in
            [ErrorKind::NotFound, ErrorKind::PermissionDenied, ErrorKind::StorageFull, ErrorKind::Other, ErrorKind::TimedOut]
        {
            for at_root in [true, false] {
                let error = disk_error(&leaky(kind), at_root);
                assert!(!error.message.contains("secret"), "{kind:?}: {}", error.message);
                assert!(!error.is_internal(), "{kind:?} is the computer's surroundings, not a fault to report");
            }
        }
        assert_eq!(disk_error(&leaky(ErrorKind::PermissionDenied), false).code, ErrorCode::Forbidden);
        assert_eq!(disk_error(&leaky(ErrorKind::NotFound), false).code, ErrorCode::NotFound);
        assert_eq!(disk_error(&leaky(ErrorKind::StorageFull), false).message, "The disk is full.");
        assert!(disk_error(&leaky(ErrorKind::NotFound), true).message.contains("connect it"));
    }

    fn segment() -> impl Strategy<Value = String> {
        prop_oneof![
            Just("..".to_owned()),
            Just(".".to_owned()),
            Just(String::new()),
            Just(".hidden".to_owned()),
            Just("dl".to_owned()),
            Just("dl-other".to_owned()),
            Just("m".to_owned()),
            Just("NUL".to_owned()),
            Just("x:y".to_owned()),
            Just("x.".to_owned()),
            "[a-zA-Z0-9 _-]{1,12}",
            "\\PC{1,8}",
        ]
    }

    proptest! {
        /// Whatever is asked for, a found folder is a root and plain names below it, at the very place the words name.
        #[test]
        fn a_found_folder_is_a_root_and_plain_names_below_it(segments in prop::collection::vec(segment(), 0..8), absolute in any::<bool>()) {
            let roots = [root("/m/dl", Downloads), root("/m/shows", Added)];
            let joined = segments.join("/");
            let requested = if absolute { abs(&format!("/m/{joined}")) } else { joined };
            if let Ok((root, relative)) = locate(&roots, &requested) {
                prop_assert!(roots.contains(root));
                prop_assert!(relative.components().all(|c| matches!(c, Component::Normal(name) if browsable(name))));
                prop_assert!(!segments.iter().any(|s| s == ".." || (s.starts_with('.') && s != ".")));
                prop_assert_eq!(Path::new(&requested).components().collect::<PathBuf>(), root.path.join(&relative));
            }
        }

        /// The paths the browser hands out lead back to where they came from.
        #[test]
        fn every_plain_path_below_a_root_is_found_again(names in prop::collection::vec("\\PC{1,16}", 0..6)) {
            prop_assume!(names.iter().all(|n| !n.contains(['/', '\\']) && n.trim() == n && browsable(OsStr::new(n))));
            let roots = [root("/m/dl", Downloads)];
            let relative: PathBuf = names.iter().collect();
            let requested = display(&roots[0].path.join(&relative));
            let (root, found) = locate(&roots, &requested).unwrap();
            prop_assert_eq!(root, &roots[0]);
            prop_assert_eq!(found, relative);
        }

        #[test]
        fn natural_order_is_a_total_order(
            a in prop_oneof!["[0-9aAbB ]{0,6}", "\\PC{0,8}"],
            b in prop_oneof!["[0-9aAbB ]{0,6}", "\\PC{0,8}"],
            c in prop_oneof!["[0-9aAbB ]{0,6}", "\\PC{0,8}"],
        ) {
            prop_assert_eq!(natural_cmp(&a, &b), natural_cmp(&b, &a).reverse());
            prop_assert_eq!(natural_cmp(&a, &b) == Ordering::Equal, a == b);
            if natural_cmp(&a, &b).is_le() && natural_cmp(&b, &c).is_le() {
                prop_assert!(natural_cmp(&a, &c).is_le(), "{a:?} <= {b:?} <= {c:?}");
            }
        }

        /// Names that read alike (case aside, numbers with leading zeros) still get one order each, both ways round.
        #[test]
        fn names_that_read_alike_still_differ(name in "[a-zA-Z0-9 ]{1,10}", zeros in 1usize..3) {
            let toggled: String = name.chars().map(|c| if c.is_lowercase() { c.to_ascii_uppercase() } else { c.to_ascii_lowercase() }).collect();
            let padded = format!("{}{name}", "0".repeat(zeros));
            for other in [toggled, padded] {
                if other != name {
                    prop_assert_ne!(natural_cmp(&name, &other), Ordering::Equal);
                    prop_assert_eq!(natural_cmp(&name, &other), natural_cmp(&other, &name).reverse());
                }
            }
        }

        /// Any name `new_folder_name` takes is one the browser then shows and opens.
        #[test]
        fn a_new_folder_can_be_browsed(name in "\\PC{0,40}") {
            if let Ok(name) = new_folder_name(&name) {
                prop_assert!(browsable(OsStr::new(name)) && windows_plain(name) && name.len() <= MAX_NAME_BYTES);
            }
        }
    }

    #[cfg(unix)]
    mod disk {
        use std::os::unix::fs::symlink;

        use super::*;

        /// A root on disk with folders, files, hidden entries and links into it, out of it and nowhere, and a folder
        /// outside it with a secret.
        struct Disk {
            _dir: tempfile::TempDir,
            root: Root,
            outside: PathBuf,
        }

        impl Disk {
            fn new() -> Self {
                let dir = tempfile::tempdir().unwrap();
                let base = std::fs::canonicalize(dir.path()).unwrap();
                let (path, outside) = (base.join("root"), base.join("outside"));
                for folder in ["a", "B", "Episode 10", "Episode 2", ".hidden"] {
                    std::fs::create_dir_all(path.join(folder)).unwrap();
                }
                std::fs::create_dir_all(&outside).unwrap();
                std::fs::write(outside.join("secret.txt"), "secret").unwrap();
                std::fs::write(path.join("a/inner.txt"), "inner").unwrap();
                std::fs::write(path.join("A.txt"), "hello").unwrap();
                std::fs::write(path.join("z.mkv"), [0; 10]).unwrap();
                std::fs::write(path.join("song.mp3"), [0; 3]).unwrap();
                std::fs::write(path.join(".env"), "TOKEN=x").unwrap();
                symlink(path.join("a"), path.join("in")).unwrap();
                symlink(path.join("A.txt"), path.join("A-link.txt")).unwrap();
                symlink(&outside, path.join("out")).unwrap();
                symlink(outside.join("secret.txt"), path.join("secret.txt")).unwrap();
                symlink(path.join("gone"), path.join("dangling")).unwrap();
                symlink("a", path.join("rel-in")).unwrap();
                symlink("../outside", path.join("rel-out")).unwrap();
                symlink("a/../../outside/secret.txt", path.join("rel-secret.txt")).unwrap();
                Self { _dir: dir, root: Root { path, kind: Downloads }, outside }
            }

            fn list(&self, relative: &str) -> ApiResult<Listing> {
                list(&self.root, Path::new(relative), 0, MAX_PAGE, false, MAX_ENTRIES)
            }

            fn path(&self, relative: &str) -> String {
                display(&self.root.path.join(relative))
            }
        }

        fn names(listing: &Listing) -> Vec<&str> {
            listing.entries.iter().map(|e| e.name.as_str()).collect()
        }

        #[test]
        fn folders_come_first_then_files_and_nothing_hidden_or_outside() {
            let disk = Disk::new();
            let listing = disk.list("").unwrap();
            assert_eq!(
                names(&listing),
                ["a", "B", "Episode 2", "Episode 10", "in", "rel-in", "A-link.txt", "A.txt", "song.mp3", "z.mkv"]
            );
            assert_eq!((listing.total, listing.truncated), (10, false));
            let entry = |name: &str| listing.entries.iter().find(|e| e.name == name).unwrap();
            assert_eq!((entry("in").kind, entry("in").size), (FolderEntryKind::Folder, None));
            assert_eq!((entry("A.txt").kind, entry("A.txt").size, entry("A.txt").media), (FolderEntryKind::File, Some(5), None));
            assert_eq!(
                (entry("A-link.txt").size, entry("z.mkv").media, entry("song.mp3").media),
                (Some(5), Some("video"), Some("audio"))
            );
            assert!(listing.entries.iter().all(|e| e.modified.is_some_and(|m| m > 1_600_000_000_000)));
            let folders = list(&disk.root, Path::new(""), 0, MAX_PAGE, true, MAX_ENTRIES).unwrap();
            assert_eq!(names(&folders), ["a", "B", "Episode 2", "Episode 10", "in", "rel-in"]);
        }

        #[test]
        fn pages_split_the_same_order() {
            let disk = Disk::new();
            let page = |offset, limit| {
                let listing = list(&disk.root, Path::new(""), offset, limit, false, MAX_ENTRIES).unwrap();
                (names(&listing).into_iter().map(str::to_owned).collect::<Vec<_>>(), listing.total)
            };
            assert_eq!(page(0, 1), (vec!["a".to_owned()], 10));
            assert_eq!(page(9, 5), (vec!["z.mkv".to_owned()], 10));
            assert_eq!(page(10, 5), (vec![], 10));
            assert_eq!(page(usize::MAX, 5), (vec![], 10));
            let all: Vec<String> = (0..10).flat_map(|offset| page(offset, 1).0).collect();
            assert_eq!(all, page(0, MAX_PAGE).0);
        }

        #[test]
        fn a_huge_folder_shows_only_the_first_entries_it_gives() {
            let disk = Disk::new();
            let at_most = |max| {
                let listing = list(&disk.root, Path::new(""), 0, MAX_PAGE, false, max).unwrap();
                (listing.entries.len(), listing.total, listing.truncated)
            };
            assert_eq!(at_most(3), (3, 3, true));
            assert_eq!(at_most(9), (9, 9, true));
            assert_eq!(at_most(10), (10, 10, false));
            assert_eq!(at_most(0), (0, 0, true));
        }

        #[test]
        fn links_are_followed_only_inside_the_root() {
            let disk = Disk::new();
            assert_eq!(names(&disk.list("in").unwrap()), ["inner.txt"]);
            assert_eq!(names(&disk.list("rel-in").unwrap()), ["inner.txt"]);
            for escape in ["out", "rel-out", "dangling", "secret.txt", "rel-secret.txt", "in/../out"] {
                assert!(disk.list(escape).is_err(), "{escape}");
            }
            assert_eq!(disk.list("out").unwrap_err().code, ErrorCode::Forbidden);
            assert_eq!(disk.list("rel-out").unwrap_err().code, ErrorCode::Forbidden);
            assert_eq!(disk.list("dangling").unwrap_err().code, ErrorCode::NotFound);
            // A folder swapped for a link out after it was found is still refused while opening.
            let roots = [disk.root.clone()];
            let (root, relative) = locate(&roots, &disk.path("B")).unwrap();
            std::fs::remove_dir(disk.root.path.join("B")).unwrap();
            symlink(&disk.outside, disk.root.path.join("B")).unwrap();
            assert_eq!(list(root, &relative, 0, MAX_PAGE, false, MAX_ENTRIES).unwrap_err().code, ErrorCode::Forbidden);
        }

        #[test]
        fn what_is_not_a_readable_folder_says_why() {
            let disk = Disk::new();
            assert_eq!(disk.list("A.txt").unwrap_err().message, "That is a file, not a folder.");
            assert_eq!(disk.list("never").unwrap_err().message, "This folder isn't there anymore.");
            let missing = Root { path: disk.root.path.join("unplugged"), kind: Added };
            let error = list(&missing, Path::new(""), 0, 1, false, MAX_ENTRIES).unwrap_err();
            assert_eq!(error.code, ErrorCode::NotFound);
            assert!(error.message.contains("connect it"));
        }

        #[test]
        fn a_folder_magnetar_may_not_read_is_forbidden() {
            use std::os::unix::fs::PermissionsExt;
            // Root reads everything; the check means nothing there.
            if unsafe { libc::geteuid() } == 0 {
                return;
            }
            let disk = Disk::new();
            let locked = disk.root.path.join("B");
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
            let error = disk.list("B").unwrap_err();
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(error.code, ErrorCode::Forbidden);
            assert!(error.message.starts_with("Magnetar isn't allowed"));
        }

        #[test]
        fn long_and_unicode_names_arrive_whole() {
            let disk = Disk::new();
            let long = format!("{}a", "é".repeat(127));
            assert_eq!(long.len(), MAX_NAME_BYTES);
            for name in [long.as_str(), "Ünïcödé 😀 – 第1話.mkv", "a b  c"] {
                std::fs::write(disk.root.path.join("B").join(name), "x").unwrap();
            }
            let mut listed = names(&disk.list("B").unwrap()).into_iter().map(str::to_owned).collect::<Vec<_>>();
            listed.sort();
            let mut expected = vec![long.clone(), "Ünïcödé 😀 – 第1話.mkv".to_owned(), "a b  c".to_owned()];
            expected.sort();
            assert_eq!(listed, expected);
        }

        #[cfg(target_os = "linux")]
        #[test]
        fn names_that_are_not_text_are_left_out() {
            use std::os::unix::ffi::OsStrExt;
            let disk = Disk::new();
            std::fs::write(disk.root.path.join("B").join(OsStr::from_bytes(b"bad\xff.mkv")), "x").unwrap();
            std::fs::write(disk.root.path.join("B/good.mkv"), "x").unwrap();
            assert_eq!(names(&disk.list("B").unwrap()), ["good.mkv"]);
        }

        #[test]
        fn folders_are_made_only_inside_a_root() {
            let disk = Disk::new();
            let roots = [disk.root.clone()];
            let made = make_folder(&roots, &disk.path("a"), " Season 1 ").unwrap();
            assert_eq!(made, disk.path("a/Season 1"));
            assert!(disk.root.path.join("a/Season 1").is_dir());
            assert_eq!(make_folder(&roots, &disk.path("a"), "Season 1").unwrap(), made, "a folder already there is fine");
            assert_eq!(make_folder(&roots, &disk.path(""), "A.txt").unwrap_err().code, ErrorCode::BadRequest);
            assert_eq!(make_folder(&roots, &disk.path(""), "../escape").unwrap_err().code, ErrorCode::BadRequest);
            assert_eq!(make_folder(&roots, &disk.path("never"), "x").unwrap_err().code, ErrorCode::NotFound);
            assert_eq!(make_folder(&roots, &display(&disk.outside), "x").unwrap_err().code, ErrorCode::Forbidden);
            assert_eq!(make_folder(&roots, &disk.path("out"), "x").unwrap_err().code, ErrorCode::Forbidden);
            assert_eq!(std::fs::read_dir(&disk.outside).unwrap().count(), 1, "nothing was made outside");
        }
    }
}
