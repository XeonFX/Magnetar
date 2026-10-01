//! The MCP endpoint: stateless Streamable HTTP with JSON responses. Every POST carries complete
//! JSON-RPC messages and gets its answer in the same response, so there are no sessions to keep.

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::api::actions::Actions;
use crate::config::VERSION;
use crate::error::{ApiError, ApiResult};
use crate::protocol::{DOWNLOAD_STATUSES, SeriesTaskInput, SeriesTaskPatch, StartDownloadInput};

const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

fn read_only() -> Value {
    json!({ "readOnlyHint": true, "destructiveHint": false })
}

fn tool(name: &str, description: &str, input: Value, annotations: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input, "annotations": annotations })
}

/// Null clears a field, as in REST PATCH; omitting it keeps the current value.
fn series_fields() -> Map<String, Value> {
    let nullable = |kind: &str, description: &str| json!({ "type": [kind, "null"], "description": description });
    let fields = json!({
        "titleFilter": nullable("string", "Extra text that must appear in a result title; null clears it."),
        "provider": nullable("string", "Restrict to one source; null searches all."),
        "season": nullable("integer", "Season number; when set only SxxEyy-style titles match. Null clears it."),
        "startEpisode": { "type": "integer", "description": "First episode to look for." },
        "endEpisode": nullable("integer", "Last episode; the rule disables itself once it is downloaded. Null means no end."),
        "checkIntervalMinutes": { "type": "integer", "description": "How often to check, in minutes." },
        "enabled": { "type": "boolean", "description": "False pauses the rule without deleting it." },
        "downloadFolder": nullable("string", "Must be inside the configured download folder; null uses the default."),
        "resolution": { "type": ["string", "null"], "enum": ["720p", "1080p", "2160p", null], "description": "Only releases of this resolution; null takes any." },
        "minSeeders": { "type": "integer", "minimum": 1, "description": "Skip releases with fewer seeders (default 1)." },
        "maxSizeMb": nullable("integer", "Skip releases larger than this many MiB; null means no limit."),
        "preferWords": nullable("string", "Comma-separated words that make a release preferred (a group such as SubsPlease, a codec such as HEVC)."),
        "excludeWords": nullable("string", "Comma-separated words that rule a release out (CAM, dubbed)."),
    });
    fields.as_object().cloned().unwrap_or_default()
}

fn with(mut base: Map<String, Value>, extra: Value) -> Value {
    if let Value::Object(extra) = extra {
        base.extend(extra);
    }
    Value::Object(base)
}

static TOOLS: std::sync::LazyLock<Vec<Value>> = std::sync::LazyLock::new(tools);

fn tools() -> Vec<Value> {
    let id = json!({ "id": { "type": "integer", "description": "Download id from list_downloads." } });
    let series_id = json!({ "id": { "type": "integer", "description": "Series task id from list_series_tasks." } });
    let write = |idempotent: bool, destructive: bool, open_world: bool| json!({ "readOnlyHint": false, "destructiveHint": destructive, "idempotentHint": idempotent, "openWorldHint": open_world });
    vec![
        tool("list_sources", "List torrent sources and whether each is enabled.", schema(json!({}), &[]), read_only()),
        tool(
            "search_torrents",
            "Search one or all enabled torrent sources. Inspect the per-source outcomes before treating an empty result list as no matches. Result ids remain valid for about 30 minutes.",
            schema(
                json!({
                    "query": { "type": "string", "description": "Words that every returned title should contain." },
                    "source": { "type": "string", "description": "Exact source name from list_sources, or omit to search all enabled sources." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Maximum results to return, from 1 to 200. Defaults to 25." },
                }),
                &["query"],
            ),
            json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": true }),
        ),
        tool(
            "get_torrent_details",
            "Resolve the description and magnet for a result returned by search_torrents. Some sources fetch a detail page lazily.",
            schema(
                json!({ "resultId": { "type": "string", "description": "Opaque result id returned by search_torrents." } }),
                &["resultId"],
            ),
            json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": true }),
        ),
        tool(
            "get_settings",
            "Read the default download folder and post-download behavior. Secret and notification settings are never exposed.",
            schema(json!({}), &[]),
            read_only(),
        ),
        tool(
            "start_download",
            "Queue a torrent download. Prefer a resultId from search_torrents because lazy sources cannot always be started from a magnet alone.",
            schema(
                json!({
                    "resultId": { "type": "string", "description": "Opaque id returned by search_torrents." },
                    "magnet": { "type": "string", "description": "Raw magnet URI when no search result id is available." },
                    "folder": { "type": "string", "description": "Optional save folder override; must be inside the configured download folder." },
                }),
                &[],
            ),
            write(false, false, true),
        ),
        tool(
            "list_downloads",
            "List downloads with current progress, speeds, peers, and status.",
            schema(
                json!({ "status": { "type": "string", "description": format!("Optional status filter: {}.", DOWNLOAD_STATUSES.join(", ")) } }),
                &[],
            ),
            read_only(),
        ),
        tool("pause_download", "Pause an active download.", schema(id.clone(), &["id"]), write(true, false, false)),
        tool("resume_download", "Resume a paused download.", schema(id.clone(), &["id"]), write(true, false, false)),
        tool(
            "delete_download",
            "Remove a download from Magnetar. deleteFiles defaults to false. Setting it true permanently erases downloaded data from disk.",
            schema(
                with(
                    id.as_object().cloned().unwrap_or_default(),
                    json!({ "deleteFiles": { "type": "boolean", "description": "False keeps downloaded files. True permanently erases them." } }),
                ),
                &["id"],
            ),
            write(true, true, false),
        ),
        tool(
            "list_series_tasks",
            "List automatic series download rules and their next episode/check state.",
            schema(json!({}), &[]),
            read_only(),
        ),
        tool(
            "create_series_task",
            "Create an automatic rule that searches for and downloads new episodes.",
            schema(
                with(
                    series_fields(),
                    json!({
                        "name": { "type": "string" },
                        "query": { "type": "string", "description": "Search query, e.g. \"One Piece 1080p\"." },
                        "startFrom": {
                            "type": "string",
                            "enum": ["episode", "latest", "new"],
                            "description": "episode: from startEpisode, catching up on everything after it (default). latest: the newest episode already out, then each new one. new: only episodes released from now on."
                        },
                    }),
                ),
                &["name", "query"],
            ),
            json!({ "readOnlyHint": false, "destructiveHint": false }),
        ),
        tool(
            "update_series_task",
            "Change one or more fields of an automatic series rule. Anything you leave out keeps its current value, so pass only what should change.",
            schema(
                with(
                    series_fields(),
                    with(
                        series_id.as_object().cloned().unwrap_or_default(),
                        json!({ "name": { "type": "string" }, "query": { "type": "string" } }),
                    ),
                ),
                &["id"],
            ),
            write(true, false, false),
        ),
        tool(
            "delete_series_task",
            "Delete an automatic series rule. Existing downloads and their files are kept.",
            schema(series_id.clone(), &["id"]),
            write(true, true, false),
        ),
        tool(
            "check_series_task_now",
            "Run one series rule immediately. This can queue one or more matching episode downloads.",
            schema(series_id, &["id"]),
            json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true }),
        ),
    ]
}

#[derive(Deserialize)]
struct Search {
    query: String,
    source: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResultId {
    result_id: String,
}

#[derive(Deserialize)]
struct Status {
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Id {
    id: i64,
    #[serde(default)]
    delete_files: bool,
}

fn args<T: DeserializeOwned>(tool: &str, arguments: &Value) -> ApiResult<T> {
    serde_json::from_value(arguments.clone()).map_err(|e| ApiError::bad(format!("Invalid arguments for tool {tool}: {e}")))
}

fn to_value(value: impl serde::Serialize) -> ApiResult<Value> {
    Ok(serde_json::to_value(value).unwrap_or(Value::Null))
}

async fn call_tool(actions: &Actions, name: &str, arguments: &Value, cancel: &CancellationToken) -> ApiResult<Value> {
    match name {
        "list_sources" => to_value(actions.sources()),
        "search_torrents" => {
            let a: Search = args(name, arguments)?;
            to_value(actions.search(&a.query, a.source.as_deref(), a.limit, cancel).await?)
        }
        "get_torrent_details" => to_value(actions.details(&args::<ResultId>(name, arguments)?.result_id, cancel).await?),
        "get_settings" => to_value(actions.agent_settings()),
        "start_download" => to_value(actions.start_download(args::<StartDownloadInput>(name, arguments)?, cancel).await?),
        "list_downloads" => to_value(actions.list_downloads(args::<Status>(name, arguments)?.status.as_deref())?),
        "pause_download" => to_value(actions.pause(args::<Id>(name, arguments)?.id).await?),
        "resume_download" => to_value(actions.resume(args::<Id>(name, arguments)?.id)?),
        "delete_download" => {
            let a: Id = args(name, arguments)?;
            to_value(actions.delete_download(a.id, a.delete_files).await?)
        }
        "list_series_tasks" => to_value(actions.list_series()),
        "create_series_task" => to_value(actions.create_series(args::<SeriesTaskInput>(name, arguments)?).await?),
        "update_series_task" => {
            let id = args::<Id>(name, arguments)?.id;
            let mut fields = arguments.clone();
            if let Some(object) = fields.as_object_mut() {
                object.remove("id");
            }
            to_value(actions.update_series(id, args::<SeriesTaskPatch>(name, &fields)?)?)
        }
        "delete_series_task" => to_value(actions.delete_series(args::<Id>(name, arguments)?.id)?),
        "check_series_task_now" => to_value(actions.check_series_now(args::<Id>(name, arguments)?.id).await?),
        _ => Err(ApiError::not_found(format!("Unknown tool {name}"))),
    }
}

/// Wraps a result for MCP; caller mistakes come back as tool errors the model can read, not stack traces.
fn tool_result(result: ApiResult<Value>) -> Value {
    match result {
        Ok(value) => {
            let value = if value.is_null() { json!({ "success": true }) } else { value };
            let structured = if value.is_array() { json!({ "items": value }) } else { value.clone() };
            json!({ "content": [{ "type": "text", "text": value.to_string() }], "structuredContent": structured })
        }
        Err(error) => {
            let message = if error.is_internal() {
                tracing::error!("MCP tool failed: {}", error.message);
                "The operation failed. See the Magnetar log for details.".to_owned()
            } else {
                error.message
            };
            json!({ "content": [{ "type": "text", "text": message }], "isError": true })
        }
    }
}

pub(crate) fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Answers one JSON-RPC message; None for notifications and responses.
async fn message(actions: &Actions, message: &Value, cancel: &CancellationToken) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").cloned().filter(|id| !id.is_null());
    let (Some(method), Some(id)) = (method, id) else {
        return (message.get("method").is_none() && message.get("id").is_none())
            .then(|| error(Value::Null, -32600, "Invalid Request"));
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let requested = params["protocolVersion"].as_str().unwrap_or_default();
            let version = PROTOCOL_VERSIONS.iter().find(|v| **v == requested).unwrap_or(&PROTOCOL_VERSIONS[0]);
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "magnetar", "version": VERSION },
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": *TOOLS }),
        "tools/call" => {
            let Some(name) = params["name"].as_str() else { return Some(error(id, -32602, "Missing tool name")) };
            if !TOOLS.iter().any(|t| t["name"] == name) {
                return Some(error(id, -32602, &format!("Unknown tool: {name}")));
            }
            let arguments = if params["arguments"].is_object() { params["arguments"].clone() } else { json!({}) };
            tool_result(call_tool(actions, name, &arguments, cancel).await)
        }
        _ => return Some(error(id, -32601, &format!("Method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// A POST to /mcp: the status and, unless every message was a notification, the JSON answer.
pub async fn handle(actions: &Actions, body: &[u8], cancel: &CancellationToken) -> (u16, Option<Value>) {
    let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
        return (400, Some(error(Value::Null, -32700, "Parse error")));
    };
    match parsed {
        Value::Array(batch) => {
            let mut answers = Vec::new();
            for item in &batch {
                answers.extend(message(actions, item, cancel).await);
            }
            if answers.is_empty() { (202, None) } else { (200, Some(Value::Array(answers))) }
        }
        single => match message(actions, &single, cancel).await {
            Some(answer) => (200, Some(answer)),
            None => (202, None),
        },
    }
}
