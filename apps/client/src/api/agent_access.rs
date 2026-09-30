use std::sync::{Arc, Mutex};

use subtle::ConstantTimeEq;

use crate::db::{SecretName, SecretStore, write_private};
use crate::paths::Paths;
use crate::protocol::AgentStatusDto;
use crate::protocol::encoding::random_id;
use crate::settings::SettingsService;

/// 256 bits, base64url so it survives a shell or a JSON config.
pub fn generate_token() -> String {
    random_id(32)
}

/// Constant-time comparison, so timing doesn't reveal how much of a guess was right.
pub fn token_matches(presented: Option<&str>, expected: &str) -> bool {
    match presented {
        Some(presented) if !presented.is_empty() && !expected.is_empty() => {
            presented.len() == expected.len() && bool::from(presented.as_bytes().ct_eq(expected.as_bytes()))
        }
        _ => false,
    }
}

/// The agent API switch, its bearer token, and the endpoint file MCP clients discover it through.
pub struct AgentAccess {
    settings: Arc<SettingsService>,
    secrets: Arc<SecretStore>,
    paths: Paths,
    base_url: Mutex<String>,
}

impl AgentAccess {
    pub fn new(settings: Arc<SettingsService>, secrets: Arc<SecretStore>, paths: Paths) -> Self {
        Self { settings, secrets, paths, base_url: Mutex::new(format!("http://localhost:{}", crate::config::DEFAULT_PORT)) }
    }

    pub fn enabled(&self) -> bool {
        self.settings.get().agent_api_enabled
    }

    pub fn allow_remote(&self) -> bool {
        self.settings.get().agent_api_allow_remote
    }

    pub fn token(&self) -> String {
        self.secrets.get(SecretName::AgentApiToken)
    }

    fn base_url(&self) -> String {
        self.base_url.lock().unwrap().clone()
    }

    pub fn status(&self) -> AgentStatusDto {
        let mcp_url = format!("{}/mcp", self.base_url());
        AgentStatusDto {
            enabled: self.enabled(),
            allow_remote: self.allow_remote(),
            token: self.token(),
            claude_command: crate::system::claude::command(&mcp_url),
            mcp_url,
            endpoint_file: self.paths.endpoint.to_string_lossy().into_owned(),
        }
    }

    pub fn set(&self, enabled: Option<bool>, allow_remote: Option<bool>) -> AgentStatusDto {
        if enabled == Some(true) && self.token().is_empty() {
            self.secrets.set(SecretName::AgentApiToken, &generate_token());
        }
        self.settings.update(|s| {
            if let Some(enabled) = enabled {
                s.agent_api_enabled = enabled;
            }
            if let Some(allow_remote) = allow_remote {
                s.agent_api_allow_remote = allow_remote;
            }
        });
        self.write_endpoint_file();
        self.status()
    }

    pub fn regenerate(&self) -> AgentStatusDto {
        self.secrets.set(SecretName::AgentApiToken, &generate_token());
        self.write_endpoint_file();
        self.status()
    }

    /// Publishes the resolved URLs and token for MCP clients.
    pub fn publish(&self, base_url: &str) {
        *self.base_url.lock().unwrap() = base_url.to_owned();
        self.write_endpoint_file();
    }

    /// Owner-only, written atomically so readers never see half a file.
    fn write_endpoint_file(&self) {
        let base_url = self.base_url();
        let json = serde_json::to_string_pretty(&serde_json::json!({
            "baseUrl": base_url,
            "apiUrl": format!("{base_url}/api"),
            "mcpUrl": format!("{base_url}/mcp"),
            "token": self.token(),
        }))
        .expect("JSON");
        let temporary = self.paths.endpoint.with_extension(format!("{}.tmp", std::process::id()));
        let written =
            write_private(&temporary, json.as_bytes(), false).and_then(|_| std::fs::rename(&temporary, &self.paths.endpoint));
        if let Err(error) = written {
            tracing::warn!("Could not write the agent endpoint file: {error}");
        }
    }
}
