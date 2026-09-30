//! The menu-bar (macOS) or notification-area (Windows) icon. Its menu shows what is transferring,
//! each unfinished download with its own controls, speed limits, a few settings, remote access and
//! update state. The menu is described as rows (`rows`) from a snapshot of the app; while their
//! shape stays the same, the native items are updated in place, so an open menu keeps ticking.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::app::App;
use crate::config::VERSION;
use crate::protocol::bytes::{format_bytes, format_rate};
use crate::protocol::{
    AltSpeedMode, DownloadDto, DownloadStatus, EngineState, LoginStartupStatus, TransferStatusDto, UpdateStatusDto,
};
use crate::settings::AppSettings;
use crate::system::handlers::OpenTarget;
use crate::system::{login_startup, open_in_browser, open_with_system, reveal_in_file_manager};

const REFRESH: Duration = Duration::from_secs(1);
/// Reading Open at Login runs `launchctl` on macOS, so it is read now and then, and after a change.
const LOGIN_REFRESH: Duration = Duration::from_secs(30);
/// Downloads listed by name; the rest are one "Show All" away.
const MAX_LISTED: usize = 8;
const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;
const DOWNLOAD_PRESETS: [u64; 7] = [0, MIB, 2 * MIB, 5 * MIB, 10 * MIB, 20 * MIB, 50 * MIB];
const UPLOAD_PRESETS: [u64; 6] = [0, 256 * KIB, 512 * KIB, MIB, 2 * MIB, 5 * MIB];

/// What a menu row does. Toggles decide at click time, so a row's command never changes with state.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Command {
    OpenDashboard,
    /// The dashboard's settings, at a section when given.
    OpenSettings(Option<&'static str>),
    OpenRemoteDashboard,
    OpenDownloadsFolder,
    TogglePause(i64),
    Reveal(i64),
    PauseAll,
    ResumeAll,
    SlowMode(AltSpeedMode),
    DownloadLimit(u64),
    UploadLimit(u64),
    ToggleNotifyOnComplete,
    ToggleNotifyOnStart,
    ToggleOpenAtLogin,
    CheckForUpdates,
    InstallUpdate,
    Quit,
}

#[derive(Clone, PartialEq, Debug)]
enum Row {
    Label(String),
    Separator,
    Item { text: String, command: Command, enabled: bool },
    Check { text: String, command: Command, checked: bool },
    Submenu { text: String, rows: Vec<Row> },
}

/// Open at Login as last read or set, and when.
type LoginCache = Arc<Mutex<Option<(LoginStartupStatus, Instant)>>>;

fn open_at_login(cache: &LoginCache) -> LoginStartupStatus {
    let mut cached = cache.lock().unwrap_or_else(|e| e.into_inner());
    match *cached {
        Some((status, at)) if at.elapsed() < LOGIN_REFRESH => status,
        _ => {
            let status = login_startup::status();
            *cached = Some((status, Instant::now()));
            status
        }
    }
}

/// Everything the menu shows, read from the app once per refresh.
struct Snapshot {
    downloads: Vec<DownloadDto>,
    transfer: TransferStatusDto,
    settings: AppSettings,
    open_at_login: LoginStartupStatus,
    /// Connected, and the account's e-mail, when the device is linked to an account.
    remote: Option<(bool, Option<String>)>,
    updates: UpdateStatusDto,
    /// When updates were last checked, in local time.
    checked_at: Option<String>,
}

impl Snapshot {
    fn read(app: &App, login: &LoginCache) -> Self {
        let updates = app.updates.status();
        let checked_at = updates
            .last_checked_at
            .as_deref()
            .and_then(crate::protocol::encoding::parse_iso)
            .map(|at| at.with_timezone(&chrono::Local).format("%H:%M").to_string());
        Self {
            downloads: app.downloads.unfinished(),
            transfer: app.downloads.transfer_status(),
            settings: app.settings.get(),
            open_at_login: open_at_login(login),
            remote: app.remote.link(),
            updates,
            checked_at,
        }
    }
}

fn truncate(name: &str, max: usize) -> String {
    if name.chars().count() > max { format!("{}…", name.chars().take(max - 1).collect::<String>()) } else { name.to_owned() }
}

fn rate(bytes_per_second: u64) -> String {
    format_rate(bytes_per_second as f64)
}

fn limit_text(limit: u64) -> String {
    if limit == 0 { "Unlimited".into() } else { rate(limit) }
}

/// Roughly how long is left, or None when it can't be told.
fn eta(d: &DownloadDto) -> Option<String> {
    if d.download_speed == 0 || d.total_bytes == 0 {
        return None;
    }
    let left = d.total_bytes as f64 * (100.0 - d.progress.clamp(0.0, 100.0)) / 100.0;
    Some(duration_text((left / d.download_speed as f64).ceil() as u64))
}

fn duration_text(seconds: u64) -> String {
    match seconds {
        0..60 => "less than a minute left".into(),
        60..3600 => format!("{} min left", seconds.div_ceil(60)),
        3600..86_400 => {
            let minutes = seconds.div_ceil(60);
            match minutes % 60 {
                0 => format!("{} h left", minutes / 60),
                m => format!("{} h {m} min left", minutes / 60),
            }
        }
        _ => match seconds.div_ceil(86_400) {
            1 => "1 day left".into(),
            days => format!("{days} days left"),
        },
    }
}

fn is_running(status: DownloadStatus) -> bool {
    matches!(
        status,
        DownloadStatus::Queued | DownloadStatus::FetchingMetadata | DownloadStatus::Downloading | DownloadStatus::Seeding
    )
}

fn is_stopped(status: DownloadStatus) -> bool {
    matches!(status, DownloadStatus::Paused | DownloadStatus::Error)
}

fn percent(d: &DownloadDto) -> String {
    format!("{}%", d.progress.clamp(0.0, 100.0).floor())
}

/// The download's submenu title: its name and, at a glance, how it is doing.
fn download_title(d: &DownloadDto) -> String {
    let name = truncate(&d.name, 40);
    match d.status {
        DownloadStatus::Downloading => format!("{name} — {} · ↓ {}", percent(d), rate(d.download_speed)),
        DownloadStatus::FetchingMetadata => format!("{name} — getting details…"),
        DownloadStatus::Seeding => format!("{name} — seeding · ↑ {}", rate(d.upload_speed)),
        DownloadStatus::Queued => format!("{name} — queued"),
        DownloadStatus::Paused => format!("{name} — paused at {}", percent(d)),
        DownloadStatus::Error => format!("{name} — failed"),
        DownloadStatus::Completed => format!("{name} — done"),
    }
}

/// The download's own rows. Always the same shape, whatever its state, so an open submenu stays open.
fn download_rows(d: &DownloadDto) -> Vec<Row> {
    let size = if d.total_bytes > 0 {
        format!("{} of {}", percent(d), format_bytes(d.total_bytes as f64))
    } else {
        "Size not known yet".into()
    };
    let detail = match d.status {
        DownloadStatus::Error => format!("Failed: {}", truncate(d.error.as_deref().unwrap_or("unknown error"), 60)),
        DownloadStatus::Paused => "Paused".into(),
        DownloadStatus::Queued => "Waiting to start".into(),
        _ => {
            let mut parts = vec![format!("↓ {}", rate(d.download_speed)), format!("↑ {}", rate(d.upload_speed))];
            parts.push(if d.peers == 1 { "1 peer".into() } else { format!("{} peers", d.peers) });
            if let Some(left) = eta(d).filter(|_| d.status == DownloadStatus::Downloading) {
                parts.push(left);
            }
            parts.join(" · ")
        }
    };
    let reveal = if cfg!(target_os = "macos") {
        "Show in Finder"
    } else if cfg!(windows) {
        "Show in Explorer"
    } else {
        "Show in Folder"
    };
    vec![
        Row::Label(size),
        Row::Label(detail),
        Row::Separator,
        Row::Item {
            text: if is_stopped(d.status) { "Resume".into() } else { "Pause".into() },
            command: Command::TogglePause(d.id),
            enabled: true,
        },
        Row::Item { text: reveal.into(), command: Command::Reveal(d.id), enabled: true },
    ]
}

/// A limit picker: the presets, plus the current value when the dashboard set another one.
fn limit_rows(current: u64, presets: &[u64], command: fn(u64) -> Command) -> Vec<Row> {
    let mut rows: Vec<Row> = presets
        .iter()
        .map(|&limit| Row::Check { text: limit_text(limit), command: command(limit), checked: limit == current })
        .collect();
    if !presets.contains(&current) {
        rows.push(Row::Separator);
        rows.push(Row::Check { text: format!("{} (custom)", rate(current)), command: command(current), checked: true });
    }
    rows
}

fn clock(minutes: u16) -> String {
    format!("{:02}:{:02}", minutes / 60 % 24, minutes % 60)
}

/// The rows of the menu, top to bottom.
fn rows(s: &Snapshot) -> Vec<Row> {
    let mut rows = Vec::new();

    // What is happening now.
    let down: u64 = s.downloads.iter().map(|d| d.download_speed).sum();
    let up: u64 = s.downloads.iter().map(|d| d.upload_speed).sum();
    rows.push(Row::Label(match s.transfer.engine {
        EngineState::WaitingForNetwork => {
            s.transfer.message.clone().unwrap_or_else(|| "Waiting for the network connection…".into())
        }
        EngineState::Failed => s.transfer.message.clone().unwrap_or_else(|| "Downloads can't run right now".into()),
        EngineState::Starting => "Starting…".into(),
        _ if down == 0 && up == 0 => "Idle".into(),
        _ => format!("↓ {}   ↑ {}", rate(down), rate(up)),
    }));
    let count = |f: fn(DownloadStatus) -> bool| s.downloads.iter().filter(|d| f(d.status)).count();
    let downloading = count(|st| matches!(st, DownloadStatus::Downloading | DownloadStatus::FetchingMetadata));
    let seeding = count(|st| st == DownloadStatus::Seeding);
    let waiting = count(|st| st == DownloadStatus::Queued);
    let stopped = count(is_stopped);
    let summary: Vec<String> =
        [(downloading, "downloading"), (seeding, "seeding"), (waiting, "queued"), (stopped, "paused or failed")]
            .into_iter()
            .filter(|(n, _)| *n > 0)
            .map(|(n, what)| format!("{n} {what}"))
            .collect();
    rows.push(Row::Label(if summary.is_empty() { "No downloads in progress".into() } else { summary.join(" · ") }));
    if s.transfer.download_limit > 0 || s.transfer.upload_limit > 0 {
        let why = if s.transfer.alt_speed_active { " (slow mode)" } else { "" };
        rows.push(Row::Label(format!(
            "Limited to ↓ {} · ↑ {}{why}",
            limit_text(s.transfer.download_limit),
            limit_text(s.transfer.upload_limit)
        )));
    }

    // Each download.
    if !s.downloads.is_empty() {
        rows.push(Row::Separator);
        for d in s.downloads.iter().take(MAX_LISTED) {
            rows.push(Row::Submenu { text: download_title(d), rows: download_rows(d) });
        }
        if s.downloads.len() > MAX_LISTED {
            rows.push(Row::Item {
                text: format!("Show All {} Downloads…", s.downloads.len()),
                command: Command::OpenDashboard,
                enabled: true,
            });
        }
    }

    // Controls.
    rows.push(Row::Separator);
    rows.push(Row::Item { text: "Pause All".into(), command: Command::PauseAll, enabled: downloading + seeding + waiting > 0 });
    rows.push(Row::Item { text: "Resume All".into(), command: Command::ResumeAll, enabled: stopped > 0 });
    let settings = &s.settings;
    let mode = settings.alt_speed_mode;
    rows.push(Row::Submenu {
        text: match mode {
            AltSpeedMode::Off => "Slow Mode: Off".into(),
            AltSpeedMode::On => "Slow Mode: On".into(),
            AltSpeedMode::Scheduled if s.transfer.alt_speed_active => "Slow Mode: Scheduled, on now".into(),
            AltSpeedMode::Scheduled => "Slow Mode: Scheduled".into(),
        },
        rows: vec![
            Row::Check { text: "Off".into(), command: Command::SlowMode(AltSpeedMode::Off), checked: mode == AltSpeedMode::Off },
            Row::Check { text: "On".into(), command: Command::SlowMode(AltSpeedMode::On), checked: mode == AltSpeedMode::On },
            Row::Check {
                text: format!("On a Schedule, {}–{}", clock(settings.alt_schedule_from), clock(settings.alt_schedule_to)),
                command: Command::SlowMode(AltSpeedMode::Scheduled),
                checked: mode == AltSpeedMode::Scheduled,
            },
            Row::Separator,
            Row::Label(format!(
                "Slow mode limits: ↓ {} · ↑ {}",
                limit_text(settings.alt_download_limit),
                limit_text(settings.alt_upload_limit)
            )),
            Row::Item { text: "Change Slow Mode…".into(), command: Command::OpenSettings(Some("downloads")), enabled: true },
        ],
    });
    rows.push(Row::Submenu {
        text: format!("Download Limit: {}", limit_text(settings.download_limit)),
        rows: limit_rows(settings.download_limit, &DOWNLOAD_PRESETS, Command::DownloadLimit),
    });
    rows.push(Row::Submenu {
        text: format!("Upload Limit: {}", limit_text(settings.upload_limit)),
        rows: limit_rows(settings.upload_limit, &UPLOAD_PRESETS, Command::UploadLimit),
    });

    // Places.
    rows.push(Row::Separator);
    rows.push(Row::Item { text: "Open Dashboard".into(), command: Command::OpenDashboard, enabled: true });
    rows.push(Row::Item { text: "Open Downloads Folder".into(), command: Command::OpenDownloadsFolder, enabled: true });
    if let Some((connected, email)) = &s.remote {
        rows.push(Row::Label(match (connected, email) {
            (true, Some(email)) => format!("Remote access: {email}"),
            (true, None) => "Remote access: connected".into(),
            (false, _) => "Remote access: reconnecting…".into(),
        }));
        rows.push(Row::Item { text: "Open Remote Dashboard".into(), command: Command::OpenRemoteDashboard, enabled: true });
    }

    // Settings.
    let mut preferences = vec![
        Row::Check {
            text: "Notify When a Download Finishes".into(),
            command: Command::ToggleNotifyOnComplete,
            checked: settings.notify_on_complete,
        },
        Row::Check {
            text: "Notify When a Download Starts".into(),
            command: Command::ToggleNotifyOnStart,
            checked: settings.notify_on_start,
        },
    ];
    match s.open_at_login {
        LoginStartupStatus::Unavailable => {}
        status => preferences.push(Row::Check {
            text: if status == LoginStartupStatus::RequiresApproval {
                "Open at Login (allow it in System Settings)".into()
            } else {
                "Open at Login".into()
            },
            command: Command::ToggleOpenAtLogin,
            checked: status != LoginStartupStatus::Disabled,
        }),
    }
    preferences.push(Row::Separator);
    preferences.push(Row::Item { text: "All Settings…".into(), command: Command::OpenSettings(None), enabled: true });
    rows.push(Row::Separator);
    rows.push(Row::Submenu { text: "Settings".into(), rows: preferences });

    // Updates.
    let updates = &s.updates;
    rows.push(Row::Separator);
    if updates.installing {
        rows.push(Row::Label(format!("Magnetar v{VERSION}")));
        rows.push(Row::Label("Installing update…".into()));
    } else if let Some(available) = &updates.available {
        rows.push(Row::Label(format!("Magnetar v{VERSION} — {} available", available.tag)));
        let how = if updates.can_self_install { "(restarts the app)" } else { "(opens the release page)" };
        rows.push(Row::Item {
            text: format!("Update to {} {how}", available.tag),
            command: Command::InstallUpdate,
            enabled: true,
        });
    } else {
        let suffix = if updates.last_check_error.is_some() {
            " — update check failed".to_owned()
        } else if let Some(checked) = &s.checked_at {
            format!(" — up to date, checked {checked}")
        } else {
            String::new()
        };
        rows.push(Row::Label(format!("Magnetar v{VERSION}{suffix}")));
        rows.push(Row::Item {
            text: if updates.checking { "Checking for Updates…".into() } else { "Check for Updates…".into() },
            command: Command::CheckForUpdates,
            enabled: !updates.checking,
        });
    }
    rows.push(Row::Item { text: "Quit Magnetar".into(), command: Command::Quit, enabled: true });
    rows
}

/// Same rows in the same places with the same commands: the built menu can be updated in place.
fn same_shape(a: &[Row], b: &[Row]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|pair| match pair {
            (Row::Label(_), Row::Label(_)) | (Row::Separator, Row::Separator) => true,
            (Row::Item { command: x, .. }, Row::Item { command: y, .. }) => x == y,
            (Row::Check { command: x, .. }, Row::Check { command: y, .. }) => x == y,
            (Row::Submenu { rows: x, .. }, Row::Submenu { rows: y, .. }) => same_shape(x, y),
            _ => false,
        })
}

/// Total download rate for the menu-bar title, or '' when nothing downloads.
fn speed_text(downloads: &[DownloadDto]) -> String {
    let total: u64 = downloads.iter().filter(|d| d.status != DownloadStatus::Seeding).map(|d| d.download_speed).sum();
    if total > 0 { rate(total) } else { String::new() }
}

/// The native item behind each row.
enum Built {
    Plain(MenuItem),
    Separator(PredefinedMenuItem),
    Check(CheckMenuItem),
    Submenu(Submenu, Vec<Built>),
}

impl Built {
    fn item(&self) -> &dyn IsMenuItem {
        match self {
            Built::Plain(item) => item,
            Built::Separator(item) => item,
            Built::Check(item) => item,
            Built::Submenu(item, _) => item,
        }
    }
}

fn build(rows: &[Row], commands: &mut HashMap<MenuId, Command>) -> Vec<Built> {
    rows.iter()
        .map(|row| match row {
            Row::Label(text) => Built::Plain(MenuItem::new(text, false, None)),
            Row::Separator => Built::Separator(PredefinedMenuItem::separator()),
            Row::Item { text, command, enabled } => {
                let item = MenuItem::new(text, *enabled, None);
                commands.insert(item.id().clone(), *command);
                Built::Plain(item)
            }
            Row::Check { text, command, checked } => {
                let item = CheckMenuItem::new(text, true, *checked, None);
                commands.insert(item.id().clone(), *command);
                Built::Check(item)
            }
            Row::Submenu { text, rows } => {
                let submenu = Submenu::new(text, true);
                let children = build(rows, commands);
                for child in &children {
                    if let Err(error) = submenu.append(child.item()) {
                        tracing::warn!("Could not add a tray menu row: {error}");
                    }
                }
                Built::Submenu(submenu, children)
            }
        })
        .collect()
}

/// Brings built items of the same shape up to date. Check marks are always set: the system flips
/// them on click before the app has acted.
fn update(built: &[Built], old: &[Row], new: &[Row]) {
    for ((item, before), after) in built.iter().zip(old).zip(new) {
        match (item, after) {
            (Built::Plain(item), Row::Label(text)) if before != after => item.set_text(text),
            (Built::Plain(item), Row::Item { text, enabled, .. }) if before != after => {
                item.set_text(text);
                item.set_enabled(*enabled);
            }
            (Built::Check(item), Row::Check { text, checked, .. }) => {
                if before != after {
                    item.set_text(text);
                }
                item.set_checked(*checked);
            }
            (Built::Submenu(item, children), Row::Submenu { text, rows }) => {
                if let Row::Submenu { text: old_text, rows: old_rows } = before {
                    if old_text != text {
                        item.set_text(text);
                    }
                    update(children, old_rows, rows);
                }
            }
            _ => {}
        }
    }
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

/// Carries out a menu command. Anything slow runs on the app's runtime, never on the menu's thread.
fn perform(
    command: Command,
    app: &Arc<App>,
    login: &LoginCache,
    dashboard_url: &str,
    runtime: &tokio::runtime::Handle,
    quit: &Arc<dyn Fn() + Send + Sync>,
) {
    let app = app.clone();
    match command {
        Command::OpenDashboard => open_in_browser(dashboard_url),
        Command::OpenSettings(None) => open_in_browser(&format!("{dashboard_url}/settings")),
        Command::OpenSettings(Some(section)) => open_in_browser(&format!("{dashboard_url}/settings?section={section}")),
        Command::OpenRemoteDashboard => open_in_browser(&app.remote.status().cloud_url),
        Command::OpenDownloadsFolder => open_with_system(app.settings.get().download_folder),
        Command::Reveal(id) => match app.downloads.location(id) {
            Ok(path) => reveal_in_file_manager(&path),
            Err(error) => tracing::warn!("Could not show download {id}: {error}"),
        },
        Command::TogglePause(id) => {
            runtime.spawn(async move {
                let stopped = app.downloads.get(id).is_ok_and(|d| is_stopped(d.status));
                let result = if stopped { app.actions.resume(id) } else { app.actions.pause(id).await };
                if let Err(error) = result {
                    tracing::warn!("Could not {} download {id}: {error}", if stopped { "resume" } else { "pause" });
                }
            });
        }
        Command::PauseAll => {
            runtime.spawn(async move {
                for d in app.downloads.unfinished().into_iter().filter(|d| is_running(d.status)) {
                    if let Err(error) = app.actions.pause(d.id).await {
                        tracing::warn!("Could not pause download {}: {error}", d.id);
                    }
                }
            });
        }
        Command::ResumeAll => {
            for d in app.downloads.unfinished().into_iter().filter(|d| is_stopped(d.status)) {
                if let Err(error) = app.actions.resume(d.id) {
                    tracing::warn!("Could not resume download {}: {error}", d.id);
                }
            }
        }
        Command::SlowMode(mode) => {
            app.settings.update(|s| s.alt_speed_mode = mode);
        }
        Command::DownloadLimit(limit) => {
            app.settings.update(|s| s.download_limit = limit);
        }
        Command::UploadLimit(limit) => {
            app.settings.update(|s| s.upload_limit = limit);
        }
        Command::ToggleNotifyOnComplete => {
            app.settings.update(|s| s.notify_on_complete = !s.notify_on_complete);
        }
        Command::ToggleNotifyOnStart => {
            app.settings.update(|s| s.notify_on_start = !s.notify_on_start);
        }
        Command::ToggleOpenAtLogin => {
            let login = login.clone();
            runtime.spawn_blocking(move || {
                let enable = login_startup::status() == LoginStartupStatus::Disabled;
                match login_startup::set(enable) {
                    Ok(status) => *login.lock().unwrap_or_else(|e| e.into_inner()) = Some((status, Instant::now())),
                    Err(error) => tracing::warn!("Could not change Open at Login: {error}"),
                }
            });
        }
        Command::CheckForUpdates => {
            runtime.spawn(async move { app.updates.check().await });
        }
        Command::InstallUpdate => {
            runtime.spawn(async move {
                if let Some(page) = app.updates.install().await {
                    open_in_browser(&page);
                }
            });
        }
        Command::Quit => quit(),
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
    let mut shown: Vec<Row> = Vec::new();
    let mut built: Vec<Built> = Vec::new();
    let mut commands: HashMap<MenuId, Command> = HashMap::new();
    let mut title = String::new();
    let mut tooltip = String::new();
    let mut next_refresh = Instant::now();
    let login: LoginCache = Arc::default();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250));
        // The icon must be created once the event loop is running (macOS).
        if matches!(event, Event::NewEvents(StartCause::Init)) && tray.is_none() {
            let icon = icon().and_then(|icon| {
                Ok(TrayIconBuilder::new()
                    .with_icon(icon)
                    .with_icon_as_template(cfg!(target_os = "macos"))
                    .with_tooltip("Magnetar")
                    .with_menu_on_left_click(cfg!(target_os = "macos"))
                    .build()?)
            });
            match icon {
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
            perform(command, &app, &login, &dashboard_url, &runtime, &quit);
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
            let snapshot = Snapshot::read(&app, &login);
            let current = rows(&snapshot);
            if same_shape(&shown, &current) {
                update(&built, &shown, &current);
            } else {
                let menu = Menu::new();
                let mut ids = HashMap::new();
                built = build(&current, &mut ids);
                for item in &built {
                    if let Err(error) = menu.append(item.item()) {
                        tracing::warn!("Could not add a tray menu row: {error}");
                    }
                }
                tray.set_menu(Some(Box::new(menu)));
                commands = ids;
            }
            shown = current;
            let speed = speed_text(&snapshot.downloads);
            if cfg!(target_os = "macos") && speed != title {
                tray.set_title(Some(&speed));
                title = speed;
            }
            let summary = match shown.first() {
                Some(Row::Label(text)) if text != "Idle" => format!("Magnetar — {text}"),
                _ => "Magnetar".to_owned(),
            };
            if summary != tooltip {
                if let Err(error) = tray.set_tooltip(Some(&summary)) {
                    tracing::debug!("Could not set the tray tooltip: {error}");
                }
                tooltip = summary;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn download(id: i64, status: DownloadStatus) -> DownloadDto {
        DownloadDto {
            id,
            name: format!("Download {id}"),
            status,
            progress: 40.0,
            total_bytes: 1024 * MIB,
            download_speed: if status == DownloadStatus::Downloading { 2 * MIB } else { 0 },
            upload_speed: if status == DownloadStatus::Seeding { 300 * KIB } else { 0 },
            peers: 5,
            source: "test".into(),
            save_path: "/tmp".into(),
            added_at: format!("2026-10-01T10:{:02}:00Z", id % 60),
            completed_at: None,
            error: None,
            series_task_id: None,
            uploaded_bytes: 0,
            partial_files: None,
        }
    }

    fn snapshot(downloads: Vec<DownloadDto>) -> Snapshot {
        Snapshot {
            downloads,
            transfer: TransferStatusDto {
                engine: EngineState::Running,
                message: None,
                network_interface: None,
                alt_speed_active: false,
                download_limit: 0,
                upload_limit: 0,
                free_bytes: None,
            },
            settings: AppSettings::default(),
            open_at_login: LoginStartupStatus::Disabled,
            remote: None,
            updates: UpdateStatusDto {
                current_version: VERSION.into(),
                available: None,
                can_self_install: true,
                checking: false,
                installing: false,
                last_checked_at: None,
                last_check_error: None,
            },
            checked_at: Some("20:37".into()),
        }
    }

    fn labels(rows: &[Row]) -> Vec<&str> {
        rows.iter().filter_map(|r| if let Row::Label(t) = r { Some(t.as_str()) } else { None }).collect()
    }

    fn find(rows: &[Row], command: Command) -> Option<&Row> {
        rows.iter().find_map(|row| match row {
            Row::Item { command: c, .. } | Row::Check { command: c, .. } if *c == command => Some(row),
            Row::Submenu { rows, .. } => find(rows, command),
            _ => None,
        })
    }

    fn submenu<'a>(rows: &'a [Row], title: &str) -> &'a [Row] {
        rows.iter()
            .find_map(|row| match row {
                Row::Submenu { text, rows } if text == title => Some(rows.as_slice()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no submenu {title:?} in {rows:#?}"))
    }

    fn checked(rows: &[Row]) -> Vec<&str> {
        rows.iter()
            .filter_map(|r| if let Row::Check { text, checked: true, .. } = r { Some(text.as_str()) } else { None })
            .collect()
    }

    fn enabled(rows: &[Row], command: Command) -> bool {
        matches!(find(rows, command), Some(Row::Item { enabled: true, .. }))
    }

    /// The downloads listed by name: their submenus hold a Pause or Resume row.
    fn listed(rows: &[Row]) -> usize {
        rows.iter()
            .filter(|r| matches!(r, Row::Submenu { rows, .. } if rows.iter().any(|c| matches!(c, Row::Item { command: Command::TogglePause(_), .. }))))
            .count()
    }

    #[test]
    fn idle_says_so_and_offers_nothing_to_pause_or_resume() {
        let rows = rows(&snapshot(vec![]));
        assert_eq!(labels(&rows)[..2], ["Idle", "No downloads in progress"]);
        assert!(!enabled(&rows, Command::PauseAll));
        assert!(!enabled(&rows, Command::ResumeAll));
        assert_eq!(listed(&rows), 0);
    }

    #[test]
    fn totals_and_counts_cover_every_download() {
        let rows = rows(&snapshot(vec![
            download(1, DownloadStatus::Downloading),
            download(2, DownloadStatus::Downloading),
            download(3, DownloadStatus::Seeding),
            download(4, DownloadStatus::Paused),
            download(5, DownloadStatus::Error),
        ]));
        assert_eq!(labels(&rows)[..2], ["↓ 4 MiB/s   ↑ 300 KiB/s", "2 downloading · 1 seeding · 2 paused or failed"]);
        assert!(enabled(&rows, Command::PauseAll));
        assert!(enabled(&rows, Command::ResumeAll));
    }

    #[test]
    fn a_stopped_engine_says_why_instead_of_speeds() {
        let mut s = snapshot(vec![download(1, DownloadStatus::Downloading)]);
        s.transfer.engine = EngineState::WaitingForNetwork;
        s.transfer.message = Some("Waiting for VPN (utun4)".into());
        assert_eq!(labels(&rows(&s))[0], "Waiting for VPN (utun4)");
    }

    #[test]
    fn each_download_can_be_paused_or_resumed_and_shown() {
        let mut failed = download(2, DownloadStatus::Error);
        failed.error = Some("No space left on the disk".into());
        let rows = rows(&snapshot(vec![download(1, DownloadStatus::Downloading), failed]));
        let running = submenu(&rows, "Download 1 — 40% · ↓ 2 MiB/s");
        assert_eq!(labels(running), ["40% of 1 GiB", "↓ 2 MiB/s · ↑ 0 B/s · 5 peers · 6 min left"]);
        assert!(matches!(&running[3], Row::Item { text, command: Command::TogglePause(1), .. } if text == "Pause"));
        assert!(matches!(&running[4], Row::Item { command: Command::Reveal(1), .. }));
        let stopped = submenu(&rows, "Download 2 — failed");
        assert_eq!(labels(stopped)[1], "Failed: No space left on the disk");
        assert!(matches!(&stopped[3], Row::Item { text, command: Command::TogglePause(2), .. } if text == "Resume"));
    }

    #[test]
    fn lists_eight_downloads_and_links_the_rest() {
        let rows = rows(&snapshot((1..=11).map(|id| download(id, DownloadStatus::Downloading)).collect()));
        assert_eq!(listed(&rows), MAX_LISTED);
        assert!(
            rows.iter().any(
                |r| matches!(r, Row::Item { text, command: Command::OpenDashboard, .. } if text == "Show All 11 Downloads…")
            )
        );
        let eight = super::rows(&snapshot((1..=8).map(|id| download(id, DownloadStatus::Downloading)).collect()));
        assert_eq!(listed(&eight), 8);
        assert!(!eight.iter().any(|r| matches!(r, Row::Item { text, .. } if text.starts_with("Show All"))));
    }

    #[test]
    fn limits_check_exactly_the_one_in_force_and_keep_a_custom_one() {
        let mut s = snapshot(vec![]);
        s.settings.download_limit = 5 * MIB;
        s.settings.upload_limit = 700 * KIB;
        let rows = rows(&s);
        assert_eq!(checked(submenu(&rows, "Download Limit: 5 MiB/s")), ["5 MiB/s"]);
        let upload = submenu(&rows, "Upload Limit: 700 KiB/s");
        assert_eq!(checked(upload), ["700 KiB/s (custom)"]);
        assert_eq!(upload.len(), UPLOAD_PRESETS.len() + 2);
        assert!(matches!(upload[UPLOAD_PRESETS.len()], Row::Separator));
        s.settings.download_limit = 0;
        assert_eq!(checked(submenu(&super::rows(&s), "Download Limit: Unlimited")), ["Unlimited"]);
    }

    #[test]
    fn limits_in_force_are_shown_with_their_reason() {
        let mut s = snapshot(vec![]);
        assert!(!labels(&rows(&s)).iter().any(|l| l.starts_with("Limited")));
        s.transfer.download_limit = 2 * MIB;
        s.transfer.alt_speed_active = true;
        assert!(labels(&rows(&s)).contains(&"Limited to ↓ 2 MiB/s · ↑ Unlimited (slow mode)"));
    }

    #[test]
    fn slow_mode_offers_its_three_modes_with_the_schedule() {
        let mut s = snapshot(vec![]);
        s.settings.alt_speed_mode = AltSpeedMode::Scheduled;
        s.settings.alt_schedule_from = 8 * 60 + 5;
        s.settings.alt_schedule_to = 23 * 60;
        s.transfer.alt_speed_active = true;
        let rows = rows(&s);
        let slow = submenu(&rows, "Slow Mode: Scheduled, on now");
        assert_eq!(checked(slow), ["On a Schedule, 08:05–23:00"]);
        assert!(labels(slow).contains(&"Slow mode limits: ↓ 2 MiB/s · ↑ 512 KiB/s"));
    }

    #[test]
    fn open_at_login_is_offered_only_where_it_works() {
        let mut s = snapshot(vec![]);
        s.open_at_login = LoginStartupStatus::Unavailable;
        assert!(find(&rows(&s), Command::ToggleOpenAtLogin).is_none());
        s.open_at_login = LoginStartupStatus::RequiresApproval;
        assert!(matches!(
            find(&rows(&s), Command::ToggleOpenAtLogin),
            Some(Row::Check { text, checked: true, .. }) if text == "Open at Login (allow it in System Settings)"
        ));
    }

    #[test]
    fn updates_offer_a_check_until_one_is_running() {
        let mut s = snapshot(vec![]);
        assert!(labels(&rows(&s)).contains(&format!("Magnetar v{VERSION} — up to date, checked 20:37").as_str()));
        assert!(enabled(&rows(&s), Command::CheckForUpdates));
        s.updates.checking = true;
        assert!(!enabled(&rows(&s), Command::CheckForUpdates));
        s.updates.checking = false;
        s.updates.last_check_error = Some("offline".into());
        assert!(labels(&rows(&s)).contains(&format!("Magnetar v{VERSION} — update check failed").as_str()));
    }

    #[test]
    fn an_update_arriving_rebuilds_so_its_row_installs() {
        let mut s = snapshot(vec![]);
        let before = rows(&s);
        s.updates.available = Some(crate::protocol::AvailableUpdateDto {
            version: "9.0.0".into(),
            tag: "v9.0.0".into(),
            release_url: "https://github.com/XeonFX/Magnetar/releases/tag/v9.0.0".into(),
        });
        let after = rows(&s);
        assert!(
            matches!(find(&after, Command::InstallUpdate), Some(Row::Item { text, .. }) if text == "Update to v9.0.0 (restarts the app)")
        );
        // Same place, other command: updating the old item's text would leave it checking for updates.
        assert!(!same_shape(&before, &after));
    }

    #[test]
    fn long_names_are_cut_on_characters_not_bytes() {
        let mut d = download(1, DownloadStatus::Queued);
        d.name = "Ł".repeat(60);
        assert_eq!(download_title(&d), format!("{}… — queued", "Ł".repeat(39)));
        d.name = "Ł".repeat(40);
        assert_eq!(download_title(&d), format!("{} — queued", "Ł".repeat(40)));
    }

    #[test]
    fn time_left_reads_naturally() {
        assert_eq!(duration_text(0), "less than a minute left");
        assert_eq!(duration_text(59), "less than a minute left");
        assert_eq!(duration_text(60), "1 min left");
        assert_eq!(duration_text(61), "2 min left");
        assert_eq!(duration_text(3600), "1 h left");
        assert_eq!(duration_text(3601), "1 h 1 min left");
        assert_eq!(duration_text(86_400), "1 day left");
        assert_eq!(duration_text(86_401), "2 days left");
        let mut stalled = download(1, DownloadStatus::Downloading);
        stalled.download_speed = 0;
        assert_eq!(eta(&stalled), None);
        stalled.download_speed = MIB;
        stalled.total_bytes = 0;
        assert_eq!(eta(&stalled), None);
    }

    fn status() -> impl Strategy<Value = DownloadStatus> {
        prop_oneof![
            Just(DownloadStatus::Queued),
            Just(DownloadStatus::FetchingMetadata),
            Just(DownloadStatus::Downloading),
            Just(DownloadStatus::Seeding),
            Just(DownloadStatus::Paused),
            Just(DownloadStatus::Error),
        ]
    }

    type Tick = (DownloadStatus, f64, u64, u32);

    fn tick() -> impl Strategy<Value = Vec<Tick>> {
        proptest::collection::vec((status(), 0.0f64..=100.0, 0u64..100_000_000, 0u32..500), 12)
    }

    fn downloads(count: usize, ticks: &[Tick]) -> Vec<DownloadDto> {
        ticks
            .iter()
            .take(count)
            .enumerate()
            .map(|(i, &(status, progress, speed, peers))| {
                let mut d = download(i as i64 + 1, status);
                d.progress = progress;
                d.download_speed = speed;
                d.upload_speed = speed / 3;
                d.peers = peers;
                d
            })
            .collect()
    }

    proptest! {
        /// Speeds, progress, peers and each download's state change all the time; none of that may
        /// rebuild the menu, which would close it under the pointer.
        #[test]
        fn ticking_never_changes_the_shape(count in 0usize..12, before in tick(), after in tick()) {
            let (a, b) = (rows(&snapshot(downloads(count, &before))), rows(&snapshot(downloads(count, &after))));
            prop_assert!(same_shape(&a, &b));
        }

        /// A download arriving is a real change, and rebuilds up to the listed maximum.
        #[test]
        fn a_new_download_changes_the_shape_while_it_is_listed(count in 0usize..12, ticks in tick()) {
            let (a, b) = (rows(&snapshot(downloads(count, &ticks))), rows(&snapshot(downloads(count + 1, &ticks))));
            prop_assert_eq!(same_shape(&a, &b), count > MAX_LISTED);
        }
    }
}
