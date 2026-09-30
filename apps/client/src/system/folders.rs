use std::path::{Path, PathBuf};

use crate::error::ApiResult;
use crate::paths::home_dir;
use crate::protocol::FolderListing;

fn absolute(path: Option<&str>) -> PathBuf {
    let path = path.map(str::trim).filter(|p| !p.is_empty()).map(PathBuf::from).unwrap_or_else(home_dir);
    let absolute = std::path::absolute(&path).unwrap_or(path);
    // Resolve "." and ".." textually, as the dashboard shows the path it gets back.
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other),
        }
    }
    normalized
}

/// Lists the subfolders of a folder on the device, for the dashboard's folder browser.
pub fn list_folder(path: Option<&str>) -> FolderListing {
    let current = absolute(path);
    let parent = current.parent().map(|p| p.to_string_lossy().into_owned());
    let path_text = current.to_string_lossy().into_owned();
    if !current.exists() {
        return FolderListing { path: path_text, parent, folders: vec![], exists: false, error: None };
    }
    match std::fs::read_dir(&current) {
        Ok(entries) => {
            let mut folders: Vec<String> = entries
                .filter_map(Result::ok)
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|name| !name.starts_with('.'))
                .collect();
            folders.sort_by_key(|name| name.to_lowercase());
            FolderListing { path: path_text, parent, folders, exists: true, error: None }
        }
        Err(error) => FolderListing { path: path_text, parent, folders: vec![], exists: true, error: Some(error.to_string()) },
    }
}

pub fn make_folder(path: &str) -> ApiResult<FolderListing> {
    std::fs::create_dir_all(absolute(Some(path)))?;
    Ok(list_folder(Some(path)))
}

/// Shows the macOS folder chooser via `osascript`: the dashboard runs in a browser, but on the
/// local dashboard the server is the user's own machine. None when cancelled or unsupported.
pub async fn pick_folder_natively(start: Option<&str>, prompt: &str) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let mut script = format!("POSIX path of (choose folder with prompt \"{}\"", escape(prompt));
    if let Some(start) = start.filter(|s| Path::new(s).exists()) {
        script.push_str(&format!(" default location POSIX file \"{}\"", escape(start)));
    }
    script.push(')');
    let output = tokio::process::Command::new("/usr/bin/osascript").args(["-e", &script]).output().await.ok()?;
    let chosen = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || chosen.is_empty() {
        return None;
    }
    Some(if chosen.len() > 1 { chosen.trim_end_matches('/').to_owned() } else { chosen })
}
