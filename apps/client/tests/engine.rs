//! The download manager on a real torrent engine. A local file stands in for a finished download, so
//! nothing needs peers.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use librqbit::spawn_utils::BlockingSpawner;
use librqbit::{CreateTorrentOptions, create_torrent};
use magnetar::app::{App, AppOptions};
use magnetar::downloads::AddDownload;
use magnetar::downloads::engine::{Engine, NetworkOptions, SpeedLimits};
use magnetar::downloads::manager::{EngineSource, FileSource};
use magnetar::paths::Paths;
use magnetar::protocol::{DownloadStatus, PostDownloadAction};

async fn start_app(paths: &Paths) -> Arc<App> {
    let engine = Arc::new(Engine::start(paths, &NetworkOptions::default(), SpeedLimits::default()).await.unwrap());
    let app = App::new(AppOptions {
        paths: paths.clone(),
        engine: EngineSource::Fixed(engine),
        providers: Vec::new(),
        legacy_database: None,
        show_lookups: false,
    })
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
    seed_distinct_file(folder, paths, 0).await
}

/// Like `seed_file`, with contents shifted by `offset` so each offset is a different torrent.
async fn seed_distinct_file(folder: &Path, paths: &Paths, offset: u32) -> String {
    std::fs::create_dir_all(folder).unwrap();
    let file = folder.join("episode.mkv");
    std::fs::write(&file, (0..3 * 1024 * 1024u32).map(|i| ((i + offset) % 251) as u8).collect::<Vec<u8>>()).unwrap();
    let torrent = create_torrent(&file, CreateTorrentOptions::default(), &BlockingSpawner::new(2)).await.unwrap();
    let hash = torrent.info_hash().as_string();
    std::fs::create_dir_all(&paths.torrent_files).unwrap();
    std::fs::write(paths.torrent_files.join(format!("{hash}.torrent")), torrent.as_bytes().unwrap()).unwrap();
    hash
}

#[tokio::test(flavor = "multi_thread")]
async fn a_torrent_file_starts_at_once_and_its_files_can_be_chosen() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("Downloads");
    let paths = Paths::new(dir.path().join("data")).unwrap();
    let pack = folder.join("Show S01");
    std::fs::create_dir_all(&pack).unwrap();
    std::fs::write(pack.join("e01.mkv"), vec![7u8; 600_000]).unwrap();
    let subtitle = b"1\n00:00:01,000 --> 00:00:02,000\nHello\n";
    std::fs::write(pack.join("e01.srt"), subtitle).unwrap();
    // Small pieces, so the episode has whole pieces of its own besides the one it shares.
    let options = CreateTorrentOptions {
        trackers: vec!["udp://tracker.example:1337/announce".into()],
        piece_length: Some(64 * 1024),
        ..Default::default()
    };
    let torrent = create_torrent(&pack, options, &BlockingSpawner::new(2)).await.unwrap();

    let app = start_app(&paths).await;
    let added = app
        .downloads
        .add_torrent_file(torrent.as_bytes().unwrap().to_vec(), "Torrent file", Some(folder.display().to_string()))
        .unwrap();
    assert_eq!(added.name, "Show S01");
    wait_for(&app, added.id, DownloadStatus::Seeding).await;

    let files = app.downloads.files(added.id).unwrap();
    let names: Vec<(&str, Option<&str>, bool)> = files.iter().map(|f| (f.path.as_str(), f.media, f.done == f.size)).collect();
    assert_eq!(names, [("e01.mkv", Some("video"), true), ("e01.srt", None, true)]);
    assert!(files.iter().all(|f| f.selected));

    // Finish it, so trimming and widening the choice can be seen not to restart it.
    app.downloads.pause(added.id).await.unwrap();
    app.stop().await;
    let app = start_app(&paths).await;
    wait_for(&app, added.id, DownloadStatus::Completed).await;
    let partial = app.downloads.select_files(added.id, vec![0, 0]).await.unwrap();
    assert_eq!(partial.partial_files.map(|p| (p.selected, p.total)), Some((1, 2)));
    assert_eq!((partial.status, partial.total_bytes), (DownloadStatus::Completed, 600_000), "nothing new to fetch");
    assert!(!app.downloads.files(added.id).unwrap()[1].selected);
    assert!(app.downloads.select_files(added.id, vec![]).await.is_err(), "at least one file");
    assert!(app.downloads.select_files(added.id, vec![2]).await.is_err(), "no such file");
    let all = app.downloads.select_files(added.id, vec![1, 0]).await.unwrap();
    assert_eq!(all.partial_files, None, "every file chosen is not partial");
    assert_eq!(all.status, DownloadStatus::Completed, "the subtitle is already on disk");
    std::fs::remove_file(pack.join("e01.srt")).unwrap();
    app.downloads.select_files(added.id, vec![0]).await.unwrap();
    let widened = app.downloads.select_files(added.id, vec![0, 1]).await.unwrap();
    assert_ne!(widened.status, DownloadStatus::Completed, "a newly chosen missing file is fetched");
    // Nobody seeds the subtitle, so it waits for peers, in the engine.
    let subtitle_file = async {
        for _ in 0..300 {
            if let Ok(file) = app.downloads.open_file(added.id, 1) {
                return file;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the subtitle never became playable from the engine");
    };
    let file = subtitle_file.await;
    assert_eq!((file.name.as_str(), file.size), ("e01.srt", subtitle.len() as u64));
    assert!(matches!(file.source, FileSource::Engine(_, 1)));
    // Once the engine has checked what is on disk, the episode counts and the subtitle doesn't.
    let mut running = app.downloads.files(added.id).unwrap();
    for _ in 0..300 {
        if running[0].done > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        running = app.downloads.files(added.id).unwrap();
    }
    assert_eq!(running[0].done, 9 * 64 * 1024, "all but the piece it shares with the subtitle");
    assert_eq!(running[1].done, 0);
    assert_eq!(std::fs::metadata(pack.join("e01.srt")).unwrap().len(), subtitle.len() as u64, "made full length");
    let file = app.downloads.open_file(added.id, 1).unwrap();
    assert!(matches!(file.source, FileSource::Engine(_, 1)), "but not read from disk: it holds nothing yet");
    assert_eq!(app.downloads.location(added.id).unwrap(), pack);

    // Paused across a restart, what each file has comes from the pieces the engine saved.
    app.downloads.pause(added.id).await.unwrap();
    app.stop().await;
    let app = start_app(&paths).await;
    let paused = app.downloads.files(added.id).unwrap();
    assert_eq!(paused.iter().map(|f| f.done).collect::<Vec<_>>(), running.iter().map(|f| f.done).collect::<Vec<_>>());
    let refused = app.downloads.open_file(added.id, 1).err().map(|e| e.message);
    assert_eq!(refused.as_deref(), Some("Resume the download to play what it has so far."));

    // The same torrent again is the same download.
    let again = app.downloads.add_torrent_file(torrent.as_bytes().unwrap().to_vec(), "Torrent file", None).unwrap();
    assert_eq!(again.id, added.id);
    assert!(app.downloads.add_torrent_file(b"d4:junke".to_vec(), "Torrent file", None).is_err());
    app.stop().await;
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
            episode: None,
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

/// The kill switch: with an interface chosen, nothing runs until it exists, and everything stops
/// when it goes away.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tokio::test(flavor = "multi_thread")]
async fn downloads_wait_for_the_chosen_interface_and_stop_without_it() {
    use magnetar::protocol::EngineState;
    let loopback = if cfg!(target_os = "macos") { "lo0" } else { "lo" };
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::new(dir.path().join("data")).unwrap();
    let app = App::new(AppOptions {
        paths: paths.clone(),
        engine: EngineSource::Managed(paths.clone()),
        providers: Vec::new(),
        legacy_database: None,
        show_lookups: false,
    })
    .unwrap();
    app.settings.update(|s| {
        s.network_interface = "magnetar-missing0".into();
        s.download_folder = dir.path().join("Downloads").display().to_string();
    });
    app.start();
    let wait_engine = |state: EngineState| {
        let app = app.clone();
        async move {
            for _ in 0..200 {
                if app.downloads.transfer_status().engine == state {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("engine never reached {state:?}: {:?}", app.downloads.transfer_status());
        }
    };
    wait_engine(EngineState::WaitingForNetwork).await;
    let magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Nobody+seeds+this";
    let added = app
        .downloads
        .add(AddDownload {
            name: String::new(),
            magnet_uri: magnet.into(),
            source: "Magnet".into(),
            series_task_id: None,
            episode: None,
            save_folder: None,
        })
        .unwrap();
    assert_eq!(added.status, DownloadStatus::Queued, "no engine, no traffic");

    app.settings.update(|s| s.network_interface = loopback.into());
    wait_engine(EngineState::Running).await;
    wait_for(&app, added.id, DownloadStatus::FetchingMetadata).await;
    assert_eq!(app.downloads.transfer_status().network_interface.as_deref(), Some(loopback));

    app.settings.update(|s| s.network_interface = "magnetar-missing0".into());
    wait_engine(EngineState::WaitingForNetwork).await;
    wait_for(&app, added.id, DownloadStatus::Queued).await;
    app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pause_all_and_resume_all_touch_only_what_they_should() {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::new(dir.path().join("data")).unwrap();
    let app = start_app(&paths).await;
    let mut ids = Vec::new();
    for (offset, name) in ["One", "Two"].into_iter().enumerate() {
        let folder = dir.path().join(name);
        let hash = seed_distinct_file(&folder, &paths, offset as u32).await;
        let added = app
            .downloads
            .add(AddDownload {
                name: String::new(),
                magnet_uri: format!("magnet:?xt=urn:btih:{hash}"),
                source: "Magnet".into(),
                series_task_id: None,
                episode: None,
                save_folder: Some(folder.display().to_string()),
            })
            .unwrap();
        wait_for(&app, added.id, DownloadStatus::Seeding).await;
        ids.push(added.id);
    }
    assert_ne!(ids[0], ids[1]);

    assert_eq!(app.actions.pause_all().await, 2);
    for &id in &ids {
        assert_eq!(app.downloads.get(id).unwrap().status, DownloadStatus::Paused);
    }
    assert_eq!(app.actions.pause_all().await, 0, "nothing left running");

    assert_eq!(app.actions.resume_all(), 2);
    for &id in &ids {
        wait_for(&app, id, DownloadStatus::Seeding).await;
    }
    assert_eq!(app.actions.resume_all(), 0, "nothing left stopped");
    app.stop().await;
}
