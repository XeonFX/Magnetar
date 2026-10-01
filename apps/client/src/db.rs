use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rusqlite::{Connection, OptionalExtension, params};

use crate::protocol::encoding::{from_base64, random_bytes, to_base64};

/// Schema versions, applied in order and recorded in `PRAGMA user_version`. Append only: a shipped
/// migration never changes, a new one is added after it.
const MIGRATIONS: &[&str] = &[
    r"
CREATE TABLE series_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  provider TEXT,
  title_filter TEXT,
  season INTEGER,
  start_episode INTEGER NOT NULL DEFAULT 1,
  end_episode INTEGER,
  download_folder TEXT,
  last_downloaded_episode INTEGER NOT NULL DEFAULT 0,
  check_interval_minutes INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_is_placeholder INTEGER NOT NULL DEFAULT 0,
  magnet_uri TEXT NOT NULL,
  info_hash TEXT NOT NULL COLLATE NOCASE UNIQUE,
  save_path TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  start_notification_sent INTEGER NOT NULL DEFAULT 0,
  complete_notification_sent INTEGER NOT NULL DEFAULT 0,
  series_task_id INTEGER REFERENCES series_tasks(id) ON DELETE SET NULL
);
CREATE INDEX downloads_series_task ON downloads(series_task_id);
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE browser_keys (
  key_id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
",
    r"
ALTER TABLE downloads ADD COLUMN uploaded_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE downloads ADD COLUMN selected_files TEXT;
ALTER TABLE downloads ADD COLUMN episode INTEGER;
",
    r"
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES browser_keys(key_id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_key ON push_subscriptions(key_id);
",
    r"
ALTER TABLE series_tasks ADD COLUMN resolution TEXT;
ALTER TABLE series_tasks ADD COLUMN min_seeders INTEGER NOT NULL DEFAULT 1;
ALTER TABLE series_tasks ADD COLUMN max_size_mb INTEGER;
ALTER TABLE series_tasks ADD COLUMN prefer_words TEXT;
ALTER TABLE series_tasks ADD COLUMN exclude_words TEXT;
ALTER TABLE series_tasks ADD COLUMN show_info TEXT;
ALTER TABLE series_tasks ADD COLUMN show_checked_at TEXT;
CREATE TABLE series_rejects (
  task_id INTEGER NOT NULL REFERENCES series_tasks(id) ON DELETE CASCADE,
  info_hash TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (task_id, info_hash)
);
",
    r"
CREATE TABLE watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  resolution TEXT,
  min_seeders INTEGER NOT NULL DEFAULT 1,
  max_size_mb INTEGER,
  prefer_words TEXT,
  exclude_words TEXT,
  auto_download INTEGER NOT NULL DEFAULT 0,
  check_interval_minutes INTEGER NOT NULL DEFAULT 360,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_checked_at TEXT,
  found TEXT,
  download_id INTEGER
);
",
];

/// The app database. Statements are short, so one connection behind a mutex serves every service.
#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // With WAL this keeps the database consistent and syncs at checkpoints, not every write.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (version, migration) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            let tx = conn.transaction()?;
            tx.execute_batch(migration)?;
            tx.pragma_update(None, "user_version", version as i64 + 1)?;
            tx.commit()?;
        }
        Ok(Self(Arc::new(Mutex::new(conn))))
    }

    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Tiny key/value store for app state that isn't worth a table (device id, import markers…).
#[derive(Clone)]
pub struct KeyValue(pub Db);

impl KeyValue {
    pub fn get(&self, key: &str) -> Option<String> {
        self.0.lock().query_row("SELECT value FROM kv WHERE key = ?", [key], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn set(&self, key: &str, value: Option<&str>) {
        let db = self.0.lock();
        let result = match value {
            None => db.execute("DELETE FROM kv WHERE key = ?", [key]),
            Some(value) => db.execute(
                "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value],
            ),
        };
        // Logging an error can read settings, which needs the database: release it first.
        drop(db);
        if let Err(error) = result {
            tracing::error!("Could not save {key}: {error}");
        }
    }
}

/// Encrypts secrets at rest (SMTP password, bot token, agent token, device token, browser keys)
/// with AES-256-GCM under a key kept in its own owner-only file beside the database. A copied
/// database alone reveals none of them.
pub struct SecretBox {
    cipher: Aes256Gcm,
}

impl SecretBox {
    pub fn open(key_path: &Path) -> anyhow::Result<Self> {
        if !key_path.exists() {
            write_private(key_path, &random_bytes(32), true)?;
        }
        let key = std::fs::read(key_path)?;
        anyhow::ensure!(key.len() == 32, "{} is not a 32-byte key", key_path.display());
        restrict_to_owner(key_path);
        Ok(Self { cipher: Aes256Gcm::new_from_slice(&key)? })
    }

    pub fn seal(&self, plaintext: &str) -> String {
        let iv: [u8; 12] = random_bytes(12).try_into().expect("12 bytes");
        let sealed = self.cipher.encrypt(&Nonce::from(iv), plaintext.as_bytes()).expect("in-memory encryption");
        let (body, tag) = sealed.split_at(sealed.len() - 16);
        format!("v1:{}:{}:{}", to_base64(&iv), to_base64(body), to_base64(tag))
    }

    pub fn open_sealed(&self, sealed: &str) -> anyhow::Result<String> {
        let parts: Vec<&str> = sealed.split(':').collect();
        let [version, iv, body, tag] = parts[..] else { anyhow::bail!("Unrecognised secret format") };
        anyhow::ensure!(version == "v1", "Unrecognised secret format");
        let iv: [u8; 12] = from_base64(iv)?.try_into().map_err(|_| anyhow::anyhow!("Unrecognised secret format"))?;
        let mut ciphertext = from_base64(body)?;
        ciphertext.extend(from_base64(tag)?);
        let plaintext = self
            .cipher
            .decrypt(&Nonce::from(iv), ciphertext.as_slice())
            .map_err(|_| anyhow::anyhow!("Secret failed authentication"))?;
        Ok(String::from_utf8(plaintext)?)
    }
}

/// Writes a file only the current user can read. `new_only` refuses to replace an existing one.
pub fn write_private(path: &Path, contents: &[u8], new_only: bool) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    if new_only {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(contents)?;
    restrict_to_owner(path);
    Ok(())
}

/// Replaces `path` with `contents` in one step, a temporary file renamed over it, so a reader never
/// sees half a file. `private` makes it owner-only, as for secrets; otherwise it keeps the
/// permissions it had.
pub fn replace_file(path: &Path, contents: &[u8], private: bool) -> std::io::Result<()> {
    let temporary =
        path.with_file_name(format!(".{}.{}.tmp", path.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
    let written = if private {
        write_private(&temporary, contents, false)
    } else {
        std::fs::write(&temporary, contents).map(|()| {
            if let Ok(metadata) = std::fs::metadata(path) {
                let _ = std::fs::set_permissions(&temporary, metadata.permissions());
            }
        })
    };
    written.and_then(|()| std::fs::rename(&temporary, path)).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

/// POSIX: mode 600. Windows ignores modes, so inherited ACLs are replaced with the current user only.
pub fn restrict_to_owner(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    if let Ok(user) = std::env::var("USERNAME") {
        let _ =
            crate::system::hidden_command("icacls").arg(path).args(["/inheritance:r", "/grant:r", &format!("{user}:F")]).output();
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum SecretName {
    SmtpPassword,
    TelegramBotToken,
    AgentApiToken,
    DeviceToken,
}

impl SecretName {
    fn key(self) -> &'static str {
        match self {
            Self::SmtpPassword => "smtpPassword",
            Self::TelegramBotToken => "telegramBotToken",
            Self::AgentApiToken => "agentApiToken",
            Self::DeviceToken => "deviceToken",
        }
    }
}

/// Named secrets in the `secrets` table, sealed by a SecretBox. Decrypted values are cached: the
/// agent token is checked on every API request and the store is the only writer.
pub struct SecretStore {
    db: Db,
    pub(crate) sealer: Arc<SecretBox>,
    cache: Mutex<HashMap<SecretName, String>>,
}

impl SecretStore {
    pub fn new(db: Db, sealer: Arc<SecretBox>) -> Self {
        Self { db, sealer, cache: Mutex::default() }
    }

    pub fn get(&self, name: SecretName) -> String {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(value) = cache.get(&name) {
            return value.clone();
        }
        let row: Option<String> = self
            .db
            .lock()
            .query_row("SELECT value FROM secrets WHERE name = ?", [name.key()], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        // A key file replaced underneath us: treat as unset rather than crash.
        let value = row.and_then(|sealed| self.sealer.open_sealed(&sealed).ok()).unwrap_or_default();
        cache.insert(name, value.clone());
        value
    }

    pub fn set(&self, name: SecretName, value: &str) {
        let db = self.db.lock();
        let result = if value.is_empty() {
            db.execute("DELETE FROM secrets WHERE name = ?", [name.key()])
        } else {
            db.execute(
                "INSERT INTO secrets (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                params![name.key(), self.sealer.seal(value)],
            )
        };
        drop(db);
        if let Err(error) = result {
            tracing::error!("Could not save a secret: {error}");
        }
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).insert(name, value.to_owned());
    }

    pub fn has(&self, name: SecretName) -> bool {
        !self.get(name).is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn replacing_a_file_keeps_or_restricts_its_permissions_and_leaves_nothing_behind() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("settings.json");
        std::fs::write(&shared, "old").unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o644)).unwrap();
        replace_file(&shared, b"new", false).unwrap();
        assert_eq!(std::fs::read_to_string(&shared).unwrap(), "new");
        assert_eq!(std::fs::metadata(&shared).unwrap().permissions().mode() & 0o777, 0o644);

        let secret = dir.path().join("endpoint.json");
        std::fs::write(&secret, "old").unwrap();
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o644)).unwrap();
        replace_file(&secret, b"token", true).unwrap();
        assert_eq!(std::fs::metadata(&secret).unwrap().permissions().mode() & 0o777, 0o600);

        // A folder that doesn't exist fails cleanly, with no temporary file anywhere.
        assert!(replace_file(&dir.path().join("missing/x.json"), b"x", false).is_err());
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[test]
    fn sealed_secrets_round_trip_and_detect_tampering() {
        let dir = tempfile::tempdir().unwrap();
        let sealer = SecretBox::open(&dir.path().join("secret.key")).unwrap();
        let sealed = sealer.seal("hunter2");
        assert!(sealed.starts_with("v1:"));
        assert_eq!(sealer.open_sealed(&sealed).unwrap(), "hunter2");
        let tampered = sealed.replacen("v1:", "v1:A", 1);
        assert!(sealer.open_sealed(&tampered).is_err());
    }
}
