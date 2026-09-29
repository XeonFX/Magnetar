//! Validates, dispatches and answers dashboard calls, and forwards broadcast events. The same
//! methods serve the local WebSocket and the end-to-end encrypted relay (see
//! `packages/protocol/src/rpc.ts` for the contract).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use base64::Engine as _;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::app::App;
use crate::config::{ARCH, PLATFORM, VERSION};
use crate::downloads::media::{MediaReader, media_type, open_reader, read_at};
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::protocol::encoding::random_id;
use crate::protocol::{
    AppInfoDto, ClaudeConnectResultDto, NotificationEvent, SeriesTaskInput, SeriesTaskPatch, SettingsPatch, StartDownloadInput,
};
use crate::search::cache::to_result_dto;
use crate::system;

/// Methods that act on the device's own screen or programs, not offered through the relay.
const LOCAL_ONLY_METHODS: [&str; 5] =
    ["fs.pickNative", "agent.connectClaude", "downloads.reveal", "downloads.openFile", "downloads.streamUrl"];
/// Streams a relayed browser may hold open at once, and the most one read returns: base64 in
/// JSON in a sealed frame must stay under the relay's 1 MiB.
const MAX_STREAMS: usize = 4;
const MAX_STREAM_READ: usize = 448 * 1024;

/// One connected dashboard. Messages for it arrive on the receiver handed back by `connect`.
pub struct RpcSession {
    app: Weak<App>,
    inner: Arc<SessionInner>,
}

struct SessionInner {
    local: bool,
    out: mpsc::UnboundedSender<Value>,
    /// Cancelled when the dashboard disconnects.
    closed: CancellationToken,
    /// In-flight searches, for cancellation.
    searches: Mutex<HashMap<String, CancellationToken>>,
    /// Files being played through this session, oldest first.
    streams: Mutex<Vec<(String, Arc<tokio::sync::Mutex<MediaReader>>)>>,
}

impl SessionInner {
    fn send(&self, message: Value) {
        if !self.closed.is_cancelled() {
            let _ = self.out.send(message);
        }
    }

    fn emit(&self, event: &str, data: Value) {
        self.send(json!({ "event": event, "data": data }));
    }
}

pub struct RpcServer {
    app: Weak<App>,
}

impl RpcServer {
    pub fn new(app: Weak<App>) -> Self {
        Self { app }
    }

    /// Opens a session; `local` is the device's own dashboard, as opposed to a relayed browser.
    pub fn connect(&self, local: bool) -> (RpcSession, mpsc::UnboundedReceiver<Value>) {
        let (out, receiver) = mpsc::unbounded_channel();
        let inner = Arc::new(SessionInner {
            local,
            out,
            closed: CancellationToken::new(),
            searches: Mutex::default(),
            streams: Mutex::default(),
        });
        if let Some(app) = self.app.upgrade() {
            let mut events = app.events.subscribe();
            let forward = inner.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = forward.closed.cancelled() => return,
                        received = events.recv() => match received {
                            Ok(event) => forward.emit(event.name, event.data.clone()),
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(_) => return,
                        },
                    }
                }
            });
        }
        (RpcSession { app: self.app.clone(), inner }, receiver)
    }
}

impl RpcSession {
    /// Handles one client message; the reply arrives on the session's receiver.
    pub fn handle(&self, message: Value) {
        let (Some(id), Some(method)) = (message.get("id").and_then(Value::as_i64), message.get("method").and_then(Value::as_str))
        else {
            return;
        };
        let method = method.to_owned();
        let params = message.get("params").cloned().filter(|p| !p.is_null()).unwrap_or_else(|| json!({}));
        let inner = self.inner.clone();
        let Some(app) = self.app.upgrade() else { return };
        tokio::spawn(async move {
            let reply = match dispatch(&app, &inner, &method, params).await {
                Ok(result) => json!({ "id": id, "result": result }),
                Err(error) => {
                    if error.is_internal() {
                        tracing::error!("{method} failed: {}", error.message);
                    }
                    json!({ "id": id, "error": { "code": error.code, "message": error.message } })
                }
            };
            inner.send(reply);
        });
    }

    pub fn close(&self) {
        self.inner.closed.cancel();
        self.inner.streams.lock().unwrap().clear();
        for (_, search) in self.inner.searches.lock().unwrap().drain() {
            search.cancel();
        }
    }
}

impl Drop for RpcSession {
    fn drop(&mut self) {
        self.close();
    }
}

fn parse<T: DeserializeOwned>(params: Value) -> ApiResult<T> {
    serde_json::from_value(params).map_err(|e| ApiError::bad(format!("params: {e}")))
}

fn ok(value: impl serde::Serialize) -> ApiResult<Value> {
    Ok(serde_json::to_value(value).unwrap_or(Value::Null))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoParams {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdParams {
    id: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchStart {
    query: String,
    source: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SearchId {
    search_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ResultId {
    result_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeleteDownload {
    id: i64,
    #[serde(default)]
    delete_files: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectFiles {
    id: i64,
    files: Vec<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileRef {
    id: i64,
    index: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StreamRead {
    stream_id: String,
    offset: u64,
    length: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StreamId {
    stream_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SeriesUpdate {
    id: i64,
    patch: SeriesTaskPatch,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathParams {
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PickNative {
    start: Option<String>,
    prompt: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enabled {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AgentSet {
    enabled: Option<bool>,
    allow_remote: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeviceName {
    device_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Label {
    label: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct KeyId {
    key_id: String,
}

/// A device name: trimmed, 1–60 characters.
fn device_name(name: Option<String>, required: bool) -> ApiResult<Option<String>> {
    match name.map(|n| n.trim().to_owned()) {
        Some(name) if (1..=60).contains(&name.chars().count()) => Ok(Some(name)),
        None if !required => Ok(None),
        _ => Err(ApiError::bad("deviceName: must be 1 to 60 characters")),
    }
}

async fn dispatch(app: &Arc<App>, session: &Arc<SessionInner>, method: &str, params: Value) -> ApiResult<Value> {
    if !session.local && LOCAL_ONLY_METHODS.contains(&method) {
        return Err(ApiError::new(ErrorCode::Forbidden, format!("{method} is only available on the device itself")));
    }
    let a = &app.actions;
    match method {
        "app.info" => {
            parse::<NoParams>(params)?;
            ok(AppInfoDto {
                version: VERSION,
                platform: PLATFORM,
                arch: ARCH,
                data_directory: app.paths.data_dir.to_string_lossy().into_owned(),
                native_folder_picker: session.local && cfg!(target_os = "macos"),
            })
        }
        "sources.list" => {
            parse::<NoParams>(params)?;
            ok(a.sources())
        }
        "search.start" => {
            let SearchStart { query, source } = parse(params)?;
            let query = query.trim().to_owned();
            if query.is_empty() {
                return Err(ApiError::bad("query: must not be empty"));
            }
            a.require_available_source(source.as_deref())?;
            let search_id = random_id(6);
            let cancel = session.closed.child_token();
            session.searches.lock().unwrap().insert(search_id.clone(), cancel.clone());
            let (app, session, id) = (app.clone(), session.clone(), search_id.clone());
            tokio::spawn(async move {
                let on_results = |batch: Vec<_>| {
                    let results: Vec<_> = batch
                        .into_iter()
                        .map(|r| {
                            let (result_id, _) = app.actions.cache.add(Clone::clone(&r));
                            to_result_dto(&r, &result_id)
                        })
                        .collect();
                    session.emit("search.results", json!({ "searchId": id, "results": results }));
                };
                let on_outcome = |outcome: &_| session.emit("search.source", json!({ "searchId": id, "outcome": outcome }));
                let outcome = app.search.search_stream(&query, source.as_deref(), &on_results, &on_outcome, &cancel, true).await;
                if !cancel.is_cancelled() {
                    let error = outcome.err().map(|e| e.to_string());
                    session.emit("search.done", json!({ "searchId": id, "error": error }));
                }
                session.searches.lock().unwrap().remove(&id);
            });
            ok(json!({ "searchId": search_id }))
        }
        "search.cancel" => {
            let SearchId { search_id } = parse(params)?;
            if let Some(search) = session.searches.lock().unwrap().remove(&search_id) {
                search.cancel();
            }
            ok(Value::Null)
        }
        "search.details" => {
            let ResultId { result_id } = parse(params)?;
            ok(a.details(&result_id, &session.closed).await?)
        }

        "downloads.list" => {
            parse::<NoParams>(params)?;
            ok(a.list_downloads(None)?)
        }
        "downloads.start" => ok(a.start_download(parse::<StartDownloadInput>(params)?, &session.closed).await?),
        "downloads.pause" => ok(a.pause(parse::<IdParams>(params)?.id).await?),
        "downloads.resume" => ok(a.resume(parse::<IdParams>(params)?.id)?),
        "downloads.delete" => {
            let DeleteDownload { id, delete_files } = parse(params)?;
            a.delete_download(id, delete_files).await?;
            ok(Value::Null)
        }

        "downloads.files" => ok(app.downloads.files(parse::<IdParams>(params)?.id)?),
        "downloads.selectFiles" => {
            let SelectFiles { id, files } = parse(params)?;
            ok(app.downloads.select_files(id, files).await?)
        }
        "downloads.reveal" => {
            system::reveal_in_file_manager(&app.downloads.location(parse::<IdParams>(params)?.id)?);
            ok(Value::Null)
        }
        "downloads.openFile" => {
            let FileRef { id, index } = parse(params)?;
            // Media only: a torrent can carry programs, and those are never opened from here.
            let file = app.downloads.files(id)?.into_iter().find(|f| f.index == index);
            if !file.as_ref().is_some_and(|f| f.playable && f.done == f.size) {
                return Err(ApiError::bad("Only finished video and audio files open from here."));
            }
            match app.downloads.open_file(id, index)?.source {
                crate::downloads::manager::FileSource::Disk(path) => system::open_with_system(path),
                _ => return Err(ApiError::bad("That file is not finished yet.")),
            }
            ok(Value::Null)
        }
        "downloads.streamUrl" => {
            let FileRef { id, index } = parse(params)?;
            app.downloads.open_file(id, index)?;
            ok(json!({ "url": format!("/stream/{}", app.streams.grant(id, index)) }))
        }
        "stream.open" => {
            let FileRef { id, index } = parse(params)?;
            let file = app.downloads.open_file(id, index)?;
            let reader = open_reader(&file).await?;
            let stream_id = random_id(9);
            let mut streams = session.streams.lock().unwrap();
            if streams.len() >= MAX_STREAMS {
                streams.remove(0);
            }
            streams.push((stream_id.clone(), Arc::new(tokio::sync::Mutex::new(reader))));
            ok(json!({ "streamId": stream_id, "size": file.size, "name": file.name, "type": media_type(&file.name) }))
        }
        "stream.read" => {
            let StreamRead { stream_id, offset, length } = parse(params)?;
            let reader = session.streams.lock().unwrap().iter().find(|(id, _)| *id == stream_id).map(|(_, r)| r.clone());
            let reader = reader.ok_or_else(|| ApiError::not_found("That stream was closed. Open the player again."))?;
            let bytes = read_at(&mut *reader.lock().await, offset, length.min(MAX_STREAM_READ)).await?;
            ok(json!({ "data": base64::engine::general_purpose::STANDARD.encode(bytes) }))
        }
        "stream.close" => {
            let StreamId { stream_id } = parse(params)?;
            session.streams.lock().unwrap().retain(|(id, _)| *id != stream_id);
            ok(Value::Null)
        }
        "transfer.status" => {
            parse::<NoParams>(params)?;
            ok(app.downloads.transfer_status())
        }
        "network.interfaces" => {
            parse::<NoParams>(params)?;
            ok(json!({
                "supported": crate::downloads::transfer::INTERFACE_BINDING,
                "interfaces": crate::downloads::transfer::list_interfaces(),
            }))
        }

        "series.list" => {
            parse::<NoParams>(params)?;
            ok(a.list_series())
        }
        "series.create" => ok(a.create_series(parse::<SeriesTaskInput>(params)?)?),
        "series.update" => {
            let SeriesUpdate { id, patch } = parse(params)?;
            ok(a.update_series(id, patch)?)
        }
        "series.delete" => {
            a.delete_series(parse::<IdParams>(params)?.id)?;
            ok(Value::Null)
        }
        "series.checkNow" => ok(a.check_series_now(parse::<IdParams>(params)?.id).await?),

        "settings.get" => {
            parse::<NoParams>(params)?;
            ok(app.settings.to_dto())
        }
        "settings.update" => ok(app.settings.apply_patch(parse::<SettingsPatch>(params)?.validated()?)),
        "notifications.test" => {
            parse::<NoParams>(params)?;
            let event = NotificationEvent {
                kind: "test",
                title: "Test notification".into(),
                message: "If you can read this, notifications are working.".into(),
            };
            app.notifications.dispatch(event, true).await?;
            ok(Value::Null)
        }

        "fs.list" => ok(system::folders::list_folder(parse::<PathParams>(params)?.path.as_deref())),
        "fs.mkdir" => {
            let path = parse::<PathParams>(params)?.path.filter(|p| !p.is_empty());
            let path = path.ok_or_else(|| ApiError::bad("path: must not be empty"))?;
            ok(system::folders::make_folder(&path)?)
        }
        "fs.pickNative" => {
            let PickNative { start, prompt } = parse(params)?;
            let prompt = prompt.unwrap_or_else(|| "Choose a folder".into());
            ok(json!({ "path": system::folders::pick_folder_natively(start.as_deref(), &prompt).await }))
        }

        "updates.status" => {
            parse::<NoParams>(params)?;
            ok(app.updates.status())
        }
        "updates.check" => {
            parse::<NoParams>(params)?;
            ok(app.updates.check().await)
        }
        "updates.install" => {
            parse::<NoParams>(params)?;
            if let Some(release_page) = app.updates.install().await {
                system::open_in_browser(&release_page);
            }
            ok(app.updates.status())
        }

        "startup.status" => {
            parse::<NoParams>(params)?;
            ok(json!({ "status": system::login_startup::status() }))
        }
        "startup.set" => ok(json!({ "status": system::login_startup::set(parse::<Enabled>(params)?.enabled)? })),

        "agent.status" => {
            parse::<NoParams>(params)?;
            ok(app.agent.status())
        }
        "agent.set" => {
            let AgentSet { enabled, allow_remote } = parse(params)?;
            ok(app.agent.set(enabled, allow_remote))
        }
        "agent.regenerateToken" => {
            parse::<NoParams>(params)?;
            ok(app.agent.regenerate())
        }
        "agent.connectClaude" => {
            parse::<NoParams>(params)?;
            let agent = app.agent.set(Some(true), None);
            let status = match system::claude::find_cli() {
                Some(cli) => {
                    system::claude::register(&cli, &agent.mcp_url).await?;
                    "connected"
                }
                None => "cliNotFound",
            };
            ok(ClaudeConnectResultDto { status, command: system::claude::command(&agent.mcp_url), agent })
        }

        "remote.status" => {
            parse::<NoParams>(params)?;
            ok(app.remote.status())
        }
        "remote.pair" => ok(app.remote.pair(device_name(parse::<DeviceName>(params)?.device_name, false)?).await?),
        "remote.cancelPairing" => {
            parse::<NoParams>(params)?;
            ok(app.remote.cancel_pairing())
        }
        "remote.unpair" => {
            parse::<NoParams>(params)?;
            ok(app.remote.unpair().await)
        }
        "remote.rename" => {
            let name = device_name(parse::<DeviceName>(params)?.device_name, true)?.unwrap_or_default();
            ok(app.remote.rename(&name).await?)
        }
        "remote.linkBrowser" => {
            let label = parse::<Label>(params)?.label.map(|l| l.trim().to_owned());
            if label.as_ref().is_some_and(|l| l.chars().count() > 60) {
                return Err(ApiError::bad("label: must be at most 60 characters"));
            }
            ok(app.remote.link_browser(label.as_deref())?)
        }
        "remote.revokeBrowser" => ok(app.remote.revoke_browser(&parse::<KeyId>(params)?.key_id)),

        "legacy.status" => {
            parse::<NoParams>(params)?;
            ok(app.legacy.status())
        }
        "legacy.import" => {
            parse::<NoParams>(params)?;
            let result = app.legacy.run()?;
            app.downloads.load_new();
            app.series.changed();
            ok(result)
        }
        _ => Err(ApiError::not_found(format!("Unknown method {method}"))),
    }
}
