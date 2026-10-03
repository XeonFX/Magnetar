use std::sync::{Arc, Mutex};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::db::{Db, SecretName, SecretStore};
use crate::events::EventBus;
use crate::paths::default_download_folder;
use crate::protocol::{AltSpeedMode, PostDownloadAction, SettingsDto, SettingsPatch};

/// Everything persisted in the settings row. Secrets live in the SecretStore instead. New settings
/// need no migration: missing keys take their default.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub download_folder: String,
    pub post_download_action: PostDownloadAction,
    pub seed_ratio: f64,
    /// Bytes per second; 0 is no limit.
    pub download_limit: u64,
    pub upload_limit: u64,
    /// Used instead while the alternative limits are on (by hand or on schedule).
    pub alt_download_limit: u64,
    pub alt_upload_limit: u64,
    pub alt_speed_mode: AltSpeedMode,
    /// Local time, minutes after midnight. A window whose end is before its start runs overnight.
    pub alt_schedule_from: u16,
    pub alt_schedule_to: u16,
    /// The days (0 = Monday) a scheduled window starts on.
    pub alt_schedule_days: Vec<u8>,
    /// Empty: any interface. Otherwise torrent traffic only uses this one, and stops without it.
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
    pub email_from: String,
    pub email_to: String,
    pub desktop_enabled: bool,
    pub push_enabled: bool,
    pub ntfy_server: String,
    pub ntfy_topic: String,
    pub telegram_enabled: bool,
    pub telegram_chat_id: String,
    /// Off by default: enabling it lets any program on this machine search and start downloads.
    pub agent_api_enabled: bool,
    /// Remote agent requests still need HTTPS and the bearer token.
    pub agent_api_allow_remote: bool,
    /// Scrubbed error reports to CodeFusion Console (see telemetry.rs).
    pub error_reports_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            download_folder: default_download_folder().to_string_lossy().into_owned(),
            post_download_action: PostDownloadAction::StopSeeding,
            seed_ratio: 1.0,
            download_limit: 0,
            upload_limit: 0,
            alt_download_limit: 2 * 1024 * 1024,
            alt_upload_limit: 512 * 1024,
            alt_speed_mode: AltSpeedMode::Off,
            alt_schedule_from: 8 * 60,
            alt_schedule_to: 23 * 60,
            alt_schedule_days: (0..7).collect(),
            network_interface: String::new(),
            disabled_providers: Vec::new(),
            language: "en".into(),
            notify_on_start: true,
            notify_on_complete: true,
            email_enabled: false,
            smtp_host: String::new(),
            smtp_port: 587,
            smtp_use_ssl: true,
            smtp_username: String::new(),
            email_from: String::new(),
            email_to: String::new(),
            desktop_enabled: true,
            push_enabled: false,
            ntfy_server: "https://ntfy.sh".into(),
            ntfy_topic: String::new(),
            telegram_enabled: false,
            telegram_chat_id: String::new(),
            agent_api_enabled: false,
            agent_api_allow_remote: false,
            error_reports_enabled: true,
        }
    }
}

pub struct SettingsService {
    db: Db,
    pub secrets: Arc<SecretStore>,
    events: EventBus,
    cached: Mutex<Option<AppSettings>>,
}

impl SettingsService {
    pub fn new(db: Db, secrets: Arc<SecretStore>, events: EventBus) -> Self {
        Self { db, secrets, events, cached: Mutex::new(None) }
    }

    pub fn get(&self) -> AppSettings {
        let mut cached = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(settings) = cached.as_ref() {
            return settings.clone();
        }
        let row: Option<String> =
            self.db.lock().query_row("SELECT json FROM settings WHERE id = 1", [], |r| r.get(0)).optional().ok().flatten();
        let settings = row.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
        *cached = Some(settings);
        cached.clone().unwrap()
    }

    /// Writes a change to the non-secret settings and tells every dashboard.
    pub fn update(&self, change: impl FnOnce(&mut AppSettings)) -> AppSettings {
        let mut next = self.get();
        change(&mut next);
        let json = serde_json::to_string(&next).expect("settings serialize");
        let saved = self
            .db
            .lock()
            .execute("INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json", [json]);
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = Some(next.clone());
        if let Err(error) = saved {
            crate::log_failure!(&error, "Could not save settings: {error}");
        }
        self.events.emit("settings.changed", self.to_dto());
        next
    }

    /// Applies a validated patch from the dashboard, secrets included.
    pub fn apply_patch(&self, patch: SettingsPatch) -> SettingsDto {
        if let Some(password) = &patch.smtp_password {
            self.secrets.set(SecretName::SmtpPassword, password);
        }
        if let Some(token) = &patch.telegram_bot_token {
            self.secrets.set(SecretName::TelegramBotToken, token);
        }
        self.update(|s| {
            macro_rules! apply {
                ($($field:ident),*) => { $(if let Some(value) = patch.$field { s.$field = value; })* };
            }
            apply!(
                download_folder,
                post_download_action,
                seed_ratio,
                download_limit,
                upload_limit,
                alt_download_limit,
                alt_upload_limit,
                alt_speed_mode,
                alt_schedule_from,
                alt_schedule_to,
                alt_schedule_days,
                network_interface,
                disabled_providers,
                language,
                notify_on_start,
                notify_on_complete,
                email_enabled,
                smtp_host,
                smtp_use_ssl,
                smtp_username,
                email_from,
                email_to,
                desktop_enabled,
                push_enabled,
                ntfy_server,
                ntfy_topic,
                telegram_enabled,
                telegram_chat_id,
                error_reports_enabled
            );
            if let Some(port) = patch.smtp_port {
                s.smtp_port = port as u16;
            }
        });
        self.to_dto()
    }

    pub fn is_provider_enabled(&self, name: &str) -> bool {
        !self.get().disabled_providers.iter().any(|p| p.eq_ignore_ascii_case(name))
    }

    pub fn to_dto(&self) -> SettingsDto {
        let s = self.get();
        SettingsDto {
            download_folder: s.download_folder,
            post_download_action: s.post_download_action,
            seed_ratio: s.seed_ratio,
            download_limit: s.download_limit,
            upload_limit: s.upload_limit,
            alt_download_limit: s.alt_download_limit,
            alt_upload_limit: s.alt_upload_limit,
            alt_speed_mode: s.alt_speed_mode,
            alt_schedule_from: s.alt_schedule_from,
            alt_schedule_to: s.alt_schedule_to,
            alt_schedule_days: s.alt_schedule_days,
            network_interface: s.network_interface,
            disabled_providers: s.disabled_providers,
            language: s.language,
            notify_on_start: s.notify_on_start,
            notify_on_complete: s.notify_on_complete,
            email_enabled: s.email_enabled,
            smtp_host: s.smtp_host,
            smtp_port: s.smtp_port,
            smtp_use_ssl: s.smtp_use_ssl,
            smtp_username: s.smtp_username,
            smtp_password_set: self.secrets.has(SecretName::SmtpPassword),
            email_from: s.email_from,
            email_to: s.email_to,
            desktop_enabled: s.desktop_enabled,
            push_enabled: s.push_enabled,
            ntfy_server: s.ntfy_server,
            ntfy_topic: s.ntfy_topic,
            telegram_enabled: s.telegram_enabled,
            telegram_bot_token_set: self.secrets.has(SecretName::TelegramBotToken),
            telegram_chat_id: s.telegram_chat_id,
            error_reports_enabled: s.error_reports_enabled,
        }
    }
}
