use std::future::Future;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures::future::join_all;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::config::USER_AGENT;

/// A backstop, not the usual limit: mirror fallback is staggered (see MirrorRotator), which caps
/// the wait on a slow host at ~1.5s. apibay.org takes ~16s on an uncached query, so shorter than
/// this would fail searches that were merely slow.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug)]
pub enum FetchError {
    Status(u16, String),
    Timeout,
    Cancelled,
    Unreachable,
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Status(status, host) => write!(f, "HTTP {status} from {host}"),
            Self::Timeout => f.write_str("timed out"),
            Self::Cancelled => f.write_str("cancelled"),
            Self::Unreachable => f.write_str("unreachable"),
        }
    }
}

impl std::error::Error for FetchError {}

/// Runs a future unless the token is cancelled first.
pub async fn cancellable<T>(cancel: &CancellationToken, future: impl Future<Output = anyhow::Result<T>>) -> anyhow::Result<T> {
    tokio::select! {
        _ = cancel.cancelled() => Err(FetchError::Cancelled.into()),
        result = future => result,
    }
}

/// GET a page as text, failing on non-2xx, a timeout, or cancellation.
pub async fn fetch_text(http: &reqwest::Client, url: &str, cancel: &CancellationToken) -> anyhow::Result<String> {
    cancellable(cancel, async {
        let response = http
            .get(url)
            .header("user-agent", USER_AGENT.as_str())
            .header("accept", "text/html,application/json;q=0.9,*/*;q=0.8")
            .timeout(SEARCH_TIMEOUT)
            .send()
            .await
            .map_err(classify)?;
        if !response.status().is_success() {
            let host = response.url().host_str().unwrap_or_default().to_owned();
            return Err(FetchError::Status(response.status().as_u16(), host).into());
        }
        response.text().await.map_err(classify)
    })
    .await
}

fn classify(error: reqwest::Error) -> anyhow::Error {
    if error.is_timeout() {
        FetchError::Timeout.into()
    } else if error.is_connect() {
        FetchError::Unreachable.into()
    } else {
        error.into()
    }
}

/// Fetches pages 2..=count+1 concurrently for providers that page their results. A failed extra
/// page is dropped rather than losing the page-1 rows already in hand; only cancellation fails.
pub async fn fetch_extra_pages<T, F, Fut>(count: usize, page: F, cancel: &CancellationToken) -> anyhow::Result<Vec<T>>
where
    F: Fn(usize) -> Fut,
    Fut: Future<Output = anyhow::Result<Vec<T>>>,
{
    let pages = join_all((0..count).map(|i| page(i + 2))).await;
    if cancel.is_cancelled() {
        return Err(FetchError::Cancelled.into());
    }
    Ok(pages.into_iter().flat_map(|p| p.unwrap_or_default()).collect())
}

pub fn is_cancelled(error: &anyhow::Error) -> bool {
    matches!(error.downcast_ref::<FetchError>(), Some(FetchError::Cancelled))
}

/// A short, user-facing reason a provider failed.
pub fn describe_failure(error: &anyhow::Error) -> String {
    if let Some(fetch) = error.downcast_ref::<FetchError>() {
        return match fetch {
            FetchError::Status(status, _) => format!("HTTP {status}"),
            other => other.to_string(),
        };
    }
    if error.downcast_ref::<serde_json::Error>().is_some() {
        return "unreadable response".into();
    }
    if let Some(reqwest) = error.downcast_ref::<reqwest::Error>()
        && (reqwest.is_request() || reqwest.is_body())
    {
        return "unreachable".into();
    }
    error.to_string()
}

/// `parseInt` of a cell; 0 for anything else. Sites send numbers as numbers or strings.
pub fn to_int(value: &Value) -> u32 {
    let n = match value {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => {
            let trimmed = s.trim();
            let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<f64>().unwrap_or(0.0)
        }
        _ => 0.0,
    };
    if n.is_finite() && n > 0.0 { n.trunc().min(i32::MAX as f64) as u32 } else { 0 }
}

pub fn text_to_int(text: &str) -> u32 {
    to_int(&Value::String(text.to_owned()))
}

/// `Number(value)`: a whole-string number, 0 otherwise.
pub fn to_number(value: &Value) -> f64 {
    let n = match value {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) if s.trim().is_empty() => 0.0,
        Value::String(s) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    };
    if n.is_finite() { n } else { 0.0 }
}

pub fn from_unix_seconds(value: &Value) -> Option<DateTime<Utc>> {
    let seconds = to_number(value);
    (seconds > 0.0).then(|| DateTime::from_timestamp_millis((seconds * 1000.0) as i64)).flatten()
}

pub fn as_trimmed_str(value: &Value) -> &str {
    value.as_str().map(str::trim).unwrap_or_default()
}
