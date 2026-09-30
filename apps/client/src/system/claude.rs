//! Registers this app's MCP server with Claude Code, for the "Connect Claude" button.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::{ApiError, ApiResult};
use crate::paths::home_dir;

const SERVER_NAME: &str = "magnetar";
const TIMEOUT: Duration = Duration::from_secs(30);

/// The command that registers the server for every project (`--scope user`).
pub fn command(mcp_url: &str) -> String {
    format!("claude mcp add --transport http --scope user {SERVER_NAME} {mcp_url}")
}

/// The Claude Code CLI. An app started from Finder or the Start menu gets a minimal PATH, so the
/// installer's usual locations are checked too.
pub fn find_cli() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    let home = home_dir();
    let mut folders: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    folders.extend([home.join(".local/bin"), home.join(".claude/local")]);
    if cfg!(windows) {
        folders.extend(std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("npm")));
    } else {
        folders.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    folders.iter().flat_map(|folder| names.iter().map(move |name| folder.join(name))).find(|path| path.is_file())
}

async fn run(cli: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    // npm installs a .cmd shim on Windows, which only cmd can start.
    let mut command = if cli.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd")) {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(cli);
        c
    } else {
        tokio::process::Command::new(cli)
    };
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    tokio::time::timeout(TIMEOUT, command.output())
        .await
        .unwrap_or_else(|_| Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out")))
}

/// Adds (or re-points, when the port changed) the user-scope MCP server entry.
pub async fn register(cli: &Path, mcp_url: &str) -> ApiResult<()> {
    // An earlier entry may point at another port; `add` refuses to overwrite, so drop it first.
    let _ = run(cli, &["mcp", "remove", "--scope", "user", SERVER_NAME]).await;
    let output = run(cli, &["mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, mcp_url])
        .await
        .map_err(|e| ApiError::bad(format!("Could not run Claude Code: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim().lines().last().unwrap_or("no details");
        return Err(ApiError::bad(format!("Claude Code could not add the server: {detail}")));
    }
    tracing::info!("Registered the MCP server with Claude Code ({mcp_url})");
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    /// Linux won't run a file a process has open for writing, and a CLI started by one test
    /// inherits the other test's script while it is being written ("Text file busy"). So the tests
    /// write and run their fake CLIs one at a time.
    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn fake_cli(dir: &Path, script: &str) -> PathBuf {
        let cli = dir.join("claude");
        std::fs::write(&cli, script).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        cli
    }

    #[tokio::test]
    async fn replaces_any_earlier_entry_with_a_user_scope_one() {
        let _turn = ONE_AT_A_TIME.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("calls.log");
        let cli = fake_cli(dir.path(), &format!("#!/bin/sh\necho \"$@\" >> '{}'\n", log.display()));

        register(&cli, "http://localhost:47821/mcp").await.unwrap();
        let calls = std::fs::read_to_string(&log).unwrap();
        assert_eq!(
            calls,
            "mcp remove --scope user magnetar\nmcp add --transport http --scope user magnetar http://localhost:47821/mcp\n"
        );
        assert_eq!(command("http://x/mcp"), "claude mcp add --transport http --scope user magnetar http://x/mcp");
    }

    #[tokio::test]
    async fn a_failing_cli_reports_its_error() {
        let _turn = ONE_AT_A_TIME.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(dir.path(), "#!/bin/sh\n[ \"$2\" = add ] && { echo 'boom' >&2; exit 1; }\nexit 0\n");
        let error = register(&cli, "http://localhost:1/mcp").await.unwrap_err();
        assert!(error.message.ends_with("boom"), "{}", error.message);
    }
}
