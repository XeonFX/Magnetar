//! Imports downloads, series tasks and settings from the legacy .NET MediaDownloader. The legacy
//! database is opened read-only and never changed, so the old app keeps working. Its secrets were
//! encrypted with ASP.NET Data Protection keys this app can't use; they are reported for re-entry.

use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, params};

use crate::db::{Db, KeyValue};
use crate::error::{ApiError, ApiResult};
use crate::protocol::encoding::{iso, now_iso};
use crate::protocol::{LegacyImportResultDto, LegacyImportStatusDto, PostDownloadAction};
use crate::settings::SettingsService;

const IMPORTED_KEY: &str = "legacy.importedAt";

/// The legacy app stored DownloadStatus as its enum index.
const LEGACY_STATUSES: [&str; 7] = ["Queued", "FetchingMetadata", "Downloading", "Seeding", "Paused", "Completed", "Error"];

/// EF Core wrote "2026-07-09 14:40:00.1234567" (UTC, no zone).
pub fn legacy_date(value: Option<&str>) -> Option<String> {
    let value = value?.trim().replacen(' ', "T", 1);
    if let Ok(zoned) = chrono::DateTime::parse_from_rfc3339(&value) {
        return Some(iso(zoned.with_timezone(&chrono::Utc)));
    }
    let local = chrono::NaiveDateTime::parse_from_str(&value, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    // Milliseconds, as the TypeScript side kept them.
    let truncated = local.and_utc().timestamp_millis();
    chrono::DateTime::from_timestamp_millis(truncated).map(iso)
}

pub struct LegacyImporter {
    db: Db,
    kv: KeyValue,
    settings: Arc<SettingsService>,
    legacy_path: Option<PathBuf>,
}

fn opt<T: rusqlite::types::FromSql>(row: &Row<'_>, column: &str) -> Option<T> {
    row.get::<_, Option<T>>(column).ok().flatten()
}

impl LegacyImporter {
    pub fn new(db: Db, kv: KeyValue, settings: Arc<SettingsService>, legacy_path: Option<PathBuf>) -> Self {
        Self { db, kv, settings, legacy_path }
    }

    fn open(&self) -> Option<(PathBuf, Connection)> {
        let path = self.legacy_path.clone().filter(|p| p.exists())?;
        let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
        Some((path, connection))
    }

    pub fn status(&self) -> LegacyImportStatusDto {
        let path_text = self.legacy_path.as_ref().map(|p| p.to_string_lossy().into_owned());
        let unavailable =
            LegacyImportStatusDto { available: false, path: path_text.clone(), imported: false, downloads: 0, series_tasks: 0 };
        let Some((_, legacy)) = self.open() else { return unavailable };
        let count = |table: &str| legacy.query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| r.get::<_, i64>(0));
        match (count("Downloads"), count("SeriesTasks")) {
            (Ok(downloads), Ok(series_tasks)) => LegacyImportStatusDto {
                available: true,
                path: path_text,
                imported: self.kv.get(IMPORTED_KEY).is_some(),
                downloads,
                series_tasks,
            },
            (Err(error), _) | (_, Err(error)) => {
                tracing::warn!("Could not read the legacy database: {error}");
                unavailable
            }
        }
    }

    pub fn run(&self) -> ApiResult<LegacyImportResultDto> {
        let (_, legacy) = self.open().ok_or_else(|| ApiError::bad("No legacy MediaDownloader database was found."))?;
        let result = self.copy(&legacy)?;
        self.kv.set(IMPORTED_KEY, Some(&now_iso()));
        tracing::info!("Imported {} downloads and {} series tasks from the legacy app", result.downloads, result.series_tasks);
        Ok(result)
    }

    fn copy(&self, legacy: &Connection) -> ApiResult<LegacyImportResultDto> {
        let mut secrets_to_reenter = Vec::new();
        let legacy_settings = legacy
            .query_row("SELECT * FROM \"Settings\" WHERE \"Id\" = 1", [], |row| {
                let flag = |c: &str| opt::<i64>(row, c) == Some(1);
                let text = |c: &str| opt::<String>(row, c).unwrap_or_default();
                if !text("SmtpPassword").is_empty() {
                    secrets_to_reenter.push("SMTP password".to_owned());
                }
                if !text("TelegramBotToken").is_empty() {
                    secrets_to_reenter.push("Telegram bot token".to_owned());
                }
                let mut s = self.settings.get();
                s.download_folder = text("DownloadFolder");
                s.notify_on_start = flag("NotifyOnStart");
                s.notify_on_complete = flag("NotifyOnComplete");
                s.email_enabled = flag("EmailEnabled");
                s.smtp_host = text("SmtpHost");
                s.smtp_port = opt::<i64>(row, "SmtpPort").and_then(|p| u16::try_from(p).ok()).unwrap_or(587);
                s.smtp_use_ssl = flag("SmtpUseSsl");
                s.smtp_username = text("SmtpUsername");
                s.email_from = text("EmailFrom");
                s.email_to = text("EmailTo");
                s.desktop_enabled = flag("DesktopEnabled");
                s.push_enabled = flag("PushEnabled");
                s.ntfy_server = text("NtfyServer");
                s.ntfy_topic = text("NtfyTopic");
                s.telegram_enabled = flag("TelegramEnabled");
                s.telegram_chat_id = text("TelegramChatId");
                s.post_download_action =
                    if flag("PostDownloadAction") { PostDownloadAction::KeepSeeding } else { PostDownloadAction::StopSeeding };
                s.disabled_providers = text("DisabledProviders")
                    .split(',')
                    .map(|p| p.trim().to_owned())
                    .filter(|p| !p.is_empty() && p != "PTE")
                    .collect();
                s.language = Some(text("Language")).filter(|l| !l.is_empty()).unwrap_or_else(|| "en".into());
                s.agent_api_enabled = flag("AgentApiEnabled");
                s.agent_api_allow_remote = flag("AgentApiAllowRemote");
                Ok(s)
            })
            .optional()?;
        let settings_found = legacy_settings.is_some();
        if let Some(imported) = legacy_settings {
            self.settings.update(move |s| *s = imported);
        }

        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let mut series_map = std::collections::HashMap::new();
        let mut series_tasks = 0;
        {
            let mut statement = legacy.prepare("SELECT * FROM \"SeriesTasks\" ORDER BY \"Id\"")?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let legacy_id: i64 = row.get("Id")?;
                let (name, query): (String, String) = (row.get("Name")?, row.get("Query")?);
                // A re-import maps to the task it created last time instead of adding it again.
                let existing: Option<i64> = tx
                    .query_row("SELECT id FROM series_tasks WHERE name = ? AND query = ?", [&name, &query], |r| r.get(0))
                    .optional()?;
                if let Some(id) = existing {
                    series_map.insert(legacy_id, id);
                    continue;
                }
                let provider = opt::<String>(row, "Provider").filter(|p| p != "PTE");
                let created = legacy_date(opt::<String>(row, "CreatedAt").as_deref()).unwrap_or_else(now_iso);
                let id: i64 = tx.query_row(
                    "INSERT INTO series_tasks (name, query, provider, title_filter, season, start_episode, end_episode,
                       download_folder, last_downloaded_episode, check_interval_minutes, enabled, last_checked_at, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                    params![
                        name,
                        query,
                        provider,
                        opt::<String>(row, "TitleFilter"),
                        opt::<i64>(row, "Season"),
                        opt::<i64>(row, "StartEpisode").unwrap_or(1),
                        opt::<i64>(row, "EndEpisode"),
                        opt::<String>(row, "DownloadFolder"),
                        opt::<i64>(row, "LastDownloadedEpisode").unwrap_or(0),
                        opt::<i64>(row, "CheckIntervalMinutes").unwrap_or(60),
                        opt::<i64>(row, "Enabled").unwrap_or(1),
                        legacy_date(opt::<String>(row, "LastCheckedAt").as_deref()),
                        created
                    ],
                    |r| r.get(0),
                )?;
                series_map.insert(legacy_id, id);
                series_tasks += 1;
            }
        }

        let mut downloads = 0;
        {
            let mut statement = legacy.prepare("SELECT * FROM \"Downloads\" ORDER BY \"Id\"")?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                // Private-tracker (.torrent file) downloads can't be resumed without that tracker.
                let magnet = opt::<String>(row, "MagnetUri").unwrap_or_default();
                if magnet.is_empty() {
                    continue;
                }
                let status = opt::<i64>(row, "Status").and_then(|s| LEGACY_STATUSES.get(s as usize)).copied().unwrap_or("Paused");
                // Imported downloads start paused so both apps never write the same files at once.
                let status = if matches!(status, "Completed" | "Error") { status } else { "Paused" };
                let series = opt::<i64>(row, "SeriesTaskId").and_then(|id| series_map.get(&id).copied());
                downloads += tx.execute(
                    "INSERT OR IGNORE INTO downloads (name, name_is_placeholder, magnet_uri, info_hash, save_path, source, status,
                       progress, total_bytes, added_at, completed_at, error, start_notification_sent, complete_notification_sent,
                       series_task_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                    params![
                        opt::<String>(row, "Name").unwrap_or_default(),
                        opt::<i64>(row, "NameIsPlaceholder").unwrap_or(0),
                        magnet,
                        opt::<String>(row, "InfoHash").unwrap_or_default().to_lowercase(),
                        opt::<String>(row, "SavePath").unwrap_or_default(),
                        opt::<String>(row, "Source").unwrap_or_default(),
                        status,
                        opt::<f64>(row, "Progress").unwrap_or(0.0),
                        opt::<i64>(row, "TotalBytes").unwrap_or(0),
                        legacy_date(opt::<String>(row, "AddedAt").as_deref()).unwrap_or_else(now_iso),
                        legacy_date(opt::<String>(row, "CompletedAt").as_deref()),
                        opt::<String>(row, "Error"),
                        opt::<i64>(row, "CompleteNotificationSent").unwrap_or(0),
                        series
                    ],
                )?;
            }
        }
        tx.commit()?;
        Ok(LegacyImportResultDto { downloads, series_tasks, settings: settings_found, secrets_to_reenter })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn legacy_dates_become_utc_iso() {
        assert_eq!(super::legacy_date(Some("2026-09-01 10:00:00.1234567")).as_deref(), Some("2026-09-01T10:00:00.123Z"));
        assert_eq!(super::legacy_date(Some("2026-07-01 09:00:00")).as_deref(), Some("2026-07-01T09:00:00.000Z"));
        assert_eq!(super::legacy_date(Some("nonsense")), None);
        assert_eq!(super::legacy_date(None), None);
    }
}
