//! `magnetar mcp`: the app's MCP server on standard input and output, for agents that only start
//! local servers (Claude Desktop). Each line in is a JSON-RPC message, passed to the running app's
//! HTTP endpoint; each answer goes out as one line. Replies may come out of order, as JSON-RPC
//! allows, so a long search doesn't hold up a ping. Nothing but JSON-RPC is written to stdout.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::paths::Paths;

/// Where the running app answers, from the endpoint file it keeps current. The bridge talks to it
/// on this computer, which needs no token, so none is sent: a stopped app's port can't collect it.
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub mcp_url: String,
}

impl Endpoint {
    pub fn read(paths: &Paths) -> Option<Self> {
        let file: Value = serde_json::from_str(&std::fs::read_to_string(&paths.endpoint).ok()?).ok()?;
        Some(Self { mcp_url: file["mcpUrl"].as_str()?.to_owned() })
    }
}

/// How long a freshly started app gets to answer.
const START_WAIT: Duration = Duration::from_secs(20);
const NOT_RUNNING: &str = "Magnetar isn't running. Open it on this computer, then try again.";

/// Passes messages until `input` ends. `endpoint` is read again for every message, so a restarted
/// app on another port is found; `start_app` is tried once when the app can't be reached.
pub async fn serve<R, W>(
    input: R,
    output: W,
    endpoint: impl Fn() -> Option<Endpoint> + Send + Sync + 'static,
    start_app: impl Fn() -> bool + Send + Sync + 'static,
) where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let http = reqwest::Client::builder().no_proxy().build().expect("HTTP client");
    let output = Arc::new(Mutex::new(output));
    let endpoint = Arc::new(endpoint);
    let start_app = Arc::new(start_app);
    let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut lines = input.lines();
    let mut tasks = tokio::task::JoinSet::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let (http, output, endpoint, start_app, started) =
            (http.clone(), output.clone(), endpoint.clone(), start_app.clone(), started.clone());
        tasks.spawn(async move {
            let answer =
                relay(&http, &line, &*endpoint, || !started.swap(true, std::sync::atomic::Ordering::SeqCst) && start_app()).await;
            if let Some(answer) = answer {
                let mut out = output.lock().await;
                let mut text = serde_json::to_string(&answer).expect("JSON");
                text.push('\n');
                if out.write_all(text.as_bytes()).await.is_err() || out.flush().await.is_err() {
                    tracing::debug!("The agent stopped reading");
                }
            }
        });
    }
    while tasks.join_next().await.is_some() {}
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// One message there and its answer back; None when there is nothing to answer (notifications).
async fn relay(
    http: &reqwest::Client,
    line: &str,
    endpoint: &(dyn Fn() -> Option<Endpoint> + Send + Sync),
    start_app: impl Fn() -> bool,
) -> Option<Value> {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return Some(error(Value::Null, -32700, "Parse error"));
    };
    // Only requests get answers; notifications and a batch of them get none.
    let id = message.get("id").cloned().filter(|_| message.get("method").is_some());
    let fail = |text: &str| id.clone().map(|id| error(id, -32000, text));

    let post = |target: &Endpoint| {
        http.post(&target.mcp_url)
            .header("accept", "application/json, text/event-stream")
            .json(&message)
            .timeout(Duration::from_secs(300))
            .send()
    };
    let mut response = match endpoint() {
        Some(target) => post(&target).await.ok(),
        None => None,
    };
    if response.is_none() && start_app() {
        let deadline = tokio::time::Instant::now() + START_WAIT;
        while response.is_none() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if let Some(target) = endpoint() {
                response = post(&target).await.ok();
            }
        }
    }
    let Some(response) = response else { return fail(NOT_RUNNING) };
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    match status.as_u16() {
        200 => Some(body),
        202 => None,
        _ => {
            let reason = body["error"].as_str().map_or_else(|| format!("Magnetar answered {status}"), str::to_owned);
            fail(&reason)
        }
    }
}

/// Starts the app in the background, apart from this process, so it outlives the agent.
pub fn start_app() -> bool {
    #[cfg(target_os = "macos")]
    if let Some(bundle) = crate::paths::mac_app_bundle() {
        return std::process::Command::new("/usr/bin/open").arg("-g").arg(bundle).status().is_ok_and(|s| s.success());
    }
    let Ok(program) = std::env::current_exe() else { return false };
    let mut command = std::process::Command::new(program);
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0000_0008 | 0x0800_0000);
    command.spawn().is_ok()
}

/// `magnetar mcp`, reading and writing the process's own stdin and stdout.
pub fn main(paths: Paths) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(serve(
        tokio::io::BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
        move || Endpoint::read(&paths),
        start_app,
    ));
    Ok(())
}
