use rusqlite::{OptionalExtension, Row, params};

use super::episode::EpisodeRule;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::events::EventBus;
use crate::protocol::encoding::now_iso;
use crate::protocol::{SeriesTaskDto, SeriesTaskInput};

#[derive(Clone, Debug)]
pub struct SeriesTask {
    pub id: i64,
    pub name: String,
    pub query: String,
    pub provider: Option<String>,
    pub title_filter: Option<String>,
    pub season: Option<i64>,
    pub start_episode: i64,
    pub end_episode: Option<i64>,
    pub download_folder: Option<String>,
    pub last_downloaded_episode: i64,
    pub check_interval_minutes: i64,
    pub enabled: bool,
    pub last_checked_at: Option<String>,
}

impl SeriesTask {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            query: row.get("query")?,
            provider: row.get("provider")?,
            title_filter: row.get("title_filter")?,
            season: row.get("season")?,
            start_episode: row.get("start_episode")?,
            end_episode: row.get("end_episode")?,
            download_folder: row.get("download_folder")?,
            last_downloaded_episode: row.get("last_downloaded_episode")?,
            check_interval_minutes: row.get("check_interval_minutes")?,
            enabled: row.get("enabled")?,
            last_checked_at: row.get("last_checked_at")?,
        })
    }

    pub fn next_episode(&self) -> i64 {
        self.start_episode.max(self.last_downloaded_episode + 1)
    }

    pub fn is_finished(&self) -> bool {
        self.end_episode.is_some_and(|end| self.last_downloaded_episode >= end)
    }

    pub fn rule(&self) -> EpisodeRule<'_> {
        EpisodeRule { query: &self.query, title_filter: self.title_filter.as_deref(), season: self.season }
    }

    /// The rule's editable fields, as a create would take them.
    pub fn as_input(&self) -> SeriesTaskInput {
        SeriesTaskInput {
            name: self.name.clone(),
            query: self.query.clone(),
            provider: self.provider.clone(),
            title_filter: self.title_filter.clone(),
            season: self.season,
            start_episode: self.start_episode,
            end_episode: self.end_episode,
            check_interval_minutes: self.check_interval_minutes,
            enabled: self.enabled,
            download_folder: self.download_folder.clone(),
        }
    }

    pub fn apply(&mut self, input: SeriesTaskInput) {
        self.name = input.name;
        self.query = input.query;
        self.provider = input.provider;
        self.title_filter = input.title_filter;
        self.season = input.season;
        self.start_episode = input.start_episode;
        self.end_episode = input.end_episode;
        self.check_interval_minutes = input.check_interval_minutes;
        self.enabled = input.enabled;
        self.download_folder = input.download_folder;
    }

    pub fn to_dto(&self) -> SeriesTaskDto {
        SeriesTaskDto {
            id: self.id,
            name: self.name.clone(),
            query: self.query.clone(),
            provider: self.provider.clone(),
            title_filter: self.title_filter.clone(),
            season: self.season,
            start_episode: self.start_episode,
            end_episode: self.end_episode,
            last_downloaded_episode: self.last_downloaded_episode,
            next_episode: self.next_episode(),
            check_interval_minutes: self.check_interval_minutes,
            enabled: self.enabled,
            download_folder: self.download_folder.clone(),
            last_checked_at: self.last_checked_at.clone(),
            finished: self.is_finished(),
        }
    }
}

pub struct SeriesStore {
    db: Db,
    events: EventBus,
}

impl SeriesStore {
    pub fn new(db: Db, events: EventBus) -> Self {
        Self { db, events }
    }

    pub fn all(&self) -> Vec<SeriesTask> {
        let db = self.db.lock();
        let mut statement = db.prepare("SELECT * FROM series_tasks ORDER BY id").expect("series_tasks table");
        statement.query_map([], SeriesTask::from_row).map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    pub fn get(&self, id: i64) -> ApiResult<SeriesTask> {
        self.db
            .lock()
            .query_row("SELECT * FROM series_tasks WHERE id = ?", [id], SeriesTask::from_row)
            .optional()?
            .ok_or_else(|| ApiError::not_found(format!("No series task with id {id}.")))
    }

    pub fn create(&self, input: &SeriesTaskInput) -> ApiResult<SeriesTask> {
        let task = self.db.lock().query_row(
            "INSERT INTO series_tasks (name, query, provider, title_filter, season, start_episode, end_episode, download_folder,
               check_interval_minutes, enabled, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
            params![
                input.name,
                input.query,
                input.provider,
                input.title_filter,
                input.season,
                input.start_episode,
                input.end_episode,
                input.download_folder,
                input.check_interval_minutes,
                input.enabled,
                now_iso()
            ],
            SeriesTask::from_row,
        )?;
        self.changed();
        Ok(task)
    }

    pub fn save(&self, task: &SeriesTask) -> ApiResult<()> {
        self.db.lock().execute(
            "UPDATE series_tasks SET name = ?, query = ?, provider = ?, title_filter = ?, season = ?, start_episode = ?,
               end_episode = ?, download_folder = ?, last_downloaded_episode = ?, check_interval_minutes = ?, enabled = ?,
               last_checked_at = ?
             WHERE id = ?",
            params![
                task.name,
                task.query,
                task.provider,
                task.title_filter,
                task.season,
                task.start_episode,
                task.end_episode,
                task.download_folder,
                task.last_downloaded_episode,
                task.check_interval_minutes,
                task.enabled,
                task.last_checked_at,
                task.id
            ],
        )?;
        self.changed();
        Ok(())
    }

    /// Its downloads are kept and become manual downloads (the foreign key sets them to null).
    pub fn delete(&self, id: i64) -> ApiResult<()> {
        self.get(id)?;
        self.db.lock().execute("DELETE FROM series_tasks WHERE id = ?", [id])?;
        self.changed();
        Ok(())
    }

    pub fn dtos(&self) -> Vec<SeriesTaskDto> {
        self.all().iter().map(SeriesTask::to_dto).collect()
    }

    pub fn changed(&self) {
        self.events.emit("series.changed", self.dtos());
    }
}
