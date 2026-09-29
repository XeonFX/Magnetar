//! Data shapes shared with the dashboard (`packages/protocol/src/model.ts`), plus the validation the
//! TypeScript side does with zod.

use serde::{Deserialize, Deserializer, Serialize};

use crate::downloads::engine::MIN_SPEED_LIMIT;
use crate::error::{ApiError, ApiResult};

pub const DOWNLOAD_STATUSES: [&str; 7] = ["Queued", "FetchingMetadata", "Downloading", "Seeding", "Paused", "Completed", "Error"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DownloadStatus {
    Queued,
    FetchingMetadata,
    Downloading,
    Seeding,
    Paused,
    Completed,
    Error,
}

impl DownloadStatus {
    pub fn as_str(self) -> &'static str {
        DOWNLOAD_STATUSES[self as usize]
    }

    pub fn parse(value: &str) -> Option<Self> {
        use DownloadStatus::*;
        [Queued, FetchingMetadata, Downloading, Seeding, Paused, Completed, Error]
            .into_iter()
            .find(|s| s.as_str().eq_ignore_ascii_case(value))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum PostDownloadAction {
    #[default]
    StopSeeding,
    KeepSeeding,
    /// Seed until as much has been uploaded as `seedRatio` times the download's size.
    SeedToRatio,
}

/// When the alternative speed limits apply instead of the usual ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AltSpeedMode {
    #[default]
    Off,
    On,
    Scheduled,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EngineState {
    Running,
    Starting,
    /// The chosen network interface (a VPN) is not up, so nothing downloads.
    WaitingForNetwork,
    Failed,
    /// No engine at all (tests).
    Off,
}

/// The torrent engine and its limits, as the Downloads page shows them.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransferStatusDto {
    pub engine: EngineState,
    pub message: Option<String>,
    pub network_interface: Option<String>,
    pub alt_speed_active: bool,
    /// The caps in force now, bytes per second; 0 is none.
    pub download_limit: u64,
    pub upload_limit: u64,
    /// Free space where new downloads go.
    pub free_bytes: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceDto {
    pub name: String,
    pub addresses: Vec<String>,
    /// Named like a VPN tunnel (utun, tun, wg, ppp, ipsec…).
    pub vpn: bool,
}

/// One file of a download's torrent.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFileDto {
    pub index: usize,
    /// Relative to the download's folder, with `/` separators.
    pub path: String,
    pub size: u64,
    /// Verified bytes so far.
    pub done: u64,
    pub selected: bool,
    /// A video or audio file the dashboard can play.
    pub playable: bool,
}

/// How many of a torrent's files are being downloaded, when not all of them.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct FileSelectionDto {
    pub selected: u32,
    pub total: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct SourceDto {
    pub name: String,
    pub enabled: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultDto {
    pub result_id: String,
    pub title: String,
    pub source: String,
    pub size_bytes: u64,
    pub seeders: u32,
    pub leechers: u32,
    pub published_at: Option<String>,
    pub details_url: Option<String>,
    pub info_hash: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceOutcomeDto {
    pub source: String,
    /// "ok" or "failed"
    pub status: &'static str,
    pub returned: usize,
    pub filtered: usize,
    pub error: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub results: Vec<SearchResultDto>,
    pub sources: Vec<SourceOutcomeDto>,
    pub total_matched: usize,
    pub truncated: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TorrentDetailsDto {
    pub result: SearchResultDto,
    pub description: Option<String>,
    pub magnet_uri: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadDto {
    pub id: i64,
    pub name: String,
    pub status: DownloadStatus,
    pub progress: f64,
    pub total_bytes: u64,
    pub download_speed: u64,
    pub upload_speed: u64,
    pub peers: u32,
    pub source: String,
    pub save_path: String,
    pub added_at: String,
    pub completed_at: Option<String>,
    pub error: Option<String>,
    pub series_task_id: Option<i64>,
    pub uploaded_bytes: u64,
    pub partial_files: Option<FileSelectionDto>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SeriesTaskDto {
    pub id: i64,
    pub name: String,
    pub query: String,
    pub provider: Option<String>,
    pub title_filter: Option<String>,
    pub season: Option<i64>,
    pub start_episode: i64,
    pub end_episode: Option<i64>,
    pub last_downloaded_episode: i64,
    pub next_episode: i64,
    pub check_interval_minutes: i64,
    pub enabled: bool,
    pub download_folder: Option<String>,
    pub last_checked_at: Option<String>,
    pub finished: bool,
}

/// Secret fields are write-only: reads say whether one is set, never what it is.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    pub download_folder: String,
    pub post_download_action: PostDownloadAction,
    pub seed_ratio: f64,
    pub download_limit: u64,
    pub upload_limit: u64,
    pub alt_download_limit: u64,
    pub alt_upload_limit: u64,
    pub alt_speed_mode: AltSpeedMode,
    pub alt_schedule_from: u16,
    pub alt_schedule_to: u16,
    pub alt_schedule_days: Vec<u8>,
    pub network_interface: String,
    pub disabled_providers: Vec<String>,
    pub language: String,
    pub notify_on_start: bool,
    pub notify_on_complete: bool,
    pub email_enabled: bool,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_use_ssl: bool,
    pub smtp_username: String,
    pub smtp_password_set: bool,
    pub email_from: String,
    pub email_to: String,
    pub desktop_enabled: bool,
    pub push_enabled: bool,
    pub ntfy_server: String,
    pub ntfy_topic: String,
    pub telegram_enabled: bool,
    pub telegram_bot_token_set: bool,
    pub telegram_chat_id: String,
    pub error_reports_enabled: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct FolderListing {
    pub path: String,
    pub parent: Option<String>,
    pub folders: Vec<String>,
    pub exists: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LoginStartupStatus {
    Unavailable,
    Disabled,
    Enabled,
    RequiresApproval,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdateDto {
    pub version: String,
    pub tag: String,
    pub release_url: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusDto {
    pub current_version: String,
    pub available: Option<AvailableUpdateDto>,
    pub can_self_install: bool,
    pub checking: bool,
    pub installing: bool,
    pub last_checked_at: Option<String>,
    pub last_check_error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusDto {
    pub enabled: bool,
    pub allow_remote: bool,
    pub token: String,
    pub base_url: String,
    pub mcp_url: String,
    pub endpoint_file: String,
}

/// Outcome of registering this device's MCP server with Claude Code on the device.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeConnectResultDto {
    /// "connected", or "cliNotFound" when the user has to run `command` themselves.
    pub status: &'static str,
    pub command: String,
    pub agent: AgentStatusDto,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LinkedBrowserDto {
    pub key_id: String,
    pub label: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PendingPairingDto {
    pub url: String,
    pub expires_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatusDto {
    pub cloud_url: String,
    pub paired: bool,
    pub device_id: Option<String>,
    pub device_name: String,
    pub account_email: Option<String>,
    pub connected: bool,
    pub pending_pairing: Option<PendingPairingDto>,
    pub browsers: Vec<LinkedBrowserDto>,
    pub last_error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportStatusDto {
    pub available: bool,
    pub path: Option<String>,
    pub imported: bool,
    pub downloads: i64,
    pub series_tasks: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportResultDto {
    pub downloads: usize,
    pub series_tasks: usize,
    pub settings: bool,
    /// Secrets the legacy app encrypted with a key this app can't read; re-enter them in Settings.
    pub secrets_to_reenter: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppInfoDto {
    pub version: &'static str,
    pub platform: &'static str,
    pub arch: &'static str,
    pub data_directory: String,
    pub native_folder_picker: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct NotificationEvent {
    /// started | completed | update | test
    pub kind: &'static str,
    pub title: String,
    pub message: String,
}

// ---- Inputs ----

/// Present-and-null vs absent, for PATCH-style inputs: `None` = keep, `Some(None)` = clear.
pub fn double_option<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Ok(Some(Option::deserialize(d)?))
}

/// A nullable field that must still be present (the REST PUT body).
fn required_nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::deserialize(d)
}

fn default_start_episode() -> i64 {
    1
}

fn default_check_interval() -> i64 {
    60
}

fn default_true() -> bool {
    true
}

/// A new series rule; omitted fields take their defaults.
#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SeriesTaskInput {
    pub name: String,
    pub query: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub title_filter: Option<String>,
    #[serde(default)]
    pub season: Option<i64>,
    #[serde(default = "default_start_episode")]
    pub start_episode: i64,
    #[serde(default)]
    pub end_episode: Option<i64>,
    #[serde(default = "default_check_interval")]
    pub check_interval_minutes: i64,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub download_folder: Option<String>,
}

/// Every field of a rule, required (REST PUT), so an omission can't silently reset one.
#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SeriesTaskReplacement {
    pub name: String,
    pub query: String,
    #[serde(deserialize_with = "required_nullable")]
    pub provider: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub title_filter: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub season: Option<i64>,
    pub start_episode: i64,
    #[serde(deserialize_with = "required_nullable")]
    pub end_episode: Option<i64>,
    pub check_interval_minutes: i64,
    pub enabled: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub download_folder: Option<String>,
}

/// A partial change: anything omitted keeps its current value. Null clears a nullable field.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SeriesTaskPatch {
    pub name: Option<String>,
    pub query: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub provider: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub title_filter: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub season: Option<Option<i64>>,
    pub start_episode: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    pub end_episode: Option<Option<i64>>,
    pub check_interval_minutes: Option<i64>,
    pub enabled: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub download_folder: Option<Option<String>>,
}

impl From<SeriesTaskReplacement> for SeriesTaskPatch {
    fn from(r: SeriesTaskReplacement) -> Self {
        Self {
            name: Some(r.name),
            query: Some(r.query),
            provider: Some(r.provider),
            title_filter: Some(r.title_filter),
            season: Some(r.season),
            start_episode: Some(r.start_episode),
            end_episode: Some(r.end_episode),
            check_interval_minutes: Some(r.check_interval_minutes),
            enabled: Some(r.enabled),
            download_folder: Some(r.download_folder),
        }
    }
}

impl SeriesTaskInput {
    /// Trims, turns blank optional text into null, and checks what a create would reject.
    pub fn validated(mut self) -> ApiResult<Self> {
        fn optional_text(value: Option<String>) -> Option<String> {
            value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
        }
        self.name = self.name.trim().to_owned();
        self.query = self.query.trim().to_owned();
        self.provider = optional_text(self.provider);
        self.title_filter = optional_text(self.title_filter);
        self.download_folder = optional_text(self.download_folder);
        let mut problems = Vec::new();
        if self.name.is_empty() {
            problems.push("A series task needs a name.");
        }
        if self.query.is_empty() {
            problems.push("A series task needs a search query, otherwise it can never match an episode.");
        }
        if self.season.is_some_and(|s| s < 0) {
            problems.push("season cannot be negative.");
        }
        if self.start_episode < 1 || self.end_episode.is_some_and(|e| e < 1) {
            problems.push("Episodes are numbered from 1.");
        }
        if self.check_interval_minutes < 1 {
            problems.push("checkIntervalMinutes must be at least 1.");
        }
        if self.end_episode.is_some_and(|end| end < self.start_episode) {
            problems.push("endEpisode cannot be before startEpisode.");
        }
        if problems.is_empty() { Ok(self) } else { Err(ApiError::bad(problems.join(" "))) }
    }
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StartDownloadInput {
    pub result_id: Option<String>,
    pub magnet: Option<String>,
    /// A .torrent file, base64.
    pub torrent: Option<String>,
    pub folder: Option<String>,
}

/// A partial settings change. Secrets are set by value and cleared with an empty string.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SettingsPatch {
    pub download_folder: Option<String>,
    pub post_download_action: Option<PostDownloadAction>,
    pub seed_ratio: Option<f64>,
    pub download_limit: Option<u64>,
    pub upload_limit: Option<u64>,
    pub alt_download_limit: Option<u64>,
    pub alt_upload_limit: Option<u64>,
    pub alt_speed_mode: Option<AltSpeedMode>,
    pub alt_schedule_from: Option<u16>,
    pub alt_schedule_to: Option<u16>,
    pub alt_schedule_days: Option<Vec<u8>>,
    pub network_interface: Option<String>,
    pub disabled_providers: Option<Vec<String>>,
    pub language: Option<String>,
    pub notify_on_start: Option<bool>,
    pub notify_on_complete: Option<bool>,
    pub email_enabled: Option<bool>,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<i64>,
    pub smtp_use_ssl: Option<bool>,
    pub smtp_username: Option<String>,
    pub smtp_password: Option<String>,
    pub email_from: Option<String>,
    pub email_to: Option<String>,
    pub desktop_enabled: Option<bool>,
    pub push_enabled: Option<bool>,
    pub ntfy_server: Option<String>,
    pub ntfy_topic: Option<String>,
    pub telegram_enabled: Option<bool>,
    pub telegram_bot_token: Option<String>,
    pub telegram_chat_id: Option<String>,
    pub error_reports_enabled: Option<bool>,
}

pub fn is_email(text: &str) -> bool {
    let Some((local, domain)) = text.split_once('@') else { return false };
    !local.is_empty()
        && !text.chars().any(char::is_whitespace)
        && !domain.contains('@')
        && domain.split('.').count() >= 2
        && domain.split('.').all(|label| !label.is_empty())
}

impl SettingsPatch {
    /// Trims text fields and rejects values the dashboard would have refused.
    pub fn validated(mut self) -> ApiResult<Self> {
        let trim = |v: &mut Option<String>| {
            if let Some(text) = v {
                *text = text.trim().to_owned();
            }
        };
        for field in [
            &mut self.download_folder,
            &mut self.network_interface,
            &mut self.smtp_host,
            &mut self.smtp_username,
            &mut self.ntfy_topic,
            &mut self.telegram_bot_token,
            &mut self.telegram_chat_id,
        ] {
            trim(field);
        }
        let mut problems = Vec::new();
        if self.download_folder.as_deref() == Some("") {
            problems.push("downloadFolder: Download folder is required".to_owned());
        }
        if let Some(language) = &self.language
            && (language.len() != 2 || !language.bytes().all(|b| b.is_ascii_lowercase()))
        {
            problems.push("language: expected a two-letter language code".to_owned());
        }
        if self.seed_ratio.is_some_and(|r| !(0.1..=100.0).contains(&r)) {
            problems.push("seedRatio: must be between 0.1 and 100".to_owned());
        }
        for (name, value) in [
            ("downloadLimit", self.download_limit),
            ("uploadLimit", self.upload_limit),
            ("altDownloadLimit", self.alt_download_limit),
            ("altUploadLimit", self.alt_upload_limit),
        ] {
            if value.is_some_and(|v| v != 0 && !(MIN_SPEED_LIMIT..=u32::MAX as u64).contains(&v)) {
                problems.push(format!("{name}: must be 0 (no limit) or at least {} KiB/s", MIN_SPEED_LIMIT / 1024));
            }
        }
        for (name, value) in [("altScheduleFrom", self.alt_schedule_from), ("altScheduleTo", self.alt_schedule_to)] {
            if value.is_some_and(|m| m >= 24 * 60) {
                problems.push(format!("{name}: minutes after midnight, below 1440"));
            }
        }
        if let Some(days) = &mut self.alt_schedule_days {
            days.sort_unstable();
            days.dedup();
            if days.iter().any(|d| *d > 6) {
                problems.push("altScheduleDays: days are 0 (Monday) to 6 (Sunday)".to_owned());
            }
        }
        if self.network_interface.as_deref().is_some_and(|n| n.len() > 64 || n.contains(['/', '\\', '\0'])) {
            problems.push("networkInterface: not an interface name".to_owned());
        }
        if self.smtp_port.is_some_and(|p| !(1..=65535).contains(&p)) {
            problems.push("smtpPort: must be between 1 and 65535".to_owned());
        }
        for (name, value) in [("emailFrom", &self.email_from), ("emailTo", &self.email_to)] {
            if value.as_deref().is_some_and(|v| !v.is_empty() && !is_email(v)) {
                problems.push(format!("{name}: Invalid email address"));
            }
        }
        if let Some(server) = self.ntfy_server.as_deref().filter(|s| !s.is_empty()) {
            let valid = url::Url::parse(server).is_ok_and(|u| matches!(u.scheme(), "http" | "https"));
            if !valid {
                problems.push("ntfyServer: Invalid URL".to_owned());
            }
        }
        if problems.is_empty() { Ok(self) } else { Err(ApiError::bad(problems.join("; "))) }
    }
}
