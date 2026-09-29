use std::sync::Arc;

use rusqlite::{OptionalExtension, params};

use crate::db::{Db, SecretBox};
use crate::protocol::LinkedBrowserDto;
use crate::protocol::e2e::KEY_BYTES;
use crate::protocol::encoding::{from_base64url, now_iso, random_bytes, random_id, to_base64url};

/// The keys of browsers allowed to reach this device through the relay, sealed at rest. A key is
/// minted here and leaves only inside a link fragment, so the relay never holds one.
pub struct BrowserKeyStore {
    db: Db,
    sealer: Arc<SecretBox>,
}

impl BrowserKeyStore {
    pub fn new(db: Db, sealer: Arc<SecretBox>) -> Self {
        Self { db, sealer }
    }

    /// Mints a key; `active` false keeps it unusable until pairing completes.
    pub fn mint(&self, label: &str, active: bool) -> anyhow::Result<(String, Vec<u8>)> {
        let key_id = random_id(9);
        let key = random_bytes(KEY_BYTES);
        self.db.lock().execute(
            "INSERT INTO browser_keys (key_id, key, label, created_at, active) VALUES (?, ?, ?, ?, ?)",
            params![key_id, self.sealer.seal(&to_base64url(&key)), label, now_iso(), active],
        )?;
        Ok((key_id, key))
    }

    pub fn activate(&self, key_id: &str) {
        let _ = self.db.lock().execute("UPDATE browser_keys SET active = 1 WHERE key_id = ?", [key_id]);
    }

    /// The key for a handshake, or None when unknown, inactive or revoked.
    pub fn lookup(&self, key_id: &str) -> Option<Vec<u8>> {
        let sealed: String = self
            .db
            .lock()
            .query_row("SELECT key FROM browser_keys WHERE key_id = ? AND active = 1", [key_id], |r| r.get(0))
            .optional()
            .ok()??;
        let key = from_base64url(&self.sealer.open_sealed(&sealed).ok()?).ok()?;
        (key.len() == KEY_BYTES).then_some(key)
    }

    pub fn touch(&self, key_id: &str) {
        let _ = self.db.lock().execute("UPDATE browser_keys SET last_seen_at = ? WHERE key_id = ?", params![now_iso(), key_id]);
    }

    pub fn revoke(&self, key_id: &str) {
        let _ = self.db.lock().execute("DELETE FROM browser_keys WHERE key_id = ?", [key_id]);
    }

    pub fn revoke_inactive(&self) {
        let _ = self.db.lock().execute("DELETE FROM browser_keys WHERE active = 0", []);
    }

    pub fn revoke_all(&self) {
        let _ = self.db.lock().execute("DELETE FROM browser_keys", []);
    }

    pub fn list(&self) -> Vec<LinkedBrowserDto> {
        let db = self.db.lock();
        let Ok(mut statement) =
            db.prepare("SELECT key_id, label, created_at, last_seen_at FROM browser_keys WHERE active = 1 ORDER BY created_at")
        else {
            return Vec::new();
        };
        statement
            .query_map([], |r| {
                Ok(LinkedBrowserDto { key_id: r.get(0)?, label: r.get(1)?, created_at: r.get(2)?, last_seen_at: r.get(3)? })
            })
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }
}
