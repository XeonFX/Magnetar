//! Browser notifications that arrive with the website closed. A linked browser gives the device its
//! push subscription over the encrypted channel; the device seals each notification for it (see
//! `protocol::webpush`) and the Worker, which holds the signing key push services want, only passes
//! the ciphertext on.

use rusqlite::params;
use serde::Serialize;

use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::protocol::encoding::{from_base64url, now_iso};

pub struct PushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

/// What a notification shows, as the website's service worker reads it.
#[derive(Serialize)]
pub struct PushPayload<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub kind: &'a str,
    /// Where a click takes the browser: this device's dashboard.
    pub url: String,
}

/// Push services this app sends to: the ones the Worker's `@codefusion-cc/web-push` sends to, which
/// refuses anything else too. Refusing it here as well means a subscription can't turn the device
/// into a way to make requests elsewhere.
const PUSH_HOSTS: [&str; 4] =
    ["fcm.googleapis.com", "updates.push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];
/// The package's `MAX_ENDPOINT_LENGTH`: longer than any address the push services hand out.
const MAX_ENDPOINT_LENGTH: usize = 1024;

pub fn is_push_service(endpoint: &str) -> bool {
    let Ok(url) = url::Url::parse(endpoint) else { return false };
    let Some(host) = url.host_str() else { return false };
    endpoint.len() <= MAX_ENDPOINT_LENGTH
        && url.scheme() == "https"
        && url.port().is_none()
        && PUSH_HOSTS.iter().any(|allowed| if allowed.starts_with('.') { host.ends_with(allowed) } else { host == *allowed })
}

pub struct PushSubscriptions {
    db: Db,
}

impl PushSubscriptions {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Stores a browser's subscription under its key; revoking the key removes it.
    pub fn add(&self, key_id: &str, endpoint: &str, p256dh: &str, auth: &str) -> ApiResult<()> {
        if !is_push_service(endpoint) {
            return Err(ApiError::bad("That is not a push service this app sends to."));
        }
        let p256dh_ok = from_base64url(p256dh).is_ok_and(|k| k.len() == 65 && k[0] == 4);
        let auth_ok = from_base64url(auth).is_ok_and(|a| a.len() == 16);
        if !p256dh_ok || !auth_ok {
            return Err(ApiError::bad("The subscription's keys are not valid."));
        }
        self.db.lock().execute(
            "INSERT INTO push_subscriptions (endpoint, key_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET key_id = excluded.key_id, p256dh = excluded.p256dh, auth = excluded.auth",
            params![endpoint, key_id, p256dh, auth, now_iso()],
        )?;
        Ok(())
    }

    pub fn remove(&self, endpoint: &str) {
        let _ = self.db.lock().execute("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
    }

    pub fn contains(&self, endpoint: &str) -> bool {
        self.db.lock().query_row("SELECT 1 FROM push_subscriptions WHERE endpoint = ?", [endpoint], |_| Ok(())).is_ok()
    }

    pub fn all(&self) -> Vec<PushSubscription> {
        let db = self.db.lock();
        let Ok(mut statement) = db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions") else { return Vec::new() };
        statement
            .query_map([], |r| Ok(PushSubscription { endpoint: r.get(0)?, p256dh: r.get(1)?, auth: r.get(2)? }))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn is_empty(&self) -> bool {
        !self.db.lock().query_row("SELECT 1 FROM push_subscriptions LIMIT 1", [], |_| Ok(())).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_browsers_push_services_are_reachable() {
        for good in [
            "https://fcm.googleapis.com/fcm/send/abc:def",
            "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
            "https://web.push.apple.com/QGuQyavXutnMH",
            "https://wns2-par02p.notify.windows.com/w/?token=AwYAAA",
        ] {
            assert!(is_push_service(good), "{good}");
        }
        for bad in [
            "http://fcm.googleapis.com/fcm/send/x",
            "https://fcm.googleapis.com:8443/x",
            "https://evil.example/fcm.googleapis.com",
            "https://fcm.googleapis.com.evil.example/x",
            "https://push.apple.com.evil.example/x",
            "https://notify.windows.com/x",
            "https://169.254.169.254/latest",
            "not a url",
            &format!("https://fcm.googleapis.com/{}", "a".repeat(1024)),
        ] {
            assert!(!is_push_service(bad), "{bad}");
        }
    }
}
