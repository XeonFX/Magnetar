//! The agent REST surface under /api. Mirrors the MCP tools one-to-one; both go through Actions.
//! PATCH /api/series/{id} changes the fields sent; PUT replaces the whole rule and so requires
//! every field — a partial PUT is a 400, not a silent reset.

use axum::http::{Method, StatusCode};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::api::actions::Actions;
use crate::error::{ApiError, ApiResult};
use crate::protocol::{SeriesTaskInput, SeriesTaskPatch, SeriesTaskReplacement, StartDownloadInput};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchRequest {
    query: String,
    source: Option<String>,
    limit: Option<usize>,
}

fn body<T: DeserializeOwned>(bytes: &[u8]) -> ApiResult<T> {
    let json: Value = serde_json::from_slice(bytes).map_err(|_| ApiError::bad("The request body must be JSON."))?;
    serde_json::from_value(json).map_err(|e| ApiError::bad(format!("body: {e}")))
}

fn to_json(value: impl serde::Serialize) -> ApiResult<Value> {
    Ok(serde_json::to_value(value).unwrap_or(Value::Null))
}

/// The route a path matches, with its numeric or string parameter.
enum Route<'a> {
    Sources,
    Search,
    SearchResult(&'a str),
    Downloads,
    Download(i64),
    DownloadPause(i64),
    DownloadResume(i64),
    Series,
    SeriesTask(i64),
    SeriesCheck(i64),
    Settings,
}

impl Route<'_> {
    fn methods(&self) -> &'static [&'static str] {
        match self {
            Route::Sources | Route::SearchResult(_) | Route::Settings => &["GET"],
            Route::Search | Route::DownloadPause(_) | Route::DownloadResume(_) | Route::SeriesCheck(_) => &["POST"],
            Route::Downloads | Route::Series => &["GET", "POST"],
            Route::Download(_) => &["GET", "DELETE"],
            Route::SeriesTask(_) => &["GET", "PUT", "PATCH", "DELETE"],
        }
    }
}

fn route(path: &str) -> Option<Route<'_>> {
    let segments: Vec<&str> = path.trim_start_matches("/api/").split('/').collect();
    let id = |s: &str| s.parse::<i64>().ok().filter(|_| s.bytes().all(|b| b.is_ascii_digit()));
    let word = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    Some(match segments.as_slice() {
        ["sources"] => Route::Sources,
        ["search"] => Route::Search,
        ["search", result] if word(result) => Route::SearchResult(result),
        ["downloads"] => Route::Downloads,
        ["downloads", n] => Route::Download(id(n)?),
        ["downloads", n, "pause"] => Route::DownloadPause(id(n)?),
        ["downloads", n, "resume"] => Route::DownloadResume(id(n)?),
        ["series"] => Route::Series,
        ["series", n] => Route::SeriesTask(id(n)?),
        ["series", n, "check"] => Route::SeriesCheck(id(n)?),
        ["settings"] => Route::Settings,
        _ => return None,
    })
}

pub async fn handle(
    actions: &Actions,
    method: &Method,
    path: &str,
    query: Option<&str>,
    bytes: &[u8],
    cancel: &CancellationToken,
) -> (StatusCode, Value) {
    let Some(route) = route(path) else { return (StatusCode::NOT_FOUND, json!({ "error": "Not found." })) };
    if !route.methods().contains(&method.as_str()) {
        return (StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Method not allowed." }));
    }
    let param = |name: &str| {
        url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
    };
    let result: ApiResult<Value> = async {
        match (route, method.as_str()) {
            (Route::Sources, _) => to_json(actions.sources()),
            (Route::Search, _) => {
                let input: SearchRequest = body(bytes)?;
                to_json(actions.search(&input.query, input.source.as_deref(), input.limit, cancel).await?)
            }
            (Route::SearchResult(id), _) => to_json(actions.details(id, cancel).await?),
            (Route::Downloads, "POST") => to_json(actions.start_download(body::<StartDownloadInput>(bytes)?, cancel).await?),
            (Route::Downloads, _) => to_json(actions.list_downloads(param("status").as_deref())?),
            (Route::Download(id), "DELETE") => {
                to_json(actions.delete_download(id, param("deleteFiles").as_deref() == Some("true")).await?)
            }
            (Route::Download(id), _) => to_json(actions.get_download(id)?),
            (Route::DownloadPause(id), _) => to_json(actions.pause(id).await?),
            (Route::DownloadResume(id), _) => to_json(actions.resume(id)?),
            (Route::Series, "POST") => to_json(actions.create_series(body::<SeriesTaskInput>(bytes)?).await?),
            (Route::Series, _) => to_json(actions.list_series()),
            (Route::SeriesTask(id), "PUT") => to_json(actions.update_series(id, body::<SeriesTaskReplacement>(bytes)?.into())?),
            (Route::SeriesTask(id), "PATCH") => to_json(actions.update_series(id, body::<SeriesTaskPatch>(bytes)?)?),
            (Route::SeriesTask(id), "DELETE") => to_json(actions.delete_series(id)?),
            (Route::SeriesTask(id), _) => to_json(actions.get_series(id)?),
            (Route::SeriesCheck(id), _) => to_json(actions.check_series_now(id).await?),
            (Route::Settings, _) => to_json(actions.agent_settings()),
        }
    }
    .await;
    match result {
        Ok(value) => (StatusCode::OK, value),
        Err(error) if error.is_internal() => {
            tracing::error!("Agent API {method} {path} failed: {}", error.message);
            (StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "Internal error." }))
        }
        Err(error) => {
            (StatusCode::from_u16(error.http_status()).unwrap_or(StatusCode::BAD_REQUEST), json!({ "error": error.message }))
        }
    }
}

/// The `Allow` header value for a path, for 405 answers.
pub fn allowed_methods(path: &str) -> Option<String> {
    route(path).map(|r| r.methods().join(", "))
}
