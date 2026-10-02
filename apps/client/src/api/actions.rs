use std::sync::Arc;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::rate_limiter::RateLimiter;
use super::save_folder::resolve_agent_folder;
use crate::downloads::{AddDownload, DownloadManager};
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::protocol::{
    DOWNLOAD_STATUSES, DownloadDto, DownloadStatus, SearchResponse, SeriesTaskDto, SeriesTaskInput, SeriesTaskPatch, SourceDto,
    StartDownloadInput, StartFrom, TorrentDetailsDto,
};
use crate::search::SearchService;
use crate::search::cache::{SearchResultCache, to_result_dto};
use crate::search::types::SharedResult;
use crate::series::episode::EpisodeRule;
use crate::series::{SeriesMonitor, SeriesStore};
use crate::settings::SettingsService;

const DEFAULT_SEARCH_LIMIT: usize = 25;
const MAX_SEARCH_LIMIT: usize = 200;

/// Who is asking. Agents (REST/MCP) are rate limited and confined to the download folder because
/// they choose arguments after reading untrusted text; the dashboard is a person.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Caller {
    Agent,
    User,
}

#[derive(Serialize)]
pub struct Done {
    pub success: bool,
    pub message: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    pub download_folder: String,
    pub post_download_action: crate::protocol::PostDownloadAction,
}

/// Starts a download for a search result, resolving a lazy source's magnet first. `series` is the
/// series task and episode it was found for.
pub async fn start_from_result(
    search: &SearchService,
    downloads: &Arc<DownloadManager>,
    shared: SharedResult,
    series: Option<(i64, i64)>,
    save_folder: Option<String>,
    cancel: &CancellationToken,
) -> ApiResult<DownloadDto> {
    let result = search.with_magnet(&shared, cancel).await;
    if cancel.is_cancelled() {
        return Err(ApiError::bad("The request was cancelled."));
    }
    if result.magnet_uri.is_empty() {
        return Err(ApiError::bad(format!("Could not resolve a magnet link for \"{}\" from {}.", result.title, result.source)));
    }
    downloads.add(AddDownload {
        name: result.title,
        magnet_uri: result.magnet_uri,
        source: result.source,
        series_task_id: series.map(|(task, _)| task),
        episode: series.map(|(_, episode)| episode),
        save_folder,
    })
}

/// Everything that can be done to the app, in one place. The dashboard RPC, REST and MCP are thin
/// wrappers over this, so the surfaces cannot drift apart or enforce different rules. Each surface
/// gets an instance bound to its caller, so agent limits can't be forgotten per method.
#[derive(Clone)]
pub struct Actions {
    pub search: Arc<SearchService>,
    pub downloads: Arc<DownloadManager>,
    pub series: Arc<SeriesStore>,
    pub monitor: Arc<SeriesMonitor>,
    pub settings: Arc<SettingsService>,
    pub cache: Arc<SearchResultCache>,
    pub limiter: Arc<RateLimiter>,
    pub caller: Caller,
}

impl Actions {
    /// The same actions on behalf of another caller.
    pub fn as_caller(&self, caller: Caller) -> Self {
        Self { caller, ..self.clone() }
    }

    /// Agents only: spends one allowance of outbound traffic to the torrent sites.
    fn limit(&self, operation: &str) -> ApiResult<()> {
        if self.caller == Caller::Agent { self.limiter.ensure_allowed(operation) } else { Ok(()) }
    }

    /// Agents only: confines a chosen folder to the download folder.
    fn folder(&self, requested: Option<&str>) -> ApiResult<Option<String>> {
        match self.caller {
            Caller::Agent => resolve_agent_folder(requested, &self.settings.get().download_folder),
            Caller::User => Ok(requested.map(str::trim).filter(|f| !f.is_empty()).map(str::to_owned)),
        }
    }

    pub fn sources(&self) -> Vec<SourceDto> {
        self.search
            .providers
            .iter()
            .map(|p| SourceDto { id: p.id().into(), name: p.name().into(), enabled: self.settings.is_provider_enabled(p.name()) })
            .collect()
    }

    /// One-shot search for agents: merged, de-duplicated, truncated to `limit`.
    pub async fn search(
        &self,
        query: &str,
        source: Option<&str>,
        limit: Option<usize>,
        cancel: &CancellationToken,
    ) -> ApiResult<SearchResponse> {
        if query.trim().is_empty() {
            return Err(ApiError::bad("A search query is required."));
        }
        if limit.is_some_and(|l| !(1..=MAX_SEARCH_LIMIT).contains(&l)) {
            return Err(ApiError::bad(format!("limit must be between 1 and {MAX_SEARCH_LIMIT}.")));
        }
        self.limit("search")?;
        self.require_available_source(source)?;
        let take = limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
        let collected = self.search.collect(query, source, cancel, true).await?;
        let total_matched = collected.results.len();
        let results = collected
            .results
            .into_iter()
            .take(take)
            .map(|r| {
                let dto_source = r.clone();
                let (id, _) = self.cache.add(r);
                to_result_dto(&dto_source, &id)
            })
            .collect();
        Ok(SearchResponse { results, sources: collected.outcomes, total_matched, truncated: total_matched > take })
    }

    pub async fn details(&self, result_id: &str, cancel: &CancellationToken) -> ApiResult<TorrentDetailsDto> {
        self.limit("detail")?;
        let shared = self.cache.get(result_id)?;
        self.search.ensure_details(&shared, cancel).await;
        let result = shared.lock().unwrap().clone();
        Ok(TorrentDetailsDto {
            result: to_result_dto(&result, result_id),
            description: result.description.clone(),
            magnet_uri: (!result.magnet_uri.is_empty()).then(|| result.magnet_uri.clone()),
        })
    }

    pub async fn start_download(&self, input: StartDownloadInput, cancel: &CancellationToken) -> ApiResult<DownloadDto> {
        let folder = self.folder(input.folder.as_deref())?;
        if let Some(result_id) = input.result_id.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
            let shared = self.cache.get(result_id)?;
            return start_from_result(&self.search, &self.downloads, shared, None, folder, cancel).await;
        }
        if let Some(magnet) = input.magnet.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            if !magnet.to_ascii_lowercase().starts_with("magnet:") {
                return Err(ApiError::bad("`magnet` must be a magnet: URI."));
            }
            let source = if self.caller == Caller::Agent { "Agent" } else { "Magnet" };
            let item = self.downloads.add(AddDownload {
                name: String::new(),
                magnet_uri: magnet.to_owned(),
                source: source.into(),
                series_task_id: None,
                episode: None,
                save_folder: folder,
            })?;
            tracing::info!("Started download from a supplied magnet: {}", item.name);
            return Ok(item);
        }
        if let Some(torrent) = input.torrent.as_deref().filter(|t| !t.is_empty()) {
            let bytes = crate::protocol::encoding::from_base64(torrent)
                .map_err(|_| ApiError::bad("`torrent` must be a base64-encoded .torrent file."))?;
            return self.start_torrent(bytes, folder);
        }
        Err(ApiError::bad(
            "Provide `resultId` (from a search), `magnet` or `torrent`. For sources that resolve magnets lazily, only `resultId` works.",
        ))
    }

    /// Starts a download from a .torrent file's bytes, in `folder` or the default one.
    pub fn add_torrent(&self, bytes: Vec<u8>, folder: Option<&str>) -> ApiResult<DownloadDto> {
        self.start_torrent(bytes, self.folder(folder)?)
    }

    fn start_torrent(&self, bytes: Vec<u8>, folder: Option<String>) -> ApiResult<DownloadDto> {
        let source = if self.caller == Caller::Agent { "Agent" } else { "Torrent file" };
        let item = self.downloads.add_torrent_file(bytes, source, folder)?;
        tracing::info!("Started download from a .torrent file: {}", item.name);
        Ok(item)
    }

    pub fn list_downloads(&self, status: Option<&str>) -> ApiResult<Vec<DownloadDto>> {
        let all = self.downloads.list();
        let Some(status) = status.filter(|s| !s.is_empty()) else { return Ok(all) };
        let wanted = DownloadStatus::parse(status).ok_or_else(|| {
            ApiError::bad(format!("Unknown status '{status}'. Valid values: {}.", DOWNLOAD_STATUSES.join(", ")))
        })?;
        Ok(all.into_iter().filter(|d| d.status == wanted).collect())
    }

    pub fn get_download(&self, id: i64) -> ApiResult<DownloadDto> {
        self.downloads.get(id)
    }

    pub async fn pause(&self, id: i64) -> ApiResult<DownloadDto> {
        self.downloads.pause(id).await
    }

    pub fn resume(&self, id: i64) -> ApiResult<DownloadDto> {
        self.downloads.resume(id)
    }

    /// Pauses every download that is running, queued or seeding; how many were paused.
    pub async fn pause_all(&self) -> usize {
        let mut paused = 0;
        for d in self.downloads.unfinished().into_iter().filter(|d| d.status.wants_engine()) {
            match self.downloads.pause(d.id).await {
                Ok(_) => paused += 1,
                Err(error) => tracing::warn!("Could not pause download {}: {error}", d.id),
            }
        }
        paused
    }

    /// Resumes every paused or failed download; how many were resumed.
    pub fn resume_all(&self) -> usize {
        let mut resumed = 0;
        for d in self.downloads.unfinished().into_iter().filter(|d| !d.status.wants_engine()) {
            match self.downloads.resume(d.id) {
                Ok(_) => resumed += 1,
                Err(error) => tracing::warn!("Could not resume download {}: {error}", d.id),
            }
        }
        resumed
    }

    /// `delete_files` erases what was downloaded — the one irreversible action, so it defaults to false everywhere.
    pub async fn delete_download(&self, id: i64, delete_files: bool) -> ApiResult<Done> {
        let item = self.downloads.get(id)?;
        tracing::info!("Deleting download '{}' (deleteFiles: {delete_files})", item.name);
        self.downloads.delete(id, delete_files).await?;
        let message = if delete_files { "Download and its files deleted." } else { "Download removed; files kept." };
        Ok(Done { success: true, message })
    }

    pub fn list_series(&self) -> Vec<SeriesTaskDto> {
        self.series.dtos()
    }

    pub fn get_series(&self, id: i64) -> ApiResult<SeriesTaskDto> {
        Ok(self.series.get(id)?.to_dto())
    }

    /// Creates a rule. Starting from the latest episode, or with new ones only, first asks the
    /// sources what is already out, so the rule doesn't download a backlog nobody wanted.
    pub async fn create_series(&self, input: SeriesTaskInput) -> ApiResult<SeriesTaskDto> {
        let mut input = input.validated()?;
        self.require_available_source(input.provider.as_deref())?;
        input.download_folder = self.folder(input.download_folder.as_deref())?;
        let latest = match input.start_from {
            StartFrom::Episode => None,
            _ => {
                self.limit("series lookup")?;
                let rule = EpisodeRule { query: &input.query, title_filter: input.title_filter.as_deref(), season: input.season };
                Some(self.monitor.latest_episode(&rule, input.provider.as_deref()).await?)
            }
        };
        let mut task = self.series.create(&input)?;
        if let Some(latest) = latest {
            task.last_downloaded_episode = if input.start_from == StartFrom::New { latest } else { (latest - 1).max(0) };
            self.series.save(&task)?;
        }
        self.refresh_show_later(task.id);
        Ok(task.to_dto())
    }

    /// Looks the show up on TVmaze in the background; the card fills in when it answers.
    fn refresh_show_later(&self, id: i64) {
        let monitor = self.monitor.clone();
        tokio::spawn(async move {
            if let Err(error) = monitor.refresh_show(id).await {
                tracing::debug!("TVmaze lookup failed: {error}");
            }
        });
    }

    /// Changes only the fields supplied, then validates the merged result so a patch can't leave the
    /// rule in a state a create would reject. A replace is just a patch that names every field.
    pub fn update_series(&self, id: i64, patch: SeriesTaskPatch) -> ApiResult<SeriesTaskDto> {
        let mut task = self.series.get(id)?;
        let mut merged = task.as_input();
        macro_rules! apply {
            ($($field:ident),*) => { $(if let Some(value) = patch.$field.clone() { merged.$field = value; })* };
        }
        apply!(
            name,
            query,
            provider,
            title_filter,
            season,
            start_episode,
            end_episode,
            check_interval_minutes,
            enabled,
            download_folder,
            resolution,
            min_seeders,
            max_size_mb,
            prefer_words,
            exclude_words
        );
        let renamed = merged.name.trim() != task.name;
        let mut merged = merged.validated()?;
        if patch.provider.is_some() {
            self.require_available_source(merged.provider.as_deref())?;
        }
        // Only re-check the folder when the patch names one: an existing rule may point somewhere
        // the user chose in the dashboard, and renaming it must not fail.
        merged.download_folder = match patch.download_folder {
            None => task.download_folder.clone(),
            Some(_) => self.folder(merged.download_folder.as_deref())?,
        };
        task.apply(merged);
        self.series.save(&task)?;
        if renamed {
            self.refresh_show_later(task.id);
        }
        Ok(task.to_dto())
    }

    pub fn delete_series(&self, id: i64) -> ApiResult<Done> {
        self.series.delete(id)?;
        Ok(Done { success: true, message: "Series task deleted; its downloads were kept." })
    }

    /// Can queue downloads, so it is a write even though it reads like a refresh.
    pub async fn check_series_now(&self, id: i64) -> ApiResult<SeriesTaskDto> {
        self.limit("series check")?;
        let task = self.series.get(id)?;
        self.require_available_source(task.provider.as_deref())?;
        Ok(self.monitor.check_now(id).await?.to_dto())
    }

    /// The settings an agent may know about: nothing secret, nothing about notifications.
    pub fn agent_settings(&self) -> AgentSettings {
        let s = self.settings.get();
        AgentSettings { download_folder: s.download_folder, post_download_action: s.post_download_action }
    }

    /// Rejects a named source a search would silently skip, and an installation with no sources at all.
    pub fn require_available_source(&self, requested: Option<&str>) -> ApiResult<()> {
        let sources = self.sources();
        let Some(requested) = requested.map(str::trim).filter(|r| !r.is_empty()) else {
            return if sources.iter().any(|s| s.enabled) {
                Ok(())
            } else {
                Err(ApiError::bad("No torrent sources are available. Enable a source in Settings."))
            };
        };
        let Some(source) =
            sources.iter().find(|s| s.name.eq_ignore_ascii_case(requested) || s.id.eq_ignore_ascii_case(requested))
        else {
            let names: Vec<_> = sources.iter().map(|s| s.name.as_str()).collect();
            return Err(ApiError::bad(format!("Unknown source '{requested}'. Valid sources: {}.", names.join(", "))));
        };
        if !source.enabled {
            return Err(ApiError::new(
                ErrorCode::BadRequest,
                format!("Source '{}' is disabled. Enable it in Settings before using it.", source.name),
            ));
        }
        Ok(())
    }
}
