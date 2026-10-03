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

/// Engine calls return within seconds; one that doesn't fails the test, naming the call, instead
/// of hanging it.
macro_rules! bounded {
    ($call:expr) => {
        tokio::time::timeout(Duration::from_secs(30), $call)
            .await
            .unwrap_or_else(|_| panic!("{} never returned", stringify!($call)))
    };
}

async fn start_app(paths: &Paths) -> Arc<App> {
    start_app_and_engine(paths).await.0
}

async fn start_app_and_engine(paths: &Paths) -> (Arc<App>, Arc<Engine>) {
    let engine = Arc::new(Engine::start(paths, &NetworkOptions::default(), SpeedLimits::default()).await.unwrap());
    let app = App::new(AppOptions {
        paths: paths.clone(),
        engine: EngineSource::Fixed(engine.clone()),
        providers: Vec::new(),
        legacy_database: None,
        show_lookups: false,
    })
    .unwrap();
    app.settings.update(|s| s.post_download_action = PostDownloadAction::KeepSeeding).unwrap();
    app.start();
    (app, engine)
}

fn magnet(hash: &str, folder: &Path) -> AddDownload {
    AddDownload {
        name: String::new(),
        magnet_uri: format!("magnet:?xt=urn:btih:{hash}"),
        source: "Magnet".into(),
        series_task_id: None,
        episode: None,
        save_folder: Some(folder.display().to_string()),
    }
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
    let torrent = bounded!(create_torrent(&file, CreateTorrentOptions::default(), &BlockingSpawner::new(2))).unwrap();
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
    let torrent = bounded!(create_torrent(&pack, options, &BlockingSpawner::new(2))).unwrap();

    let app = bounded!(start_app(&paths));
    let added = app
        .downloads
        .add_torrent_file(torrent.as_bytes().unwrap().to_vec(), "Torrent file", Some(folder.display().to_string()))
        .unwrap();
    assert_eq!(added.name, "Show S01");
    wait_for(&app, added.id, DownloadStatus::Seeding).await;

    let files = app.downloads.files(added.id).unwrap();
    // The torrent lists the folder in the order the file system gave it, so find each file by name.
    let episode = files.iter().position(|f| f.path == "e01.mkv").expect("the episode is in the torrent");
    let sub = 1 - episode;
    let mut names: Vec<(&str, Option<&str>, bool)> = files.iter().map(|f| (f.path.as_str(), f.media, f.done == f.size)).collect();
    names.sort();
    assert_eq!(names, [("e01.mkv", Some("video"), true), ("e01.srt", None, true)]);
    assert!(files.iter().all(|f| f.selected));

    // Finish it, so trimming and widening the choice can be seen not to restart it.
    bounded!(app.downloads.pause(added.id)).unwrap();
    bounded!(app.stop());
    let app = bounded!(start_app(&paths));
    wait_for(&app, added.id, DownloadStatus::Completed).await;
    let partial = bounded!(app.downloads.select_files(added.id, vec![episode, episode])).unwrap();
    assert_eq!(partial.partial_files.map(|p| (p.selected, p.total)), Some((1, 2)));
    assert_eq!((partial.status, partial.total_bytes), (DownloadStatus::Completed, 600_000), "nothing new to fetch");
    assert!(!app.downloads.files(added.id).unwrap()[sub].selected);
    assert!(bounded!(app.downloads.select_files(added.id, vec![])).is_err(), "at least one file");
    assert!(bounded!(app.downloads.select_files(added.id, vec![2])).is_err(), "no such file");
    let all = bounded!(app.downloads.select_files(added.id, vec![sub, episode])).unwrap();
    assert_eq!(all.partial_files, None, "every file chosen is not partial");
    assert_eq!(all.status, DownloadStatus::Completed, "the subtitle is already on disk");
    // Straight after a start, while the engine may still hold the torrent it restored (see `Engine::handle`).
    std::fs::remove_file(pack.join("e01.srt")).unwrap();
    bounded!(app.downloads.select_files(added.id, vec![episode])).unwrap();
    assert_eq!(app.downloads.files(added.id).unwrap()[sub].done, 0, "a left-out file that is gone has nothing");
    let widened = bounded!(app.downloads.select_files(added.id, vec![episode, sub])).unwrap();
    assert_ne!(widened.status, DownloadStatus::Completed, "a newly chosen missing file is fetched");
    // Nobody seeds the subtitle, so it waits for peers, in the engine.
    let subtitle_file = async {
        for _ in 0..300 {
            if let Ok(file) = app.downloads.open_file(added.id, sub) {
                return file;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the subtitle never became playable from the engine");
    };
    let file = subtitle_file.await;
    assert_eq!((file.name.as_str(), file.size), ("e01.srt", subtitle.len() as u64));
    assert!(matches!(file.source, FileSource::Engine(_, index) if index == sub));
    // Once the engine has checked what is on disk, the episode counts and the subtitle doesn't.
    let mut running = app.downloads.files(added.id).unwrap();
    for _ in 0..300 {
        if running[episode].done > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        running = app.downloads.files(added.id).unwrap();
    }
    // All but the piece it shares with the subtitle: its last piece when it comes first, its first
    // piece (64 KiB less the subtitle) when the subtitle comes first.
    let shared = if episode == 0 { 600_000 - 9 * 64 * 1024 } else { 64 * 1024 - subtitle.len() as u64 };
    assert_eq!(running[episode].done, 600_000 - shared, "all but the piece it shares with the subtitle");
    assert_eq!(running[sub].done, 0);
    assert_eq!(std::fs::metadata(pack.join("e01.srt")).unwrap().len(), subtitle.len() as u64, "made full length");
    let file = app.downloads.open_file(added.id, sub).unwrap();
    assert!(matches!(file.source, FileSource::Engine(_, index) if index == sub), "but not read from disk: it holds nothing yet");
    assert_eq!(app.downloads.location(added.id).unwrap(), pack);

    // Paused across a restart, what each file has comes from the pieces the engine saved.
    bounded!(app.downloads.pause(added.id)).unwrap();
    bounded!(app.stop());
    let app = bounded!(start_app(&paths));
    let paused = app.downloads.files(added.id).unwrap();
    assert_eq!(paused.iter().map(|f| f.done).collect::<Vec<_>>(), running.iter().map(|f| f.done).collect::<Vec<_>>());
    let refused = app.downloads.open_file(added.id, sub).err().map(|e| e.message);
    assert_eq!(refused.as_deref(), Some("Resume the download to play what it has so far."));

    // The same torrent again is the same download.
    let again = app.downloads.add_torrent_file(torrent.as_bytes().unwrap().to_vec(), "Torrent file", None).unwrap();
    assert_eq!(again.id, added.id);
    assert!(app.downloads.add_torrent_file(b"d4:junke".to_vec(), "Torrent file", None).is_err());
    // Nested one level past what the engine's parser takes, or 100,000 levels: refused before it parses it.
    for depth in [127, 100_000] {
        let refused = app.downloads.add_torrent_file(crafted_torrent(depth), "Torrent file", None).err().map(|e| e.message);
        let expected = "That .torrent file is not usable: its data is nested more than 128 levels deep.";
        assert_eq!(refused.as_deref(), Some(expected), "{depth} deep");
    }
    assert_eq!(app.downloads.list().len(), 1);
    bounded!(app.stop());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_update_pauses_downloads_and_the_next_start_resumes_only_those() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("Downloads");
    let paths = Paths::new(dir.path().join("data")).unwrap();
    let hash = bounded!(seed_file(&folder, &paths));
    let bitv = paths.torrent_session.join(format!("{hash}.bitv"));

    let app = bounded!(start_app(&paths));
    let added = app.downloads.add(magnet(&hash, &folder)).unwrap();
    wait_for(&app, added.id, DownloadStatus::Seeding).await;
    assert!(bitv.exists(), "the engine saves the pieces it verified");

    bounded!(app.downloads.pause_for_update());
    assert_eq!(app.downloads.get(added.id).unwrap().status, DownloadStatus::Paused);
    bounded!(app.stop());

    // The new version resumes what the update paused.
    let app = bounded!(start_app(&paths));
    wait_for(&app, added.id, DownloadStatus::Seeding).await;

    // One the user paused is not resumed; being finished, it counts as completed and the engine
    // lets go of it, leaving the file.
    bounded!(app.downloads.pause(added.id)).unwrap();
    assert!(bitv.exists(), "a paused torrent keeps its saved pieces");
    bounded!(app.stop());
    let app = bounded!(start_app(&paths));
    wait_for(&app, added.id, DownloadStatus::Completed).await;
    for _ in 0..100 {
        if !bitv.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!bitv.exists());
    bounded!(app.downloads.delete(added.id, false)).unwrap();
    assert!(folder.join("episode.mkv").exists());
    bounded!(app.stop());
}

/// A double click: the resume lands while the engine still pauses the torrent, and must not take it
/// up halfway, to be left paused under a download shown as running.
#[tokio::test(flavor = "multi_thread")]
async fn a_download_resumed_while_it_pauses_runs() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("Downloads");
    let paths = Paths::new(dir.path().join("data")).unwrap();
    let hash = bounded!(seed_file(&folder, &paths));
    let (app, engine) = bounded!(start_app_and_engine(&paths));
    let added = app.downloads.add(magnet(&hash, &folder)).unwrap();
    wait_for(&app, added.id, DownloadStatus::Seeding).await;

    // join! polls in order, so the pause has handed the torrent over before the resume starts.
    let (paused, resumed) =
        bounded!(async { tokio::join!(app.downloads.pause(added.id), async { app.downloads.resume(added.id) }) });
    assert_eq!(paused.unwrap().status, DownloadStatus::Paused);
    assert_ne!(resumed.unwrap().status, DownloadStatus::Paused);
    wait_for(&app, added.id, DownloadStatus::Seeding).await;
    let torrent = engine.handle(&hash).expect("in the engine");
    assert!(!torrent.is_paused(), "seeding, not left paused");
    bounded!(app.stop());
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
    app.settings
        .update(|s| {
            s.network_interface = "magnetar-missing0".into();
            s.download_folder = dir.path().join("Downloads").display().to_string();
        })
        .unwrap();
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

    app.settings.update(|s| s.network_interface = loopback.into()).unwrap();
    wait_engine(EngineState::Running).await;
    wait_for(&app, added.id, DownloadStatus::FetchingMetadata).await;
    assert_eq!(app.downloads.transfer_status().network_interface.as_deref(), Some(loopback));

    app.settings.update(|s| s.network_interface = "magnetar-missing0".into()).unwrap();
    wait_engine(EngineState::WaitingForNetwork).await;
    wait_for(&app, added.id, DownloadStatus::Queued).await;
    bounded!(app.stop());
}

#[tokio::test(flavor = "multi_thread")]
async fn pause_all_and_resume_all_touch_only_what_they_should() {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::new(dir.path().join("data")).unwrap();
    let app = bounded!(start_app(&paths));
    let mut ids = Vec::new();
    for (offset, name) in ["One", "Two"].into_iter().enumerate() {
        let folder = dir.path().join(name);
        let hash = bounded!(seed_distinct_file(&folder, &paths, offset as u32));
        let added = app.downloads.add(magnet(&hash, &folder)).unwrap();
        wait_for(&app, added.id, DownloadStatus::Seeding).await;
        ids.push(added.id);
    }
    assert_ne!(ids[0], ids[1]);

    assert_eq!(bounded!(app.actions.pause_all()), 2);
    for &id in &ids {
        assert_eq!(app.downloads.get(id).unwrap().status, DownloadStatus::Paused);
    }
    assert_eq!(bounded!(app.actions.pause_all()), 0, "nothing left running");

    assert_eq!(app.actions.resume_all(), 2);
    for &id in &ids {
        wait_for(&app, id, DownloadStatus::Seeding).await;
    }
    assert_eq!(app.actions.resume_all(), 0, "nothing left stopped");
    bounded!(app.stop());
}

/// A torrent whose info dictionary nests `depth` lists under a key nobody reads: what crashed the
/// engine's parser, a few hundred kilobytes of it.
fn crafted_torrent(depth: usize) -> Vec<u8> {
    let info = [b"d6:lengthi1e4:name7:crafted12:piece lengthi16384e6:pieces20:".to_vec(), vec![0; 20]].concat();
    [b"d4:info".to_vec(), info, b"3:zzz".to_vec(), vec![b'l'; depth], vec![b'e'; depth], b"ee".to_vec()].concat()
}

/// A crafted torrent the engine had saved and the download list still has queued: the next start
/// drops it with the reason before anything parses it, and runs the rest.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tokio::test(flavor = "multi_thread")]
async fn a_crafted_torrent_left_queued_is_dropped_on_start_with_the_reason() {
    use magnetar::protocol::EngineState;
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("Downloads");
    let paths = Paths::new(dir.path().join("data")).unwrap();
    let options =
        |engine| AppOptions { paths: paths.clone(), engine, providers: Vec::new(), legacy_database: None, show_lookups: false };
    let fine = bounded!(seed_file(&folder, &paths));
    let crafted = "0123456789abcdef0123456789abcdef01234567";
    let (fine_id, crafted_id) = {
        let app = App::new(options(EngineSource::Off)).unwrap();
        // Loopback only: nothing of this test leaves the machine.
        let loopback = if cfg!(target_os = "macos") { "lo0" } else { "lo" };
        app.settings.update(|s| s.network_interface = loopback.into()).unwrap();
        app.start();
        let fine = app.downloads.add(magnet(&fine, &folder)).unwrap().id;
        let crafted = app.downloads.add(magnet(crafted, &folder)).unwrap().id;
        bounded!(app.stop());
        (fine, crafted)
    };
    let bytes = crafted_torrent(100_000);
    std::fs::create_dir_all(&paths.torrent_session).unwrap();
    let saved =
        [paths.torrent_files.join(format!("{crafted}.torrent")), paths.torrent_session.join(format!("{crafted}.torrent"))];
    for file in &saved {
        std::fs::write(file, &bytes).unwrap();
    }
    let bitv = paths.torrent_session.join(format!("{crafted}.bitv"));
    std::fs::write(&bitv, [0]).unwrap();
    let list = serde_json::json!({ "torrents": { "0": {
        "info_hash": crafted, "trackers": [], "output_folder": folder, "only_files": null, "is_paused": false
    } } });
    std::fs::write(paths.torrent_session.join("session.json"), list.to_string()).unwrap();

    let app = App::new(options(EngineSource::Managed(paths.clone()))).unwrap();
    app.start();
    let failed = app.downloads.get(crafted_id).unwrap();
    assert_eq!(failed.status, DownloadStatus::Error);
    assert_eq!(failed.error.as_deref(), Some("This torrent can't be used: its data is nested more than 128 levels deep."));
    for gone in saved.iter().chain([&bitv]) {
        assert!(!gone.exists(), "{} is left", gone.display());
    }
    let list = std::fs::read_to_string(paths.torrent_session.join("session.json")).unwrap();
    assert!(!list.contains(crafted), "the engine's list still has it: {list}");

    for _ in 0..200 {
        if app.downloads.transfer_status().engine == EngineState::Running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(app.downloads.transfer_status().engine, EngineState::Running);
    wait_for(&app, fine_id, DownloadStatus::Completed).await;
    assert_eq!(app.downloads.get(crafted_id).unwrap().status, DownloadStatus::Error, "it stays out of the engine");
    bounded!(app.stop());
}
