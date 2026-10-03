//! The dashboard RPC end to end, on a real app without a torrent engine.

mod common;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use magnetar::app::{App, AppOptions};
use magnetar::downloads::manager::EngineSource;
use magnetar::paths::Paths;
use magnetar::rpc::RpcSession;
use magnetar::search::types::{Provider, TorrentSearchResult};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_util::sync::CancellationToken;

struct Fake;

#[async_trait]
impl Provider for Fake {
    fn name(&self) -> &'static str {
        "Fake"
    }

    fn id(&self) -> &'static str {
        "fk"
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
    let app = App::new(AppOptions {
        paths,
        engine: EngineSource::Off,
        providers: vec![Arc::new(Fake)],
        legacy_database: Some(legacy),
        show_lookups: false,
    })
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
    // Connecting agents changes files and runs programs on the device: never from afar.
    assert!(relayed.call("agent.clients", json!({})).await.unwrap_err().starts_with("forbidden"));
    assert!(relayed.call("agent.connect", json!({ "client": "cursor" })).await.unwrap_err().starts_with("forbidden"));
    assert!(c.call("agent.connect", json!({ "client": "notepad" })).await.unwrap_err().starts_with("bad_request"));
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
async fn a_source_is_named_by_its_name_or_its_short_id() {
    let h = harness();
    let mut c = Client::new(&h.app, true);
    assert_eq!(c.ok("sources.list", json!({})).await, json!([{ "id": "fk", "name": "Fake", "enabled": true }]));
    for source in ["fk", "FK", "Fake", "fake"] {
        let started = c.ok("search.start", json!({ "query": "Show", "source": source })).await;
        let results = c.event("search.results").await;
        assert_eq!(results["searchId"], started["searchId"], "{source}");
        c.event("search.done").await;
    }
    let error = c.call("search.start", json!({ "query": "Show", "source": "f" })).await.unwrap_err();
    assert!(error.contains("Unknown source 'f'"), "{error}");
}

#[tokio::test]
async fn a_device_name_is_one_the_website_can_use_as_an_address() {
    let h = harness();
    let mut c = Client::new(&h.app, true);
    for bad in ["MacBook Pro", "login", "Paweł", "-x", "a--b", &"a".repeat(41), ""] {
        let error = c.call("remote.rename", json!({ "deviceName": bad })).await.unwrap_err();
        assert!(error.starts_with("bad_request") && error.contains("single hyphens"), "{bad:?}: {error}");
    }
    let renamed = c.ok("remote.rename", json!({ "deviceName": " MacBook-Pro " })).await;
    assert_eq!(renamed["deviceName"], "MacBook-Pro");
    assert_eq!(c.ok("remote.status", json!({})).await["deviceName"], "MacBook-Pro");
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

/// The app as it starts again on the same data folder.
fn restarted(h: &Harness) -> Arc<App> {
    App::new(AppOptions {
        paths: Paths::new(h.dir.path().join("data")).unwrap(),
        engine: EngineSource::Off,
        providers: vec![],
        legacy_database: None,
        show_lookups: false,
    })
    .unwrap()
}

#[tokio::test]
async fn turning_agent_access_off_or_replacing_its_token_is_never_reported_done_unless_saved() {
    let h = harness();
    let mut c = Client::new(&h.app, true);
    let token = c.ok("agent.set", json!({ "enabled": true, "allowRemote": true })).await["token"].as_str().unwrap().to_owned();

    // The disk refuses every write.
    h.app.db.lock().pragma_update(None, "query_only", true).unwrap();
    for (method, params) in [("agent.set", json!({ "enabled": false })), ("agent.regenerateToken", json!({}))] {
        let error = c.call(method, params).await.unwrap_err();
        assert!(error.starts_with("internal: The change could not be saved, so nothing changed"), "{method}: {error}");
    }
    let error = c.call("settings.update", json!({ "telegramBotToken": "123:abc" })).await.unwrap_err();
    assert!(error.starts_with("internal: The change could not be saved"), "{error}");
    let status = c.ok("agent.status", json!({})).await;
    assert_eq!((status["enabled"].clone(), status["token"].clone()), (json!(true), json!(token)));
    assert_eq!(c.ok("settings.get", json!({})).await["telegramBotTokenSet"], false);
    let endpoint: Value = serde_json::from_slice(&std::fs::read(&h.app.paths.endpoint).unwrap()).unwrap();
    assert_eq!(endpoint["token"], token.as_str());
    // What the next start finds is what the dashboard still shows.
    let again = restarted(&h);
    assert!(again.agent.enabled() && again.agent.allow_remote());
    assert_eq!(again.agent.token(), token);

    // Saved, a new token replaces the old one for good.
    h.app.db.lock().pragma_update(None, "query_only", false).unwrap();
    let rotated = c.ok("agent.regenerateToken", json!({})).await["token"].as_str().unwrap().to_owned();
    assert_ne!(rotated, token);
    assert_eq!(restarted(&h).agent.token(), rotated);
    assert_eq!(c.ok("agent.set", json!({ "enabled": false })).await["enabled"], false);
    assert!(!restarted(&h).agent.enabled());
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

/// .torrent files through the dashboard: whole when small, in `downloads.upload` pieces when not.
mod torrent_uploads {
    use magnetar::downloads::manager::MAX_TORRENT_FILE;
    use magnetar::downloads::upload::TORRENT_UPLOAD_CHUNK as PIECE;
    use magnetar::protocol::encoding::to_base64;

    use super::common::torrent_of_size;
    use super::*;

    /// Sends `bytes` as pieces `from..to` of upload `id`; the bytes received after the last one.
    async fn send_pieces(c: &mut Client, id: &str, bytes: &[u8], pieces: std::ops::Range<usize>) -> Result<Value, String> {
        let mut last = Ok(Value::Null);
        for offset in pieces.map(|i| i * PIECE).filter(|o| *o < bytes.len()) {
            let data = to_base64(&bytes[offset..(offset + PIECE).min(bytes.len())]);
            last =
                c.call("downloads.upload", json!({ "uploadId": id, "offset": offset, "size": bytes.len(), "data": data })).await;
            last.as_ref()?;
        }
        last
    }

    /// The names of the downloads started from .torrent files, sorted.
    async fn torrent_downloads(c: &mut Client) -> Vec<String> {
        let list = c.ok("downloads.list", json!({})).await;
        let mut names: Vec<String> = list
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["source"] == "Torrent file")
            .map(|d| d["name"].as_str().unwrap().to_owned())
            .collect();
        names.sort();
        names
    }

    async fn upload(c: &mut Client, id: &str, bytes: &[u8]) -> Result<Value, String> {
        send_pieces(c, id, bytes, 0..bytes.len().div_ceil(PIECE)).await?;
        c.call("downloads.startUpload", json!({ "uploadId": id })).await
    }

    #[tokio::test]
    async fn a_small_file_starts_whole_as_before() {
        let h = harness();
        let mut c = Client::new(&h.app, false);
        let torrent = torrent_of_size(190_000, "Small");
        let download = c.ok("downloads.start", json!({ "torrent": to_base64(&torrent) })).await;
        assert_eq!((download["name"].as_str(), download["source"].as_str()), (Some("Small"), Some("Torrent file")));
    }

    #[tokio::test]
    async fn files_of_750_kb_and_exactly_4_mib_arrive_in_pieces_and_start_in_the_chosen_folder() {
        let h = harness();
        let mut c = Client::new(&h.app, false);
        let medium = torrent_of_size(750_000, "Medium");
        let received = send_pieces(&mut c, "m", &medium, 0..2).await.unwrap();
        assert_eq!(received, json!({ "received": 750_000 }));
        // Through the relay, a folder inside the download folder.
        let real = std::fs::canonicalize(h.dir.path()).unwrap().display().to_string();
        let downloads = std::path::PathBuf::from(real.trim_start_matches(r"\\?\"));
        h.app.settings.update(|s| s.download_folder = downloads.display().to_string()).unwrap();
        let folder = downloads.join("Medium");
        let download = c.ok("downloads.startUpload", json!({ "uploadId": "m", "folder": folder })).await;
        assert_eq!(download["name"], "Medium");
        assert_eq!(download["savePath"], folder.display().to_string());

        let largest = torrent_of_size(MAX_TORRENT_FILE, "Largest");
        assert_eq!(upload(&mut c, "l", &largest).await.unwrap()["name"], "Largest");
        assert_eq!(torrent_downloads(&mut c).await, ["Largest", "Medium"]);
        // Started uploads are gone.
        assert!(c.call("downloads.startUpload", json!({ "uploadId": "l" })).await.unwrap_err().starts_with("not_found"));
    }

    #[tokio::test]
    async fn one_byte_over_4_mib_is_refused_at_the_first_piece() {
        let h = harness();
        let mut c = Client::new(&h.app, false);
        let error = c
            .call("downloads.upload", json!({ "uploadId": "big", "offset": 0, "size": MAX_TORRENT_FILE + 1, "data": "AAAA" }))
            .await
            .unwrap_err();
        assert_eq!(error, "bad_request: That .torrent file is larger than 4 MB.");
        assert!(c.call("downloads.startUpload", json!({ "uploadId": "big" })).await.unwrap_err().starts_with("not_found"));
    }

    #[tokio::test]
    async fn pieces_out_of_order_or_missing_drop_the_file_instead_of_starting_a_broken_one() {
        let h = harness();
        let mut c = Client::new(&h.app, false);
        let torrent = torrent_of_size(1_600_000, "Ordered");
        let piece = |i: usize| to_base64(&torrent[i * PIECE..((i + 1) * PIECE).min(torrent.len())]);
        let size = torrent.len();

        // A skipped piece.
        send_pieces(&mut c, "a", &torrent, 0..1).await.unwrap();
        let skipped =
            c.call("downloads.upload", json!({ "uploadId": "a", "offset": 2 * PIECE, "size": size, "data": piece(2) })).await;
        assert_eq!(skipped.unwrap_err(), "bad_request: Part of the .torrent file got lost on the way. Add it again.");
        // The file is gone, so even the right next piece is refused.
        let after = c.call("downloads.upload", json!({ "uploadId": "a", "offset": PIECE, "size": size, "data": piece(1) })).await;
        assert!(after.unwrap_err().starts_with("not_found"));

        // A piece sent twice.
        send_pieces(&mut c, "b", &torrent, 0..2).await.unwrap();
        assert!(send_pieces(&mut c, "b", &torrent, 1..2).await.unwrap_err().starts_with("bad_request"));

        // Another size halfway, and a piece running past the size.
        send_pieces(&mut c, "c", &torrent, 0..1).await.unwrap();
        let resized =
            c.call("downloads.upload", json!({ "uploadId": "c", "offset": PIECE, "size": size + 1, "data": piece(1) })).await;
        assert!(resized.unwrap_err().starts_with("bad_request"));
        let past = c.call("downloads.upload", json!({ "uploadId": "d", "offset": 0, "size": 10, "data": piece(0) })).await;
        assert!(past.unwrap_err().starts_with("bad_request"));

        // Truncated: started before the last piece came.
        send_pieces(&mut c, "e", &torrent, 0..2).await.unwrap();
        let truncated = c.call("downloads.startUpload", json!({ "uploadId": "e" })).await;
        assert_eq!(truncated.unwrap_err(), "bad_request: Only part of the .torrent file arrived. Add it again.");
        assert!(c.call("downloads.startUpload", json!({ "uploadId": "e" })).await.unwrap_err().starts_with("not_found"));

        // Junk instead of base64, and an empty piece.
        let junk = c.call("downloads.upload", json!({ "uploadId": "f", "offset": 0, "size": 10, "data": "not base64!" })).await;
        assert!(junk.unwrap_err().starts_with("bad_request"));
        let empty = c.call("downloads.upload", json!({ "uploadId": "f", "offset": 0, "size": 10, "data": "" })).await;
        assert!(empty.unwrap_err().starts_with("bad_request"));

        // An id the contract doesn't allow: empty, or longer than 64.
        for id in [String::new(), "i".repeat(65)] {
            let refused = c.call("downloads.upload", json!({ "uploadId": id, "offset": 0, "size": 10, "data": "AAAA" })).await;
            assert_eq!(refused.unwrap_err(), "bad_request: uploadId: 1 to 64 characters");
        }
        let longest = "i".repeat(64);
        let accepted = c.call("downloads.upload", json!({ "uploadId": longest, "offset": 0, "size": 10, "data": "AAAA" })).await;
        assert_eq!(accepted.unwrap()["received"], 3);

        // None of it started anything; the whole file in order still does.
        assert_eq!(upload(&mut c, "g", &torrent).await.unwrap()["name"], "Ordered");
        assert_eq!(torrent_downloads(&mut c).await, ["Ordered"]);
    }

    #[tokio::test]
    async fn two_files_at_once_arrive_side_by_side() {
        let h = harness();
        let mut c = Client::new(&h.app, false);
        let one = torrent_of_size(1_200_000, "One");
        let two = torrent_of_size(900_000, "Two");
        for i in 0..3 {
            send_pieces(&mut c, "one", &one, i..i + 1).await.unwrap();
            send_pieces(&mut c, "two", &two, i..i + 1).await.unwrap();
        }
        assert_eq!(c.ok("downloads.startUpload", json!({ "uploadId": "two" })).await["name"], "Two");
        assert_eq!(c.ok("downloads.startUpload", json!({ "uploadId": "one" })).await["name"], "One");
    }

    #[tokio::test]
    async fn pieces_belong_to_their_connection_and_leave_with_it() {
        let h = harness();
        let torrent = torrent_of_size(800_000, "Mine");
        let mut first = Client::new(&h.app, false);
        send_pieces(&mut first, "x", &torrent, 0..2).await.unwrap();
        let mut other = Client::with_key(&h.app, Some("another-browser"));
        assert!(other.call("downloads.startUpload", json!({ "uploadId": "x" })).await.unwrap_err().starts_with("not_found"));

        // The connection drops mid-transfer: what arrived is let go, and the file is added again from the start.
        send_pieces(&mut first, "y", &torrent, 0..1).await.unwrap();
        first.session.close();
        let mut again = Client::new(&h.app, false);
        assert!(send_pieces(&mut again, "y", &torrent, 1..2).await.unwrap_err().starts_with("not_found"));
        assert_eq!(upload(&mut again, "y", &torrent).await.unwrap()["name"], "Mine");
    }
}

/// Files: what a dashboard may browse and choose, on this computer and through the relay.
mod files {
    use std::path::{Path, PathBuf};

    use librqbit::spawn_utils::BlockingSpawner;
    use librqbit::{CreateTorrentOptions, create_torrent};

    use super::*;

    /// The download folder (with a folder and a file), a folder that may be added, and a private one beside them.
    fn folders(h: &Harness) -> (PathBuf, PathBuf, PathBuf) {
        // Real names (macOS's /var is /private/var, Windows runners' RUNNER~1 a short name), written as people do.
        let real = std::fs::canonicalize(h.dir.path()).unwrap();
        let base = PathBuf::from(text(&real).trim_start_matches(r"\\?\"));
        let (downloads, media, private) = (base.join("Downloads"), base.join("Media"), base.join("Private"));
        for folder in [&downloads, &media, &private] {
            std::fs::create_dir_all(folder.join("Sub")).unwrap();
        }
        std::fs::write(downloads.join("notes.txt"), "hi").unwrap();
        std::fs::write(private.join("secret.txt"), "secret").unwrap();
        h.app.settings.update(|s| s.download_folder = text(&downloads)).unwrap();
        (downloads, media, private)
    }

    fn text(path: &Path) -> String {
        path.display().to_string()
    }

    fn names(page: &Value) -> Vec<&str> {
        page["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect()
    }

    #[tokio::test]
    async fn a_relayed_browser_sees_only_the_download_folder_and_folders_added_on_the_computer() {
        let h = harness();
        let (downloads, media, private) = folders(&h);
        let mut local = Client::new(&h.app, true);
        let mut relayed = Client::new(&h.app, false);

        assert_eq!(relayed.ok("app.info", json!({})).await["fileBrowser"], true);
        let roots = relayed.ok("fs.roots", json!({})).await;
        assert_eq!((&roots["canAdd"], roots["roots"].as_array().unwrap().len()), (&json!(false), 1));
        assert_eq!((&roots["roots"][0]["path"], &roots["roots"][0]["kind"]), (&json!(text(&downloads)), &json!("downloads")));
        assert!(roots["roots"][0]["available"] == true && roots["roots"][0]["freeBytes"].as_u64().unwrap() > 0);
        let page = relayed.ok("fs.browse", json!({ "path": text(&downloads) })).await;
        assert_eq!(
            (names(&page), &page["root"], &page["total"]),
            (vec!["Sub", "notes.txt"], &json!(text(&downloads)), &json!(2))
        );

        // Nothing outside the roots, however it is spelled, and only the computer itself adds a root.
        let outside = [
            text(&private),
            text(&downloads.join("..").join("Private")),
            text(&downloads.join("Sub").join("..").join("..")),
            text(downloads.parent().unwrap()),
            text(&media),
            "relative".into(),
        ];
        for path in outside.iter().chain(&[text(Path::new(&std::path::MAIN_SEPARATOR.to_string()))]) {
            assert!(relayed.call("fs.browse", json!({ "path": path })).await.unwrap_err().starts_with("forbidden"), "{path}");
        }
        assert!(relayed.call("fs.addRoot", json!({ "path": text(&private) })).await.unwrap_err().starts_with("forbidden"));
        let made = relayed.call("fs.createFolder", json!({ "parent": text(&private), "name": "x" })).await;
        assert!(made.unwrap_err().starts_with("forbidden") && !private.join("x").exists());
        // The removed methods that listed and made folders anywhere are gone for good.
        for method in ["fs.list", "fs.mkdir"] {
            assert!(local.call(method, json!({ "path": text(&private) })).await.unwrap_err().starts_with("not_found"));
        }

        // The owner adds Media on the computer: the relayed browser sees it too, and may stop seeing it.
        let added = local.ok("fs.addRoot", json!({ "path": format!("{}{}", text(&media), std::path::MAIN_SEPARATOR) })).await;
        assert_eq!(
            (&added["canAdd"], &added["roots"][1]["path"], &added["roots"][1]["kind"]),
            (&json!(true), &json!(text(&media)), &json!("added"))
        );
        assert_eq!(local.ok("fs.addRoot", json!({ "path": text(&media) })).await["roots"].as_array().unwrap().len(), 2, "once");
        assert_eq!(names(&relayed.ok("fs.browse", json!({ "path": text(&media) })).await), ["Sub"]);
        let made = relayed.ok("fs.createFolder", json!({ "parent": text(&media.join("Sub")), "name": "Season 1" })).await;
        assert_eq!(made["path"], text(&media.join("Sub").join("Season 1")));
        assert!(media.join("Sub").join("Season 1").is_dir());
        // Removing is the owner's too, on the computer.
        assert!(relayed.call("fs.removeRoot", json!({ "path": text(&media) })).await.unwrap_err().starts_with("forbidden"));
        assert_eq!(local.ok("fs.removeRoot", json!({ "path": text(&media) })).await["roots"].as_array().unwrap().len(), 1);
        assert!(relayed.call("fs.browse", json!({ "path": text(&media) })).await.unwrap_err().starts_with("forbidden"));

        // A root must be an existing folder, written in full.
        assert!(local.call("fs.addRoot", json!({ "path": "relative/x" })).await.unwrap_err().starts_with("bad_request"));
        assert!(
            local.call("fs.addRoot", json!({ "path": text(&media.join("gone")) })).await.unwrap_err().starts_with("not_found")
        );
        assert!(
            local
                .call("fs.addRoot", json!({ "path": text(&downloads.join("notes.txt")) }))
                .await
                .unwrap_err()
                .starts_with("bad_request")
        );
    }

    #[tokio::test]
    async fn a_relayed_browser_chooses_folders_only_inside_what_it_may_browse() {
        let h = harness();
        let (downloads, media, private) = folders(&h);
        let mut local = Client::new(&h.app, true);
        let mut relayed = Client::new(&h.app, false);
        let magnet = format!("magnet:?xt=urn:btih:{}&dn=x", "E".repeat(40));

        for folder in [text(&private), text(&downloads.join("..").join("Private")), text(&media)] {
            let refused = |result: Result<Value, String>| result.unwrap_err().contains("From another device");
            assert!(refused(relayed.call("settings.update", json!({ "downloadFolder": folder })).await), "{folder}");
            assert!(refused(relayed.call("downloads.start", json!({ "magnet": magnet, "folder": folder })).await), "{folder}");
            assert!(refused(relayed.call("series.create", json!({ "name": "S", "query": "S", "downloadFolder": folder })).await));
        }
        assert_eq!(local.ok("settings.get", json!({})).await["downloadFolder"], text(&downloads));
        assert_eq!(local.ok("downloads.list", json!({})).await, json!([]));

        let inside = downloads.join("Sub").join("New");
        assert_eq!(
            relayed.ok("downloads.start", json!({ "magnet": magnet, "folder": text(&inside) })).await["savePath"],
            text(&inside)
        );
        local.ok("fs.addRoot", json!({ "path": text(&media) })).await;
        let moved = relayed.ok("settings.update", json!({ "downloadFolder": text(&media.join("Sub")) })).await;
        assert_eq!(moved["downloadFolder"], text(&media.join("Sub")));
        // The old download folder stays browsable, where its downloads still are; not when another root holds it.
        let paths = |roots: Value| {
            roots["roots"].as_array().unwrap().iter().map(|r| r["path"].as_str().unwrap().to_owned()).collect::<Vec<_>>()
        };
        let expected = [text(&media.join("Sub")), text(&media), text(&downloads)];
        assert_eq!(paths(relayed.ok("fs.roots", json!({})).await), expected);
        relayed.ok("settings.update", json!({ "downloadFolder": text(&downloads) })).await;
        assert_eq!(paths(relayed.ok("fs.roots", json!({})).await), [text(&downloads), text(&media)]);
        // The dashboard on the computer itself chooses freely.
        assert_eq!(
            local.ok("settings.update", json!({ "downloadFolder": text(&private) })).await["downloadFolder"],
            text(&private)
        );
    }

    #[tokio::test]
    async fn a_download_folder_not_made_yet_is_made_but_one_on_a_missing_disk_is_not() {
        let h = harness();
        let (downloads, media, _) = folders(&h);
        let mut relayed = Client::new(&h.app, false);
        let fresh = downloads.join("Magnetar");
        h.app.settings.update(|s| s.download_folder = text(&fresh)).unwrap();
        let roots = relayed.ok("fs.roots", json!({})).await;
        assert_eq!((&roots["roots"][0]["path"], &roots["roots"][0]["available"]), (&json!(text(&fresh)), &json!(true)));
        assert!(fresh.is_dir());

        let unplugged = media.join("Unplugged").join("Downloads");
        h.app.settings.update(|s| s.download_folder = text(&unplugged)).unwrap();
        let roots = relayed.ok("fs.roots", json!({})).await;
        assert_eq!((&roots["roots"][0]["available"], &roots["roots"][0]["freeBytes"]), (&json!(false), &Value::Null));
        assert!(!media.join("Unplugged").exists());
        let error = relayed.call("fs.browse", json!({ "path": text(&unplugged) })).await.unwrap_err();
        assert!(error.starts_with("not_found") && error.contains("connect it"), "{error}");
    }

    #[tokio::test]
    async fn pages_list_folders_first_with_the_downloads_their_entries_belong_to() {
        let h = harness();
        let (downloads, _, _) = folders(&h);
        let show = downloads.join("Show S01");
        std::fs::create_dir_all(&show).unwrap();
        std::fs::write(downloads.join("clip.mp4"), vec![1u8; 70_000]).unwrap();
        std::fs::write(show.join("E01.mkv"), vec![2u8; 50_000]).unwrap();
        std::fs::write(show.join("E01.srt"), "1").unwrap();
        let spawner = BlockingSpawner::new(1);
        let add = async |path: &Path| {
            let torrent = create_torrent(path, CreateTorrentOptions::default(), &spawner).await.unwrap();
            h.app
                .downloads
                .add_torrent_file(torrent.as_bytes().unwrap().to_vec(), "Torrent file", Some(text(&downloads)))
                .unwrap()
                .id
        };
        let (clip, pack) = (add(&downloads.join("clip.mp4")).await, add(&show).await);

        let mut relayed = Client::new(&h.app, false);
        let page = relayed.ok("fs.browse", json!({ "path": text(&downloads) })).await;
        assert_eq!(
            (names(&page), &page["total"], &page["truncated"]),
            (vec!["Show S01", "Sub", "clip.mp4", "notes.txt"], &json!(4), &json!(false))
        );
        let entries = page["entries"].as_array().unwrap();
        assert_eq!((&entries[0]["kind"], &entries[0]["download"]), (&json!("folder"), &json!({ "id": pack })));
        assert_eq!(&entries[1]["download"], &Value::Null);
        assert_eq!(
            (&entries[2]["kind"], &entries[2]["size"], &entries[2]["media"], &entries[2]["download"]),
            (&json!("file"), &json!(70_000), &json!("video"), &json!({ "id": clip, "index": 0 }))
        );
        assert_eq!((&entries[3]["media"], &entries[3]["download"]), (&Value::Null, &Value::Null));

        let inner = relayed.ok("fs.browse", json!({ "path": text(&show) })).await;
        assert_eq!(page["separator"], std::path::MAIN_SEPARATOR.to_string());
        assert_eq!((names(&inner), &inner["root"]), (vec!["E01.mkv", "E01.srt"], &json!(text(&downloads))));
        let files = relayed.ok("downloads.files", json!({ "id": pack })).await;
        for entry in inner["entries"].as_array().unwrap() {
            let index = entry["download"]["index"].as_u64().unwrap() as usize;
            assert_eq!(files[index]["path"], entry["name"], "the index is the file's own");
        }

        // Pages split the same order; past the end is empty; only folders when asked.
        let page_of = |offset: u64, limit: u64| json!({ "path": text(&downloads), "offset": offset, "limit": limit });
        assert_eq!(names(&relayed.ok("fs.browse", page_of(0, 1)).await), ["Show S01"]);
        assert_eq!(names(&relayed.ok("fs.browse", page_of(3, 1)).await), ["notes.txt"]);
        let past = relayed.ok("fs.browse", page_of(4, 1)).await;
        assert_eq!((names(&past), &past["total"]), (Vec::<&str>::new(), &json!(4)));
        assert_eq!(
            names(&relayed.ok("fs.browse", page_of(0, 100_000)).await).len(),
            4,
            "a limit beyond the page size is the page size"
        );
        let folders_only = relayed.ok("fs.browse", json!({ "path": text(&downloads), "foldersOnly": true })).await;
        assert_eq!(names(&folders_only), ["Show S01", "Sub"]);
        assert!(
            relayed
                .call("fs.browse", json!({ "path": text(&downloads), "offset": -1 }))
                .await
                .unwrap_err()
                .starts_with("bad_request")
        );
        assert!(
            relayed
                .call("fs.browse", json!({ "path": text(&downloads), "sort": "size" }))
                .await
                .unwrap_err()
                .starts_with("bad_request")
        );
    }
}
