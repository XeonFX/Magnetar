use std::path::{Component, Path, PathBuf};

use crate::error::{ApiError, ApiResult};

/// Confines an agent-chosen save folder to the download root.
///
/// An agent picks tool arguments after reading titles and descriptions fetched from torrent sites,
/// which can carry instructions. A chosen folder plus a chosen torrent would otherwise write
/// attacker-named files anywhere the user can write (a LaunchAgents folder, a shell rc directory).
/// People choosing a folder in the dashboard are not restricted.
pub fn resolve_agent_folder(requested: Option<&str>, download_root: &str) -> ApiResult<Option<String>> {
    confine_folder(requested, &[download_root], |requested| {
        format!(
            "Downloads can only be saved inside the configured download folder ('{download_root}'). '{requested}' is outside it. Use an absolute path inside that folder, or change the download folder in Settings."
        )
    })
}

/// Confines a folder chosen through the relay to the folders the dashboard may browse (`system::folders::roots`).
///
/// A browser through the relay runs the website's code, which the device can't vouch for (docs/ARCHITECTURE.md): it
/// may save downloads and move the download folder only inside what it can already see, so that choosing a folder
/// never widens what it can browse. The dashboard on the device itself chooses freely.
pub fn resolve_remote_folder(requested: Option<&str>, roots: &[&str]) -> ApiResult<Option<String>> {
    confine_folder(requested, roots, |requested| {
        format!(
            "From another device, folders can only be chosen inside the download folder or a folder added to Files on the computer running Magnetar. '{requested}' is outside them. Add it there first, or choose a folder inside one of them."
        )
    })
}

/// `requested`, every link along it resolved, when that is inside one of `roots` (resolved the same way); else the
/// error `outside` words. A root that can't be resolved confines nothing.
fn confine_folder(requested: Option<&str>, roots: &[&str], outside: impl FnOnce(&str) -> String) -> ApiResult<Option<String>> {
    let Some(requested) = requested.map(str::trim).filter(|r| !r.is_empty()) else { return Ok(None) };
    let Ok(candidate) = canonicalize(Path::new(requested), 0) else {
        return Err(ApiError::bad(format!("'{requested}' is not a usable folder path.")));
    };
    let inside = roots.iter().filter_map(|root| canonicalize(Path::new(root), 0).ok()).any(|root| candidate.starts_with(root));
    if !inside {
        return Err(ApiError::bad(outside(requested)));
    }
    Ok(Some(candidate.to_string_lossy().into_owned()))
}

/// Absolute path with every symlink along it resolved, including in ancestors and link targets,
/// as far as the path exists. A purely textual check would pass a link inside the root that points
/// outside it. Inspection errors fail closed.
fn canonicalize(path: &Path, links_followed: usize) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(links_followed <= 40, "Too many symbolic links");
    let full = std::path::absolute(path)?;
    let mut current = PathBuf::new();
    for component in full.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => current.push(component),
            Component::CurDir => {}
            Component::ParentDir => {
                current.pop();
            }
            Component::Normal(name) => {
                current.push(name);
                let metadata = match std::fs::symlink_metadata(&current) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                if metadata.file_type().is_symlink() {
                    let target = std::fs::read_link(&current)?;
                    let parent = current.parent().map(Path::to_path_buf).unwrap_or_default();
                    current = canonicalize(&parent.join(target), links_followed + 1)?;
                } else if !metadata.is_dir() {
                    anyhow::bail!("The folder path contains a file");
                }
            }
        }
    }
    Ok(current)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn confines_agent_folders_to_the_download_root() {
        let base = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(base.path()).unwrap().join("root");
        let outside = root.parent().unwrap().join("outside");
        std::fs::create_dir_all(root.join("shows")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        std::fs::write(root.join("file.txt"), "x").unwrap();
        let root_text = root.to_str().unwrap();
        let resolve = |p: &Path| resolve_agent_folder(Some(p.to_str().unwrap()), root_text);

        assert_eq!(resolve_agent_folder(Some("  "), root_text).unwrap(), None);
        assert_eq!(resolve(&root.join("shows")).unwrap().as_deref(), root.join("shows").to_str());
        assert_eq!(resolve(&root.join("new/deeper")).unwrap().as_deref(), root.join("new/deeper").to_str());
        assert_eq!(resolve(&root).unwrap().as_deref(), Some(root_text));

        for escape in [outside.clone(), root.join(".."), root.join("escape/x"), PathBuf::from(format!("{root_text}-sibling"))] {
            assert!(resolve(&escape).unwrap_err().message.contains("only be saved inside"), "{}", escape.display());
        }
        assert!(resolve(&root.join("file.txt/x")).unwrap_err().message.contains("not a usable folder"));
    }
}
