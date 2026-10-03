use std::sync::{Arc, Mutex};

use subtle::ConstantTimeEq;

use serde::{Deserialize, Serialize};

use crate::db::{SecretName, SecretStore, replace_file};
use crate::error::ApiResult;
use crate::paths::Paths;
use crate::protocol::AgentStatusDto;
use crate::protocol::encoding::random_token;
use crate::settings::{SettingsService, saving_failed};

/// 256 bits, base64url so it survives a shell or a JSON config.
pub fn generate_token() -> String {
    random_token(32)
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
            mcp_url,
            endpoint_file: self.paths.endpoint.to_string_lossy().into_owned(),
        }
    }

    /// Turns the API on or off and remote access with it. Turned on for the first time, it gets its
    /// token in the same transaction. Nothing is reported done that isn't saved.
    pub fn set(&self, enabled: Option<bool>, allow_remote: Option<bool>) -> ApiResult<AgentStatusDto> {
        let token = (enabled == Some(true) && self.token().is_empty()).then(generate_token);
        let secrets: Vec<(SecretName, &str)> = token.iter().map(|t| (SecretName::AgentApiToken, t.as_str())).collect();
        self.settings
            .update_with(&secrets, |s| {
                if let Some(enabled) = enabled {
                    s.agent_api_enabled = enabled;
                }
                if let Some(allow_remote) = allow_remote {
                    s.agent_api_allow_remote = allow_remote;
                }
            })
            .map_err(saving_failed)?;
        self.write_endpoint_file();
        Ok(self.status())
    }

    /// Replaces the token: the old one stops working once the new one is saved, and not before.
    pub fn regenerate(&self) -> ApiResult<AgentStatusDto> {
        self.secrets.set(SecretName::AgentApiToken, &generate_token()).map_err(saving_failed)?;
        self.write_endpoint_file();
        Ok(self.status())
    }

    /// Publishes the resolved URLs and token for MCP clients.
    pub fn publish(&self, base_url: &str) {
        *self.base_url.lock().unwrap() = base_url.to_owned();
        self.write_endpoint_file();
    }

    /// Owner-only, written atomically so readers never see half a file.
    fn write_endpoint_file(&self) {
        let base_url = self.base_url();
        let file = EndpointFile {
            api_url: format!("{base_url}/api"),
            mcp_url: format!("{base_url}/mcp"),
            token: self.token(),
            base_url,
        };
        let json = serde_json::to_string_pretty(&file).expect("JSON");
        if let Err(error) = replace_file(&self.paths.endpoint, json.as_bytes(), true) {
            tracing::warn!("Could not write the agent endpoint file: {error}");
        }
    }
}

/// `endpoint.json` in the data folder: where agents on this computer find the running app.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointFile {
    pub base_url: String,
    pub api_url: String,
    pub mcp_url: String,
    pub token: String,
}

impl EndpointFile {
    pub fn read(paths: &Paths) -> Option<Self> {
        serde_json::from_str(&std::fs::read_to_string(&paths.endpoint).ok()?).ok()
    }
}
