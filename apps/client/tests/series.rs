//! Series tasks on a real app with a scripted search source: which release each episode gets, where
//! a new task starts, and how a dead release is replaced.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mediadownloader::app::{App, AppOptions};
use mediadownloader::downloads::manager::EngineSource;
use mediadownloader::paths::Paths;
use mediadownloader::protocol::{DownloadStatus, SeriesTaskInput, StartFrom};
use mediadownloader::search::types::{Provider, TorrentSearchResult};
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
