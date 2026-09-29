//! The download manager on a real torrent engine. A local file stands in for a finished download, so
//! nothing needs peers.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use librqbit::spawn_utils::BlockingSpawner;
use librqbit::{CreateTorrentOptions, create_torrent};
use mediadownloader::app::{App, AppOptions};
use mediadownloader::downloads::AddDownload;
use mediadownloader::downloads::engine::Engine;
use mediadownloader::paths::Paths;
use mediadownloader::protocol::{DownloadStatus, PostDownloadAction};

async fn start_app(paths: &Paths) -> Arc<App> {
    let engine = Arc::new(Engine::start(paths).await.unwrap());
    let app = App::new(AppOptions { paths: paths.clone(), engine: Some(engine), providers: Vec::new(), legacy_database: None })
        .unwrap();
    app.settings.update(|s| s.post_download_action = PostDownloadAction::KeepSeeding);
    app.start();
    app
}

async fn wait_for(app: &App, id: i64, status: DownloadStatus) {
    for _ in 0..300 {
        if app.downloads.get(id).unwrap().status == status {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("download {id} never reached {status:?}: {:?}", app.downloads.get(id).unwrap());
}

/// A finished 3 MiB file in `folder`, with its .torrent cached so the manager needs no peers for
/// metadata. Returns the info hash.
async fn seed_file(folder: &Path, paths: &Paths) -> String {
    std::fs::create_dir_all(folder).unwrap();
    let file = folder.join("episode.mkv");
    std::fs::write(&file, (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect::<Vec<u8>>()).unwrap();
    let torrent = create_torrent(&file, CreateTorrentOptions::default(), &BlockingSpawner::new(2)).await.unwrap();
    let hash = torrent.info_hash().as_string();
    std::fs::create_dir_all(&paths.torrent_files).unwrap();
    std::fs::write(paths.torrent_files.join(format!("{hash}.torrent")), torrent.as_bytes().unwrap()).unwrap();
    hash
}

#[tokio::test(flavor = "multi_thread")]
async fn an_update_pauses_downloads_and_the_next_start_resumes_only_those() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("Downloads");
    let paths = Paths::new(dir.path().join("data")).unwrap();
    let hash = seed_file(&folder, &paths).await;
    let bitv = paths.torrent_session.join(format!("{hash}.bitv"));

    let app = start_app(&paths).await;
    let added = app
        .downloads
        .add(AddDownload {
            name: String::new(),
            magnet_uri: format!("magnet:?xt=urn:btih:{hash}"),
            source: "Magnet".into(),
            series_task_id: None,
            save_folder: Some(folder.display().to_string()),
        })
        .unwrap();
    wait_for(&app, added.id, DownloadStatus::Seeding).await;
    assert!(bitv.exists(), "the engine saves the pieces it verified");

    app.downloads.pause_for_update().await;
    assert_eq!(app.downloads.get(added.id).unwrap().status, DownloadStatus::Paused);
    app.stop().await;

    // The new version resumes what the update paused.
    let app = start_app(&paths).await;
    wait_for(&app, added.id, DownloadStatus::Seeding).await;

    // One the user paused is not resumed; being finished, it counts as completed and the engine
    // lets go of it, leaving the file.
    app.downloads.pause(added.id).await.unwrap();
    assert!(bitv.exists(), "a paused torrent keeps its saved pieces");
    app.stop().await;
    let app = start_app(&paths).await;
    wait_for(&app, added.id, DownloadStatus::Completed).await;
    for _ in 0..100 {
        if !bitv.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!bitv.exists());
    app.downloads.delete(added.id, false).await.unwrap();
    assert!(folder.join("episode.mkv").exists());
    app.stop().await;
}
