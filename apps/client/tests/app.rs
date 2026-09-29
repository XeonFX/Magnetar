//! The dashboard RPC end to end, on a real app without a torrent engine.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mediadownloader::app::{App, AppOptions};
use mediadownloader::downloads::manager::EngineSource;
use mediadownloader::paths::Paths;
use mediadownloader::rpc::RpcSession;
use mediadownloader::search::types::{Provider, TorrentSearchResult};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_util::sync::CancellationToken;

struct Fake;

#[async_trait]
impl Provider for Fake {
    fn name(&self) -> &'static str {
        "Fake"
    }

    async fn search(&self, _: &reqwest::Client, query: &str, _: &CancellationToken) -> anyhow::Result<Vec<TorrentSearchResult>> {
        let row = |title: String, hash: char, seeders| TorrentSearchResult {
            info_hash: hash.to_string().repeat(40),
            magnet_uri: format!("magnet:?xt=urn:btih:{}&dn=x", hash.to_string().repeat(40)),
            seeders,
            ..TorrentSearchResult::new(title, "Fake")
        };
        Ok(vec![row(format!("{query} S01E01 1080p"), 'c', 3), row("unrelated".into(), 'd', 9)])
    }
}

/// The legacy .NET schema, as EF Core created it.
fn legacy_database(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("legacy.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        r#"
        CREATE TABLE "SeriesTasks" ("Id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "Name" TEXT NOT NULL, "Query" TEXT NOT NULL,
          "Provider" TEXT NULL, "TitleFilter" TEXT NULL, "Season" INTEGER NULL, "StartEpisode" INTEGER NOT NULL, "EndEpisode" INTEGER NULL,
          "DownloadFolder" TEXT NULL, "LastDownloadedEpisode" INTEGER NOT NULL, "CheckIntervalMinutes" INTEGER NOT NULL, "Enabled" INTEGER NOT NULL,
          "LastCheckedAt" TEXT NULL, "CreatedAt" TEXT NOT NULL);
        CREATE TABLE "Settings" ("Id" INTEGER NOT NULL PRIMARY KEY, "DownloadFolder" TEXT NOT NULL, "NotifyOnStart" INTEGER NOT NULL,
          "NotifyOnComplete" INTEGER NOT NULL, "EmailEnabled" INTEGER NOT NULL, "SmtpHost" TEXT NOT NULL, "SmtpPort" INTEGER NOT NULL,
          "SmtpUseSsl" INTEGER NOT NULL, "SmtpUsername" TEXT NOT NULL, "SmtpPassword" TEXT NOT NULL, "EmailFrom" TEXT NOT NULL, "EmailTo" TEXT NOT NULL,
          "DesktopEnabled" INTEGER NOT NULL, "PushEnabled" INTEGER NOT NULL, "NtfyServer" TEXT NOT NULL, "NtfyTopic" TEXT NOT NULL,
          "TelegramEnabled" INTEGER NOT NULL, "TelegramBotToken" TEXT NOT NULL, "TelegramChatId" TEXT NOT NULL,
          "PostDownloadAction" INTEGER NOT NULL DEFAULT 0, "DisabledProviders" TEXT NOT NULL DEFAULT '', "Language" TEXT NOT NULL DEFAULT 'en',
          "AgentApiAllowRemote" INTEGER NOT NULL DEFAULT 0, "AgentApiEnabled" INTEGER NOT NULL DEFAULT 0, "AgentApiToken" TEXT NOT NULL DEFAULT '');
        CREATE TABLE "Downloads" ("Id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "Name" TEXT NOT NULL, "MagnetUri" TEXT NOT NULL,
          "InfoHash" TEXT NOT NULL, "SavePath" TEXT NOT NULL, "Source" TEXT NOT NULL, "Status" INTEGER NOT NULL, "Progress" REAL NOT NULL,
          "TotalBytes" INTEGER NOT NULL, "AddedAt" TEXT NOT NULL, "CompletedAt" TEXT NULL, "Error" TEXT NULL, "StartNotificationSent" INTEGER NOT NULL,
          "CompleteNotificationSent" INTEGER NOT NULL, "SeriesTaskId" INTEGER NULL, "TorrentFilePath" TEXT NULL, "NameIsPlaceholder" INTEGER NOT NULL DEFAULT 0);
        INSERT INTO "SeriesTasks" VALUES (7, 'Frieren', 'Frieren 1080p', 'Nyaa', 'SubsPlease', NULL, 1, 28, NULL, 12, 60, 1, '2026-09-01 10:00:00.1234567', '2026-07-01 09:00:00');
        INSERT INTO "Settings" VALUES (1, '/Volumes/Media', 1, 0, 1, 'smtp.example.com', 465, 1, 'me', 'CfDJ8-encrypted', 'me@example.com', 'me@example.com',
          1, 0, 'https://ntfy.sh', '', 0, '', '', 1, 'PTE,EZTV', 'pl', 0, 1, 'CfDJ8-token');
        INSERT INTO "Downloads" VALUES (1, 'Frieren - 12', 'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=x', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          '/Volumes/Media', 'Nyaa', 5, 100, 1000, '2026-09-01 10:00:00', '2026-09-01 11:00:00', NULL, 1, 1, 7, NULL, 0);
        INSERT INTO "Downloads" VALUES (2, 'Ubuntu', 'magnet:?xt=urn:btih:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          '/Volumes/Media', 'RARBG', 2, 40, 5000, '2026-09-02 10:00:00', NULL, NULL, 1, 0, NULL, NULL, 0);
        INSERT INTO "Downloads" VALUES (3, 'Private', '', 'pte-1', '/Volumes/Media', 'PTE', 2, 10, 5000, '2026-09-02 10:00:00', NULL, NULL, 1, 0, NULL, '/x.torrent', 0);
        "#,
    )
    .unwrap();
    path
}

struct Harness {
    app: Arc<App>,
    dir: tempfile::TempDir,
}

fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let legacy = legacy_database(dir.path());
    let paths = Paths::new(dir.path().join("data")).unwrap();
    let app =
        App::new(AppOptions { paths, engine: EngineSource::Off, providers: vec![Arc::new(Fake)], legacy_database: Some(legacy) })
            .unwrap();
    app.start();
    Harness { app, dir }
}

struct Client {
    session: RpcSession,
    replies: UnboundedReceiver<Value>,
    next_id: i64,
    events: Vec<Value>,
}

impl Client {
    fn new(app: &App, local: bool) -> Self {
        Self::with_key(app, (!local).then_some("relayed-test"))
    }

    /// A relayed browser holding this key, or the local dashboard without one.
    fn with_key(app: &App, key_id: Option<&str>) -> Self {
        let (session, replies) = app.rpc.connect(key_id.map(str::to_owned));
        Self { session, replies, next_id: 0, events: Vec::new() }
    }

    async fn next(&mut self) -> Value {
        tokio::time::timeout(Duration::from_secs(5), self.replies.recv()).await.expect("a message in time").expect("open session")
    }

    /// A call's result, or "code: message".
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.session.handle(json!({ "id": id, "method": method, "params": params }));
        loop {
            let message = self.next().await;
            if message["id"] == id {
                return match message.get("error") {
                    Some(error) => Err(format!("{}: {}", error["code"].as_str().unwrap(), error["message"].as_str().unwrap())),
                    None => Ok(message["result"].clone()),
                };
            }
            self.events.push(message);
        }
    }

    async fn ok(&mut self, method: &str, params: Value) -> Value {
        self.call(method, params).await.unwrap_or_else(|e| panic!("{method}: {e}"))
    }

    async fn event(&mut self, name: &str) -> Value {
        if let Some(i) = self.events.iter().position(|e| e["event"] == name) {
            return self.events.remove(i)["data"].clone();
        }
        loop {
            let message = self.next().await;
            if message["event"] == name {
                return message["data"].clone();
            }
        }
    }
}

#[tokio::test]
async fn validates_parameters_and_rejects_unknown_methods() {
    let h = harness();
    let mut c = Client::new(&h.app, true);
    assert!(c.call("nope", json!({})).await.unwrap_err().starts_with("not_found"));
    assert!(c.call("downloads.pause", json!({ "id": "x" })).await.unwrap_err().starts_with("bad_request"));
    assert!(c.call("app.info", json!({ "extra": 1 })).await.unwrap_err().starts_with("bad_request"));
    // Device-screen methods are refused through the relay.
    let mut relayed = Client::new(&h.app, false);
    assert!(relayed.call("fs.pickNative", json!({})).await.unwrap_err().starts_with("forbidden"));
    assert!(relayed.call("agent.connectClaude", json!({})).await.unwrap_err().starts_with("forbidden"));
    assert_eq!(relayed.ok("app.info", json!({})).await["nativeFolderPicker"], false);
}

#[tokio::test]
async fn secrets_are_write_only() {
    let h = harness();
    let mut c = Client::new(&h.app, true);
    let updated = c.ok("settings.update", json!({ "telegramBotToken": "123:abc", "emailTo": "me@example.com" })).await;
    assert_eq!(updated["telegramBotTokenSet"], true);
    assert!(!updated.to_string().contains("123:abc"));
    assert!(c.call("settings.update", json!({ "emailTo": "not an email" })).await.unwrap_err().starts_with("bad_request"));
    assert!(c.call("settings.update", json!({ "downloadFolder": "  " })).await.unwrap_err().contains("required"));
}

#[tokio::test]
async fn streams_a_search_to_the_connection_that_started_it() {
    let h = harness();
    let mut c = Client::new(&h.app, true);
    let started = c.ok("search.start", json!({ "query": "Show" })).await;
    let results = c.event("search.results").await;
    assert_eq!(results["searchId"], started["searchId"]);
    // The relevance filter dropped "unrelated".
    let titles: Vec<&str> = results["results"].as_array().unwrap().iter().map(|r| r["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["Show S01E01 1080p"]);
    let done = c.event("search.done").await;
    assert_eq!(done["error"], Value::Null);

    // The result id resolves details and starts a download.
    let result_id = results["results"][0]["resultId"].as_str().unwrap().to_owned();
    let details = c.ok("search.details", json!({ "resultId": result_id })).await;
    assert!(details["magnetUri"].as_str().unwrap().starts_with("magnet:?"));
    let folder = h.dir.path().join("dl");
    let download = c.ok("downloads.start", json!({ "resultId": result_id, "folder": folder })).await;
    assert_eq!(download["name"], "Show S01E01 1080p");
    assert_eq!(download["source"], "Fake");
}

#[tokio::test]
async fn downloads_without_an_engine() {
    let h = harness();
    let mut c = Client::new(&h.app, true);
    let magnet = format!("magnet:?xt=urn:btih:{}&dn=Some+Name", "E".repeat(40));
    let folder = h.dir.path().join("dl");
    let added = c.ok("downloads.start", json!({ "magnet": magnet, "folder": folder })).await;
    assert_eq!(
        (added["name"].as_str(), added["status"].as_str(), added["source"].as_str()),
        (Some("Some Name"), Some("Queued"), Some("Magnet"))
    );
    assert_eq!(c.ok("downloads.start", json!({ "magnet": magnet })).await["id"], added["id"]);
    assert_eq!(c.ok("downloads.pause", json!({ "id": added["id"] })).await["status"], "Paused");
    assert_eq!(c.ok("downloads.resume", json!({ "id": added["id"] })).await["status"], "Queued");
    c.ok("downloads.delete", json!({ "id": added["id"] })).await;
    assert!(!c.ok("downloads.list", json!({})).await.as_array().unwrap().iter().any(|d| d["id"] == added["id"]));
    assert!(c.call("downloads.start", json!({ "magnet": "magnet:?xt=urn:btih:zz" })).await.unwrap_err().contains("info hash"));
}

#[tokio::test]
async fn a_series_patch_changes_only_what_it_names_and_is_validated_as_a_whole() {
    let h = harness();
    let mut c = Client::new(&h.app, true);
    let created = c
        .ok("series.create", json!({ "name": "Show", "query": "Show 1080p", "season": 2, "startEpisode": 5, "enabled": false }))
        .await;
    let renamed = c.ok("series.update", json!({ "id": created["id"], "patch": { "name": "Renamed" } })).await;
    assert_eq!(
        (renamed["name"].as_str(), renamed["season"].as_i64(), renamed["startEpisode"].as_i64()),
        (Some("Renamed"), Some(2), Some(5))
    );
    assert_eq!(renamed["enabled"], false);
    assert_eq!(c.ok("series.update", json!({ "id": created["id"], "patch": { "season": null } })).await["season"], Value::Null);
    let error = c.call("series.update", json!({ "id": created["id"], "patch": { "endEpisode": 1 } })).await.unwrap_err();
    assert!(error.contains("before startEpisode"), "{error}");
    assert!(c.call("series.create", json!({ "name": "x", "query": " " })).await.unwrap_err().contains("search query"));
    assert!(
        c.call("series.create", json!({ "name": "x", "query": "y", "provider": "Nope" }))
            .await
            .unwrap_err()
            .contains("Unknown source")
    );
}

#[tokio::test]
async fn legacy_import_copies_settings_series_and_resumable_downloads() {
    let h = harness();
    let mut c = Client::new(&h.app, true);
    let status = c.ok("legacy.status", json!({})).await;
    assert_eq!(status["available"], true);
    assert_eq!(status["imported"], false);
    assert_eq!((status["downloads"].as_i64(), status["seriesTasks"].as_i64()), (Some(3), Some(1)));
    let result = c.ok("legacy.import", json!({})).await;
    assert_eq!(result, json!({ "downloads": 2, "seriesTasks": 1, "settings": true, "secretsToReenter": ["SMTP password"] }));

    let settings = c.ok("settings.get", json!({})).await;
    assert_eq!(settings["downloadFolder"], "/Volumes/Media");
    assert_eq!(settings["language"], "pl");
    assert_eq!(settings["postDownloadAction"], "KeepSeeding");
    assert_eq!(settings["disabledProviders"], json!(["EZTV"]));
    assert_eq!(settings["smtpPort"], 465);
    assert_eq!(settings["smtpPasswordSet"], false);

    let series = c.ok("series.list", json!({})).await;
    let frieren = series.as_array().unwrap().iter().find(|s| s["name"] == "Frieren").unwrap().clone();
    assert_eq!(frieren["provider"], "Nyaa");
    assert_eq!(frieren["titleFilter"], "SubsPlease");
    assert_eq!(
        (frieren["endEpisode"].as_i64(), frieren["lastDownloadedEpisode"].as_i64(), frieren["nextEpisode"].as_i64()),
        (Some(28), Some(12), Some(13))
    );
    assert_eq!(frieren["lastCheckedAt"], "2026-09-01T10:00:00.123Z");

    let downloads = c.ok("downloads.list", json!({})).await;
    let by_name = |name: &str| downloads.as_array().unwrap().iter().find(|d| d["name"] == name).cloned();
    let imported = by_name("Frieren - 12").unwrap();
    assert_eq!((imported["status"].as_str(), imported["progress"].as_f64()), (Some("Completed"), Some(100.0)));
    assert_eq!(imported["seriesTaskId"], frieren["id"]);
    // In progress in the old app: imported paused so both apps never write the same files.
    assert_eq!(by_name("Ubuntu").unwrap()["status"], "Paused");
    assert!(by_name("Private").is_none());
    assert_eq!(c.ok("legacy.status", json!({})).await["imported"], true);

    // Importing again adds nothing that is already there.
    let again = c.ok("legacy.import", json!({})).await;
    assert_eq!((again["downloads"].as_i64(), again["seriesTasks"].as_i64()), (Some(0), Some(0)));
    let frierens = c.ok("series.list", json!({})).await.as_array().unwrap().iter().filter(|s| s["name"] == "Frieren").count();
    assert_eq!(frierens, 1);
}

#[tokio::test]
async fn agent_access_writes_an_owner_only_endpoint_file() {
    let h = harness();
    let mut c = Client::new(&h.app, true);
    let status = c.ok("agent.set", json!({ "enabled": true })).await;
    assert_eq!(status["enabled"], true);
    let token = status["token"].as_str().unwrap().to_owned();
    assert_eq!(token.len(), 43);
    let endpoint: Value = serde_json::from_slice(&std::fs::read(&h.app.paths.endpoint).unwrap()).unwrap();
    assert_eq!(endpoint["token"], token.as_str());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&h.app.paths.endpoint).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert_ne!(c.ok("agent.regenerateToken", json!({})).await["token"], token.as_str());
}

#[tokio::test]
async fn linked_browsers_ask_for_push_and_lose_it_with_their_key() {
    use base64::Engine as _;
    let h = harness();
    h.app
        .db
        .lock()
        .execute(
            "INSERT INTO browser_keys (key_id, key, label, created_at, active) VALUES ('k1', 'sealed', 'Phone', '2026-09-29', 1)",
            [],
        )
        .unwrap();
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let mut point = vec![4u8];
    point.extend([7u8; 64]);
    let endpoint = "https://fcm.googleapis.com/fcm/send/abc:123";
    let subscription = json!({ "endpoint": endpoint, "p256dh": b64(&point), "auth": b64(&[1u8; 16]) });

    let mut local = Client::new(&h.app, true);
    let refused = local.call("push.subscribe", subscription.clone()).await.unwrap_err();
    assert!(refused.starts_with("bad_request") && refused.contains("desktop notifications"), "{refused}");

    let mut phone = Client::with_key(&h.app, Some("k1"));
    assert_eq!(phone.ok("push.status", json!({ "endpoint": endpoint })).await["subscribed"], false);
    phone.ok("push.subscribe", subscription.clone()).await;
    assert_eq!(phone.ok("push.status", json!({ "endpoint": endpoint })).await["subscribed"], true);
    for bad in [
        json!({ "endpoint": "https://evil.example/push", "p256dh": b64(&point), "auth": b64(&[1u8; 16]) }),
        json!({ "endpoint": endpoint, "p256dh": b64(&[4u8; 33]), "auth": b64(&[1u8; 16]) }),
        json!({ "endpoint": endpoint, "p256dh": b64(&point), "auth": b64(&[1u8; 8]) }),
    ] {
        assert!(phone.call("push.subscribe", bad).await.unwrap_err().starts_with("bad_request"));
    }

    h.app.remote.revoke_browser("k1");
    assert_eq!(
        phone.ok("push.status", json!({ "endpoint": endpoint })).await["subscribed"],
        false,
        "revoking the key drops its subscription"
    );
}
