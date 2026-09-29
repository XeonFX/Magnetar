//! The local server: who may reach the dashboard and the agent API, and what the API answers.

use std::sync::Arc;

use mediadownloader::app::{App, AppOptions};
use mediadownloader::downloads::manager::EngineSource;
use mediadownloader::http::server;
use mediadownloader::paths::Paths;
use serde_json::{Value, json};

async fn start() -> (Arc<App>, String, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::new(dir.path().join("data")).unwrap();
    let app = App::new(AppOptions {
        paths,
        engine: EngineSource::Off,
        providers: mediadownloader::search::providers::all(),
        legacy_database: None,
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
    assert_eq!(init["result"]["serverInfo"]["name"], "mediadownloader");
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
    let (app, base, dir) = start().await;
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
