use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::db::{Db, SecretName, SecretStore};
use crate::error::{ApiError, ApiResult};
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
    /// Held for a whole change, from reading the settings to caching what was saved: concurrent
    /// changes apply one after the other, each to the settings the one before saved.
    writing: Mutex<()>,
}

const SAVE_SETTINGS: &str = "INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json";

impl SettingsService {
    pub fn new(db: Db, secrets: Arc<SecretStore>, events: EventBus) -> Self {
        Self { db, secrets, events, cached: Mutex::new(None), writing: Mutex::new(()) }
    }

    fn cached(&self) -> MutexGuard<'_, Option<AppSettings>> {
        self.cached.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The saved settings: cached once read. A row that no longer parses is the defaults; a database
    /// that can't be read is an error, and nothing is cached.
    fn load(&self) -> rusqlite::Result<AppSettings> {
        if let Some(settings) = self.cached().as_ref() {
            return Ok(settings.clone());
        }
        let row: Option<String> =
            self.db.lock().query_row("SELECT json FROM settings WHERE id = 1", [], |r| r.get(0)).optional()?;
        let settings = match row.map(|json| serde_json::from_str::<AppSettings>(&json)) {
            Some(Ok(settings)) => settings,
            Some(Err(error)) => {
                tracing::warn!("The saved settings could not be read, so the defaults apply: {error}");
                AppSettings::default()
            }
            None => AppSettings::default(),
        };
        Ok(self.cached().get_or_insert(settings).clone())
    }

    /// The settings; the defaults while the database can't be read (not remembered: the next call reads again).
    pub fn get(&self) -> AppSettings {
        self.load().unwrap_or_else(|error| {
            crate::log_failure!(&error, "Could not read the settings: {error}");
            AppSettings::default()
        })
    }

    /// Changes the non-secret settings, saves them and tells every dashboard. Returns what was saved;
    /// on an error nothing changed.
    pub fn update(&self, change: impl FnOnce(&mut AppSettings)) -> rusqlite::Result<AppSettings> {
        self.update_with(&[], change)
    }

    /// `update`, saving `secrets` in the same transaction: both are saved or neither.
    pub fn update_with(
        &self,
        secrets: &[(SecretName, &str)],
        change: impl FnOnce(&mut AppSettings),
    ) -> rusqlite::Result<AppSettings> {
        let saved = {
            let _writing = self.writing.lock().unwrap_or_else(|e| e.into_inner());
            let mut next = self.load()?;
            change(&mut next);
            let json = serde_json::to_string(&next).expect("settings serialize");
            self.secrets.set_with(secrets, |tx| tx.execute(SAVE_SETTINGS, [json]).map(drop))?;
            *self.cached() = Some(next.clone());
            next
        };
        self.events.emit("settings.changed", self.to_dto());
        Ok(saved)
    }

    /// Applies a validated patch from the dashboard, secrets included: all of it is saved, or none.
    pub fn apply_patch(&self, mut patch: SettingsPatch) -> ApiResult<SettingsDto> {
        let (password, token) = (patch.smtp_password.take(), patch.telegram_bot_token.take());
        let secrets: Vec<(SecretName, &str)> = [(SecretName::SmtpPassword, &password), (SecretName::TelegramBotToken, &token)]
            .into_iter()
            .filter_map(|(name, value)| Some((name, value.as_deref()?)))
            .collect();
        self.update_with(&secrets, |s| {
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
        })
        .map_err(saving_failed)?;
        Ok(self.to_dto())
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

/// A change that could not be saved, as its caller is told.
pub fn saving_failed(error: rusqlite::Error) -> ApiError {
    ApiError::internal_from(format!("The change could not be saved, so nothing changed: {error}"), error)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::db::SecretBox;

    struct Store {
        dir: tempfile::TempDir,
        db: Db,
        settings: Arc<SettingsService>,
    }

    impl Store {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let db = Db::open(&dir.path().join("magnetar.db")).unwrap();
            let settings = Self::service(&dir, &db);
            Self { dir, db, settings }
        }

        fn service(dir: &tempfile::TempDir, db: &Db) -> Arc<SettingsService> {
            let sealer = Arc::new(SecretBox::open(&dir.path().join("secret.key")).unwrap());
            Arc::new(SettingsService::new(db.clone(), Arc::new(SecretStore::new(db.clone(), sealer)), EventBus::default()))
        }

        /// The same database read by a service that has cached nothing, as after a restart.
        fn reopened(&self) -> Arc<SettingsService> {
            Self::service(&self.dir, &Db::open(&self.dir.path().join("magnetar.db")).unwrap())
        }

        /// Every write fails from now on, as on a read-only volume.
        fn read_only(&self) {
            self.db.lock().pragma_update(None, "query_only", true).unwrap();
        }
    }

    #[test]
    fn a_change_that_cannot_be_saved_changes_nothing_and_says_so() {
        let store = Store::new();
        store.settings.update(|s| s.download_limit = 100).unwrap();
        let mut events = store.settings.events.subscribe();
        store.read_only();

        assert!(store.settings.update(|s| s.download_limit = 200).is_err());
        let patch = SettingsPatch { upload_limit: Some(5), ..Default::default() };
        let error = store.settings.apply_patch(patch).unwrap_err();
        assert!(error.is_internal() && error.message.contains("nothing changed"), "{error}");

        assert_eq!((store.settings.get().download_limit, store.settings.get().upload_limit), (100, 0));
        assert!(events.try_recv().is_err(), "no dashboard is told of a change that did not happen");
        assert_eq!(store.reopened().get().download_limit, 100);
    }

    #[test]
    fn a_patch_saves_its_secrets_and_settings_together_or_neither() {
        let store = Store::new();
        // Only the settings row refuses the write: the secret written before it in the same patch must not stay.
        store
            .db
            .lock()
            .execute_batch(
                "CREATE TEMP TRIGGER no_settings_insert BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
                 CREATE TEMP TRIGGER no_settings_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;",
            )
            .unwrap();
        let patch = SettingsPatch {
            smtp_password: Some("hunter2".into()),
            email_to: Some("me@example.com".into()),
            ..Default::default()
        };
        assert!(store.settings.apply_patch(patch).is_err());
        assert!(!store.settings.secrets.has(SecretName::SmtpPassword));
        assert!(!store.reopened().secrets.has(SecretName::SmtpPassword));
        assert_eq!(store.settings.get().email_to, "");

        store.db.lock().execute_batch("DROP TRIGGER no_settings_insert; DROP TRIGGER no_settings_update;").unwrap();
        let patch = SettingsPatch {
            smtp_password: Some("hunter2".into()),
            email_to: Some("me@example.com".into()),
            ..Default::default()
        };
        let saved = store.settings.apply_patch(patch).unwrap();
        assert!(saved.smtp_password_set);
        let reopened = store.reopened();
        assert_eq!((reopened.secrets.get(SecretName::SmtpPassword), reopened.get().email_to), ("hunter2".into(), "me@example.com".into()));
    }

    #[test]
    fn concurrent_changes_each_apply_to_what_the_one_before_saved() {
        let store = Store::new();
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let settings = store.settings.clone();
                std::thread::spawn(move || {
                    settings
                        .update(|s| {
                            // Wide open for another change to read the same settings meanwhile.
                            std::thread::sleep(Duration::from_millis(5));
                            s.download_limit += 1;
                            s.disabled_providers.push(format!("p{i}"));
                        })
                        .unwrap();
                })
            })
            .collect();
        let other_field = {
            let settings = store.settings.clone();
            std::thread::spawn(move || settings.apply_patch(SettingsPatch { language: Some("pl".into()), ..Default::default() }))
        };
        for thread in threads {
            thread.join().unwrap();
        }
        other_field.join().unwrap().unwrap();
        for settings in [store.settings.get(), store.reopened().get()] {
            assert_eq!(settings.download_limit, 8);
            assert_eq!(settings.disabled_providers.len(), 8);
            assert_eq!(settings.language, "pl");
        }
    }

    #[test]
    fn settings_that_cannot_be_read_are_neither_remembered_as_the_defaults_nor_overwritten() {
        let store = Store::new();
        store.settings.update(|s| s.seed_ratio = 3.0).unwrap();
        let fresh = store.reopened();
        // A database that can't be read for a moment: the defaults stand in, and a change is refused.
        store.db.lock().execute_batch("ALTER TABLE settings RENAME TO settings_away").unwrap();
        assert_eq!(fresh.get().seed_ratio, AppSettings::default().seed_ratio);
        assert!(fresh.update(|s| s.download_limit = 1).is_err());
        store.db.lock().execute_batch("ALTER TABLE settings_away RENAME TO settings").unwrap();
        assert_eq!(fresh.get().seed_ratio, 3.0);
        assert_eq!(fresh.get().download_limit, 0);
    }

    #[test]
    fn a_settings_row_that_no_longer_parses_is_the_defaults_and_can_be_saved_over() {
        let store = Store::new();
        store.db.lock().execute("INSERT INTO settings (id, json) VALUES (1, '{not json')", []).unwrap();
        assert_eq!(store.settings.get().language, "en");
        store.settings.update(|s| s.language = "de".into()).unwrap();
        assert_eq!(store.reopened().get().language, "de");
    }
}
