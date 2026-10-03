//! Series tasks on a real app with a scripted search source: which release each episode gets, where
//! a new task starts, and how a dead release is replaced.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use magnetar::app::{App, AppOptions};
use magnetar::downloads::manager::EngineSource;
use magnetar::paths::Paths;
use magnetar::protocol::{DownloadStatus, SeriesTaskInput, StartFrom};
use magnetar::search::types::{Provider, TorrentSearchResult};
use tokio_util::sync::CancellationToken;

/// Releases of "Show", every episode up to `aired`, in 720p and 1080p from two groups.
struct Releases {
    aired: Mutex<i64>,
}

fn release(episode: i64, group: &str, resolution: &str, seeders: u32) -> TorrentSearchResult {
    // A hash per (episode, group, resolution), so every release is a different torrent.
    let seed = format!("{episode}{group}{resolution}");
    let hash: String = format!("{:x}", seed.bytes().fold(0u64, |h, b| h.wrapping_mul(131).wrapping_add(b as u64)))
        .chars()
        .cycle()
        .take(40)
        .collect();
    TorrentSearchResult {
        info_hash: hash.clone(),
        magnet_uri: format!("magnet:?xt=urn:btih:{hash}"),
        seeders,
        size_bytes: if resolution == "1080p" { 1_400_000_000 } else { 700_000_000 },
        ..TorrentSearchResult::new(format!("[{group}] Show - {episode:02} ({resolution})"), "Scripted")
    }
}

#[async_trait]
impl Provider for Releases {
    fn name(&self) -> &'static str {
        "Scripted"
    }

    fn id(&self) -> &'static str {
        "scripted"
    }

    async fn search(&self, _: &reqwest::Client, _: &str, _: &CancellationToken) -> anyhow::Result<Vec<TorrentSearchResult>> {
        let aired = *self.aired.lock().unwrap();
        Ok((1..=aired)
            .flat_map(|e| {
                [release(e, "Popular", "1080p", 500), release(e, "Preferred", "1080p", 20), release(e, "Popular", "720p", 900)]
            })
            .collect())
    }
}

fn app(aired: i64) -> (Arc<App>, Arc<Releases>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let source = Arc::new(Releases { aired: Mutex::new(aired) });
    let app = App::new(AppOptions {
        paths: Paths::new(dir.path().join("data")).unwrap(),
        engine: EngineSource::Off,
        providers: vec![source.clone()],
        legacy_database: None,
        show_lookups: false,
    })
    .unwrap();
    app.settings.update(|s| s.download_folder = dir.path().join("dl").display().to_string());
    (app, source, dir)
}

fn input(start_from: StartFrom) -> SeriesTaskInput {
    serde_json::from_value::<SeriesTaskInput>(serde_json::json!({ "name": "Show", "query": "Show" }))
        .map(|i| SeriesTaskInput { start_from, ..i })
        .unwrap()
}

fn titles(app: &App) -> Vec<String> {
    let mut names: Vec<String> = app.downloads.list().into_iter().map(|d| d.name).collect();
    names.sort();
    names
}

#[tokio::test]
async fn each_episode_gets_the_release_its_rules_prefer() {
    let (app, _, _dir) = app(3);
    let task = app
        .actions
        .create_series(SeriesTaskInput {
            resolution: Some("1080p".into()),
            prefer_words: Some("Preferred".into()),
            ..input(StartFrom::Episode)
        })
        .await
        .unwrap();
    app.actions.check_series_now(task.id).await.unwrap();
    assert_eq!(titles(&app), ["[Preferred] Show - 01 (1080p)", "[Preferred] Show - 02 (1080p)", "[Preferred] Show - 03 (1080p)"]);

    // Without rules, the most seeded release wins, whatever its resolution.
    let (plain, _, _dir) = app_with_one_episode().await;
    assert_eq!(titles(&plain), ["[Popular] Show - 01 (720p)"]);
}

async fn app_with_one_episode() -> (Arc<App>, Arc<Releases>, tempfile::TempDir) {
    let (app, source, dir) = app(1);
    let task = app.actions.create_series(input(StartFrom::Episode)).await.unwrap();
    app.actions.check_series_now(task.id).await.unwrap();
    (app, source, dir)
}

#[tokio::test]
async fn a_task_can_start_at_the_latest_episode_or_with_new_ones_only() {
    let (app, source, _dir) = app(5);
    let latest =
        app.actions.create_series(SeriesTaskInput { resolution: Some("720p".into()), ..input(StartFrom::Latest) }).await.unwrap();
    assert_eq!(latest.next_episode, 5);
    app.actions.check_series_now(latest.id).await.unwrap();
    assert_eq!(titles(&app), ["[Popular] Show - 05 (720p)"], "only the newest, no backlog");

    let only_new =
        app.actions.create_series(SeriesTaskInput { name: "Show again".into(), ..input(StartFrom::New) }).await.unwrap();
    assert_eq!(only_new.next_episode, 6);
    app.actions.check_series_now(only_new.id).await.unwrap();
    assert_eq!(titles(&app).len(), 1, "nothing new yet");
    *source.aired.lock().unwrap() = 6;
    app.actions.check_series_now(only_new.id).await.unwrap();
    assert_eq!(titles(&app), ["[Popular] Show - 05 (720p)", "[Popular] Show - 06 (720p)"]);
    app.actions.check_series_now(latest.id).await.unwrap();
    assert_eq!(titles(&app).len(), 2, "the same torrent for two tasks is one download");
    assert_eq!(app.actions.list_series().iter().map(|t| t.next_episode).collect::<Vec<_>>(), [7, 7]);
}

#[tokio::test]
async fn a_release_nobody_seeds_is_replaced_by_the_next_best() {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::new(dir.path().join("data")).unwrap();
    let make = || {
        App::new(AppOptions {
            paths: paths.clone(),
            engine: EngineSource::Off,
            providers: vec![Arc::new(Releases { aired: Mutex::new(1) })],
            legacy_database: None,
            show_lookups: false,
        })
        .unwrap()
    };
    let app = make();
    app.settings.update(|s| s.download_folder = dir.path().join("dl").display().to_string());
    let task = app
        .actions
        .create_series(SeriesTaskInput { resolution: Some("1080p".into()), ..input(StartFrom::Episode) })
        .await
        .unwrap();
    app.actions.check_series_now(task.id).await.unwrap();
    assert_eq!(titles(&app), ["[Popular] Show - 01 (1080p)"]);

    // The torrent died looking for peers; the next start finds it failed.
    app.db
        .lock()
        .execute(
            "UPDATE downloads SET status = 'Error', error = 'No peers found — the torrent may be dead or have no seeders.'",
            [],
        )
        .unwrap();
    drop(app);
    let app = make();
    app.start();
    app.actions.check_series_now(task.id).await.unwrap();
    let downloads = app.downloads.list();
    assert_eq!(downloads.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["[Preferred] Show - 01 (1080p)"]);
    assert_eq!(downloads[0].status, DownloadStatus::Queued);

    // It dies too: nothing left that the rules allow, so the failure stays for the user to see.
    app.db.lock().execute("UPDATE downloads SET status = 'Error', error = 'No peers found — dead'", []).unwrap();
    drop(app);
    let app = make();
    app.start();
    app.actions.check_series_now(task.id).await.unwrap();
    let downloads = app.downloads.list();
    assert_eq!(downloads.len(), 1);
    assert_eq!((downloads[0].name.as_str(), downloads[0].status), ("[Preferred] Show - 01 (1080p)", DownloadStatus::Error));
    assert_eq!(app.actions.list_series()[0].next_episode, 2, "the episode still counts as taken");
}

#[tokio::test]
async fn a_watch_reports_the_first_release_its_rules_allow_then_rests_until_armed_again() {
    use magnetar::protocol::WatchInput;
    let (app, _, _dir) = app(2);
    let watch = |value: serde_json::Value| serde_json::from_value::<WatchInput>(value).unwrap();
    let store = &app.monitor.watches;

    let uhd = store.create(watch(serde_json::json!({ "query": "Show", "resolution": "2160p" }))).unwrap();
    let checked = app.monitor.check_watch(uhd.id).await.unwrap();
    assert!(checked.found.is_none() && checked.enabled && checked.last_checked_at.is_some(), "nothing in 4K yet");

    let hd = store
        .create(watch(serde_json::json!({ "query": "Show 02", "resolution": "1080p", "preferWords": "preferred" })))
        .unwrap();
    let found = app.monitor.check_watch(hd.id).await.unwrap();
    let release = found.found.expect("a release");
    assert_eq!(release.title, "[Preferred] Show - 02 (1080p)");
    assert!(!found.enabled, "it rests once something is found");
    assert!(app.downloads.list().is_empty(), "only reported: it wasn't asked to download");

    let auto =
        store.create(watch(serde_json::json!({ "query": "Show 01", "resolution": "720p", "autoDownload": true }))).unwrap();
    let downloaded = app.monitor.check_watch(auto.id).await.unwrap();
    assert_eq!(app.downloads.get(downloaded.download_id.unwrap()).unwrap().name, "[Popular] Show - 01 (720p)");

    let rearmed =
        store.update(hd.id, watch(serde_json::json!({ "query": "Show 02", "resolution": "1080p", "enabled": true }))).unwrap();
    assert!(rearmed.enabled && rearmed.found.is_none() && rearmed.last_checked_at.is_none(), "armed again, it looks afresh");
    assert!(store.create(watch(serde_json::json!({ "query": " x " }))).is_err(), "a one-letter query would match anything");
    assert!(store.create(watch(serde_json::json!({ "query": "Show", "checkIntervalMinutes": 1 }))).is_err());
}

#[tokio::test]
async fn a_check_interval_is_a_minute_to_a_week() {
    let (app, _, _dir) = app(1);
    let every = |minutes: i64| SeriesTaskInput { check_interval_minutes: minutes, ..input(StartFrom::Episode) };
    for refused in [0, -1, 10_081, 1_000_000_000_000_000, i64::MAX] {
        let error = app.actions.create_series(every(refused)).await.unwrap_err();
        assert!(error.message.contains("checkIntervalMinutes"), "{refused}: {}", error.message);
    }
    let weekly = app.actions.create_series(every(10_080)).await.unwrap();
    assert_eq!(weekly.check_interval_minutes, 10_080);
    assert_eq!(app.actions.create_series(every(1)).await.unwrap().check_interval_minutes, 1);
    let patch =
        |minutes: i64| magnetar::protocol::SeriesTaskPatch { check_interval_minutes: Some(minutes), ..Default::default() };
    assert!(app.actions.update_series(weekly.id, patch(1_000_000_000_000_000)).is_err());
    assert!(app.actions.update_series(weekly.id, patch(10_081)).is_err());
    assert_eq!(app.actions.get_series(weekly.id).unwrap().check_interval_minutes, 10_080, "a refused patch changes nothing");
}

/// A source whose answers trip Magnetar up: "Boom" finds a release whose detail page makes the parser
/// panic, "Crash" makes the search itself panic. Anything else finds episode 1 of "Show".
struct Treacherous {
    details_asked: Mutex<usize>,
}

#[async_trait]
impl Provider for Treacherous {
    fn name(&self) -> &'static str {
        "Treacherous"
    }

    fn id(&self) -> &'static str {
        "treacherous"
    }

    async fn search(&self, _: &reqwest::Client, query: &str, _: &CancellationToken) -> anyhow::Result<Vec<TorrentSearchResult>> {
        if query.starts_with("Crash") {
            panic!("a page the parser never saw");
        }
        if query.starts_with("Boom") {
            let lazy = TorrentSearchResult {
                seeders: 5,
                info_hash: "lazy-1".into(),
                ..TorrentSearchResult::new("Boom - 01", "Treacherous")
            };
            return Ok(vec![lazy]);
        }
        Ok(vec![release(1, "Popular", "1080p", 500)])
    }

    async fn details(
        &self,
        _: &reqwest::Client,
        _: &TorrentSearchResult,
        _: &CancellationToken,
    ) -> Option<anyhow::Result<magnetar::search::types::TorrentDetails>> {
        *self.details_asked.lock().unwrap() += 1;
        panic!("a detail page the parser never saw");
    }
}

#[tokio::test]
async fn one_broken_rule_never_stops_the_others_from_being_checked() {
    let dir = tempfile::tempdir().unwrap();
    let source = Arc::new(Treacherous { details_asked: Mutex::new(0) });
    let app = App::new(AppOptions {
        paths: Paths::new(dir.path().join("data")).unwrap(),
        engine: EngineSource::Off,
        providers: vec![source.clone()],
        legacy_database: None,
        show_lookups: false,
    })
    .unwrap();
    app.settings.update(|s| s.download_folder = dir.path().join("dl").display().to_string());
    let named = |name: &str| SeriesTaskInput { name: name.into(), query: name.into(), ..input(StartFrom::Episode) };
    // Checked in this order: every broken one comes before the one that works.
    let boom = app.actions.create_series(named("Boom")).await.unwrap();
    let crash = app.actions.create_series(named("Crash")).await.unwrap();
    let huge = app.actions.create_series(named("Huge")).await.unwrap();
    let show = app.actions.create_series(named("Show")).await.unwrap();
    // An interval no create accepts, stored before there was a limit, with and without a last check.
    app.db
        .lock()
        .execute(
            "UPDATE series_tasks SET check_interval_minutes = 1000000000000000, last_checked_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
            [huge.id],
        )
        .unwrap();
    app.db.lock().execute("UPDATE series_tasks SET check_interval_minutes = ? WHERE id = ?", (i64::MAX, boom.id)).unwrap();

    app.monitor.check_all().await;
    assert_eq!(titles(&app), ["[Popular] Show - 01 (1080p)"], "the rule after the broken ones was checked");
    assert_eq!(*source.details_asked.lock().unwrap(), 1);
    let checked = |id: i64| app.actions.get_series(id).unwrap().last_checked_at;
    assert!(checked(crash.id).is_some() && checked(show.id).is_some(), "both were checked");
    assert_eq!(app.actions.get_series(huge.id).unwrap().check_interval_minutes, 10_080, "read back within the limit");

    // A rule whose check panicked is not left marked as running: the next round tries it again.
    app.db.lock().execute("UPDATE series_tasks SET last_checked_at = NULL", []).unwrap();
    app.monitor.check_all().await;
    assert_eq!(*source.details_asked.lock().unwrap(), 2);
    assert!(app.actions.check_series_now(boom.id).await.is_err(), "Check now reports the failure instead of hanging");
    assert_eq!(*source.details_asked.lock().unwrap(), 3);
}
