//! The menu-bar (macOS) or notification-area (Windows) icon. Its menu shows what is transferring,
//! each unfinished download with its own controls, speed limits, a few settings, remote access and
//! update state. A background task reads the app each second and describes the menu as rows
//! (`rows`); the main thread only applies them. While their shape stays the same the native items
//! are updated in place, so an open menu keeps ticking instead of closing on a rebuild.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tokio::sync::Notify;
use tray_icon::menu::{CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::app::App;
use crate::config::build_label;
use crate::protocol::bytes::{format_bytes, format_rate};
use crate::protocol::{
    AltSpeedMode, DownloadDto, DownloadStatus, EngineState, LoginStartupStatus, SettingsPatch, TransferStatusDto, UpdateStatusDto,
};
use crate::settings::AppSettings;
use crate::system::handlers::OpenTarget;
use crate::system::{login_startup, open_in_browser, open_with_system, reveal_in_file_manager};

const REFRESH: Duration = Duration::from_secs(1);
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

/// A row that is always clickable.
fn item(text: impl Into<String>, command: Command) -> Row {
    Row::Item { text: text.into(), command, enabled: true }
}

fn check(text: impl Into<String>, command: Command, checked: bool) -> Row {
    Row::Check { text: text.into(), command, checked }
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
    fn read(app: &App) -> Self {
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
            open_at_login: login_startup::status(),
            remote: app.remote.link(),
            updates,
            checked_at,
        }
    }

    /// Download and upload rates, summed over every download.
    fn totals(&self) -> (u64, u64) {
        self.downloads.iter().fold((0, 0), |(down, up), d| (down + d.download_speed, up + d.upload_speed))
    }
}

/// The menu as the main thread applies it.
struct MenuContent {
    rows: Vec<Row>,
    /// The menu-bar title: the download rate while something downloads.
    title: String,
    tooltip: String,
}

impl MenuContent {
    fn of(s: &Snapshot) -> Self {
        let (down, _) = s.totals();
        let headline = headline(s);
        Self {
            rows: rows(s),
            title: if down > 0 { rate(down) } else { String::new() },
            tooltip: if headline == "Idle" { "Magnetar".into() } else { format!("Magnetar — {headline}") },
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
        item(if d.status.wants_engine() { "Pause" } else { "Resume" }, Command::TogglePause(d.id)),
        item(reveal, Command::Reveal(d.id)),
    ]
}

/// A limit picker: the presets, plus the current value when the dashboard set another one.
fn limit_rows(current: u64, presets: &[u64], command: fn(u64) -> Command) -> Vec<Row> {
    let mut rows: Vec<Row> = presets.iter().map(|&limit| check(limit_text(limit), command(limit), limit == current)).collect();
    if !presets.contains(&current) {
        rows.push(Row::Separator);
        rows.push(check(format!("{} (custom)", rate(current)), command(current), true));
    }
    rows
}

fn clock(minutes: u16) -> String {
    format!("{:02}:{:02}", minutes / 60 % 24, minutes % 60)
}

/// The first line: what the engine is doing, or the totals.
fn headline(s: &Snapshot) -> String {
    let (down, up) = s.totals();
    match s.transfer.engine {
        EngineState::WaitingForNetwork => {
            s.transfer.message.clone().unwrap_or_else(|| "Waiting for the network connection…".into())
        }
        EngineState::Failed => s.transfer.message.clone().unwrap_or_else(|| "Downloads can't run right now".into()),
        EngineState::Starting => "Starting…".into(),
        _ if down == 0 && up == 0 => "Idle".into(),
        _ => format!("↓ {}   ↑ {}", rate(down), rate(up)),
    }
}

/// The rows of the menu, top to bottom.
fn rows(s: &Snapshot) -> Vec<Row> {
    let mut rows = vec![Row::Label(headline(s))];

    // What is happening now.
    let count = |f: fn(DownloadStatus) -> bool| s.downloads.iter().filter(|d| f(d.status)).count();
    let running = count(DownloadStatus::wants_engine);
    let stopped = s.downloads.len() - running;
    let downloading = count(|st| matches!(st, DownloadStatus::Downloading | DownloadStatus::FetchingMetadata));
    let seeding = count(|st| st == DownloadStatus::Seeding);
    let summary: Vec<String> = [
        (downloading, "downloading"),
        (seeding, "seeding"),
        (running - downloading - seeding, "queued"),
        (stopped, "paused or failed"),
    ]
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
            rows.push(item(format!("Show All {} Downloads…", s.downloads.len()), Command::OpenDashboard));
        }
    }

    // Controls.
    rows.push(Row::Separator);
    rows.push(Row::Item { text: "Pause All".into(), command: Command::PauseAll, enabled: running > 0 });
    rows.push(Row::Item { text: "Resume All".into(), command: Command::ResumeAll, enabled: stopped > 0 });
    let settings = &s.settings;
    let mode = settings.alt_speed_mode;
    let schedule = format!("On a Schedule, {}–{}", clock(settings.alt_schedule_from), clock(settings.alt_schedule_to));
    let mut slow: Vec<Row> =
        [(AltSpeedMode::Off, "Off".to_owned()), (AltSpeedMode::On, "On".to_owned()), (AltSpeedMode::Scheduled, schedule)]
            .into_iter()
            .map(|(option, text)| check(text, Command::SlowMode(option), mode == option))
            .collect();
    slow.extend([
        Row::Separator,
        Row::Label(format!(
            "Slow mode limits: ↓ {} · ↑ {}",
            limit_text(settings.alt_download_limit),
            limit_text(settings.alt_upload_limit)
        )),
        item("Change Slow Mode…", Command::OpenSettings(Some("downloads"))),
    ]);
    rows.push(Row::Submenu {
        text: match mode {
            AltSpeedMode::Off => "Slow Mode: Off".into(),
            AltSpeedMode::On => "Slow Mode: On".into(),
            AltSpeedMode::Scheduled if s.transfer.alt_speed_active => "Slow Mode: Scheduled, on now".into(),
            AltSpeedMode::Scheduled => "Slow Mode: Scheduled".into(),
        },
        rows: slow,
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
    rows.push(item("Open Dashboard", Command::OpenDashboard));
    rows.push(item("Open Downloads Folder", Command::OpenDownloadsFolder));
    if let Some((connected, email)) = &s.remote {
        rows.push(Row::Label(match (connected, email) {
            (true, Some(email)) => format!("Remote access: {email}"),
            (true, None) => "Remote access: connected".into(),
            (false, _) => "Remote access: reconnecting…".into(),
        }));
        rows.push(item("Open Remote Dashboard", Command::OpenRemoteDashboard));
    }

    // Settings.
    let mut preferences = vec![
        check("Notify When a Download Finishes", Command::ToggleNotifyOnComplete, settings.notify_on_complete),
        check("Notify When a Download Starts", Command::ToggleNotifyOnStart, settings.notify_on_start),
    ];
    match s.open_at_login {
        LoginStartupStatus::Unavailable => {}
        LoginStartupStatus::RequiresApproval => {
            preferences.push(check("Open at Login (allow it in System Settings)", Command::ToggleOpenAtLogin, true));
        }
        status => preferences.push(check("Open at Login", Command::ToggleOpenAtLogin, status == LoginStartupStatus::Enabled)),
    }
    preferences.push(Row::Separator);
    preferences.push(item("All Settings…", Command::OpenSettings(None)));
    rows.push(Row::Separator);
    rows.push(Row::Submenu { text: "Settings".into(), rows: preferences });

    // Updates.
    let updates = &s.updates;
    rows.push(Row::Separator);
    let build = format!("Magnetar {}", build_label());
    if updates.installing {
        rows.push(Row::Label(build));
        rows.push(Row::Label("Installing update…".into()));
    } else if let Some(available) = &updates.available {
        rows.push(Row::Label(format!("{build} — {} available", available.tag)));
        let how = if updates.can_self_install { "(restarts the app)" } else { "(opens the release page)" };
        rows.push(item(format!("Update to {} {how}", available.tag), Command::InstallUpdate));
    } else {
        let suffix = if updates.last_check_error.is_some() {
            " — update check failed".to_owned()
        } else if let Some(checked) = &s.checked_at {
            format!(" — up to date, checked {checked}")
        } else {
            String::new()
        };
        rows.push(Row::Label(format!("{build}{suffix}")));
        rows.push(Row::Item {
            text: if updates.checking { "Checking for Updates…".into() } else { "Check for Updates…".into() },
            command: Command::CheckForUpdates,
            enabled: !updates.checking,
        });
    }
    rows.push(item("What's New…", Command::OpenSettings(Some("about"))));
    rows.push(item("Quit Magnetar", Command::Quit));
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

fn append_all(built: &[Built], append: impl Fn(&dyn IsMenuItem) -> tray_icon::menu::Result<()>) {
    for child in built {
        if let Err(error) = append(child.item()) {
            tracing::warn!("Could not add a tray menu row: {error}");
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
                append_all(&children, |child| submenu.append(child));
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

/// Reads the app each second, or at once when `refresh` is notified, and leaves the menu in `latest`.
fn produce(app: Arc<App>, runtime: &tokio::runtime::Handle, latest: Arc<Mutex<Option<MenuContent>>>, refresh: Arc<Notify>) {
    runtime.spawn(async move {
        loop {
            let reader = app.clone();
            match tokio::task::spawn_blocking(move || MenuContent::of(&Snapshot::read(&reader))).await {
                Ok(content) => *latest.lock().unwrap_or_else(|e| e.into_inner()) = Some(content),
                Err(error) => tracing::warn!("Could not read the tray menu: {error}"),
            }
            tokio::select! {
                () = tokio::time::sleep(REFRESH) => {}
                () = refresh.notified() => {}
            }
        }
    });
}

/// Saves a settings change; the engine and every dashboard pick it up from there.
fn save_settings(app: &App, patch: SettingsPatch) {
    if let Err(error) = patch.validated().and_then(|patch| app.settings.apply_patch(patch)) {
        crate::log_failure!(&error, "Could not change the settings from the menu: {error}");
    }
}

fn toggle(app: &App, change: impl FnOnce(&mut AppSettings)) {
    if let Err(error) = app.settings.update(change) {
        crate::log_failure!(&error, "Could not change the settings from the menu: {error}");
    }
}

/// Carries out a menu command. Anything that touches the database or the engine runs on the app's
/// runtime, never on the menu's thread, and asks for a fresh menu when done.
fn perform(command: Command, app: &Arc<App>, dashboard_url: &str, runtime: &tokio::runtime::Handle, refresh: &Arc<Notify>) {
    let off_thread = |work: Box<dyn FnOnce(&App) + Send>| {
        let (app, refresh) = (app.clone(), refresh.clone());
        runtime.spawn_blocking(move || {
            work(&app);
            refresh.notify_one();
        });
    };
    match command {
        Command::OpenDashboard => open_in_browser(dashboard_url),
        Command::OpenSettings(None) => open_in_browser(&format!("{dashboard_url}/settings")),
        Command::OpenSettings(Some(section)) => open_in_browser(&format!("{dashboard_url}/settings/{section}")),
        Command::OpenRemoteDashboard => off_thread(Box::new(|app| open_in_browser(&app.remote.status().cloud_url))),
        Command::OpenDownloadsFolder => off_thread(Box::new(|app| {
            // Before the first download it may not exist yet; show it empty rather than do nothing.
            let folder = app.settings.get().download_folder;
            if let Err(error) = std::fs::create_dir_all(&folder) {
                tracing::warn!("Could not create the downloads folder {folder}: {error}");
            }
            open_with_system(folder);
        })),
        Command::Reveal(id) => off_thread(Box::new(move |app| match app.downloads.location(id) {
            Ok(path) => reveal_in_file_manager(&path),
            Err(error) => tracing::warn!("Could not show download {id}: {error}"),
        })),
        Command::TogglePause(id) => {
            let handle = runtime.clone();
            off_thread(Box::new(move |app| {
                let result = match app.downloads.get(id) {
                    Ok(d) if !d.status.wants_engine() => app.actions.resume(id),
                    _ => handle.block_on(app.actions.pause(id)),
                };
                if let Err(error) = result {
                    tracing::warn!("Could not pause or resume download {id}: {error}");
                }
            }))
        }
        Command::PauseAll => {
            let handle = runtime.clone();
            off_thread(Box::new(move |app| {
                handle.block_on(app.actions.pause_all());
            }))
        }
        Command::ResumeAll => off_thread(Box::new(|app| {
            app.actions.resume_all();
        })),
        Command::SlowMode(mode) => off_thread(Box::new(move |app| {
            save_settings(app, SettingsPatch { alt_speed_mode: Some(mode), ..Default::default() })
        })),
        Command::DownloadLimit(limit) => off_thread(Box::new(move |app| {
            save_settings(app, SettingsPatch { download_limit: Some(limit), ..Default::default() })
        })),
        Command::UploadLimit(limit) => {
            off_thread(Box::new(move |app| save_settings(app, SettingsPatch { upload_limit: Some(limit), ..Default::default() })))
        }
        Command::ToggleNotifyOnComplete => off_thread(Box::new(|app| {
            toggle(app, |s| s.notify_on_complete = !s.notify_on_complete);
        })),
        Command::ToggleNotifyOnStart => off_thread(Box::new(|app| {
            toggle(app, |s| s.notify_on_start = !s.notify_on_start);
        })),
        Command::ToggleOpenAtLogin => off_thread(Box::new(|_| {
            if let Err(error) = login_startup::set(login_startup::status() != LoginStartupStatus::Enabled) {
                tracing::warn!("Could not change Open at Login: {error}");
            }
        })),
        Command::CheckForUpdates => {
            let (app, refresh) = (app.clone(), refresh.clone());
            runtime.spawn(async move {
                app.updates.check().await;
                refresh.notify_one();
            });
        }
        Command::InstallUpdate => {
            let app = app.clone();
            runtime.spawn(async move {
                if let Some(page) = app.updates.install().await {
                    open_in_browser(&page);
                }
            });
        }
        // The event loop quits itself: it owns the shutdown.
        Command::Quit => {}
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
    let latest: Arc<Mutex<Option<MenuContent>>> = Arc::default();
    let refresh = Arc::new(Notify::new());
    produce(app.clone(), &runtime, latest.clone(), refresh.clone());
    let mut tray: Option<TrayIcon> = None;
    let mut shown: Vec<Row> = Vec::new();
    let mut built: Vec<Built> = Vec::new();
    let mut commands: HashMap<MenuId, Command> = HashMap::new();
    let mut title = String::new();
    let mut tooltip = String::new();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(100));
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
            match commands.get(event.id()).copied() {
                Some(Command::Quit) => quit(),
                Some(command) => perform(command, &app, &dashboard_url, &runtime, &refresh),
                None => {}
            }
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

        let Some(content) = latest.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
        if same_shape(&shown, &content.rows) {
            update(&built, &shown, &content.rows);
        } else {
            let menu = Menu::new();
            let mut ids = HashMap::new();
            built = build(&content.rows, &mut ids);
            append_all(&built, |item| menu.append(item));
            tray.set_menu(Some(Box::new(menu)));
            commands = ids;
        }
        shown = content.rows;
        if cfg!(target_os = "macos") && content.title != title {
            tray.set_title(Some(&content.title));
            title = content.title;
        }
        if content.tooltip != tooltip {
            if let Err(error) = tray.set_tooltip(Some(&content.tooltip)) {
                tracing::debug!("Could not set the tray tooltip: {error}");
            }
            tooltip = content.tooltip;
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
                current_version: crate::config::VERSION.into(),
                current_commit: "abc1234".into(),
                available: None,
                can_self_install: true,
                checking: false,
                installing: false,
                last_checked_at: None,
                last_check_error: None,
                last_check_problem: None,
                retry_at: None,
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
    fn the_title_and_tooltip_follow_the_totals() {
        let idle = MenuContent::of(&snapshot(vec![download(1, DownloadStatus::Paused)]));
        assert_eq!((idle.title.as_str(), idle.tooltip.as_str()), ("", "Magnetar"));
        let seeding = MenuContent::of(&snapshot(vec![download(1, DownloadStatus::Seeding)]));
        assert_eq!((seeding.title.as_str(), seeding.tooltip.as_str()), ("", "Magnetar — ↓ 0 B/s   ↑ 300 KiB/s"));
        let busy =
            MenuContent::of(&snapshot(vec![download(1, DownloadStatus::Downloading), download(2, DownloadStatus::Downloading)]));
        assert_eq!((busy.title.as_str(), busy.tooltip.as_str()), ("4 MiB/s", "Magnetar — ↓ 4 MiB/s   ↑ 0 B/s"));
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
        assert!(labels(&rows(&s)).contains(&format!("Magnetar {} — up to date, checked 20:37", build_label()).as_str()));
        assert!(enabled(&rows(&s), Command::CheckForUpdates));
        s.updates.checking = true;
        assert!(!enabled(&rows(&s), Command::CheckForUpdates));
        s.updates.checking = false;
        s.updates.last_check_error = Some("offline".into());
        assert!(labels(&rows(&s)).contains(&format!("Magnetar {} — update check failed", build_label()).as_str()));
    }

    #[test]
    fn an_update_arriving_rebuilds_so_its_row_installs() {
        let mut s = snapshot(vec![]);
        let before = rows(&s);
        s.updates.available = Some(crate::protocol::AvailableUpdateDto {
            version: "9.0.0".into(),
            tag: "v9.0.0".into(),
            name: "Magnetar 9.0.0".into(),
            release_url: "https://github.com/codefusion-cc/magnetar/releases/tag/v9.0.0".into(),
            published_at: None,
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
