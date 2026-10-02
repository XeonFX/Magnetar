//! Update checks and the changelog against a GitHub of the test's own: what the dashboard is told
//! for a newer, equal and older release, and when GitHub is offline, rate limited or answers nonsense.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use magnetar::app::{App, AppOptions};
use magnetar::config::VERSION;
use magnetar::db::KeyValue;
use magnetar::downloads::manager::EngineSource;
use magnetar::paths::Paths;
use serde_json::{Value, json};

/// An answer: its status, headers and body.
type Answer = (StatusCode, Vec<(&'static str, String)>, String);

/// What the fake GitHub answers next, and what it was asked.
#[derive(Default)]
struct GitHub {
    answer: Option<Answer>,
    asked: Vec<HeaderMap>,
    /// How long it takes to answer.
    delay: std::time::Duration,
}

type Shared = Arc<Mutex<GitHub>>;

async fn releases(axum::extract::State(github): axum::extract::State<Shared>, headers: HeaderMap) -> Response {
    let ((status, headers, body), delay) = {
        let mut github = github.lock().unwrap();
        github.asked.push(headers);
        (github.answer.clone().unwrap_or((StatusCode::OK, vec![], "[]".into())), github.delay)
    };
    tokio::time::sleep(delay).await;
    let mut response = (status, body).into_response();
    for (name, value) in headers {
        response.headers_mut().insert(name, value.parse().unwrap());
    }
    response
}

/// A GitHub on a free port, and its address.
async fn github() -> (Shared, String) {
    let shared = Shared::default();
    let router = Router::new().route("/repos/XeonFX/Magnetar/releases", get(releases)).with_state(shared.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (shared, address)
}

fn app(api: &str) -> (Arc<App>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let app = App::new(AppOptions {
        paths: Paths::new(dir.path().join("data")).unwrap(),
        engine: EngineSource::Off,
        providers: vec![],
        legacy_database: None,
        show_lookups: false,
    })
    .unwrap();
    app.updates.github_api.set(api.to_owned()).unwrap();
    (app, dir)
}

fn release(tag: &str, extra: Value) -> Value {
    let mut release = json!({
        "tag_name": tag,
        "name": format!("Magnetar {tag}"),
        "body": "## New\n\n- Build version in About (#30)\n- Changelog panel (#31)\n- Third thing (#32)",
        "html_url": format!("https://github.com/XeonFX/Magnetar/releases/tag/{tag}"),
        "published_at": "2026-10-02T06:02:32Z",
        "draft": false,
        "prerelease": false,
        "assets": [],
    });
    release.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    release
}

/// The version this build calls itself, without the `+dev` of a test build.
fn running() -> String {
    VERSION.split('+').next().unwrap().to_owned()
}

fn bump(version: &str, by: u64) -> String {
    let parts: Vec<u64> = version.split(['.', '-']).take(3).map(|p| p.parse().unwrap()).collect();
    format!("{}.{}.{}", parts[0], parts[1] + by, 0)
}

fn answer(github: &Shared, status: StatusCode, headers: Vec<(&'static str, String)>, body: impl Into<String>) {
    github.lock().unwrap().answer = Some((status, headers, body.into()));
}

fn status_json(app: &App) -> Value {
    serde_json::to_value(app.updates.status()).unwrap()
}

#[tokio::test]
async fn a_newer_release_is_offered_with_what_it_brings_and_told_about_once() {
    let (github, api) = github().await;
    let newer = bump(&running(), 1);
    let ahead = bump(&running(), 2);
    answer(
        &github,
        StatusCode::OK,
        vec![("etag", "\"v1\"".into())],
        json!([
            release(&format!("v{}", running()), json!({})),
            release(&format!("v{newer}"), json!({})),
            release(&format!("v{ahead}-rc.1"), json!({ "prerelease": true })),
            release(&format!("v{ahead}"), json!({ "draft": true })),
            release("nightly", json!({})),
            json!({ "tag_name": 42 }),
        ])
        .to_string(),
    );
    let (app, _dir) = app(&api);
    let status = serde_json::to_value(app.updates.check().await).unwrap();
    assert_eq!(status["available"]["version"], newer);
    assert_eq!(status["available"]["name"], format!("Magnetar v{newer}"));
    assert_eq!(status["currentVersion"], VERSION);
    assert_eq!(status["lastCheckProblem"], Value::Null);

    // The changelog: newest first, the pre-release marked, drafts and other tags left out.
    let changelog = serde_json::to_value(app.updates.releases().await).unwrap();
    let versions: Vec<&str> = changelog["releases"].as_array().unwrap().iter().map(|r| r["version"].as_str().unwrap()).collect();
    assert_eq!(versions, [format!("{ahead}-rc.1"), newer.clone(), running()]);
    assert_eq!(changelog["releases"][0]["prerelease"], true);
    assert_eq!(
        changelog["releases"][1]["notes"],
        "## New\n\n- Build version in About (#30)\n- Changelog panel (#31)\n- Third thing (#32)"
    );
    assert_eq!(changelog["problem"], Value::Null);
    // Read once: the changelog didn't ask GitHub again.
    assert_eq!(github.lock().unwrap().asked.len(), 1);

    // Told once per version, also across a restart.
    assert_eq!(KeyValue(app.db.clone()).get("updates.notified_version"), Some(newer));

    // An unchanged list costs GitHub's rate limit nothing: asked with the tag, answered 304.
    answer(&github, StatusCode::NOT_MODIFIED, vec![], "");
    let status = serde_json::to_value(app.updates.check().await).unwrap();
    assert_eq!(github.lock().unwrap().asked[1].get("if-none-match").unwrap(), "\"v1\"");
    assert_eq!(status["available"]["version"], bump(&running(), 1));
    assert_eq!(serde_json::to_value(app.updates.releases().await).unwrap()["releases"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn the_same_or_an_older_release_offers_nothing() {
    let (github, api) = github().await;
    let (app, _dir) = app(&api);
    for tag in [format!("v{}", running()), "v0.0.1".to_owned(), format!("v{}-rc.1", bump(&running(), 1))] {
        answer(&github, StatusCode::OK, vec![], json!([release(&tag, json!({}))]).to_string());
        assert_eq!(status_json(&app)["available"], Value::Null, "before {tag}");
        assert_eq!(serde_json::to_value(app.updates.check().await).unwrap()["available"], Value::Null, "{tag}");
    }
    assert_eq!(KeyValue(app.db.clone()).get("updates.notified_version"), None);
}

#[tokio::test]
async fn a_repository_without_releases_is_up_to_date() {
    let (github, api) = github().await;
    answer(&github, StatusCode::NOT_FOUND, vec![], r#"{"message":"Not Found"}"#);
    let (app, _dir) = app(&api);
    let status = serde_json::to_value(app.updates.check().await).unwrap();
    assert_eq!((status["available"].clone(), status["lastCheckProblem"].clone()), (Value::Null, Value::Null));
    assert_eq!(serde_json::to_value(app.updates.releases().await).unwrap(), json!({ "releases": [], "problem": null }));
}

#[tokio::test]
async fn offline_says_so_and_keeps_what_it_knew() {
    let (github, api) = github().await;
    answer(&github, StatusCode::OK, vec![], json!([release(&format!("v{}", bump(&running(), 1)), json!({}))]).to_string());
    let (app, _dir) = app(&api);
    app.updates.check().await;

    // A port nobody listens on.
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let (offline, _dir2) = self::app(&dead);
    let status = serde_json::to_value(offline.updates.check().await).unwrap();
    assert_eq!(status["lastCheckProblem"], "offline");
    assert!(status["lastCheckError"].as_str().unwrap().starts_with("GitHub did not answer"));
    assert_eq!(serde_json::to_value(offline.updates.releases().await).unwrap(), json!({ "releases": [], "problem": "offline" }));

    // The app that read the releases before still offers them when GitHub stops answering.
    answer(&github, StatusCode::BAD_GATEWAY, vec![], "<html>");
    let status = serde_json::to_value(app.updates.check().await).unwrap();
    assert_eq!(status["lastCheckProblem"], "unavailable");
    assert_eq!(status["available"]["version"], bump(&running(), 1));
    assert_eq!(serde_json::to_value(app.updates.releases().await).unwrap()["problem"], Value::Null);
}

#[tokio::test]
async fn the_rate_limit_says_when_it_lifts() {
    let (github, api) = github().await;
    let (app, _dir) = app(&api);
    answer(
        &github,
        StatusCode::FORBIDDEN,
        vec![("x-ratelimit-remaining", "0".into()), ("x-ratelimit-reset", "1790000000".into())],
        r#"{"message":"API rate limit exceeded"}"#,
    );
    let status = serde_json::to_value(app.updates.check().await).unwrap();
    assert_eq!(status["lastCheckProblem"], "rate-limited");
    assert_eq!(status["retryAt"], "2026-09-21T14:13:20.000Z");

    answer(&github, StatusCode::TOO_MANY_REQUESTS, vec![("retry-after", "60".into())], "");
    let status = serde_json::to_value(app.updates.check().await).unwrap();
    assert_eq!(status["lastCheckProblem"], "rate-limited");
    assert!(status["retryAt"].is_string());

    // A refusal that isn't the rate limit is GitHub being unavailable.
    answer(&github, StatusCode::FORBIDDEN, vec![("x-ratelimit-remaining", "59".into())], "{}");
    let status = serde_json::to_value(app.updates.check().await).unwrap();
    assert_eq!((status["lastCheckProblem"].clone(), status["retryAt"].clone()), (json!("unavailable"), Value::Null));

    // Once GitHub answers again, the problem is gone.
    answer(&github, StatusCode::OK, vec![], "[]");
    assert_eq!(serde_json::to_value(app.updates.check().await).unwrap()["lastCheckProblem"], Value::Null);
}

#[tokio::test]
async fn an_answer_that_is_not_a_list_of_releases_is_unavailable() {
    let (github, api) = github().await;
    let (app, _dir) = app(&api);
    for body in ["<!doctype html>", r#"{"message":"x"}"#, "null", "{"] {
        answer(&github, StatusCode::OK, vec![], body);
        let status = serde_json::to_value(app.updates.check().await).unwrap();
        assert_eq!(status["lastCheckProblem"], "unavailable", "{body}");
    }
}

#[tokio::test]
async fn two_checks_at_once_ask_github_once() {
    let (github, api) = github().await;
    answer(&github, StatusCode::OK, vec![], "[]");
    let (app, _dir) = app(&api);
    let (a, b) = tokio::join!(app.updates.check(), app.updates.check());
    assert!(!a.checking || !b.checking);
    assert_eq!(github.lock().unwrap().asked.len(), 1);
}

#[tokio::test]
async fn the_changelog_asked_for_during_a_check_waits_for_it_and_tells_nobody() {
    let (github, api) = github().await;
    let newer = bump(&running(), 1);
    answer(&github, StatusCode::OK, vec![], json!([release(&format!("v{newer}"), json!({}))]).to_string());
    github.lock().unwrap().delay = std::time::Duration::from_millis(300);
    let (app, _dir) = app(&api);

    // Opened while a check is reading GitHub: the list, once the check has it, not an empty one.
    let (status, changelog) = tokio::join!(app.updates.check(), async {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        app.updates.releases().await
    });
    assert_eq!(serde_json::to_value(&changelog).unwrap()["releases"][0]["version"], newer);
    assert_eq!(serde_json::to_value(status).unwrap()["available"]["version"], newer);
    assert_eq!(github.lock().unwrap().asked.len(), 1);
}

#[tokio::test]
async fn opening_the_changelog_first_leaves_telling_to_the_next_check() {
    let (github, api) = github().await;
    let newer = bump(&running(), 1);
    answer(&github, StatusCode::OK, vec![], json!([release(&format!("v{newer}"), json!({}))]).to_string());
    let (app, _dir) = app(&api);

    app.updates.releases().await;
    // The dashboard sees the update at once…
    assert_eq!(status_json(&app)["available"]["version"], newer);
    // …but nobody was told: the next check does that (and its notice), once.
    assert_eq!(KeyValue(app.db.clone()).get("updates.notified_version"), None);
    app.updates.check().await;
    assert_eq!(KeyValue(app.db.clone()).get("updates.notified_version"), Some(newer));
}

#[tokio::test]
async fn the_changelog_sends_at_most_256_kib_of_notes_newest_first() {
    let (github, api) = github().await;
    let long = "x".repeat(60 * 1024);
    let releases: Vec<Value> = (1..=10).map(|minor| release(&format!("v0.{minor}.0"), json!({ "body": long }))).collect();
    answer(&github, StatusCode::OK, vec![], Value::Array(releases).to_string());
    let (app, _dir) = app(&api);
    let changelog = serde_json::to_value(app.updates.releases().await).unwrap();
    let lengths: Vec<usize> =
        changelog["releases"].as_array().unwrap().iter().map(|r| r["notes"].as_str().unwrap().len()).collect();
    assert_eq!(lengths.len(), 10);
    assert_eq!(lengths.iter().sum::<usize>(), 256 * 1024);
    // The newest keep theirs whole; the oldest go without.
    assert_eq!(&lengths[..4], &[60 * 1024; 4]);
    assert_eq!(lengths[9], 0);
    assert_eq!(changelog["releases"][0]["version"], "0.10.0");
}
