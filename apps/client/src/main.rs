// A GUI app on Windows: no console window behind the notification-area icon.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::sync::Arc;
use std::time::Duration;

use mediadownloader::app::{App, AppOptions};
use mediadownloader::config::{DEFAULT_PORT, IS_DEV, VERSION};
use mediadownloader::http::server;
use mediadownloader::instance::{self, Acquired};
use mediadownloader::paths::Paths;
use mediadownloader::system::handlers::OpenTarget;
use mediadownloader::system::{open_in_browser, process_alive};

/// After a self-update the new executable waits for the old one to exit.
fn wait_for_previous_process() {
    let Some(pid) = std::env::var("MD_WAIT_FOR_PID").ok().and_then(|p| p.parse::<u32>().ok()) else { return };
    for _ in 0..120 {
        if !process_alive(pid) {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Ctrl-C, or SIGTERM from a service manager or `kill`.
async fn termination() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

fn main() -> anyhow::Result<()> {
    wait_for_previous_process();
    let paths = Paths::from_environment()?;
    mediadownloader::log::init(Some(paths.logs.clone()), *IS_DEV);
    tracing::info!("MediaDownloader {VERSION} starting (data: {})", paths.data_dir.display());

    // Opened for a magnet link or a .torrent file (Windows and Linux pass it as an argument).
    let opened = OpenTarget::from_args(std::env::args());
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let handle = runtime.handle().clone();
    let (app, server, lock) = runtime.block_on(async {
        let lock = match instance::acquire(paths.lock.clone()).await {
            Acquired::Owner(lock) => lock,
            Acquired::Running(dashboard_url) => {
                // Already running: show that instance's dashboard instead of starting a second engine.
                open_in_browser(&opened.as_ref().map_or_else(|| dashboard_url.clone(), |o| o.dashboard_link(&dashboard_url)));
                tracing::info!("Another instance is running; opened its dashboard");
                std::process::exit(0);
            }
        };
        let app = App::new(AppOptions::production(paths.clone()))?;
        mediadownloader::telemetry::start(app.settings.clone(), app.http.clone());
        app.start();
        let port = std::env::var("MD_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
        let server = Arc::new(server::start(app.clone(), port).await?);
        anyhow::Ok((app, server, Arc::new(lock)))
    })?;
    let dashboard_url = format!("http://localhost:{}", server.port);
    app.agent.publish(&dashboard_url);
    lock.publish(&dashboard_url);
    if let Some(opened) = &opened {
        open_in_browser(&opened.dashboard_link(&dashboard_url));
    }

    // Stops the server and the app, and releases the lock; exiting is up to the caller.
    let shutdown = {
        let (app, server, lock) = (app.clone(), server.clone(), lock.clone());
        move || {
            let (app, server, lock) = (app.clone(), server.clone(), lock.clone());
            async move {
                tracing::info!("Shutting down");
                server.stop();
                app.stop().await;
                lock.release();
            }
        }
    };
    let quit_for_install = shutdown.clone();
    let _ = app.updates.on_quit.set(Box::new(move || Box::pin(quit_for_install())));

    let signal_shutdown = shutdown.clone();
    handle.spawn(async move {
        termination().await;
        signal_shutdown().await;
        std::process::exit(0);
    });

    let tray_enabled = std::env::var("MD_NO_TRAY").as_deref() != Ok("1") && !*IS_DEV;
    #[cfg(any(target_os = "macos", windows))]
    if tray_enabled {
        let (quit_handle, quit_shutdown) = (handle.clone(), shutdown.clone());
        let quit: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            quit_handle.block_on(quit_shutdown());
            std::process::exit(0);
        });
        mediadownloader::tray::run(app, dashboard_url, handle, quit);
    }
    if (!tray_enabled || cfg!(not(any(target_os = "macos", windows))))
        && !*IS_DEV
        && std::env::var("MD_NO_BROWSER").as_deref() != Ok("1")
    {
        open_in_browser(&dashboard_url);
    }
    runtime.block_on(std::future::pending::<()>());
    Ok(())
}
