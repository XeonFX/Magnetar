//! The menu-bar (macOS) or notification-area (Windows) icon. Its menu shows active downloads,
//! remote access and update state, and is rebuilt while the app runs.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::app::App;
use crate::config::VERSION;
use crate::protocol::bytes::format_rate;
use crate::protocol::{DownloadDto, DownloadStatus};
use crate::system::handlers::OpenTarget;
use crate::system::open_in_browser;

const REFRESH: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Command {
    Dashboard,
    RemoteDashboard,
    InstallUpdate,
    CheckForUpdates,
    Quit,
}

#[derive(Clone, PartialEq, Eq, Debug)]
enum Entry {
    Label(String),
    Separator,
    Command(String, Command),
}

fn truncate(name: &str, max: usize) -> String {
    if name.chars().count() > max { format!("{}…", name.chars().take(max - 1).collect::<String>()) } else { name.to_owned() }
}

/// Rows of the menu, rebuilt from the app's current state.
fn entries(app: &App, dashboard_url: &str, active: &[DownloadDto]) -> Vec<Entry> {
    let mut entries = Vec::new();
    if active.is_empty() {
        entries.push(Entry::Label("No active downloads".into()));
    } else {
        for d in active {
            let name = truncate(&d.name, 44);
            entries.push(Entry::Label(match d.status {
                DownloadStatus::FetchingMetadata => format!("{name} — fetching metadata…"),
                DownloadStatus::Seeding => format!("{name} — ↑ {} (seeding)", format_rate(d.upload_speed as f64)),
                _ => format!("{name} — ↓ {}  {}%", format_rate(d.download_speed as f64), d.progress.round()),
            }));
        }
        entries.push(Entry::Separator);
        let total: u64 = active.iter().map(|d| d.download_speed).sum();
        entries.push(Entry::Label(format!("Total ↓ {}", format_rate(total as f64))));
    }

    entries.push(Entry::Separator);
    let host = dashboard_url.trim_start_matches("http://");
    entries.push(Entry::Command(format!("Dashboard — {host}"), Command::Dashboard));
    if let Some((connected, account_email)) = app.remote.link() {
        entries.push(Entry::Label(if connected {
            format!("Remote access: {}", account_email.as_deref().unwrap_or("connected"))
        } else {
            "Remote access: reconnecting…".into()
        }));
        entries.push(Entry::Command("Open remote dashboard".into(), Command::RemoteDashboard));
    }

    entries.push(Entry::Separator);
    let updates = app.updates.status();
    if updates.installing {
        entries.push(Entry::Label(format!("Magnetar v{VERSION}")));
        entries.push(Entry::Label("Installing update…".into()));
    } else if let Some(available) = &updates.available {
        entries.push(Entry::Label(format!("Magnetar v{VERSION} — {} available", available.tag)));
        let how = if updates.can_self_install { "(restarts the app)" } else { "(opens release page)" };
        entries.push(Entry::Command(format!("Update to {} {how}", available.tag), Command::InstallUpdate));
    } else {
        let suffix = if updates.last_check_error.is_some() {
            " — update check failed".to_owned()
        } else if let Some(checked) = updates.last_checked_at.as_deref().and_then(crate::protocol::encoding::parse_iso) {
            format!(" — up to date, checked {}", checked.with_timezone(&chrono::Local).format("%H:%M"))
        } else {
            String::new()
        };
        entries.push(Entry::Label(format!("Magnetar v{VERSION}{suffix}")));
        entries.push(if updates.checking {
            Entry::Label("Checking for updates…".into())
        } else {
            Entry::Command("Check for Updates…".into(), Command::CheckForUpdates)
        });
    }
    entries.push(Entry::Separator);
    entries.push(Entry::Command("Quit Magnetar".into(), Command::Quit));
    entries
}

/// Total download rate for the menu-bar title, or '' when idle.
fn speed_text(active: &[DownloadDto]) -> String {
    let total: u64 = active.iter().filter(|d| d.status != DownloadStatus::Seeding).map(|d| d.download_speed).sum();
    if total > 0 { format_rate(total as f64) } else { String::new() }
}

fn build_menu(entries: &[Entry]) -> (Menu, HashMap<MenuId, Command>) {
    let menu = Menu::new();
    let mut commands = HashMap::new();
    for entry in entries {
        let appended = match entry {
            Entry::Label(text) => menu.append(&MenuItem::new(text, false, None)),
            Entry::Separator => menu.append(&PredefinedMenuItem::separator()),
            Entry::Command(text, command) => {
                let item = MenuItem::new(text, true, None);
                commands.insert(item.id().clone(), *command);
                menu.append(&item)
            }
        };
        if let Err(error) = appended {
            tracing::warn!("Could not add a tray menu row: {error}");
        }
    }
    (menu, commands)
}

fn icon() -> anyhow::Result<Icon> {
    #[cfg(windows)]
    return Ok(Icon::from_resource(1, None)?);
    #[cfg(not(windows))]
    {
        let decoder = png::Decoder::new(std::io::Cursor::new(include_bytes!("../assets/MenuBarIcon@2x.png")));
        let mut reader = decoder.read_info()?;
        let mut rgba = vec![0; reader.output_buffer_size().unwrap_or_default()];
        let frame = reader.next_frame(&mut rgba)?;
        anyhow::ensure!(frame.color_type == png::ColorType::Rgba, "The menu-bar icon must be RGBA");
        rgba.truncate(frame.buffer_size());
        Ok(Icon::from_rgba(rgba, frame.width, frame.height)?)
    }
}

/// Runs the icon's event loop on the main thread until the app quits. `quit` stops the app and
/// exits the process.
pub fn run(app: Arc<App>, dashboard_url: String, runtime: tokio::runtime::Handle, quit: Arc<dyn Fn() + Send + Sync>) -> ! {
    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::new().build();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        // A menu-bar agent: no Dock icon.
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }
    let mut tray: Option<TrayIcon> = None;
    let mut shown: Vec<Entry> = Vec::new();
    let mut commands: HashMap<MenuId, Command> = HashMap::new();
    let mut title = String::new();
    let mut next_refresh = Instant::now();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250));
        // The icon must be created once the event loop is running (macOS).
        if matches!(event, Event::NewEvents(StartCause::Init)) && tray.is_none() {
            let built = icon().and_then(|icon| {
                Ok(TrayIconBuilder::new()
                    .with_icon(icon)
                    .with_icon_as_template(cfg!(target_os = "macos"))
                    .with_tooltip("Magnetar")
                    .with_menu_on_left_click(cfg!(target_os = "macos"))
                    .build()?)
            });
            match built {
                Ok(icon) => {
                    tracing::info!("{} icon ready", if cfg!(windows) { "Notification-area" } else { "Menu-bar" });
                    tray = Some(icon);
                }
                Err(error) => {
                    tracing::error!("Could not start the tray icon; opening the dashboard instead: {error:#}");
                    open_in_browser(&dashboard_url);
                }
            }
        }
        // macOS hands over magnet links and .torrent files as URLs, at launch and while running.
        if let Event::Opened { urls } = &event {
            for url in urls {
                if let Some(target) = OpenTarget::parse(url.as_str()) {
                    open_in_browser(&target.dashboard_link(&dashboard_url));
                }
            }
        }
        let Some(tray) = tray.as_ref() else { return };

        while let Ok(event) = MenuEvent::receiver().try_recv() {
            let Some(command) = commands.get(event.id()).copied() else { continue };
            match command {
                Command::Dashboard => open_in_browser(&dashboard_url),
                Command::RemoteDashboard => open_in_browser(&app.remote.status().cloud_url),
                Command::CheckForUpdates => {
                    let app = app.clone();
                    runtime.spawn(async move { app.updates.check().await });
                }
                Command::InstallUpdate => {
                    let app = app.clone();
                    runtime.spawn(async move {
                        if let Some(page) = app.updates.install().await {
                            open_in_browser(&page);
                        }
                    });
                }
                Command::Quit => quit(),
            }
            next_refresh = Instant::now();
        }
        // Windows: a left click opens the dashboard; the menu is on the right button.
        while let Ok(event) = TrayIconEvent::receiver().try_recv() {
            if cfg!(windows)
                && let TrayIconEvent::Click {
                    button: tray_icon::MouseButton::Left,
                    button_state: tray_icon::MouseButtonState::Up,
                    ..
                } = event
            {
                open_in_browser(&dashboard_url);
            }
        }

        if Instant::now() >= next_refresh {
            next_refresh = Instant::now() + REFRESH;
            let active = app.downloads.active();
            let current = entries(&app, &dashboard_url, &active);
            if current != shown {
                let (menu, ids) = build_menu(&current);
                tray.set_menu(Some(Box::new(menu)));
                commands = ids;
                shown = current;
            }
            let speed = speed_text(&active);
            if cfg!(target_os = "macos") && speed != title {
                tray.set_title(Some(&speed));
                title = speed;
            }
        }
    })
}
