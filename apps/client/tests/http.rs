//! The local server: who may reach the dashboard and the agent API, and what the API answers.

use std::sync::Arc;

use magnetar::app::{App, AppOptions};
use magnetar::downloads::engine::{Engine, NetworkOptions, SpeedLimits};
use magnetar::downloads::manager::EngineSource;
use magnetar::http::server;
use magnetar::paths::Paths;
use serde_json::{Value, json};

async fn start() -> (Arc<App>, String, tempfile::TempDir) {
    start_with(false).await
}

/// With `engine`, a real torrent engine, which downloads need to finish.
async fn start_with(engine: bool) -> (Arc<App>, String, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::new(dir.path().join("data")).unwrap();
    let engine = match engine {
        true => EngineSource::Fixed(Arc::new(
            Engine::start(&paths, &NetworkOptions::default(), SpeedLimits::default()).await.unwrap(),
        )),
        false => EngineSource::Off,
    };
    let app = App::new(AppOptions {
        paths,
        engine,
        providers: magnetar::search::providers::all(),
        legacy_database: None,
        show_lookups: false,
    })
    .unwrap();
    app.start();
    // Clear of the real app's port range.
    let server = server::start(app.clone(), 48_700 + (std::process::id() % 200) as u16).await.unwrap();
    (app, format!("http://127.0.0.1:{}", server.port), dir)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

#[tokio::test]
async fn dashboard_is_for_this_machine_under_a_loopback_name_only() {
    let (_app, base, _dir) = start().await;
    let http = client();
    let health = http.get(format!("{base}/health")).send().await.unwrap();
    assert_eq!(health.status(), 200);
    let config: Value = http.get(format!("{base}/app-config.json")).send().await.unwrap().json().await.unwrap();
    assert_eq!(config, json!({ "mode": "local" }));
    // A DNS-rebound name pointing here gets nothing.
    let rebound = http.get(format!("{base}/health")).header("host", "evil.example").send().await.unwrap();
    assert_eq!(rebound.status(), 404);
    // The socket only opens for the app's own origin.
    let socket = http
        .get(format!("{base}/ws"))
        .header("origin", "https://evil.example")
        .header("connection", "upgrade")
        .header("upgrade", "websocket")
        .send()
        .await
        .unwrap();
    assert_eq!(socket.status(), 403);
}

#[tokio::test]
async fn agent_api_is_off_until_enabled_then_refuses_rebinding_and_cross_origin_requests() {
    let (app, base, _dir) = start().await;
    let http = client();
    assert_eq!(http.get(format!("{base}/api/downloads")).send().await.unwrap().status(), 404);
    app.agent.set(Some(true), None);

    let list = http.get(format!("{base}/api/downloads")).send().await.unwrap();
    assert_eq!(list.status(), 200);
    assert_eq!(list.json::<Value>().await.unwrap(), json!([]));
    let rebound = http.get(format!("{base}/api/downloads")).header("host", "evil.example:47820").send().await.unwrap();
    assert_eq!(rebound.status(), 403);
    let cross_origin = http
        .post(format!("{base}/api/downloads"))
        .header("origin", "https://evil.example")
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(cross_origin.status(), 403);
    // A remote caller through a local proxy needs HTTPS.
    let proxied = http.get(format!("{base}/api/downloads")).header("x-forwarded-for", "203.0.113.9").send().await.unwrap();
    assert_eq!(proxied.status(), 404, "remote access is off");
    // A rebound page may add headers to its same-origin requests: claiming a proxy forwarded it
    // from 127.0.0.1 doesn't make it this computer.
    let rebound_as_proxied = http
        .get(format!("{base}/api/downloads"))
        .header("host", "evil.example:47820")
        .header("x-forwarded-for", "127.0.0.1")
        .send()
        .await
        .unwrap();
    assert_eq!(rebound_as_proxied.status(), 404, "a forwarded request is remote, and remote access is off");
    app.agent.set(None, Some(true));
    let with_https_claimed = http
        .get(format!("{base}/api/downloads"))
        .header("host", "evil.example:47820")
        .header("x-forwarded-for", "127.0.0.1")
        .header("x-forwarded-proto", "https")
        .send()
        .await
        .unwrap();
    assert_eq!(with_https_claimed.status(), 401, "and remote callers need the token");
}

#[tokio::test]
async fn rest_routes_validate_and_report_errors() {
    let (app, base, _dir) = start().await;
    app.agent.set(Some(true), None);
    let http = client();
    let missing = http.get(format!("{base}/api/downloads/99")).send().await.unwrap();
    assert_eq!(missing.status(), 404);
    assert!(missing.json::<Value>().await.unwrap()["error"].as_str().unwrap().contains("No download"));
    let wrong_method = http.put(format!("{base}/api/downloads")).send().await.unwrap();
    assert_eq!(wrong_method.status(), 405);
    assert_eq!(wrong_method.headers()["allow"], "GET, POST");
    let not_json = http.post(format!("{base}/api/series")).body("{").send().await.unwrap();
    assert_eq!(not_json.status(), 400);
    // A partial PUT is refused rather than silently resetting the other fields.
    let created: Value = http
        .post(format!("{base}/api/series"))
        .json(&json!({ "name": "Show", "query": "Show", "provider": null }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["id"].as_i64().unwrap();
    let partial = http.put(format!("{base}/api/series/{id}")).json(&json!({ "name": "Renamed" })).send().await.unwrap();
    assert_eq!(partial.status(), 400);
    let openapi: Value = http.get(format!("{base}/openapi/v1.json")).send().await.unwrap().json().await.unwrap();
    assert_eq!(openapi["openapi"], "3.1.0");
}

#[tokio::test]
async fn mcp_initializes_lists_and_calls_tools() {
    let (app, base, _dir) = start().await;
    app.agent.set(Some(true), None);
    let http = client();
    let rpc =
        |body: Value| http.post(format!("{base}/mcp")).header("accept", "application/json, text/event-stream").json(&body).send();

    let init: Value =
        rpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } }))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["serverInfo"]["name"], "magnetar");
    let notified = rpc(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.unwrap();
    assert_eq!(notified.status(), 202);

    let tools: Value = rpc(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await.unwrap().json().await.unwrap();
    let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"search_torrents") && names.contains(&"delete_download"), "{names:?}");

    let settings: Value =
        rpc(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "get_settings", "arguments": {} } }))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
    assert!(settings["result"]["structuredContent"]["downloadFolder"].is_string());
    assert!(settings["result"]["structuredContent"].get("smtpHost").is_none());

    // Caller mistakes come back as tool errors the model can read.
    let bad: Value = rpc(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "pause_download", "arguments": { "id": 42 } } }))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(bad["result"]["isError"], true);
    assert!(bad["result"]["content"][0]["text"].as_str().unwrap().contains("No download with id 42"));
}

#[tokio::test]
async fn a_stream_link_serves_byte_ranges_of_one_file_and_nothing_else() {
    use librqbit::spawn_utils::BlockingSpawner;
    use librqbit::{CreateTorrentOptions, create_torrent};
    let (app, base, dir) = start_with(true).await;
    let folder = dir.path().join("Downloads");
    std::fs::create_dir_all(&folder).unwrap();
    let content: Vec<u8> = (0..200_000u32).map(|i| (i % 253) as u8).collect();
    std::fs::write(folder.join("clip.mp4"), &content).unwrap();
    let torrent =
        create_torrent(&folder.join("clip.mp4"), CreateTorrentOptions::default(), &BlockingSpawner::new(1)).await.unwrap();
    let download = app
        .downloads
        .add_torrent_file(torrent.as_bytes().unwrap().to_vec(), "Torrent file", Some(folder.display().to_string()))
        .unwrap();
    // The engine checks the file on disk and finds it complete.
    for _ in 0..300 {
        if app.downloads.files(download.id).unwrap()[0].done == content.len() as u64 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let token = app.streams.grant(download.id, 0);
    let url = format!("{base}/stream/{token}");
    let http = client();

    let whole = http.get(&url).send().await.unwrap();
    assert_eq!(whole.status(), 200);
    assert_eq!(whole.headers()["content-type"], "video/mp4");
    assert_eq!(whole.headers()["accept-ranges"], "bytes");
    assert_eq!(whole.bytes().await.unwrap().to_vec(), content);

    let part = http.get(&url).header("range", "bytes=1000-1999").send().await.unwrap();
    assert_eq!(part.status(), 206);
    assert_eq!(part.headers()["content-range"], "bytes 1000-1999/200000");
    assert_eq!(part.bytes().await.unwrap().to_vec(), content[1000..2000]);

    let other_unit = http.get(&url).header("range", "items=0-5").send().await.unwrap();
    assert_eq!(other_unit.status(), 200, "not a byte range, so the whole file");
    assert!(other_unit.headers().get("content-range").is_none());

    let tail = http.get(&url).header("range", "bytes=-10").send().await.unwrap();
    assert_eq!(tail.bytes().await.unwrap().to_vec(), content[199_990..]);

    let past_the_end = http.get(&url).header("range", "bytes=200000-").send().await.unwrap();
    assert_eq!(past_the_end.status(), 416);
    assert_eq!(past_the_end.headers()["content-range"], "bytes */200000");

    let head = http.head(&url).send().await.unwrap();
    assert_eq!((head.status().as_u16(), head.headers()["content-length"].to_str().unwrap()), (200, "200000"));

    assert_eq!(http.get(format!("{base}/stream/guessed-token")).send().await.unwrap().status(), 404);
    assert_eq!(http.post(&url).send().await.unwrap().status(), 405);
    let rebound = http.get(&url).header("host", "evil.example").send().await.unwrap();
    assert_eq!(rebound.status(), 404, "only under a loopback name");
}

mod stdio_bridge {
    use magnetar::bridge::{Endpoint, serve};

    use super::*;

    /// Runs the bridge over `input` and returns what it wrote, one JSON value per line.
    async fn bridge(input: &str, endpoint: Option<Endpoint>, start_app: impl Fn() -> bool + Send + Sync + 'static) -> Vec<Value> {
        let (mut writer, reader) = tokio::io::duplex(1 << 20);
        let input = tokio::io::BufReader::new(std::io::Cursor::new(input.as_bytes().to_vec()));
        serve(input, reader, move || endpoint.clone(), start_app).await;
        let mut out = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut writer, &mut out).await.unwrap();
        out.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn by_id(answers: &[Value], id: i64) -> &Value {
        answers.iter().find(|a| a["id"] == id).unwrap_or_else(|| panic!("no answer {id} in {answers:?}"))
    }

    #[tokio::test]
    async fn passes_requests_to_the_running_app_line_by_line() {
        let (app, base, _dir) = start().await;
        app.agent.set(Some(true), None);
        let endpoint = Endpoint { mcp_url: format!("{base}/mcp"), token: app.agent.token() };
        let input = [
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } })
                .to_string(),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string(),
            String::new(),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }).to_string(),
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "list_downloads", "arguments": {} } })
                .to_string(),
            "{not json".to_owned(),
        ]
        .join("\n");
        let answers = bridge(&input, Some(endpoint), || panic!("the app is running")).await;
        assert_eq!(answers.len(), 4, "{answers:?}");
        assert_eq!(by_id(&answers, 1)["result"]["serverInfo"]["name"], "magnetar");
        assert!(by_id(&answers, 2)["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "search_torrents"));
        assert_eq!(by_id(&answers, 3)["result"]["structuredContent"], json!({ "items": [] }));
        assert!(answers.iter().any(|a| a["id"].is_null() && a["error"]["code"] == -32700));
    }

    #[tokio::test]
    async fn says_why_when_agent_access_is_off() {
        let (app, base, _dir) = start().await;
        let endpoint = Endpoint { mcp_url: format!("{base}/mcp"), token: app.agent.token() };
        let answers =
            bridge(&json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list" }).to_string(), Some(endpoint), || false).await;
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0]["id"], 7);
        assert!(answers[0]["error"]["message"].as_str().unwrap().contains("agent"), "{answers:?}");
    }

    #[tokio::test]
    async fn an_app_that_is_not_running_is_started_once_and_otherwise_explained() {
        let starts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = starts.clone();
        // Nothing listens on port 9; the start "fails" so no wait happens.
        let endpoint = Endpoint { mcp_url: "http://127.0.0.1:9/mcp".into(), token: String::new() };
        let input = [
            json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string(),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string(),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }).to_string(),
        ]
        .join("\n");
        let answers = bridge(&input, Some(endpoint), move || {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            false
        })
        .await;
        assert_eq!(starts.load(std::sync::atomic::Ordering::SeqCst), 1, "one start attempt, not one per message");
        assert_eq!(answers.len(), 2, "the notification gets no answer: {answers:?}");
        for id in [1, 2] {
            assert_eq!(
                by_id(&answers, id)["error"]["message"],
                "Magnetar isn't running. Open it on this computer, then try again."
            );
        }
        // No endpoint file at all reads the same.
        let answers = bridge(&json!({ "jsonrpc": "2.0", "id": 5, "method": "ping" }).to_string(), None, || false).await;
        assert_eq!(by_id(&answers, 5)["error"]["code"], -32000);
    }

    #[tokio::test]
    async fn a_started_app_is_waited_for() {
        let (app, base, _dir) = start().await;
        app.agent.set(Some(true), None);
        let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (flag, url) = (ready.clone(), format!("{base}/mcp"));
        let input = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string();
        let (mut writer, reader) = tokio::io::duplex(1 << 16);
        // The endpoint file appears only once the "app" has been started.
        serve(
            tokio::io::BufReader::new(std::io::Cursor::new(input.into_bytes())),
            reader,
            move || {
                flag.load(std::sync::atomic::Ordering::SeqCst).then(|| Endpoint { mcp_url: url.clone(), token: String::new() })
            },
            move || {
                ready.store(true, std::sync::atomic::Ordering::SeqCst);
                true
            },
        )
        .await;
        let mut out = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut writer, &mut out).await.unwrap();
        let answer: Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(answer, json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
    }
}
