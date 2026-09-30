//! Watches: waiting for a release of something that isn't a series (a film in 4K, an album). Each is
//! checked on its schedule; the first release its rules allow is reported, or downloaded, and the
//! watch rests until the user arms it again.

use rusqlite::{OptionalExtension, Row, params};

use super::quality::QualityRule;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::events::EventBus;
use crate::protocol::encoding::now_iso;
use crate::protocol::{FoundReleaseDto, WatchDto, WatchInput};

fn from_row(row: &Row<'_>) -> rusqlite::Result<WatchDto> {
    Ok(WatchDto {
        id: row.get("id")?,
        query: row.get("query")?,
        resolution: row.get("resolution")?,
        min_seeders: row.get("min_seeders")?,
        max_size_mb: row.get("max_size_mb")?,
        prefer_words: row.get("prefer_words")?,
        exclude_words: row.get("exclude_words")?,
        auto_download: row.get("auto_download")?,
        check_interval_minutes: row.get("check_interval_minutes")?,
        enabled: row.get("enabled")?,
        created_at: row.get("created_at")?,
        last_checked_at: row.get("last_checked_at")?,
        found: row.get::<_, Option<String>>("found")?.and_then(|json| serde_json::from_str(&json).ok()),
        download_id: row.get("download_id")?,
    })
}

pub fn quality(watch: &WatchDto) -> QualityRule {
    QualityRule::new(
        watch.resolution.as_deref(),
        watch.min_seeders,
        watch.max_size_mb,
        watch.prefer_words.as_deref(),
        watch.exclude_words.as_deref(),
    )
}

pub struct WatchStore {
    db: Db,
    events: EventBus,
}

impl WatchStore {
    pub fn new(db: Db, events: EventBus) -> Self {
        Self { db, events }
    }

    pub fn all(&self) -> Vec<WatchDto> {
        let db = self.db.lock();
        let Ok(mut statement) = db.prepare("SELECT * FROM watches ORDER BY id DESC") else { return Vec::new() };
        statement.query_map([], from_row).map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    pub fn get(&self, id: i64) -> ApiResult<WatchDto> {
        self.db
            .lock()
            .query_row("SELECT * FROM watches WHERE id = ?", [id], from_row)
            .optional()?
            .ok_or_else(|| ApiError::not_found(format!("No watch with id {id}.")))
    }

    pub fn create(&self, input: WatchInput) -> ApiResult<WatchDto> {
        let input = input.validated()?;
        let watch = self.db.lock().query_row(
            "INSERT INTO watches (query, resolution, min_seeders, max_size_mb, prefer_words, exclude_words, auto_download,
               check_interval_minutes, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
            params![
                input.query,
                input.resolution,
                input.min_seeders,
                input.max_size_mb,
                input.prefer_words,
                input.exclude_words,
                input.auto_download,
                input.check_interval_minutes,
                input.enabled,
                now_iso()
            ],
            from_row,
        )?;
        self.changed();
        Ok(watch)
    }

    /// Replaces the rules. Arming a watch again (enabled after it found something) forgets the find.
    pub fn update(&self, id: i64, input: WatchInput) -> ApiResult<WatchDto> {
        let input = input.validated()?;
        let current = self.get(id)?;
        let rearmed = input.enabled && !current.enabled;
        self.db.lock().execute(
            "UPDATE watches SET query = ?, resolution = ?, min_seeders = ?, max_size_mb = ?, prefer_words = ?, exclude_words = ?,
               auto_download = ?, check_interval_minutes = ?, enabled = ?,
               found = CASE WHEN ? THEN NULL ELSE found END, download_id = CASE WHEN ? THEN NULL ELSE download_id END,
               last_checked_at = CASE WHEN ? THEN NULL ELSE last_checked_at END
             WHERE id = ?",
            params![
                input.query,
                input.resolution,
                input.min_seeders,
                input.max_size_mb,
                input.prefer_words,
                input.exclude_words,
                input.auto_download,
                input.check_interval_minutes,
                input.enabled,
                rearmed,
                rearmed,
                rearmed,
                id
            ],
        )?;
        self.changed();
        self.get(id)
    }

    pub fn delete(&self, id: i64) -> ApiResult<()> {
        self.get(id)?;
        self.db.lock().execute("DELETE FROM watches WHERE id = ?", [id])?;
        self.changed();
        Ok(())
    }

    pub fn checked(&self, id: i64) {
        let _ = self.db.lock().execute("UPDATE watches SET last_checked_at = ? WHERE id = ?", params![now_iso(), id]);
        self.changed();
    }

    /// Records the release found; the watch rests.
    pub fn found(&self, id: i64, release: &FoundReleaseDto, download_id: Option<i64>) {
        let json = serde_json::to_string(release).unwrap_or_default();
        let _ = self.db.lock().execute(
            "UPDATE watches SET found = ?, download_id = ?, enabled = 0, last_checked_at = ? WHERE id = ?",
            params![json, download_id, now_iso(), id],
        );
        self.changed();
    }

    pub fn set_download(&self, id: i64, download_id: i64) {
        let _ = self.db.lock().execute("UPDATE watches SET download_id = ? WHERE id = ?", params![download_id, id]);
        self.changed();
    }

    pub fn changed(&self) {
        self.events.emit("watches.changed", self.all());
    }
}
