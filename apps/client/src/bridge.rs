//! `magnetar mcp`: the app's MCP server on standard input and output, for agents that only start
//! local servers (Claude Desktop). Each line in is a JSON-RPC message, passed to the running app's
//! HTTP endpoint; each answer goes out as one line. Replies may come out of order, as JSON-RPC
//! allows, so a long search doesn't hold up a ping. Nothing but JSON-RPC is written to stdout.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::api::agent_access::EndpointFile;
use crate::http::mcp::error;
use crate::paths::Paths;

/// How long a freshly started app gets to answer.
const START_WAIT: Duration = Duration::from_secs(20);
const NOT_RUNNING: &str = "Magnetar isn't running. Open it on this computer, then try again.";

/// Passes messages until `input` ends. `mcp_url` is read again for every message, so a restarted
/// app on another port is found; `start_app` is tried once, when the app can't be reached. The app
/// is on this computer, which needs no token, so none is sent: a stopped app's port can't collect it.
pub async fn serve<R, W>(
    input: R,
    output: W,
    mcp_url: impl Fn() -> Option<String> + Send + Sync + 'static,
    start_app: impl Fn() -> bool + Send + Sync + 'static,
) where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let http = reqwest::Client::builder().no_proxy().build().expect("HTTP client");
    let output = Arc::new(Mutex::new(output));
    let mcp_url = Arc::new(mcp_url);
    let tried = AtomicBool::new(false);
    let start_once = Arc::new(move || !tried.swap(true, Ordering::SeqCst) && start_app());
    let mut lines = input.lines();
    let mut tasks = tokio::task::JoinSet::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let (http, output, mcp_url, start_once) = (http.clone(), output.clone(), mcp_url.clone(), start_once.clone());
        tasks.spawn(async move {
            let Some(answer) = relay(&http, &line, &*mcp_url, &*start_once).await else { return };
            let mut text = serde_json::to_string(&answer).expect("JSON");
            text.push('\n');
            let mut out = output.lock().await;
            if out.write_all(text.as_bytes()).await.is_err() || out.flush().await.is_err() {
                tracing::debug!("The agent stopped reading");
            }
        });
    }
    while tasks.join_next().await.is_some() {}
}

/// One message there and its answer back; None when there is nothing to answer (notifications).
async fn relay(
    http: &reqwest::Client,
    line: &str,
    mcp_url: &(dyn Fn() -> Option<String> + Send + Sync),
    start_once: &(dyn Fn() -> bool + Send + Sync),
) -> Option<Value> {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return Some(error(Value::Null, -32700, "Parse error"));
    };
    // Only requests get answers; notifications and a batch of them get none.
    let id = message.get("id").cloned().filter(|_| message.get("method").is_some());
    let fail = |text: &str| id.clone().map(|id| error(id, -32000, text));

    let attempt = || async {
        let url = mcp_url()?;
        let request = http.post(url).header("accept", "application/json, text/event-stream").json(&message);
        request.timeout(Duration::from_secs(300)).send().await.ok()
    };
    let mut response = attempt().await;
    if response.is_none() && start_once() {
        let deadline = tokio::time::Instant::now() + START_WAIT;
        while response.is_none() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
            response = attempt().await;
        }
    }
    let Some(response) = response else { return fail(NOT_RUNNING) };
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    match status.as_u16() {
        200 => Some(body),
        202 => None,
        _ => fail(&body["error"].as_str().map_or_else(|| format!("Magnetar answered {status}"), str::to_owned)),
    }
}

/// Starts the app in the background, apart from this process, so it outlives the agent.
pub fn start_app() -> bool {
    #[cfg(target_os = "macos")]
    if let Some(bundle) = crate::paths::mac_app_bundle() {
        return std::process::Command::new("/usr/bin/open").arg("-g").arg(bundle).status().is_ok_and(|s| s.success());
    }
    let Ok(program) = std::env::current_exe() else { return false };
    let mut command = crate::system::hidden_command(program);
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    #[cfg(windows)]
    {
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::os::windows::process::CommandExt::creation_flags(&mut command, DETACHED_PROCESS | CREATE_NO_WINDOW);
    }
    command.spawn().is_ok()
}

/// `magnetar mcp`, reading and writing the process's own stdin and stdout.
pub fn main(paths: Paths) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(serve(
        tokio::io::BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
        move || EndpointFile::read(&paths).map(|file| file.mcp_url),
        start_app,
    ));
    Ok(())
}
