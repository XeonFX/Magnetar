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
        let origin = if target.starts_with(OWN_CRATE) { Origin::Magnetar } else { Origin::Library };
        let level = if level == Level::ERROR && describes_environment(&message, origin) { Level::WARN } else { level };
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

/// Whose code logged an error.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Origin {
    Magnetar,
    /// Another crate: librqbit, writing where the user pointed it and talking to whoever it found.
    Library,
}

/// An error describes the computer's surroundings, not a fault in Magnetar: a peer or the network dropping a
/// connection, a full disk, or a read-only one under a library's writes. The user may want to know; there is nothing
/// for us to fix. Every I/O error the message names must be one: a fault with a dropped connection in its chain stays
/// a fault. Magnetar's own writes go where Magnetar chose (an update over an app on a read-only volume), so a
/// read-only file system there stays a fault too.
pub fn describes_environment(message: &str, origin: Origin) -> bool {
    describes_environment_on(message, Os::CURRENT, origin)
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Cause {
    Connection,
    FullDisk,
    ReadOnly,
    Fault,
}

/// What an `std::io::ErrorKind`, as an I/O error's `{:?}` spells it, says about the cause.
fn kind_cause(kind: &str) -> Cause {
    match kind {
        "ConnectionReset" | "ConnectionAborted" | "ConnectionRefused" | "BrokenPipe" | "TimedOut" | "NetworkUnreachable"
        | "HostUnreachable" | "NetworkDown" => Cause::Connection,
        "StorageFull" | "QuotaExceeded" => Cause::FullDisk,
        "ReadOnlyFilesystem" => Cause::ReadOnly,
        _ => Cause::Fault,
    }
}

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

    /// The OS error codes that are not faults. The same number means something else on another system (28 is ENOSPC
    /// on Unix, ERROR_OUT_OF_PAPER on Windows), and the client only reads its own.
    fn codes(self) -> &'static [(i64, Cause)] {
        use Cause::{Connection as C, FullDisk as F, ReadOnly as R};
        match self {
            // ECONNRESET, ECONNABORTED, ECONNREFUSED, EPIPE, ETIMEDOUT, ENETUNREACH, EHOSTUNREACH, ENETDOWN; ENOSPC,
            // EDQUOT; EROFS
            Os::Linux => {
                &[(104, C), (103, C), (111, C), (32, C), (110, C), (101, C), (113, C), (100, C), (28, F), (122, F), (30, R)]
            }
            Os::Mac => &[(54, C), (53, C), (61, C), (32, C), (60, C), (51, C), (65, C), (50, C), (28, F), (69, F), (30, R)],
            // WSAECONNRESET, WSAECONNABORTED, WSAECONNREFUSED, WSAETIMEDOUT, WSAENETUNREACH, WSAEHOSTUNREACH,
            // WSAENETDOWN, ERROR_NETWORK_UNREACHABLE, ERROR_HOST_UNREACHABLE, ERROR_BROKEN_PIPE, ERROR_NO_DATA (a pipe
            // being closed); ERROR_DISK_FULL, ERROR_HANDLE_DISK_FULL, ERROR_DISK_QUOTA_EXCEEDED; ERROR_WRITE_PROTECT
            Os::Windows => &[
                (10054, C),
                (10053, C),
                (10061, C),
                (10060, C),
                (10051, C),
                (10065, C),
                (10050, C),
                (1231, C),
                (1232, C),
                (109, C),
                (232, C),
                (112, F),
                (39, F),
                (1295, F),
                (19, R),
            ],
        }
    }

    fn code_cause(self, code: &str) -> Cause {
        let code: Option<i64> = code.parse().ok();
        self.codes().iter().find(|(known, _)| Some(*known) == code).map_or(Cause::Fault, |(_, cause)| *cause)
    }
}

/// An I/O error as `{:?}` (`Os { code: 10054, kind: ConnectionReset, … }`, where the kind decides; `Kind(TimedOut)`,
/// `Custom { kind: StorageFull, … }`) and `{}` (`… (os error 28)`) write it.
static IO_ERROR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)Os \{ code: -?[0-9]+, kind: ([A-Za-z]+)|\(os error (-?[0-9]+)|(?-u:\b)(?:kind: |Kind\()([A-Za-z]+)")
        .unwrap()
});

fn describes_environment_on(message: &str, os: Os, origin: Origin) -> bool {
    let causes = IO_ERROR
        .captures_iter(message)
        .map(|caps| match (caps.get(1).or(caps.get(3)), caps.get(2)) {
            (Some(kind), _) => kind_cause(kind.as_str()),
            (_, Some(code)) => os.code_cause(code.as_str()),
            _ => Cause::Fault,
        })
        .chain(DISK_FULL_TEXT.iter().filter(|text| message.contains(*text)).map(|_| Cause::FullDisk));
    let mut any = false;
    for cause in causes {
        match cause {
            Cause::Connection | Cause::FullDisk => any = true,
            Cause::ReadOnly if origin == Origin::Library => any = true,
            _ => return false,
        }
    }
    any
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

    use super::{FileLayer, Origin, Os, describes_environment_on};

    const ALL: [Os; 3] = [Os::Linux, Os::Mac, Os::Windows];

    /// As another crate's error.
    fn environment(message: &str, os: Os) -> bool {
        describes_environment_on(message, os, Origin::Library)
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
        let cases: [(&str, Os); 16] = [
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
            ("The remote network is not reachable by the transport. (os error 1231)", Os::Windows),
            ("The remote system is not reachable by the transport. (os error 1232)", Os::Windows),
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
    fn a_read_only_disk_under_our_own_writes_is_a_fault() {
        for (message, os) in [
            ("Update install failed: Read-only file system (os error 30)", Os::Mac),
            ("Update install failed: The media is write protected. (os error 19)", Os::Windows),
            ("Custom { kind: ReadOnlyFilesystem, error: \"x\" }", Os::Linux),
        ] {
            assert!(environment(message, os), "{message}");
            assert!(!describes_environment_on(message, os, Origin::Magnetar), "{message}");
        }
        // Our own full disk and dropped connections are still the surroundings.
        assert!(describes_environment_on("Could not save downloads: database or disk is full", Os::Mac, Origin::Magnetar));
        assert!(describes_environment_on("No space left on device (os error 28)", Os::Linux, Origin::Magnetar));
        assert!(describes_environment_on(
            "Update download failed: Connection reset by peer (os error 54)",
            Os::Mac,
            Origin::Magnetar
        ));
    }

    #[test]
    fn every_io_error_named_must_be_the_surroundings() {
        // A fault whose chain also mentions a dropped connection or a full disk stays a fault.
        assert!(!environment(
            "rename failed: Invalid cross-device link (os error 18); cleanup: Broken pipe (os error 32)",
            Os::Linux
        ));
        assert!(!environment("Broken pipe (os error 32), then No such file or directory (os error 2)", Os::Mac));
        assert!(!environment("database or disk is full; Os { code: 2, kind: NotFound, message: \"x\" }", Os::Windows));
        // Several that all are, are.
        assert!(environment("send failed: Broken pipe (os error 32); retry: Connection reset by peer (os error 104)", Os::Linux));
        // The kind of the debug form decides, whatever its code.
        assert!(environment("Os { code: 10054, kind: ConnectionReset, message: \"x\" }", Os::Mac));
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
            let (code, _) = *pick.get(os.codes());
            let message = format!("{context}: {context} (os error {code})");
            prop_assert!(environment(&message, os));
        }

        #[test]
        fn text_without_an_io_error_is_reported(message in "[^():]{0,300}", os in prop::sample::select(ALL.to_vec())) {
            prop_assume!(!message.contains("disk is full"));
            prop_assert!(!environment(&message, os));
        }
    }

    /// What the error sink was handed (the sink can be set once per process).
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
            tracing::error!(target: "librqbit::session", "error writing piece: Read-only file system (os error 30)");
            tracing::error!(target: "magnetar::updates", "Update install failed: Read-only file system (os error 30)");
        });

        let reported: Vec<_> = REPORTED.lock().unwrap().clone();
        assert_eq!(
            reported,
            [
                ("librqbit_core".to_owned(), "session finished with error: invalid bencode at 7".to_owned()),
                ("settings".to_owned(), "Could not save settings: no such table: settings".to_owned()),
                ("updates".to_owned(), "Update install failed: Read-only file system (os error 30)".to_owned()),
            ]
        );
        // Sorted, so a run across midnight UTC (two daily files) still reads the lines in order.
        let mut files: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().path()).collect();
        files.sort();
        let log = files.iter().map(|path| std::fs::read_to_string(path).unwrap()).collect::<String>();
        let levels: Vec<_> = log.lines().map(|line| line.split_whitespace().nth(1).unwrap()).collect();
        assert_eq!(levels, ["WARN", "WARN", "WARN", "ERROR", "ERROR", "WARN", "ERROR"], "{log}");
        assert!(log.contains("[librqbit_dht] error dumping DHT"), "{log}");
        assert!(log.contains("filename=\"/tmp/dht.json\""), "{log}");
    }
}
