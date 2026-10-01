//! Connects AI agents on this computer to the app's MCP server: coding agents with a command line
//! of their own (Claude Code, Codex, Gemini CLI) through that command, the others (Cursor, VS Code,
//! Windsurf, OpenCode, Claude Desktop) by adding an entry to their settings file. Every agent also
//! gets a setup to follow by hand, for when it isn't found or its file can't be changed safely.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::error::{ApiError, ApiResult};

/// The name the server is registered under in every agent.
pub const SERVER_NAME: &str = "magnetar";
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentClient {
    ClaudeCode,
    Codex,
    GeminiCli,
    Cursor,
    Vscode,
    Windsurf,
    Opencode,
    ClaudeDesktop,
}

pub const ALL: [AgentClient; 8] = [
    AgentClient::ClaudeCode,
    AgentClient::Codex,
    AgentClient::GeminiCli,
    AgentClient::Cursor,
    AgentClient::Vscode,
    AgentClient::Windsurf,
    AgentClient::Opencode,
    AgentClient::ClaudeDesktop,
];

/// Where agents keep their programs and settings. `current()` for the real computer; tests point it
/// at a scratch folder.
pub struct Environment {
    pub home: PathBuf,
    /// Per-user application settings: ~/Library/Application Support, %APPDATA% or ~/.config.
    pub app_config: PathBuf,
    /// ~/.config, or $XDG_CONFIG_HOME: OpenCode keeps its settings there on every platform.
    pub xdg_config: PathBuf,
    /// $CODEX_HOME, or ~/.codex.
    pub codex_home: PathBuf,
    /// Folders searched for agent commands.
    pub path: Vec<PathBuf>,
    /// This program, which Claude Desktop starts as a stdio bridge (`magnetar mcp`).
    pub executable: PathBuf,
}

impl Environment {
    pub fn current() -> Self {
        let home = crate::paths::home_dir();
        let env_path = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
        let xdg_config = env_path("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
        let app_config = if cfg!(target_os = "macos") {
            home.join("Library/Application Support")
        } else if cfg!(windows) {
            env_path("APPDATA").unwrap_or_else(|| home.join("AppData/Roaming"))
        } else {
            xdg_config.clone()
        };
        // An app started from Finder or the Start menu gets a minimal PATH, so the installers' usual
        // folders are searched too.
        let mut path: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        path.extend([home.join(".local/bin"), home.join(".claude/local"), home.join(".npm-global/bin"), home.join(".bun/bin")]);
        if cfg!(windows) {
            path.extend(env_path("APPDATA").map(|a| a.join("npm")));
        } else {
            path.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
        }
        Self {
            codex_home: env_path("CODEX_HOME").unwrap_or_else(|| home.join(".codex")),
            executable: std::env::current_exe().unwrap_or_else(|_| PathBuf::from(SERVER_NAME)),
            home,
            app_config,
            xdg_config,
            path,
        }
    }

    /// The first of `names` found in the searched folders; Windows also tries .exe and .cmd.
    fn find(&self, name: &str) -> Option<PathBuf> {
        let names: Vec<String> =
            if cfg!(windows) { vec![format!("{name}.exe"), format!("{name}.cmd")] } else { vec![name.to_owned()] };
        self.path.iter().flat_map(|folder| names.iter().map(move |n| folder.join(n))).find(|p| p.is_file())
    }
}

/// An agent registered through its own command line.
struct Command {
    program: &'static str,
    add: fn(&str) -> Vec<String>,
    remove: &'static [&'static str],
    /// The settings file the command writes, to tell whether it is connected.
    settings: fn(&Environment) -> PathBuf,
    connected: fn(&str, &str) -> bool,
}

/// An agent registered by adding an entry to its settings file.
struct SettingsFile {
    file: fn(&Environment) -> PathBuf,
    /// Found when this folder exists.
    folder: fn(&Environment) -> PathBuf,
    /// A command that also counts as installed.
    program: Option<&'static str>,
    /// The object entries go into, and the entry for `url`.
    section: &'static str,
    entry: fn(&str, &Environment) -> Value,
}

enum How {
    Command(Command),
    File(SettingsFile),
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_owned()).collect()
}

/// The JSON object at `section.magnetar` in a settings file's text, if the file parses.
fn json_entry(text: &str, section: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok()?.get(section)?.get(SERVER_NAME).cloned()
}

/// Whether `[mcp_servers.magnetar]` in a Codex config.toml has `url = "<url>"`. Codex writes plain
/// tables, so a line reader is enough; anything unusual reads as not connected, which is safe.
fn codex_has(text: &str, url: &str) -> bool {
    let mut inside = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            inside = line == format!("[mcp_servers.{SERVER_NAME}]");
        } else if inside && let Some(value) = line.strip_prefix("url").map(str::trim_start).and_then(|l| l.strip_prefix('=')) {
            return value.trim().trim_matches(|c| c == '"' || c == '\'') == url;
        }
    }
    false
}

impl AgentClient {
    pub fn name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
            Self::GeminiCli => "Gemini CLI",
            Self::Cursor => "Cursor",
            Self::Vscode => "VS Code",
            Self::Windsurf => "Windsurf",
            Self::Opencode => "OpenCode",
            Self::ClaudeDesktop => "Claude Desktop",
        }
    }

    fn how(self) -> How {
        match self {
            Self::ClaudeCode => How::Command(Command {
                program: "claude",
                add: |url| strings(&["mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, url]),
                remove: &["mcp", "remove", "--scope", "user", SERVER_NAME],
                settings: |env| env.home.join(".claude.json"),
                connected: |text, url| json_entry(text, "mcpServers").is_some_and(|e| e["url"] == url),
            }),
            Self::Codex => How::Command(Command {
                program: "codex",
                add: |url| strings(&["mcp", "add", SERVER_NAME, "--url", url]),
                remove: &["mcp", "remove", SERVER_NAME],
                settings: |env| env.codex_home.join("config.toml"),
                connected: codex_has,
            }),
            Self::GeminiCli => How::Command(Command {
                program: "gemini",
                add: |url| strings(&["mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, url]),
                remove: &["mcp", "remove", "--scope", "user", SERVER_NAME],
                settings: |env| env.home.join(".gemini/settings.json"),
                connected: |text, url| json_entry(text, "mcpServers").is_some_and(|e| e["httpUrl"] == url || e["url"] == url),
            }),
            Self::Cursor => How::File(SettingsFile {
                file: |env| env.home.join(".cursor/mcp.json"),
                folder: |env| env.home.join(".cursor"),
                program: Some("cursor"),
                section: "mcpServers",
                entry: |url, _| json!({ "url": url }),
            }),
            Self::Vscode => How::File(SettingsFile {
                file: |env| env.app_config.join("Code/User/mcp.json"),
                folder: |env| env.app_config.join("Code"),
                program: Some("code"),
                section: "servers",
                entry: |url, _| json!({ "type": "http", "url": url }),
            }),
            Self::Windsurf => How::File(SettingsFile {
                file: |env| env.home.join(".codeium/windsurf/mcp_config.json"),
                folder: |env| env.home.join(".codeium/windsurf"),
                program: Some("windsurf"),
                section: "mcpServers",
                entry: |url, _| json!({ "serverUrl": url }),
            }),
            Self::Opencode => How::File(SettingsFile {
                file: |env| env.xdg_config.join("opencode/opencode.json"),
                folder: |env| env.xdg_config.join("opencode"),
                program: Some("opencode"),
                section: "mcp",
                entry: |url, _| json!({ "type": "remote", "url": url, "enabled": true }),
            }),
            // Claude Desktop starts local servers only: this program, as a bridge to the app.
            Self::ClaudeDesktop => How::File(SettingsFile {
                file: |env| env.app_config.join("Claude/claude_desktop_config.json"),
                folder: |env| env.app_config.join("Claude"),
                program: None,
                section: "mcpServers",
                entry: |_, env| json!({ "command": env.executable.to_string_lossy(), "args": ["mcp"] }),
            }),
        }
    }
}

/// An agent as the dashboard lists it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentClientDto {
    pub id: AgentClient,
    pub name: &'static str,
    /// Found on this computer: its command, or its settings folder.
    pub installed: bool,
    /// Already set up to reach this app at its current address.
    pub connected: bool,
    pub manual: ManualSetup,
}

/// How to connect an agent by hand.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ManualSetup {
    /// A command to run in a terminal.
    Command { text: String },
    /// JSON to merge into a settings file.
    Json { file: String, text: String },
}

fn shell_word(text: &str) -> String {
    if text.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=@".contains(c)) {
        text.to_owned()
    } else {
        format!("'{}'", text.replace('\'', r"'\''"))
    }
}

pub fn describe(client: AgentClient, url: &str, env: &Environment) -> AgentClientDto {
    let (installed, connected, manual) = match client.how() {
        How::Command(command) => {
            let installed = env.find(command.program).is_some();
            let settings = std::fs::read_to_string((command.settings)(env)).unwrap_or_default();
            let words: Vec<String> = std::iter::once(command.program.to_owned()).chain((command.add)(url)).collect();
            let text = words.iter().map(|w| shell_word(w)).collect::<Vec<_>>().join(" ");
            (installed, (command.connected)(&settings, url), ManualSetup::Command { text })
        }
        How::File(file) => {
            let path = (file.file)(env);
            let entry = (file.entry)(url, env);
            let installed = (file.folder)(env).is_dir() || file.program.and_then(|p| env.find(p)).is_some();
            let connected =
                std::fs::read_to_string(&path).ok().and_then(|t| json_entry(&t, file.section)).as_ref() == Some(&entry);
            let text = serde_json::to_string_pretty(&json!({ file.section: { SERVER_NAME: entry } })).expect("JSON");
            (installed, connected, ManualSetup::Json { file: path.to_string_lossy().into_owned(), text })
        }
    };
    AgentClientDto { id: client, name: client.name(), installed, connected, manual }
}

pub fn describe_all(url: &str, env: &Environment) -> Vec<AgentClientDto> {
    ALL.into_iter().map(|client| describe(client, url, env)).collect()
}

async fn run(program: &Path, args: &[String]) -> std::io::Result<std::process::Output> {
    run_for(program, args, TIMEOUT).await
}

async fn run_for(program: &Path, args: &[String], timeout: Duration) -> std::io::Result<std::process::Output> {
    // npm installs a .cmd shim on Windows, which only cmd can start.
    let mut command = if program.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd")) {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(program);
        c
    } else {
        tokio::process::Command::new(program)
    };
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    tokio::time::timeout(timeout, command.output())
        .await
        .unwrap_or_else(|_| Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out")))
}

/// Adds the server to `client`'s settings (or points it at `url` again). Not installed is an error;
/// the dashboard offers the setup by hand instead.
pub async fn connect(client: AgentClient, url: &str, env: &Environment) -> ApiResult<()> {
    let name = client.name();
    match client.how() {
        How::Command(command) => {
            let program = env.find(command.program).ok_or_else(|| not_found(name))?;
            // An earlier entry may point at another port, and `add` won't overwrite it.
            let _ = run(&program, &strings(command.remove)).await;
            let output =
                run(&program, &(command.add)(url)).await.map_err(|e| ApiError::bad(format!("Could not run {name}: {e}")))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let detail = stderr.trim().lines().last().unwrap_or("no details");
                return Err(ApiError::bad(format!("{name} could not add the server: {detail}")));
            }
        }
        How::File(file) => {
            if !describe(client, url, env).installed {
                return Err(not_found(name));
            }
            let entry = (file.entry)(url, env);
            edit_settings(&(file.file)(env), |settings| {
                let section = settings.entry(file.section).or_insert_with(|| json!({}));
                let Some(section) = section.as_object_mut() else {
                    return Err(format!("its \"{}\" setting isn't an object", file.section));
                };
                section.insert(SERVER_NAME.to_owned(), entry);
                Ok(())
            })
            .map_err(|e| ApiError::bad(format!("Could not change {name}'s settings: {e}. Add the setup below by hand.")))?;
        }
    }
    tracing::info!("Connected {name} to the MCP server at {url}");
    Ok(())
}

fn not_found(name: &str) -> ApiError {
    ApiError::bad(format!("{name} isn't installed where Magnetar can find it. Set it up by hand below."))
}

/// Changes a JSON settings file the way its program would: other settings untouched and in their
/// order, the file replaced in one step, and a copy of the original kept once as `.before-magnetar`.
/// A file that isn't plain JSON (comments, trailing commas) is left alone.
fn edit_settings(path: &Path, change: impl FnOnce(&mut Map<String, Value>) -> Result<(), String>) -> Result<(), String> {
    let original = match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let mut settings = match original.as_deref().map(str::trim) {
        None | Some("") => Map::new(),
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => map,
            Ok(_) => return Err(format!("{name} isn't a JSON object")),
            Err(_) => return Err(format!("{name} isn't plain JSON (it may have comments), so it was left as it is")),
        },
    };
    change(&mut settings)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Some(original) = &original {
        let backup = path.with_file_name(format!("{}.before-magnetar", path.file_name().unwrap_or_default().to_string_lossy()));
        if !backup.exists() {
            std::fs::write(&backup, original).map_err(|e| e.to_string())?;
        }
    }
    let mut text = serde_json::to_string_pretty(&Value::Object(settings)).expect("JSON");
    text.push('\n');
    let temporary =
        path.with_file_name(format!(".{}.{}.tmp", path.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
    std::fs::write(&temporary, text).map_err(|e| e.to_string())?;
    if let Ok(metadata) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&temporary, metadata.permissions());
    }
    std::fs::rename(&temporary, path).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "http://localhost:47820/mcp";

    fn scratch() -> (tempfile::TempDir, Environment) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let env = Environment {
            app_config: home.join("Library/Application Support"),
            xdg_config: home.join(".config"),
            codex_home: home.join(".codex"),
            path: vec![dir.path().join("bin")],
            executable: PathBuf::from("/Applications/Magnetar.app/Contents/MacOS/Magnetar"),
            home,
        };
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        (dir, env)
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn an_agent_nobody_installed_is_listed_with_its_setup_and_cannot_be_connected() {
        let (_dir, env) = scratch();
        let all = describe_all(URL, &env);
        assert_eq!(all.len(), ALL.len());
        assert!(all.iter().all(|c| !c.installed && !c.connected));
        let cursor = describe(AgentClient::Cursor, URL, &env);
        assert_eq!(
            cursor.manual,
            ManualSetup::Json {
                file: env.home.join(".cursor/mcp.json").to_string_lossy().into_owned(),
                text: "{\n  \"mcpServers\": {\n    \"magnetar\": {\n      \"url\": \"http://localhost:47820/mcp\"\n    }\n  }\n}"
                    .into(),
            }
        );
        let codex = describe(AgentClient::Codex, URL, &env);
        assert_eq!(codex.manual, ManualSetup::Command { text: "codex mcp add magnetar --url http://localhost:47820/mcp".into() });
    }

    #[tokio::test]
    async fn connecting_a_missing_agent_says_so() {
        let (_dir, env) = scratch();
        for client in [AgentClient::Cursor, AgentClient::ClaudeCode] {
            let error = connect(client, URL, &env).await.unwrap_err();
            assert!(error.message.contains("isn't installed"), "{}", error.message);
        }
        assert!(!env.home.join(".cursor").exists(), "nothing is created for an agent that isn't there");
    }

    #[tokio::test]
    async fn a_settings_file_keeps_everything_else_in_order_and_a_backup() {
        let (_dir, env) = scratch();
        let file = env.home.join(".cursor/mcp.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let original = r#"{"zeta": 1, "mcpServers": {"github": {"url": "https://api.githubcopilot.com/mcp/"}, "magnetar": {"url": "http://localhost:1/mcp"}}, "alpha": [true]}"#;
        std::fs::write(&file, original).unwrap();

        assert!(!describe(AgentClient::Cursor, URL, &env).connected, "an old address is not connected");
        connect(AgentClient::Cursor, URL, &env).await.unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            text,
            "{\n  \"zeta\": 1,\n  \"mcpServers\": {\n    \"github\": {\n      \"url\": \"https://api.githubcopilot.com/mcp/\"\n    },\n    \"magnetar\": {\n      \"url\": \"http://localhost:47820/mcp\"\n    }\n  },\n  \"alpha\": [\n    true\n  ]\n}\n"
        );
        assert_eq!(std::fs::read_to_string(file.with_file_name("mcp.json.before-magnetar")).unwrap(), original);
        assert!(describe(AgentClient::Cursor, URL, &env).connected);

        // Connecting again changes nothing and keeps the first backup.
        connect(AgentClient::Cursor, "http://localhost:47821/mcp", &env).await.unwrap();
        connect(AgentClient::Cursor, URL, &env).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
        assert_eq!(std::fs::read_to_string(file.with_file_name("mcp.json.before-magnetar")).unwrap(), original);
        let leftovers: Vec<_> = std::fs::read_dir(file.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(leftovers.len(), 2, "{leftovers:?}");
    }

    #[tokio::test]
    async fn each_file_agent_gets_its_own_shape_in_its_own_place() {
        let (_dir, env) = scratch();
        let cases = [
            (
                AgentClient::Vscode,
                env.app_config.join("Code"),
                env.app_config.join("Code/User/mcp.json"),
                "servers",
                json!({ "type": "http", "url": URL }),
            ),
            (
                AgentClient::Windsurf,
                env.home.join(".codeium/windsurf"),
                env.home.join(".codeium/windsurf/mcp_config.json"),
                "mcpServers",
                json!({ "serverUrl": URL }),
            ),
            (
                AgentClient::Opencode,
                env.xdg_config.join("opencode"),
                env.xdg_config.join("opencode/opencode.json"),
                "mcp",
                json!({ "type": "remote", "url": URL, "enabled": true }),
            ),
            (
                AgentClient::ClaudeDesktop,
                env.app_config.join("Claude"),
                env.app_config.join("Claude/claude_desktop_config.json"),
                "mcpServers",
                json!({ "command": "/Applications/Magnetar.app/Contents/MacOS/Magnetar", "args": ["mcp"] }),
            ),
        ];
        for (client, folder, file, section, entry) in cases {
            std::fs::create_dir_all(&folder).unwrap();
            assert!(describe(client, URL, &env).installed, "{client:?}");
            connect(client, URL, &env).await.unwrap();
            assert_eq!(read(&file), json!({ section: { "magnetar": entry } }), "{client:?}");
            assert!(describe(client, URL, &env).connected, "{client:?}");
            assert!(
                !file.with_file_name(format!("{}.before-magnetar", file.file_name().unwrap().to_string_lossy())).exists(),
                "no backup of nothing"
            );
        }
    }

    #[tokio::test]
    async fn a_file_that_is_not_plain_json_is_left_alone() {
        let (_dir, env) = scratch();
        let file = env.xdg_config.join("opencode/opencode.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        for text in ["{\n  // my servers\n  \"mcp\": {}\n}", "[1, 2]", "{\"mcp\": \"none\"}", "{\"mcp\": {},}"] {
            std::fs::write(&file, text).unwrap();
            let error = connect(AgentClient::Opencode, URL, &env).await.unwrap_err();
            assert!(error.message.contains("by hand"), "{}", error.message);
            assert_eq!(std::fs::read_to_string(&file).unwrap(), text, "untouched");
        }
    }

    #[test]
    fn command_agents_read_as_connected_from_their_own_settings() {
        let (_dir, env) = scratch();
        std::fs::write(
            env.home.join(".claude.json").tap_parent(),
            json!({ "mcpServers": { "magnetar": { "type": "http", "url": URL } } }).to_string(),
        )
        .unwrap();
        assert!(describe(AgentClient::ClaudeCode, URL, &env).connected);
        assert!(!describe(AgentClient::ClaudeCode, "http://localhost:1/mcp", &env).connected);

        std::fs::write(
            env.home.join(".gemini/settings.json").tap_parent(),
            json!({ "mcpServers": { "magnetar": { "httpUrl": URL } } }).to_string(),
        )
        .unwrap();
        assert!(describe(AgentClient::GeminiCli, URL, &env).connected);

        let config = env.codex_home.join("config.toml").tap_parent();
        std::fs::write(
            &config,
            format!("model = \"o5\"\n\n[mcp_servers.other]\nurl = \"{URL}\"\n\n[mcp_servers.magnetar]\nurl = \"{URL}\"\n"),
        )
        .unwrap();
        assert!(describe(AgentClient::Codex, URL, &env).connected);
        std::fs::write(&config, format!("[mcp_servers.other]\nurl = \"{URL}\"\n[mcp_servers.magnetar]\ncommand = \"x\"\n"))
            .unwrap();
        assert!(!describe(AgentClient::Codex, URL, &env).connected, "another server's url doesn't count");
    }

    #[test]
    fn codex_urls_are_read_whole() {
        assert!(codex_has(&format!("[mcp_servers.magnetar]\n  url = '{URL}'\n"), URL));
        assert!(!codex_has(&format!("[mcp_servers.magnetar]\nurl = \"{URL}/x\"\n"), URL));
        assert!(!codex_has(&format!("[mcp_servers.magnetar-old]\nurl = \"{URL}\"\n"), URL));
        assert!(!codex_has(&format!("url = \"{URL}\"\n"), URL));
        assert!(!codex_has("", URL));
    }

    #[test]
    fn manual_commands_quote_what_a_shell_would_split() {
        assert_eq!(shell_word("http://localhost:47820/mcp"), "http://localhost:47820/mcp");
        assert_eq!(shell_word("http://my host/mcp"), "'http://my host/mcp'");
        assert_eq!(shell_word("it's"), r"'it'\''s'");
    }

    trait TapParent {
        fn tap_parent(self) -> Self;
    }

    impl TapParent for PathBuf {
        /// Creates the folder the file goes in.
        fn tap_parent(self) -> Self {
            std::fs::create_dir_all(self.parent().unwrap()).unwrap();
            self
        }
    }

    #[cfg(unix)]
    mod commands {
        use std::os::unix::fs::PermissionsExt;

        use super::*;

        /// A stand-in for an agent's command that logs how it was run.
        fn fake(env: &Environment, dir: &Path, program: &str, script: &str) -> PathBuf {
            let log = dir.join(format!("{program}.log"));
            let path = env.path[0].join(program);
            std::fs::write(&path, format!("#!/bin/sh\necho \"$@\" >> '{}'\n{script}\n", log.display())).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            log
        }

        #[tokio::test]
        async fn each_command_agent_replaces_any_earlier_entry() {
            let (dir, env) = scratch();
            let expected = [
                (
                    AgentClient::ClaudeCode,
                    "claude",
                    "mcp remove --scope user magnetar\nmcp add --transport http --scope user magnetar http://localhost:47820/mcp\n",
                ),
                (AgentClient::Codex, "codex", "mcp remove magnetar\nmcp add magnetar --url http://localhost:47820/mcp\n"),
                (
                    AgentClient::GeminiCli,
                    "gemini",
                    "mcp remove --scope user magnetar\nmcp add --transport http --scope user magnetar http://localhost:47820/mcp\n",
                ),
            ];
            for (client, program, calls) in expected {
                let log = fake(&env, dir.path(), program, "exit 0");
                assert!(describe(client, URL, &env).installed);
                connect(client, URL, &env).await.unwrap();
                assert_eq!(std::fs::read_to_string(&log).unwrap(), calls, "{client:?}");
            }
        }

        #[tokio::test]
        async fn a_failing_command_reports_its_last_line() {
            let (dir, env) = scratch();
            fake(
                &env,
                dir.path(),
                "codex",
                "[ \"$2\" = add ] && { echo 'warming up' >&2; echo 'no such flag: --url' >&2; exit 2; }\nexit 0",
            );
            let error = connect(AgentClient::Codex, URL, &env).await.unwrap_err();
            assert_eq!(error.message, "Codex could not add the server: no such flag: --url");
        }

        #[tokio::test]
        async fn a_command_that_hangs_is_given_up_on() {
            let (dir, env) = scratch();
            fake(&env, dir.path(), "gemini", "exec sleep 60");
            let started = std::time::Instant::now();
            let error = run_for(&env.find("gemini").unwrap(), &[], Duration::from_millis(300)).await.unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
            assert!(started.elapsed() < Duration::from_secs(5));
        }
    }
}
