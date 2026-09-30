//! Logging: `tracing` events go to stderr and a daily file in the data folder (14 days kept).
//! Errors are also handed to the error sink (telemetry). Other crates only log warnings and up.

use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

const RETAINED_DAYS: usize = 14;
const OWN_CRATE: &str = "magnetar";

type ErrorSink = Box<dyn Fn(&str, &str) + Send + Sync>;
static ERROR_SINK: OnceLock<ErrorSink> = OnceLock::new();

/// Errors logged anywhere are also handed to this sink as (scope, message).
pub fn set_error_sink(sink: impl Fn(&str, &str) + Send + Sync + 'static) {
    let _ = ERROR_SINK.set(Box::new(sink));
}

struct FileLayer {
    dir: Option<PathBuf>,
    min_level: Level,
    file: Mutex<(String, Option<File>)>,
}

impl FileLayer {
    fn append(&self, line: &str) {
        let Some(dir) = &self.dir else { return };
        let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let mut state = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if state.0 != day || state.1.is_none() {
            let _ = std::fs::create_dir_all(dir);
            prune_old_logs(dir);
            state.1 = OpenOptions::new().create(true).append(true).open(dir.join(format!("app-{day}.log"))).ok();
            state.0 = day;
        }
        // A full or read-only disk must not take the app down with it.
        if let Some(file) = state.1.as_mut() {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn prune_old_logs(dir: &PathBuf) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut logs: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with("app-") && name.ends_with(".log") && name.len() == "app-2026-01-01.log".len())
        .collect();
    logs.sort();
    let excess = logs.len().saturating_sub(RETAINED_DAYS);
    for old in &logs[..excess] {
        let _ = std::fs::remove_file(dir.join(old));
    }
}

#[derive(Default)]
struct Fields {
    message: String,
    rest: String,
}

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
        } else {
            let _ = write!(self.rest, " {}={value:?}", field.name());
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else {
            let _ = write!(self.rest, " {}={value}", field.name());
        }
    }
}

/// `magnetar::downloads::manager` → `downloads`; other crates by their own name.
fn scope(target: &str) -> &str {
    let mut parts = target.split("::");
    match parts.next() {
        Some(OWN_CRATE) => parts.next().unwrap_or("app"),
        Some(other) => other,
        None => "app",
    }
}

impl<S: Subscriber> Layer<S> for FileLayer {
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        let meta = event.metadata();
        let level = *meta.level();
        let target = meta.target();
        let threshold = if target.starts_with(OWN_CRATE) {
            self.min_level
        } else if target.starts_with("librqbit_dht") {
            // Unreachable bootstrap routers are routine (and retried forever); only real failures matter.
            Level::ERROR
        } else {
            Level::WARN
        };
        if level > threshold {
            return;
        }
        let mut fields = Fields::default();
        event.record(&mut fields);
        let scope = scope(meta.target());
        let message = format!("{}{}", fields.message, fields.rest);
        let line = format!(
            "{} {:<5} [{scope}] {message}",
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            level.as_str()
        );
        if level <= Level::WARN {
            eprintln!("{line}");
        } else {
            println!("{line}");
        }
        self.append(&line);
        if level == Level::ERROR
            && let Some(sink) = ERROR_SINK.get()
        {
            sink(scope, &message);
        }
    }
}

/// Installs the logger. `logs` is None in tests, which only log to the console.
pub fn init(logs: Option<PathBuf>, verbose: bool) {
    let layer = FileLayer {
        dir: logs,
        min_level: if verbose { Level::DEBUG } else { Level::INFO },
        file: Mutex::new((String::new(), None)),
    };
    let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry().with(layer));
}
