//! Logging: `tracing` events go to stderr and a daily file in the data folder (14 days kept).
//! Errors are also handed to the error sink (telemetry), except those describing the computer's surroundings
//! (`describes_environment`), which are logged as warnings. Other crates only log warnings and up.

use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
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
        let level = if level == Level::ERROR && describes_environment(&message) { Level::WARN } else { level };
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

/// An error describes the computer's surroundings, not a fault in Magnetar: a peer or the network dropping a
/// connection, a full or read-only disk. The user may want to know; there is nothing for us to fix.
pub fn describes_environment(message: &str) -> bool {
    describes_environment_on(message, Os::CURRENT)
}

/// The `std::io::ErrorKind`s of such errors, as an I/O error's `{:?}` spells them.
const ENVIRONMENT_KINDS: [&str; 11] = [
    "ConnectionReset",
    "ConnectionAborted",
    "ConnectionRefused",
    "BrokenPipe",
    "TimedOut",
    "NetworkUnreachable",
    "HostUnreachable",
    "NetworkDown",
    "StorageFull",
    "QuotaExceeded",
    "ReadOnlyFilesystem",
];

/// SQLite's words for a full disk, and rusqlite's when SQLite gave none (`SQLITE_FULL` is 13).
const DISK_FULL_TEXT: [&str; 2] = ["database or disk is full", "Error code 13: "];

#[derive(Clone, Copy, Debug)]
enum Os {
    Linux,
    Mac,
    Windows,
}

impl Os {
    const CURRENT: Os = if cfg!(windows) {
        Os::Windows
    } else if cfg!(target_os = "macos") {
        Os::Mac
    } else {
        Os::Linux
    };

    /// The OS error codes of `ENVIRONMENT_KINDS`. The same number means something else on another system (28 is
    /// ENOSPC on Unix, ERROR_OUT_OF_PAPER on Windows), and the client only reads its own.
    fn environment_codes(self) -> &'static [i64] {
        match self {
            // ECONNRESET, ECONNABORTED, ECONNREFUSED, EPIPE, ETIMEDOUT, ENETUNREACH, EHOSTUNREACH, ENETDOWN, ENOSPC,
            // EDQUOT, EROFS
            Os::Linux => &[104, 103, 111, 32, 110, 101, 113, 100, 28, 122, 30],
            Os::Mac => &[54, 53, 61, 32, 60, 51, 65, 50, 28, 69, 30],
            // WSAECONNRESET, WSAECONNABORTED, WSAECONNREFUSED, WSAETIMEDOUT, WSAENETUNREACH, WSAEHOSTUNREACH,
            // WSAENETDOWN, ERROR_BROKEN_PIPE, ERROR_NO_DATA (a pipe being closed), ERROR_DISK_FULL,
            // ERROR_HANDLE_DISK_FULL, ERROR_DISK_QUOTA_EXCEEDED, ERROR_WRITE_PROTECT
            Os::Windows => &[10054, 10053, 10061, 10060, 10051, 10065, 10050, 109, 232, 112, 39, 1295, 19],
        }
    }
}

/// An I/O error as `{}` (`… (os error 28)`) and `{:?}` (`Os { code: 10054, kind: ConnectionReset, … }`,
/// `Kind(TimedOut)`, `Custom { kind: StorageFull, … }`) write it.
static IO_ERROR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:\(os error |\bOs \{ code: )(-?\d+)|\b(?:kind: |Kind\()(\w+)").unwrap());

fn describes_environment_on(message: &str, os: Os) -> bool {
    DISK_FULL_TEXT.iter().any(|text| message.contains(text))
        || IO_ERROR.captures_iter(message).any(|caps| match (caps.get(1), caps.get(2)) {
            (Some(code), _) => code.as_str().parse().is_ok_and(|code: i64| os.environment_codes().contains(&code)),
            (_, Some(kind)) => ENVIRONMENT_KINDS.contains(&kind.as_str()),
            _ => false,
        })
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
    use std::sync::Mutex;

    use proptest::prelude::*;

    use super::{FileLayer, Os, describes_environment_on};

    const ALL: [Os; 3] = [Os::Linux, Os::Mac, Os::Windows];

    fn environment(message: &str, os: Os) -> bool {
        describes_environment_on(message, os)
    }

    #[test]
    fn the_reported_dht_errors_are_environment_on_their_systems() {
        // As librqbit logged them, and as the console received them (scrubbed).
        let reset = "dht finished with error: framer failed: Recv(Os { code: 10054, kind: ConnectionReset, message: \"An existing connection was forcibly closed by the remote host.\" })";
        let reset_scrubbed =
            "dht finished with error: framer failed: Recv(Os { code: 10054, kind: ConnectionReset, message: \"…\" })";
        let full = "error dumping DHT: error opening \"/Users/someone/Library/Caches/com.rqbit.dht/dht.json.tmp\": No space left on device (os error 28) filename=\"/Users/someone/Library/Caches/com.rqbit.dht/dht.json\"";
        let full_scrubbed = "error dumping DHT: error opening \"…\": No space left on device (os error 28) filename=\"…\"";
        for message in [reset, reset_scrubbed] {
            assert!(environment(message, Os::Windows), "{message}");
        }
        for message in [full, full_scrubbed] {
            assert!(environment(message, Os::Mac), "{message}");
            assert!(environment(message, Os::Linux), "{message}");
        }
    }

    #[test]
    fn dropped_connections_on_each_system() {
        let cases: [(&str, Os); 14] = [
            ("Connection reset by peer (os error 104)", Os::Linux),
            ("Connection reset by peer (os error 54)", Os::Mac),
            ("An existing connection was forcibly closed by the remote host. (os error 10054)", Os::Windows),
            ("Software caused connection abort (os error 103)", Os::Linux),
            ("An established connection was aborted by the software in your host machine. (os error 10053)", Os::Windows),
            ("Broken pipe (os error 32)", Os::Mac),
            ("The pipe is being closed. (os error 232)", Os::Windows),
            ("Operation timed out (os error 60)", Os::Mac),
            ("A connection attempt failed because the connected party did not properly respond (os error 10060)", Os::Windows),
            ("Network is unreachable (os error 101)", Os::Linux),
            ("No route to host (os error 65)", Os::Mac),
            ("A socket operation was attempted to an unreachable host. (os error 10065)", Os::Windows),
            ("A socket operation was attempted to an unreachable network. (os error 10051)", Os::Windows),
            ("Connection refused (os error 111)", Os::Linux),
        ];
        for (message, os) in cases {
            assert!(environment(&format!("tracker request failed: {message}"), os), "{message}");
        }
    }

    #[test]
    fn full_and_read_only_disks_on_each_system() {
        let cases: [(&str, Os); 9] = [
            ("No space left on device (os error 28)", Os::Linux),
            ("Disk quota exceeded (os error 122)", Os::Linux),
            ("Disc quota exceeded (os error 69)", Os::Mac),
            ("Read-only file system (os error 30)", Os::Mac),
            ("There is not enough space on the disk. (os error 112)", Os::Windows),
            ("The disk is full. (os error 39)", Os::Windows),
            ("The media is write protected. (os error 19)", Os::Windows),
            ("Could not save downloads: database or disk is full", Os::Windows),
            ("Could not save settings: Error code 13: Insertion failed because database is full", Os::Linux),
        ];
        for (message, os) in cases {
            assert!(environment(message, os), "{message}");
        }
    }

    #[test]
    fn io_error_kinds_count_on_every_system() {
        for message in [
            "Kind(TimedOut)",
            "Custom { kind: StorageFull, error: \"no storage space\" }",
            "Os { code: -1, kind: ReadOnlyFilesystem, message: \"x\" }",
            "Os { code: 0, kind: NetworkDown, message: \"x\" }",
            "Custom { kind: QuotaExceeded, error: \"x\" }",
        ] {
            for os in ALL {
                assert!(environment(message, os), "{message}");
            }
        }
    }

    #[test]
    fn a_number_means_its_own_system_only() {
        // ERROR_OUT_OF_PAPER and ERROR_READ_FAULT on Windows; EXFULL and EHOSTDOWN on Linux; 10054 is no errno.
        assert!(!environment("Write failed (os error 28)", Os::Windows));
        assert!(!environment("Read failed (os error 30)", Os::Windows));
        assert!(!environment("Exchange full (os error 54)", Os::Linux));
        assert!(!environment("Host is down (os error 112)", Os::Linux));
        assert!(!environment("Something (os error 10054)", Os::Mac));
        assert!(!environment("Os { code: 104, kind: Uncategorized, message: \"x\" }", Os::Mac));
    }

    #[test]
    fn real_faults_are_still_reported() {
        for message in [
            "",
            "Could not reset the series monitor",
            "Not enough space in the queue for another search",
            "The connection was reset by the server, then the parser failed: unexpected token",
            "timed out waiting for the engine lock",
            "Disk is full of surprises",
            "No such file or directory (os error 2)",
            "Os { code: 2, kind: NotFound, message: \"No such file or directory\" }",
            "Kind(InvalidData)",
            "Permission denied (os error 13)",
            "Access is denied. (os error 5)",
            "kind: ConnectionResetting",
            "Value too large (os error 280)",
            "Error 28 in row 3 of the feed",
            "(os error 99999999999999999999999)",
            "Fehler beim Öffnen 😀 (os error 2)",
        ] {
            for os in ALL {
                assert!(!environment(message, os), "{message} on {os:?}");
            }
        }
    }

    #[test]
    fn unicode_and_very_long_messages() {
        let localized = "Eine vorhandene Verbindung wurde vom Remotehost geschlossen. (os error 10054)";
        assert!(environment(localized, Os::Windows));
        assert!(environment("磁盘空间不足。 (os error 112) 😀", Os::Windows));
        let long = format!("{} (os error 28)", "é".repeat(1_000_000));
        assert!(environment(&long, Os::Linux));
        assert!(!environment(&"é😀 space reset ".repeat(100_000), Os::Linux));
    }

    proptest! {
        #[test]
        fn any_context_around_an_environment_error_is_environment(
            context in "\\PC{0,200}",
            os in prop::sample::select(ALL.to_vec()),
            pick in any::<prop::sample::Index>(),
        ) {
            let code = *pick.get(os.environment_codes());
            let message = format!("{context}: {context} (os error {code})");
            prop_assert!(environment(&message, os));
        }

        #[test]
        fn text_without_an_io_error_is_reported(message in "[^():]{0,300}", os in prop::sample::select(ALL.to_vec())) {
            prop_assume!(!message.contains("disk is full"));
            prop_assert!(!environment(&message, os));
        }
    }

    /// What the error sink was handed, from every test of this module (the sink can be set once).
    static REPORTED: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

    #[test]
    fn the_logger_writes_environment_errors_as_warnings_and_reports_only_faults() {
        super::set_error_sink(|scope, message| REPORTED.lock().unwrap().push((scope.to_owned(), message.to_owned())));
        let dir = tempfile::tempdir().unwrap();
        let layer = FileLayer { dir: Some(dir.path().to_path_buf()), min_level: tracing::Level::INFO, file: Mutex::default() };
        let subscriber = tracing_subscriber::layer::SubscriberExt::with(tracing_subscriber::registry(), layer);
        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(target: "librqbit_dht::persistence", filename = ?"/tmp/dht.json", "error dumping DHT: error opening \"/tmp/dht.json.tmp\": No space left on device (os error 28)");
            tracing::error!(target: "librqbit_core::spawn_utils", "dht finished with error: framer failed: Recv(Os {{ code: 10054, kind: ConnectionReset, message: \"x\" }})");
            tracing::error!(target: "magnetar::downloads::manager", "Could not save downloads: database or disk is full");
            tracing::error!(target: "librqbit_core::spawn_utils", "session finished with error: invalid bencode at 7");
            tracing::error!(target: "magnetar::settings", "Could not save settings: no such table: settings");
        });

        let reported: Vec<_> = REPORTED.lock().unwrap().clone();
        assert_eq!(
            reported,
            [
                ("librqbit_core".to_owned(), "session finished with error: invalid bencode at 7".to_owned()),
                ("settings".to_owned(), "Could not save settings: no such table: settings".to_owned()),
            ]
        );
        let log = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap())
            .collect::<String>();
        let levels: Vec<_> = log.lines().map(|line| line.split_whitespace().nth(1).unwrap()).collect();
        assert_eq!(levels, ["WARN", "WARN", "WARN", "ERROR", "ERROR"], "{log}");
        assert!(log.contains("[librqbit_dht] error dumping DHT"), "{log}");
        assert!(log.contains("filename=\"/tmp/dht.json\""), "{log}");
    }
}
