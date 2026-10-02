use std::sync::Arc;

use rusqlite::{OptionalExtension, params};

use crate::db::{Db, SecretBox};
use crate::protocol::LinkedBrowserDto;
use crate::protocol::e2e::KEY_BYTES;
use crate::protocol::encoding::{from_base64url, now_iso, random_bytes, random_id, to_base64url};

/// The condition on a key's expiry, `now` (ISO) being the statement's last parameter.
const UNEXPIRED: &str = "(expires_at IS NULL OR expires_at > ?)";

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

    pub fn db(&self) -> Db {
        self.db.clone()
    }

    /// Mints a key; `active` false keeps it unusable until pairing completes. A key with `expires_at` (ISO, a
    /// link nobody has opened yet) stops working then, unless a browser has connected with it first.
    pub fn mint(&self, label: &str, active: bool, expires_at: Option<&str>) -> anyhow::Result<(String, Vec<u8>)> {
        let key_id = random_id(9);
        let key = random_bytes(KEY_BYTES);
        self.db.lock().execute(
            "INSERT INTO browser_keys (key_id, key, label, created_at, active, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![key_id, self.sealer.seal(&to_base64url(&key)), label, now_iso(), active, expires_at],
        )?;
        Ok((key_id, key))
    }

    pub fn activate(&self, key_id: &str) {
        let _ = self.db.lock().execute("UPDATE browser_keys SET active = 1 WHERE key_id = ?", [key_id]);
    }

    /// The key for a handshake, or None when unknown, inactive, expired or revoked.
    pub fn lookup(&self, key_id: &str) -> Option<Vec<u8>> {
        let sealed: String = self
            .db
            .lock()
            .query_row(
                &format!("SELECT key FROM browser_keys WHERE key_id = ? AND active = 1 AND {UNEXPIRED}"),
                params![key_id, now_iso()],
                |r| r.get(0),
            )
            .optional()
            .ok()??;
        let key = from_base64url(&self.sealer.open_sealed(&sealed).ok()?).ok()?;
        (key.len() == KEY_BYTES).then_some(key)
    }

    /// Records a connection with the key; a link that is used no longer expires. None, recording nothing, when the
    /// key is gone, inactive or expired by now (revoked or swept since its lookup); otherwise whether this was the
    /// key's first use.
    pub fn touch(&self, key_id: &str) -> Option<bool> {
        let now = now_iso();
        let db = self.db.lock();
        let first_use: bool = db
            .query_row(
                &format!("SELECT last_seen_at IS NULL FROM browser_keys WHERE key_id = ? AND active = 1 AND {UNEXPIRED}"),
                params![key_id, now],
                |r| r.get(0),
            )
            .optional()
            .ok()??;
        db.execute("UPDATE browser_keys SET last_seen_at = ?, expires_at = NULL WHERE key_id = ?", params![now, key_id]).ok()?;
        Some(first_use)
    }

    pub fn revoke(&self, key_id: &str) {
        let _ = self.db.lock().execute("DELETE FROM browser_keys WHERE key_id = ?", [key_id]);
    }

    pub fn revoke_inactive(&self) {
        let _ = self.db.lock().execute("DELETE FROM browser_keys WHERE active = 0", []);
    }

    /// Deletes every link that expired unused; returns how many.
    pub fn revoke_expired(&self) -> usize {
        self.db.lock().execute("DELETE FROM browser_keys WHERE expires_at <= ?", [now_iso()]).unwrap_or(0)
    }

    /// When the next link nobody has used yet expires (ISO), if there is one.
    pub fn next_expiry(&self) -> Option<String> {
        self.db.lock().query_row("SELECT MIN(expires_at) FROM browser_keys", [], |r| r.get(0)).ok()?
    }

    pub fn revoke_all(&self) {
        let _ = self.db.lock().execute("DELETE FROM browser_keys", []);
    }

    pub fn list(&self) -> Vec<LinkedBrowserDto> {
        let db = self.db.lock();
        let Ok(mut statement) =
            db.prepare(&format!(
                "SELECT key_id, label, created_at, last_seen_at FROM browser_keys WHERE active = 1 AND {UNEXPIRED} ORDER BY created_at"
            ))
        else {
            return Vec::new();
        };
        statement
            .query_map([now_iso()], |r| {
                Ok(LinkedBrowserDto { key_id: r.get(0)?, label: r.get(1)?, created_at: r.get(2)?, last_seen_at: r.get(3)? })
            })
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SecretBox;
    use crate::protocol::encoding::iso;

    fn store() -> (BrowserKeyStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("magnetar.db")).unwrap();
        let sealer = Arc::new(SecretBox::open(&dir.path().join("secret.key")).unwrap());
        (BrowserKeyStore::new(db, sealer), dir)
    }

    fn at(minutes: i64) -> String {
        iso(chrono::Utc::now() + chrono::Duration::minutes(minutes))
    }

    fn listed(store: &BrowserKeyStore) -> Vec<String> {
        store.list().into_iter().map(|b| b.key_id).collect()
    }

    #[test]
    fn a_link_nobody_used_in_time_is_refused_and_swept_even_after_a_restart() {
        let (store, _dir) = store();
        let (fresh, _) = store.mint("Phone", true, Some(&at(10))).unwrap();
        let (stale, _) = store.mint("Tablet", true, Some(&at(-1))).unwrap();
        let (paired, _) = store.mint("Browser used for pairing", true, None).unwrap();

        assert!(store.lookup(&fresh).is_some());
        assert!(store.lookup(&stale).is_none(), "an expired link must not open a connection");
        assert_eq!(listed(&store), [fresh.clone(), paired.clone()]);

        assert_eq!(store.revoke_expired(), 1);
        assert_eq!(store.revoke_expired(), 0);
        let rows: i64 = store.db.lock().query_row("SELECT COUNT(*) FROM browser_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 2, "only the expired link is deleted");
    }

    #[test]
    fn a_used_link_no_longer_expires_but_an_expired_one_is_not_revived() {
        let (store, _dir) = store();
        let (used, _) = store.mint("Phone", true, Some(&at(10))).unwrap();
        let (late, _) = store.mint("Tablet", true, Some(&at(-1))).unwrap();
        let (pending, _) = store.mint("Browser used for pairing", false, None).unwrap();
        assert_eq!(store.touch(&used), Some(true), "the first connection");
        assert_eq!(store.touch(&used), Some(false));
        assert_eq!(store.touch(&late), None, "an expired link is not usable");
        assert_eq!(store.touch("unknown"), None);
        assert_eq!(store.touch(&pending), None, "a key pairing has not activated is not usable");
        assert!(store.list()[0].last_seen_at.is_some());

        // Time passes: whatever still has an expiry is past it now.
        store.db.lock().execute("UPDATE browser_keys SET expires_at = ? WHERE expires_at IS NOT NULL", [at(-60)]).unwrap();
        assert_eq!(store.revoke_expired(), 1);
        assert!(store.lookup(&used).is_some());
        assert!(store.lookup(&late).is_none());
        assert_eq!(store.touch(&late), None);
    }

    #[test]
    fn the_next_expiry_is_the_soonest_unused_link() {
        let (store, _dir) = store();
        assert_eq!(store.next_expiry(), None);
        store.mint("Browser used for pairing", true, None).unwrap();
        assert_eq!(store.next_expiry(), None, "a key without an expiry is not a pending link");
        let (later, soon) = (at(10), at(5));
        let (first, _) = store.mint("Phone", true, Some(&later)).unwrap();
        let (second, _) = store.mint("Tablet", true, Some(&soon)).unwrap();
        assert_eq!(store.next_expiry(), Some(soon));
        store.touch(&second);
        assert_eq!(store.next_expiry(), Some(later));
        store.revoke(&first);
        assert_eq!(store.next_expiry(), None);
    }
}
