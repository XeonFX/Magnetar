//! Logging: `tracing` events go to stderr and a daily file in the data folder (14 days kept).
//! Errors are also handed to the error sink (telemetry), except those the computer's surroundings caused
//! (`SURROUNDINGS`), which are logged as warnings. Other crates only log warnings and up.

use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::{self, ErrorKind, Write as _};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, OnceLock};

use regex::Regex;
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
        let own = target.starts_with(OWN_CRATE);
        let threshold = if own {
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
        // Our own code decides with the error's type (`log_failure!`); another crate's error reaches us only as text.
        let level = if level == Level::ERROR && !own && library_error_from_surroundings(&message) { Level::WARN } else { level };
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

/// What the computer's surroundings do to a running app: peers and networks drop connections, disks fill up. The user
/// may want to know; there is nothing for us to fix.
const SURROUNDINGS: [ErrorKind; 10] = [
    ErrorKind::ConnectionReset,
    ErrorKind::ConnectionAborted,
    ErrorKind::ConnectionRefused,
    ErrorKind::BrokenPipe,
    ErrorKind::TimedOut,
    ErrorKind::NetworkUnreachable,
    ErrorKind::HostUnreachable,
    ErrorKind::NetworkDown,
    ErrorKind::StorageFull,
    ErrorKind::QuotaExceeded,
];

/// Whether `error`, or what caused it, is the computer's surroundings: an I/O error of `SURROUNDINGS`, or SQLite
/// finding the disk full. A read-only file system is not: Magnetar's own writes go where Magnetar chose.
pub fn caused_by_surroundings(error: &(dyn std::error::Error + 'static)) -> bool {
    std::iter::successors(Some(error), |error| error.source()).any(|error| {
        error.downcast_ref::<io::Error>().is_some_and(|error| SURROUNDINGS.contains(&error.kind()))
            || matches!(error.downcast_ref(), Some(rusqlite::Error::SqliteFailure(error, _)) if error.code == rusqlite::ErrorCode::DiskFull)
    })
}

/// `tracing::error!`, or `warn!` when `$error` was caused by the computer's surroundings (`caused_by_surroundings`):
/// a warning stays in the log and is not reported.
#[macro_export]
macro_rules! log_failure {
    ($error:expr, $($message:tt)+) => {
        if $crate::log::caused_by_surroundings($error) {
            tracing::warn!($($message)+)
        } else {
            tracing::error!($($message)+)
        }
    };
}

/// An I/O error as `{}` (`… (os error 28)`) and `{:?}` (`Os { code: 10054, kind: ConnectionReset, … }`,
/// `Kind(TimedOut)`, `Custom { kind: StorageFull, … }`) write it.
static IO_ERROR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(os error (-?[0-9]+)|(?-u:\b)(?:kind: |Kind\()([A-Za-z]+)").unwrap());

/// Whether another crate's error, by its text, is the computer's surroundings: every I/O error it names is one of
/// `SURROUNDINGS` (a fault with a dropped connection in its chain stays a fault), or a read-only file system, as
/// librqbit writes where the user pointed it. A code is read as this system's: 28 is a full disk on Unix only.
fn library_error_from_surroundings(message: &str) -> bool {
    let surroundings = |kind: ErrorKind| SURROUNDINGS.contains(&kind) || kind == ErrorKind::ReadOnlyFilesystem;
    let mut named = IO_ERROR
        .captures_iter(message)
        .map(|caps| match (caps.get(1), caps.get(2)) {
            (Some(code), _) => code.as_str().parse().is_ok_and(|code| surroundings(io::Error::from_raw_os_error(code).kind())),
            (_, Some(name)) => {
                SURROUNDINGS.iter().chain([&ErrorKind::ReadOnlyFilesystem]).any(|kind| format!("{kind:?}") == name.as_str())
            }
            _ => false,
        })
        .peekable();
    named.peek().is_some() && named.all(|surroundings| surroundings)
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

#[cfg(test)]
mod tests {
    use std::io::{self, ErrorKind};
    use std::sync::Mutex;

    use anyhow::Context as _;
    use proptest::prelude::*;

    use super::{FileLayer, SURROUNDINGS, caused_by_surroundings, library_error_from_surroundings as surroundings};

    /// `error`'s `{}`, as an anyhow chain writes it.
    fn os_error(code: i32) -> String {
        format!("tracker request failed: {}", io::Error::from_raw_os_error(code))
    }

    #[test]
    fn the_reported_library_errors_are_the_surroundings() {
        // As librqbit logged them, and as the console received them (scrubbed).
        let reset = "dht finished with error: framer failed: Recv(Os { code: 10054, kind: ConnectionReset, message: \"An existing connection was forcibly closed by the remote host.\" })";
        let reset_scrubbed =
            "dht finished with error: framer failed: Recv(Os { code: 10054, kind: ConnectionReset, message: \"…\" })";
        assert!(surroundings(reset));
        assert!(surroundings(reset_scrubbed));
        let full = "error dumping DHT: error opening \"/Users/someone/Library/Caches/com.rqbit.dht/dht.json.tmp\": No space left on device (os error 28) filename=\"/Users/someone/Library/Caches/com.rqbit.dht/dht.json\"";
        let full_scrubbed = "error dumping DHT: error opening \"…\": No space left on device (os error 28) filename=\"…\"";
        // 28 is ENOSPC on Unix, where it was reported; ERROR_OUT_OF_PAPER on Windows.
        assert_eq!(surroundings(full), cfg!(unix));
        assert_eq!(surroundings(full_scrubbed), cfg!(unix));
    }

    #[cfg(unix)]
    #[test]
    fn this_systems_codes_for_dropped_connections_and_full_or_read_only_disks() {
        for code in [
            libc::ECONNRESET,
            libc::ECONNABORTED,
            libc::ECONNREFUSED,
            libc::EPIPE,
            libc::ETIMEDOUT,
            libc::ENETUNREACH,
            libc::EHOSTUNREACH,
            libc::ENETDOWN,
            libc::ENOSPC,
            libc::EDQUOT,
            libc::EROFS,
        ] {
            assert!(surroundings(&os_error(code)), "{}", os_error(code));
        }
        for code in [libc::ENOENT, libc::EACCES, libc::EXDEV, libc::EINVAL] {
            assert!(!surroundings(&os_error(code)), "{}", os_error(code));
        }
        // Windows' numbers mean nothing here.
        assert!(!surroundings("Something (os error 10054)"));
        assert!(!surroundings("Something (os error 112)"));
    }

    #[cfg(windows)]
    #[test]
    fn this_systems_codes_for_dropped_connections_and_full_or_read_only_disks() {
        // WSAECONNRESET, WSAECONNABORTED, WSAECONNREFUSED, WSAETIMEDOUT, WSAENETUNREACH, WSAEHOSTUNREACH, WSAENETDOWN,
        // ERROR_NETWORK_UNREACHABLE, ERROR_HOST_UNREACHABLE, ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_DISK_FULL,
        // ERROR_HANDLE_DISK_FULL, ERROR_DISK_QUOTA_EXCEEDED, ERROR_WRITE_PROTECT
        for code in [10054, 10053, 10061, 10060, 10051, 10065, 10050, 1231, 1232, 109, 232, 112, 39, 1295, 19] {
            assert!(surroundings(&os_error(code)), "{}", os_error(code));
        }
        // Not found, access denied; and Unix's ENOSPC and EROFS are out of paper and a read fault here.
        for code in [2, 5, 28, 30] {
            assert!(!surroundings(&os_error(code)), "{}", os_error(code));
        }
        assert!(surroundings("Eine vorhandene Verbindung wurde vom Remotehost geschlossen. (os error 10054)"));
        assert!(surroundings("磁盘空间不足。 (os error 112) 😀"));
    }

    #[test]
    fn kinds_count_on_every_system() {
        for kind in SURROUNDINGS.into_iter().chain([ErrorKind::ReadOnlyFilesystem]) {
            let debug = format!("{:?}", io::Error::from(kind));
            assert!(surroundings(&debug), "{debug}");
            assert!(surroundings(&format!("Custom {{ kind: {kind:?}, error: \"x\" }}")), "{kind:?}");
        }
        assert!(!surroundings("Os { code: 104, kind: Uncategorized, message: \"x\" }"));
    }

    #[test]
    fn every_io_error_named_must_be_the_surroundings() {
        // A fault whose chain also mentions a dropped connection stays a fault.
        assert!(!surroundings("rename failed: Kind(CrossesDevices); cleanup: Kind(BrokenPipe)"));
        assert!(!surroundings("Kind(BrokenPipe), then Os { code: 2, kind: NotFound, message: \"x\" }"));
        // Several that all are, are.
        assert!(surroundings("send failed: Kind(BrokenPipe); retry: Kind(ConnectionReset)"));
    }

    #[test]
    fn real_faults_are_still_reported() {
        for message in [
            "",
            "Could not reset the series monitor",
            "Not enough space in the queue for another search",
            "The connection was reset by the server, then the parser failed: unexpected token",
            "timed out waiting for the engine lock",
            "database or disk is full",
            "Kind(InvalidData)",
            "kind: ConnectionResetting",
            "Error 28 in row 3 of the feed",
            "Value too large (os error 99999999999999999999999)",
            "Fehler beim Öffnen 😀 (os error 2)",
        ] {
            assert!(!surroundings(message), "{message}");
        }
    }

    #[test]
    fn unicode_and_very_long_messages() {
        let long = format!("{} Kind(StorageFull)", "é".repeat(1_000_000));
        assert!(surroundings(&long));
        assert!(!surroundings(&"é😀 space reset ".repeat(100_000)));
    }

    #[test]
    fn our_own_errors_by_their_type() {
        let full = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(13), Some("database or disk is full".into()));
        assert!(caused_by_surroundings(&full));
        let locked = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(5), Some("database is locked".into()));
        assert!(!caused_by_surroundings(&locked));
        let staged = Err::<(), _>(io::Error::from(ErrorKind::StorageFull)).context("staging the update").unwrap_err();
        assert!(caused_by_surroundings(staged.as_ref()));
        let reset =
            Err::<(), _>(io::Error::from(ErrorKind::ConnectionReset)).context("downloading").context("update").unwrap_err();
        assert!(caused_by_surroundings(reset.as_ref()));
        // Magnetar chose where to write: a read-only volume there is ours to fix.
        assert!(!caused_by_surroundings(&io::Error::from(ErrorKind::ReadOnlyFilesystem)));
        assert!(!caused_by_surroundings(&io::Error::from(ErrorKind::NotFound)));
        assert!(!caused_by_surroundings(anyhow::anyhow!("No space left on device (os error 28)").as_ref()));
    }

    proptest! {
        #[test]
        fn any_context_around_a_surroundings_error_is_the_surroundings(
            context in "\\PC{0,200}",
            pick in any::<prop::sample::Index>(),
        ) {
            let kind = *pick.get(&SURROUNDINGS);
            let message = format!("{context}: {context}: {:?}", io::Error::from(kind));
            prop_assert!(surroundings(&message));
        }

        #[test]
        fn text_without_an_io_error_is_reported(message in "[^():]{0,300}") {
            prop_assert!(!surroundings(&message));
        }
    }

    /// What the error sink was handed (it can be set once).
    static REPORTED: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

    #[test]
    fn the_logger_writes_the_surroundings_as_warnings_and_reports_only_faults() {
        super::set_error_sink(|scope, message| REPORTED.lock().unwrap().push((scope.to_owned(), message.to_owned())));
        let dir = tempfile::tempdir().unwrap();
        let layer = FileLayer { dir: Some(dir.path().to_path_buf()), min_level: tracing::Level::INFO, file: Mutex::default() };
        let subscriber = tracing_subscriber::layer::SubscriberExt::with(tracing_subscriber::registry(), layer);
        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(target: "librqbit_dht::persistence", filename = ?"/tmp/dht.json", "error dumping DHT: Kind(StorageFull)");
            tracing::error!(target: "librqbit_core::spawn_utils", "dht finished with error: framer failed: Recv(Os {{ code: 10054, kind: ConnectionReset, message: \"x\" }})");
            tracing::error!(target: "librqbit::session", "error writing piece: Kind(ReadOnlyFilesystem)");
            tracing::error!(target: "librqbit_core::spawn_utils", "session finished with error: invalid bencode at 7");
            // Our own code decides with the error's type; text alone is not second-guessed.
            tracing::error!(target: "magnetar::settings", "Could not save settings: Kind(StorageFull)");
            let full = io::Error::from(ErrorKind::StorageFull);
            crate::log_failure!(&full, target: "magnetar::downloads::manager", "Could not save downloads: {full}");
            let read_only = io::Error::from(ErrorKind::ReadOnlyFilesystem);
            crate::log_failure!(&read_only, target: "magnetar::updates", "Update install failed: {read_only}");
        });

        let reported: Vec<_> = REPORTED.lock().unwrap().clone();
        assert_eq!(
            reported,
            [
                ("librqbit_core".to_owned(), "session finished with error: invalid bencode at 7".to_owned()),
                ("settings".to_owned(), "Could not save settings: Kind(StorageFull)".to_owned()),
                ("updates".to_owned(), "Update install failed: read-only filesystem or storage medium".to_owned()),
            ]
        );
        let mut files: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().path()).collect();
        files.sort();
        let log: String = files.iter().map(|path| std::fs::read_to_string(path).unwrap()).collect();
        let levels: Vec<_> = log.lines().map(|line| line.split_whitespace().nth(1).unwrap()).collect();
        assert_eq!(levels, ["WARN", "WARN", "WARN", "ERROR", "ERROR", "WARN", "ERROR"], "{log}");
        assert!(log.contains("[librqbit_dht] error dumping DHT"), "{log}");
        assert!(log.contains("filename=\"/tmp/dht.json\""), "{log}");
        assert!(log.contains("[downloads] Could not save downloads"), "{log}");
    }
}
