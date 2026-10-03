//! Pairing with magnetar.codefusion.cc and the relay connection that lets linked browsers
//! reach this device. Everything after the handshake is sealed end to end; the Worker only moves
//! opaque frames between sockets.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use futures::future::join_all;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Bytes, Message};
use tokio_util::sync::CancellationToken;

use super::browser_keys::BrowserKeyStore;
use super::push::{PushPayload, PushSubscriptions};
use crate::app::App;
use crate::config::{CLOUD_URL, PLATFORM, USER_AGENT, VERSION};
use crate::db::{KeyValue, SecretName, SecretStore};
use crate::error::{ApiError, ApiResult};
use crate::events::EventBus;
use crate::protocol::device_name;
use crate::protocol::e2e::{
    E2ESession, FRAME_HANDSHAKE, FRAME_SEALED, Handshake, accept_browser_handshake, decode_handshake, encode_handshake,
    link_fragment,
};
use crate::protocol::encoding::{encode_uri_component, iso, parse_iso, to_base64url};
use crate::protocol::relay::{
    CLOSE_DEVICE_REMOVED, DeviceToRelay, RELAY_PING, RelayToDevice, unwrap_from_device, wrap_for_device,
};
use crate::protocol::webpush::{self, SubscriptionKeys};
use crate::protocol::{NotificationEvent, PendingPairingDto, RemoteStatusDto};
use crate::rpc::RpcSession;

const POLL: Duration = Duration::from_secs(2);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const PING_EVERY: Duration = Duration::from_secs(30);
const MAX_SESSIONS: usize = 16;
const CLOUD_TIMEOUT: Duration = Duration::from_secs(15);
const LINK_TTL: Duration = Duration::from_secs(10 * 60);
/// How long past a pairing's end the Worker still hands over an approval nobody collected: polls that could not reach it
/// keep trying until then, so an approval whose answer was lost is still collected.
const PAIRING_HANDOFF: chrono::TimeDelta = chrono::TimeDelta::minutes(10);
/// How often expired links are looked for at most: the timer stops while the computer sleeps, the expiry doesn't.
const SWEEP_EVERY: Duration = Duration::from_secs(15);

struct Pairing {
    pairing_id: String,
    poll_secret: String,
    key_id: String,
    url: String,
    expires_at: String,
    cancel: CancellationToken,
}

/// One browser behind the relay.
#[derive(Default)]
struct Connection {
    key_id: Option<String>,
    session: Option<Arc<Mutex<E2ESession>>>,
    rpc: Option<RpcSession>,
    forwarder: Option<JoinHandle<()>>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(forwarder) = self.forwarder.take() {
            forwarder.abort();
        }
    }
}

#[derive(Default)]
struct State {
    connected: bool,
    pairing: Option<Pairing>,
    last_error: Option<String>,
    relay: Option<CancellationToken>,
    writer: Option<mpsc::UnboundedSender<Message>>,
    connections: HashMap<String, Connection>,
    /// Whether a task is waiting to delete links nobody used in time.
    sweeping: bool,
}

enum Closed {
    /// The socket closed or failed; `opened` says whether it got as far as connecting.
    Dropped {
        opened: bool,
    },
    DeviceRemoved,
    Stopped,
}

pub struct RemoteService {
    /// Linked browsers' push subscriptions.
    pub pushes: PushSubscriptions,
    kv: KeyValue,
    secrets: Arc<SecretStore>,
    keys: BrowserKeyStore,
    events: EventBus,
    http: reqwest::Client,
    /// magnetar.codefusion.cc, or the Worker `MAGNETAR_CLOUD_URL` names.
    cloud_url: String,
    app: Weak<App>,
    state: Mutex<State>,
    stop: CancellationToken,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairStartResponse {
    pairing_id: String,
    poll_secret: String,
    expires_at: String,
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum PairPollResponse {
    Pending,
    Expired,
    #[serde(rename_all = "camelCase")]
    Approved {
        device_id: String,
        device_token: String,
        /// Absent from a Worker older than device names as addresses; the app's own name stands then.
        #[serde(default)]
        device_name: Option<String>,
        account_email: String,
    },
}

impl RemoteService {
    pub fn new(
        kv: KeyValue,
        secrets: Arc<SecretStore>,
        keys: BrowserKeyStore,
        events: EventBus,
        http: reqwest::Client,
        app: Weak<App>,
    ) -> Self {
        let pushes = PushSubscriptions::new(keys.db());
        Self {
            pushes,
            kv,
            secrets,
            keys,
            events,
            http,
            cloud_url: CLOUD_URL.clone(),
            app,
            state: Mutex::default(),
            stop: CancellationToken::new(),
        }
    }

    /// Sends a notification to every linked browser that asked for them, sealed for each. The Worker
    /// passes it to the browser's push service; a subscription the service no longer knows is dropped.
    pub async fn push(&self, event: &NotificationEvent) -> anyhow::Result<()> {
        let subscriptions = self.pushes.all();
        let (Some(device_id), false) = (self.device_id(), subscriptions.is_empty()) else { return Ok(()) };
        let token = self.secrets.get(SecretName::DeviceToken);
        anyhow::ensure!(!token.is_empty(), "This device is not connected to an account");
        let payload = serde_json::to_vec(&PushPayload {
            title: &event.title,
            body: &event.message,
            kind: event.kind,
            url: push_url(&device_id, self.kv.get("remote.deviceName").as_deref()),
        })?;
        let outcomes = join_all(subscriptions.iter().map(|subscription| async {
            let keys = SubscriptionKeys { p256dh: &subscription.p256dh, auth: &subscription.auth };
            let body = to_base64url(&webpush::encrypt(&keys, &payload)?);
            let answer = self
                .cloud(
                    "POST",
                    "/api/device/push",
                    Some(json!({ "endpoint": subscription.endpoint, "body": body, "ttl": 24 * 60 * 60, "urgency": "normal" })),
                    Some(&token),
                )
                .await?;
            // 404 and 410: the browser unsubscribed or the subscription expired.
            if matches!(answer["status"].as_u64(), Some(404 | 410)) {
                self.pushes.remove(&subscription.endpoint);
            } else if answer["status"].as_u64().is_none_or(|s| !(200..300).contains(&s)) {
                anyhow::bail!("the push service answered HTTP {}", answer["status"]);
            }
            anyhow::Ok(())
        }))
        .await;
        outcomes.into_iter().find(Result::is_err).unwrap_or(Ok(()))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn device_id(&self) -> Option<String> {
        self.kv.get("remote.deviceId")
    }

    pub fn device_name(&self) -> String {
        self.kv.get("remote.deviceName").unwrap_or_else(default_device_name)
    }

    pub fn start(self: &Arc<Self>) {
        // Links that went unused while the app was not running, and a watch on those still pending.
        self.keys.revoke_expired();
        self.sweep_links();
        if self.device_id().is_some() && self.secrets.has(SecretName::DeviceToken) {
            self.connect();
        }
    }

    pub fn stop(&self) {
        self.stop.cancel();
    }

    pub fn status(&self) -> RemoteStatusDto {
        let device_id = self.device_id();
        let state = self.state();
        RemoteStatusDto {
            cloud_url: self.cloud_url.clone(),
            paired: device_id.is_some(),
            browsers: if device_id.is_some() { self.keys.list() } else { Vec::new() },
            device_id,
            device_name: self.device_name(),
            account_email: self.kv.get("remote.accountEmail"),
            connected: state.connected,
            pending_pairing: state
                .pairing
                .as_ref()
                .map(|p| PendingPairingDto { url: p.url.clone(), expires_at: p.expires_at.clone() }),
            last_error: state.last_error.clone(),
        }
    }

    /// Whether this device is linked, and if so whether it is connected and to which account.
    pub fn link(&self) -> Option<(bool, Option<String>)> {
        self.device_id()?;
        Some((self.state().connected, self.kv.get("remote.accountEmail")))
    }

    fn changed(&self) {
        self.events.emit("remote.changed", self.status());
    }

    fn set_error(&self, error: Option<&str>) {
        self.state().last_error = error.map(str::to_owned);
    }

    /// Starts pairing and returns the link to open. The browser that opens it signs in, approves,
    /// and receives its key in the link fragment — so it is linked the moment pairing completes.
    pub async fn pair(self: &Arc<Self>, device_name: Option<String>) -> ApiResult<RemoteStatusDto> {
        if self.device_id().is_some() {
            return Err(ApiError::bad("This device is already connected. Disconnect it first."));
        }
        self.cancel_pairing();
        if let Some(name) = &device_name {
            self.kv.set("remote.deviceName", Some(name));
        }
        let started: PairStartResponse = serde_json::from_value(
            self.cloud(
                "POST",
                "/api/pair/start",
                Some(json!({ "name": self.device_name(), "platform": PLATFORM, "version": VERSION })),
                None,
            )
            .await?,
        )
        .map_err(|e| ApiError::internal(e.to_string()))?;
        let (key_id, key) = self.keys.mint("Browser used for pairing", false, None)?;
        let url = format!(
            "{}/pair/{}#i={}&k={}",
            self.cloud_url,
            encode_uri_component(&started.pairing_id),
            encode_uri_component(&key_id),
            to_base64url(&key)
        );
        let cancel = self.stop.child_token();
        {
            let mut state = self.state();
            state.pairing = Some(Pairing {
                pairing_id: started.pairing_id,
                poll_secret: started.poll_secret,
                key_id,
                url,
                expires_at: started.expires_at,
                cancel: cancel.clone(),
            });
            state.last_error = None;
        }
        let service = self.clone();
        tokio::spawn(async move { service.poll_pairing(cancel).await });
        self.changed();
        Ok(self.status())
    }

    pub fn cancel_pairing(&self) -> RemoteStatusDto {
        if let Some(pairing) = self.state().pairing.take() {
            pairing.cancel.cancel();
        }
        self.keys.revoke_inactive();
        self.changed();
        self.status()
    }

    async fn poll_pairing(self: Arc<Self>, cancel: CancellationToken) {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(POLL) => {}
            }
            if self.poll_pairing_once(&cancel).await {
                return;
            }
        }
    }

    /// Asks the Worker once whether the pending pairing was approved, and finishes it if so. True once there is
    /// nothing left to poll for: paired, expired, or cancelled.
    async fn poll_pairing_once(self: &Arc<Self>, cancel: &CancellationToken) -> bool {
        let Some((pairing_id, poll_secret, key_id, expires_at)) = self
            .state()
            .pairing
            .as_ref()
            .map(|p| (p.pairing_id.clone(), p.poll_secret.clone(), p.key_id.clone(), p.expires_at.clone()))
        else {
            return true;
        };
        let body = json!({ "pairingId": pairing_id, "pollSecret": poll_secret });
        let answer = self.cloud("POST", "/api/pair/poll", Some(body.clone()), None).await;
        match answer.map(serde_json::from_value::<PairPollResponse>) {
            _ if cancel.is_cancelled() => return true,
            Ok(Ok(PairPollResponse::Approved { device_id, device_token, device_name, account_email })) => {
                // Unsaved, the token is not confirmed either: the Worker hands it to the next poll again.
                if let Err(error) = self.secrets.set(SecretName::DeviceToken, &device_token) {
                    crate::log_failure!(&error, "Could not save the device token: {error}");
                    return false;
                }
                self.kv.set("remote.deviceId", Some(&device_id));
                // The name the account gave it, made unique there.
                if let Some(name) = &device_name {
                    self.kv.set("remote.deviceName", Some(name));
                }
                self.kv.set("remote.accountEmail", Some(&account_email));
                self.keys.activate(&key_id);
                self.state().pairing = None;
                tracing::info!("Paired with {account_email} as device {device_id}");
                self.connect();
                self.changed();
                // The Worker hands the token to every poll until told it arrived; unconfirmed, it drops it later.
                if let Err(error) = self.cloud("POST", "/api/pair/ack", Some(body), None).await {
                    tracing::warn!("Could not confirm the pairing to the server: {error}");
                }
                return true;
            }
            Ok(Ok(PairPollResponse::Expired)) => {
                self.expire_pairing();
                return true;
            }
            Ok(Ok(PairPollResponse::Pending)) => {}
            Ok(Err(error)) => tracing::warn!("Pairing poll returned an unexpected answer: {error}"),
            Err(error) => tracing::warn!("Pairing poll failed: {error}"),
        }
        // The Worker says when the pairing expired. Unreachable, it may have been approved with the answer lost:
        // keep asking for as long as it would still hand the approval over.
        let handoff_ended = parse_iso(&expires_at).is_some_and(|expires| expires + PAIRING_HANDOFF < chrono::Utc::now());
        if handoff_ended {
            self.expire_pairing();
        }
        handoff_ended
    }

    fn expire_pairing(&self) {
        self.set_error(Some("The pairing link expired. Start again."));
        self.cancel_pairing();
    }

    /// Disconnects from the account: revokes the device on the server and forgets every browser key.
    pub async fn unpair(&self) -> RemoteStatusDto {
        let token = self.secrets.get(SecretName::DeviceToken);
        if !token.is_empty()
            && let Err(error) = self.cloud("DELETE", "/api/device", None, Some(&token)).await
        {
            tracing::warn!("Could not revoke the device on the server; forgetting it locally anyway: {error}");
        }
        self.forget();
        self.status()
    }

    /// Renames the device, on its account first when it has one: a name another device there has is refused
    /// and nothing changes.
    pub async fn rename(&self, device_name: &str) -> ApiResult<RemoteStatusDto> {
        let token = self.secrets.get(SecretName::DeviceToken);
        let name = if token.is_empty() {
            device_name.to_owned()
        } else {
            let renamed = self.cloud("PATCH", "/api/device", Some(json!({ "name": device_name })), Some(&token)).await?;
            renamed["name"].as_str().unwrap_or(device_name).to_owned()
        };
        self.kv.set("remote.deviceName", Some(&name));
        self.changed();
        Ok(self.status())
    }

    /// Mints a key for another browser and returns the link that carries it. Unless a browser connects with it
    /// within `LINK_TTL`, the key is deleted and the dashboards see it leave the list.
    pub fn link_browser(self: &Arc<Self>, label: Option<&str>) -> ApiResult<Value> {
        let device_id = self.device_id().ok_or_else(|| ApiError::bad("Connect this device to your account first."))?;
        let label = label.map(str::trim).filter(|l| !l.is_empty()).unwrap_or("Linked browser");
        let expires_at = iso(chrono::Utc::now() + LINK_TTL);
        let (key_id, key) = self.keys.mint(label, true, Some(&expires_at))?;
        self.changed();
        self.sweep_links();
        let url = format!("{}/link#{}", self.cloud_url, link_fragment(&device_id, &key_id, &key));
        Ok(json!({ "url": url, "keyId": key_id, "expiresIn": LINK_TTL.as_secs() }))
    }

    /// Deletes each link nobody used in time when it expires, telling the dashboards, while any is pending. One
    /// task does it for every link; it ends with the last one.
    fn sweep_links(self: &Arc<Self>) {
        if std::mem::replace(&mut self.state().sweeping, true) {
            return;
        }
        let service = self.clone();
        tokio::spawn(async move {
            loop {
                let next = {
                    // Under the state lock, so a link minted meanwhile either is seen here or starts a new task.
                    let mut state = service.state();
                    let Some(next) = service.keys.next_expiry() else {
                        state.sweeping = false;
                        return;
                    };
                    next
                };
                let left = parse_iso(&next).and_then(|at| (at - chrono::Utc::now()).to_std().ok()).unwrap_or_default();
                tokio::select! {
                    _ = service.stop.cancelled() => return,
                    _ = tokio::time::sleep(left.min(SWEEP_EVERY)) => {}
                }
                if service.keys.revoke_expired() > 0 {
                    service.changed();
                }
            }
        });
    }

    /// Admits a browser that proved it holds `key_id`: false when the key was revoked or expired since its lookup.
    /// A link it came from is used now and no longer expires; on the key's first use the dashboards are told, and
    /// the one showing the link closes it.
    fn browser_connected(&self, key_id: &str) -> bool {
        let Some(first_use) = self.keys.touch(key_id) else { return false };
        if first_use {
            self.changed();
        }
        true
    }

    pub fn revoke_browser(&self, key_id: &str) -> RemoteStatusDto {
        self.keys.revoke(key_id);
        let ids: Vec<String> = self
            .state()
            .connections
            .iter()
            .filter(|(_, c)| c.key_id.as_deref() == Some(key_id))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.drop_connection(&id, true);
        }
        self.changed();
        self.status()
    }

    fn forget(&self) {
        self.kv.set("remote.deviceId", None);
        self.kv.set("remote.accountEmail", None);
        // Without its id the token is never used again; a copy left in a database that refused the write is harmless.
        if let Err(error) = self.secrets.set(SecretName::DeviceToken, "") {
            crate::log_failure!(&error, "Could not delete the device token: {error}");
        }
        self.keys.revoke_all();
        {
            let mut state = self.state();
            state.connections.clear();
            if let Some(relay) = state.relay.take() {
                relay.cancel();
            }
            state.writer = None;
            state.connected = false;
        }
        self.changed();
    }

    fn connect(self: &Arc<Self>) {
        let cancel = {
            let mut state = self.state();
            if state.relay.as_ref().is_some_and(|r| !r.is_cancelled()) || self.stop.is_cancelled() {
                return;
            }
            let cancel = self.stop.child_token();
            state.relay = Some(cancel.clone());
            cancel
        };
        let service = self.clone();
        tokio::spawn(async move { service.run_relay(cancel).await });
    }

    async fn run_relay(self: Arc<Self>, cancel: CancellationToken) {
        let mut backoff = Duration::from_secs(1);
        loop {
            let token = self.secrets.get(SecretName::DeviceToken);
            if cancel.is_cancelled() || self.device_id().is_none() || token.is_empty() {
                return;
            }
            let closed = self.relay_session(&token, &cancel).await;
            {
                let mut state = self.state();
                state.connected = false;
                state.writer = None;
                state.connections.clear();
            }
            match closed {
                Closed::Stopped => return,
                Closed::DeviceRemoved => {
                    tracing::warn!("The server no longer accepts this device; forgetting the pairing");
                    self.forget();
                    self.set_error(Some("This device was removed from your account."));
                    self.changed();
                    return;
                }
                Closed::Dropped { opened } => {
                    if opened {
                        backoff = Duration::from_secs(1);
                    } else {
                        self.set_error(Some("Could not reach the relay; retrying."));
                    }
                }
            }
            self.changed();
            let jitter = Duration::from_millis(rand::random::<u64>() % 500);
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(backoff + jitter) => {}
            }
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }

    async fn relay_session(self: &Arc<Self>, token: &str, cancel: &CancellationToken) -> Closed {
        let url = format!("{}/api/device/connect", self.cloud_url.replacen("http", "ws", 1));
        let Ok(mut request) = url.into_client_request() else { return Closed::Dropped { opened: false } };
        // A header, so the token never appears in a URL or a log line.
        let headers = request.headers_mut();
        if let (Ok(auth), Ok(agent)) = (format!("Bearer {token}").parse(), USER_AGENT.parse()) {
            headers.insert("authorization", auth);
            headers.insert("user-agent", agent);
        }
        let socket = tokio::select! {
            _ = cancel.cancelled() => return Closed::Stopped,
            connected = tokio_tungstenite::connect_async(request) => connected,
        };
        let (mut sink, mut stream) = match socket {
            Ok((socket, _)) => socket.split(),
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status().as_u16() == 401 => {
                return Closed::DeviceRemoved;
            }
            Err(error) => {
                tracing::debug!("Relay connection failed: {error}");
                return Closed::Dropped { opened: false };
            }
        };
        let (writer, mut outgoing) = mpsc::unbounded_channel::<Message>();
        let hello = serde_json::to_string(&DeviceToRelay::Hello { version: VERSION, name: &self.device_name() }).expect("JSON");
        let _ = writer.send(Message::text(hello));
        {
            let mut state = self.state();
            state.connected = true;
            state.last_error = None;
            state.writer = Some(writer.clone());
        }
        tracing::info!("Connected to the relay");
        self.changed();

        let write_task = tokio::spawn(async move {
            while let Some(message) = outgoing.recv().await {
                let closing = matches!(message, Message::Close(_));
                if sink.send(message).await.is_err() || closing {
                    break;
                }
            }
        });
        // Keeps NAT mappings and proxies from dropping an idle socket; the relay answers without waking.
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        let closed = loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = writer.send(Message::Close(Some(CloseFrame { code: CloseCode::Normal, reason: "shutting down".into() })));
                    break Closed::Stopped;
                }
                _ = ping.tick() => {
                    let _ = writer.send(Message::text(RELAY_PING));
                }
                received = stream.next() => match received {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(closed) = self.on_control(&text, &writer) {
                            break closed;
                        }
                    }
                    Some(Ok(Message::Binary(frame))) => self.on_frame(&frame, &writer),
                    Some(Ok(Message::Close(frame))) => {
                        break match frame {
                            Some(f) if u16::from(f.code) == CLOSE_DEVICE_REMOVED => Closed::DeviceRemoved,
                            _ => Closed::Dropped { opened: true },
                        };
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break Closed::Dropped { opened: true },
                },
            }
        };
        drop(writer);
        let _ = tokio::time::timeout(Duration::from_secs(2), write_task).await;
        closed
    }

    /// Text frames from the relay: a browser arrived or left, or the device was revoked.
    fn on_control(&self, text: &str, writer: &mpsc::UnboundedSender<Message>) -> Option<Closed> {
        match serde_json::from_str::<RelayToDevice>(text).ok()? {
            RelayToDevice::Open { c } => {
                let mut state = self.state();
                if state.connections.len() >= MAX_SESSIONS {
                    let _ = writer.send(close_message(&c));
                } else {
                    state.connections.insert(c, Connection::default());
                }
            }
            RelayToDevice::Close { c } => self.drop_connection(&c, false),
            RelayToDevice::Revoked => return Some(Closed::DeviceRemoved),
            RelayToDevice::Pong => {}
            RelayToDevice::Name { name } => {
                self.kv.set("remote.deviceName", Some(&name));
                self.changed();
            }
        }
        None
    }

    /// Binary frames: a browser's handshake, or a sealed RPC message.
    fn on_frame(self: &Arc<Self>, frame: &Bytes, writer: &mpsc::UnboundedSender<Message>) {
        let Some((connection_id, payload)) = unwrap_from_device(frame) else { return };
        let send = |payload: &[u8]| {
            if let Ok(wrapped) = wrap_for_device(&connection_id, payload) {
                let _ = writer.send(Message::binary(wrapped));
            }
        };
        let mut state = self.state();
        let Some(connection) = state.connections.get_mut(&connection_id) else { return };
        match payload.first() {
            Some(&FRAME_HANDSHAKE) => {
                let again = connection.session.is_some();
                // Checking the key and telling the dashboards about it don't need the state, and the status takes it.
                drop(state);
                if again {
                    return self.drop_connection(&connection_id, true);
                }
                let hello = match decode_handshake(payload) {
                    Ok(hello @ Handshake::Hello { .. }) => hello,
                    _ => return send(&encode_handshake(&Handshake::Reject { reason: "bad-hello".into() })),
                };
                let Handshake::Hello { kid, .. } = &hello else { unreachable!() };
                let Some(key) = self.keys.lookup(kid) else {
                    return send(&encode_handshake(&Handshake::Reject { reason: "unknown-key".into() }));
                };
                let (welcome, session) = match accept_browser_handshake(&hello, &key) {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        tracing::warn!("Rejected a browser handshake: {error}");
                        return send(&encode_handshake(&Handshake::Reject { reason: "bad-hello".into() }));
                    }
                };
                let Some(app) = self.app.upgrade() else { return };
                if !self.browser_connected(kid) {
                    return send(&encode_handshake(&Handshake::Reject { reason: "unknown-key".into() }));
                }
                let mut state = self.state();
                // The browser may have left meanwhile.
                let Some(connection) = state.connections.get_mut(&connection_id) else { return };
                let (rpc, mut replies) = app.rpc.connect(Some(kid.clone()));
                let session = Arc::new(Mutex::new(session));
                send(&encode_handshake(&welcome));
                // Replies and events are sealed in the order they are produced, after the welcome.
                let (sealer, writer, id) = (session.clone(), writer.clone(), connection_id.clone());
                connection.forwarder = Some(tokio::spawn(async move {
                    while let Some(message) = replies.recv().await {
                        let sealed = sealer.lock().unwrap().seal(&message);
                        let Ok(wrapped) = wrap_for_device(&id, &sealed) else { return };
                        if writer.send(Message::binary(wrapped)).is_err() {
                            return;
                        }
                    }
                }));
                connection.key_id = Some(kid.clone());
                connection.session = Some(session);
                connection.rpc = Some(rpc);
            }
            Some(&FRAME_SEALED) => {
                let (Some(session), Some(rpc)) = (&connection.session, &connection.rpc) else { return };
                let opened = session.lock().unwrap().open(payload);
                match opened {
                    Ok(message) => rpc.handle(message),
                    Err(_) => {
                        // Tampering, replay or a dropped frame: this connection can't be trusted any more.
                        drop(state);
                        self.drop_connection(&connection_id, true);
                    }
                }
            }
            _ => {}
        }
    }

    fn drop_connection(&self, connection_id: &str, notify_relay: bool) {
        let mut state = self.state();
        if state.connections.remove(connection_id).is_none() {
            return;
        }
        if notify_relay && let Some(writer) = &state.writer {
            let _ = writer.send(close_message(connection_id));
        }
    }

    /// A call to the Worker's HTTP API. Errors carry the Worker's message, fit to show.
    async fn cloud(&self, method: &str, path: &str, body: Option<Value>, bearer: Option<&str>) -> ApiResult<Value> {
        let method = reqwest::Method::from_bytes(method.as_bytes()).expect("HTTP method");
        let mut request = self.http.request(method, format!("{}{path}", self.cloud_url)).timeout(CLOUD_TIMEOUT);
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        let host = url::Url::parse(&self.cloud_url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
        let response =
            request.send().await.map_err(|_| ApiError::bad(format!("Could not reach {host}. Check the internet connection.")))?;
        let status = response.status();
        let json: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let message = json["error"].as_str().map(str::to_owned).unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
            return Err(ApiError::bad(message));
        }
        Ok(json)
    }
}

fn close_message(connection_id: &str) -> Message {
    Message::text(serde_json::to_string(&DeviceToRelay::Close { c: connection_id }).expect("JSON"))
}

fn default_device_name() -> String {
    device_name::from_hostname(&gethostname::gethostname().to_string_lossy()).unwrap_or_else(|| {
        match PLATFORM {
            "macos" => "Mac",
            "windows" => "Windows-PC",
            _ => "Linux",
        }
        .into()
    })
}

/// Where a click on a pushed notification opens the dashboard: the device's readable address
/// (`/MacBook-Pro`) under the name the account gave it, else the address by id, which the website
/// turns into the readable one.
fn push_url(device_id: &str, account_name: Option<&str>) -> String {
    match account_name.filter(|name| device_name::is_device_name(name)) {
        Some(name) => format!("/{}", encode_uri_component(name)),
        None => format!("/d/{}", encode_uri_component(device_id)),
    }
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::db::{Db, SecretBox};
    use crate::events::Event;
    use tokio::sync::broadcast;

    /// A service talking to the Worker at `cloud_url`, linked to no account.
    fn service_at(cloud_url: &str) -> (RemoteService, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("magnetar.db")).unwrap();
        let sealer = Arc::new(SecretBox::open(&dir.path().join("secret.key")).unwrap());
        let mut service = RemoteService::new(
            KeyValue(db.clone()),
            Arc::new(SecretStore::new(db.clone(), sealer.clone())),
            BrowserKeyStore::new(db, sealer),
            EventBus::default(),
            reqwest::Client::new(),
            Weak::new(),
        );
        service.cloud_url = cloud_url.to_owned();
        (service, dir)
    }

    fn linked_service() -> (Arc<RemoteService>, tempfile::TempDir) {
        let (service, dir) = service_at(&CLOUD_URL);
        service.kv.set("remote.deviceId", Some("dev_1"));
        (Arc::new(service), dir)
    }

    /// A Worker that answers each pairing poll with the next of `polls` (status, body), pending once they run out, and
    /// each confirmation with `ack_status`. `requests` lists what reached it: the path and the body.
    #[derive(Clone)]
    struct FakeCloud {
        url: String,
        requests: Arc<Mutex<Vec<(String, Value)>>>,
        polls: Arc<Mutex<std::collections::VecDeque<(u16, Value)>>>,
        ack_status: u16,
    }

    async fn fake_cloud(polls: Vec<(u16, Value)>, ack_status: u16) -> FakeCloud {
        use axum::extract::{Json, State};
        use axum::http::{StatusCode, Uri};

        async fn answer(State(cloud): State<FakeCloud>, uri: Uri, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
            cloud.requests.lock().unwrap().push((uri.path().to_owned(), body));
            let (status, answer) = if uri.path() == "/api/pair/ack" {
                (cloud.ack_status, json!({ "ok": true }))
            } else {
                cloud.polls.lock().unwrap().pop_front().unwrap_or((200, json!({ "state": "pending" })))
            };
            (StatusCode::from_u16(status).unwrap(), Json(answer))
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let cloud = FakeCloud {
            url: format!("http://{}", listener.local_addr().unwrap()),
            requests: Arc::default(),
            polls: Arc::new(Mutex::new(polls.into())),
            ack_status,
        };
        let app = axum::Router::new()
            .route("/api/pair/poll", axum::routing::post(answer))
            .route("/api/pair/ack", axum::routing::post(answer))
            .with_state(cloud.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        cloud
    }

    /// A pairing waiting for approval that ends `minutes` from now; the key of the browser that will approve it.
    fn pending_pairing(service: &RemoteService, minutes: i64) -> String {
        let (key_id, _) = service.keys.mint("Browser used for pairing", false, None).unwrap();
        service.state().pairing = Some(Pairing {
            pairing_id: "p_1".into(),
            poll_secret: "secret".into(),
            key_id: key_id.clone(),
            url: String::new(),
            expires_at: iso(chrono::Utc::now() + chrono::Duration::minutes(minutes)),
            cancel: CancellationToken::new(),
        });
        key_id
    }

    fn approved() -> (u16, Value) {
        let body = json!({
            "state": "approved", "deviceId": "d_1", "deviceToken": "token-1", "deviceName": "Studio-Mac-2", "accountEmail": "ada@example.com",
        });
        (200, body)
    }

    /// What the app sends to poll for, and to confirm, the pairing `pending_pairing` made.
    fn poll_body() -> Value {
        json!({ "pairingId": "p_1", "pollSecret": "secret" })
    }

    #[tokio::test]
    async fn an_approval_whose_answer_was_lost_is_collected_on_the_next_poll_and_confirmed() {
        let cloud = fake_cloud(vec![(502, json!({ "error": "Bad gateway" })), approved()], 200).await;
        let (service, _dir) = service_at(&cloud.url);
        let service = Arc::new(service);
        let key_id = pending_pairing(&service, 5);
        let cancel = CancellationToken::new();

        assert!(!service.poll_pairing_once(&cancel).await, "a failed poll keeps the pairing");
        assert!(service.state().pairing.is_some());
        assert_eq!(service.device_id(), None);

        assert!(service.poll_pairing_once(&cancel).await);
        assert_eq!(service.device_id().as_deref(), Some("d_1"));
        assert_eq!(service.secrets.get(SecretName::DeviceToken), "token-1");
        assert_eq!(service.device_name(), "Studio-Mac-2");
        assert_eq!(service.kv.get("remote.accountEmail").as_deref(), Some("ada@example.com"));
        assert!(service.keys.lookup(&key_id).is_some(), "the approving browser's key works now");
        assert!(service.state().pairing.is_none());
        assert_eq!(service.state().last_error, None);
        let requests = cloud.requests.lock().unwrap().clone();
        assert_eq!(
            requests,
            [
                ("/api/pair/poll".to_owned(), poll_body()),
                ("/api/pair/poll".to_owned(), poll_body()),
                ("/api/pair/ack".to_owned(), poll_body())
            ]
        );
        service.stop();
    }

    #[tokio::test]
    async fn a_token_that_could_not_be_saved_is_not_confirmed_and_is_collected_again() {
        let cloud = fake_cloud(vec![approved(), approved()], 200).await;
        let (service, _dir) = service_at(&cloud.url);
        let service = Arc::new(service);
        pending_pairing(&service, 5);
        let cancel = CancellationToken::new();
        let db = service.keys.db();
        db.lock()
            .execute_batch(
                "CREATE TEMP TRIGGER no_secret_insert BEFORE INSERT ON secrets BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;",
            )
            .unwrap();

        assert!(!service.poll_pairing_once(&cancel).await, "an unsaved token keeps the pairing");
        assert_eq!(service.device_id(), None);
        assert!(service.state().pairing.is_some());
        assert_eq!(cloud.requests.lock().unwrap().iter().filter(|r| r.0 == "/api/pair/ack").count(), 0);

        db.lock().execute_batch("DROP TRIGGER no_secret_insert;").unwrap();
        assert!(service.poll_pairing_once(&cancel).await);
        assert_eq!(service.device_id().as_deref(), Some("d_1"));
        assert_eq!(service.secrets.get(SecretName::DeviceToken), "token-1");
        assert_eq!(cloud.requests.lock().unwrap().last().map(|r| r.0.clone()).as_deref(), Some("/api/pair/ack"));
        service.stop();
    }

    #[tokio::test]
    async fn a_worker_that_cannot_take_the_confirmation_still_pairs() {
        // A Worker from before /api/pair/ack answers 404; the approval stands.
        let cloud = fake_cloud(vec![approved()], 404).await;
        let (service, _dir) = service_at(&cloud.url);
        let service = Arc::new(service);
        pending_pairing(&service, 5);

        assert!(service.poll_pairing_once(&CancellationToken::new()).await);
        assert_eq!(service.device_id().as_deref(), Some("d_1"));
        assert_eq!(service.secrets.get(SecretName::DeviceToken), "token-1");
        assert_eq!(service.state().last_error, None);
        assert_eq!(cloud.requests.lock().unwrap().last().map(|r| r.0.clone()).as_deref(), Some("/api/pair/ack"));
        service.stop();
    }

    #[tokio::test]
    async fn past_its_end_a_pairing_is_polled_until_the_handoff_ends_unless_the_worker_says_it_expired() {
        let cloud = fake_cloud(vec![(200, json!({ "state": "pending" })), (502, json!({})), (503, json!({}))], 200).await;
        let (service, _dir) = service_at(&cloud.url);
        let service = Arc::new(service);
        let cancel = CancellationToken::new();
        // Ended a minute ago by this computer's clock: the Worker's says pending, then it cannot be reached.
        pending_pairing(&service, -1);
        assert!(!service.poll_pairing_once(&cancel).await);
        assert!(!service.poll_pairing_once(&cancel).await);
        assert!(service.state().pairing.is_some());
        assert_eq!(service.state().last_error, None);

        // Unreachable until the handoff ended: given up.
        pending_pairing(&service, -11);
        assert!(service.poll_pairing_once(&cancel).await);
        assert!(service.state().pairing.is_none());
        assert_eq!(service.state().last_error.as_deref(), Some("The pairing link expired. Start again."));
        assert_eq!(service.device_id(), None);
    }

    #[tokio::test]
    async fn the_worker_saying_expired_ends_the_pairing_at_once() {
        let cloud = fake_cloud(vec![(200, json!({ "state": "expired" }))], 200).await;
        let (service, _dir) = service_at(&cloud.url);
        let service = Arc::new(service);
        let key_id = pending_pairing(&service, 5);
        assert!(service.poll_pairing_once(&CancellationToken::new()).await);
        assert!(service.state().pairing.is_none());
        assert_eq!(service.state().last_error.as_deref(), Some("The pairing link expired. Start again."));
        assert!(service.keys.lookup(&key_id).is_none());
        assert_eq!(cloud.requests.lock().unwrap().len(), 1, "nothing to confirm");
    }

    #[tokio::test]
    async fn an_approval_arriving_after_the_pairing_was_cancelled_is_not_taken() {
        let cloud = fake_cloud(vec![approved()], 200).await;
        let (service, _dir) = service_at(&cloud.url);
        let service = Arc::new(service);
        pending_pairing(&service, 5);
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(service.poll_pairing_once(&cancel).await);
        assert_eq!(service.device_id(), None);
        assert!(service.secrets.get(SecretName::DeviceToken).is_empty());
    }

    /// The browsers the last `remote.changed` waiting on `events` listed, as (key id, last used).
    fn last_listed(events: &mut broadcast::Receiver<Arc<Event>>) -> Option<Vec<(String, Option<String>)>> {
        let mut last = None;
        while let Ok(event) = events.try_recv() {
            if event.name == "remote.changed" {
                let browsers = event.data["browsers"].as_array().unwrap();
                last = Some(
                    browsers
                        .iter()
                        .map(|b| (b["keyId"].as_str().unwrap().to_owned(), b["lastSeenAt"].as_str().map(str::to_owned)))
                        .collect(),
                );
            }
        }
        last
    }

    /// Moves every pending link's expiry `minutes` from now, as if the wall clock had moved.
    fn expire_in(service: &RemoteService, minutes: i64) {
        let at = iso(chrono::Utc::now() + chrono::Duration::minutes(minutes));
        service.keys.db().lock().execute("UPDATE browser_keys SET expires_at = ? WHERE expires_at IS NOT NULL", [at]).unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_link_nobody_opens_expires_and_the_dashboards_see_it_go() {
        let (service, _dir) = linked_service();
        let mut events = service.events.subscribe();
        let link = service.link_browser(Some("My phone")).unwrap();
        let key_id = link["keyId"].as_str().unwrap().to_owned();
        assert_eq!(link["expiresIn"], json!(600));
        assert_eq!(last_listed(&mut events), Some(vec![(key_id.clone(), None)]));

        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(last_listed(&mut events), None, "nothing changes before the link expires");
        assert!(service.keys.lookup(&key_id).is_some());

        // The computer slept through the expiry: the timer did not move, the clock did.
        expire_in(&service, -1);
        tokio::time::sleep(SWEEP_EVERY).await;
        assert_eq!(last_listed(&mut events), Some(vec![]));
        assert!(service.keys.lookup(&key_id).is_none());
        assert!(service.status().browsers.is_empty());
        assert!(!service.state().sweeping, "the watch ends with the last pending link");

        // A handshake that looked the key up just before it was swept is refused and announces nothing.
        assert!(!service.browser_connected(&key_id));
        assert_eq!(last_listed(&mut events), None);
    }

    #[tokio::test(start_paused = true)]
    async fn links_expire_at_their_time_through_one_watch() {
        let (service, _dir) = linked_service();
        let first = service.link_browser(Some("Phone")).unwrap()["keyId"].as_str().unwrap().to_owned();
        let second = service.link_browser(Some("Tablet")).unwrap()["keyId"].as_str().unwrap().to_owned();
        let mut events = service.events.subscribe();

        tokio::time::sleep(Duration::from_secs(4 * 60)).await;
        assert_eq!(last_listed(&mut events), None);
        // Only the first link is due; the watch it started also takes the second.
        let now = iso(chrono::Utc::now());
        service.keys.db().lock().execute("UPDATE browser_keys SET expires_at = ? WHERE key_id = ?", (now, &first)).unwrap();
        tokio::time::sleep(SWEEP_EVERY).await;
        assert_eq!(last_listed(&mut events), Some(vec![(second.clone(), None)]));
        assert!(service.keys.lookup(&first).is_none());
        assert!(service.state().sweeping);

        expire_in(&service, -1);
        tokio::time::sleep(SWEEP_EVERY).await;
        assert_eq!(last_listed(&mut events), Some(vec![]));
        assert!(!service.state().sweeping);
    }

    #[tokio::test(start_paused = true)]
    async fn links_left_from_before_a_restart_are_swept_on_start_and_watched() {
        let (service, _dir) = linked_service();
        let stale = service.keys.mint("Phone", true, Some(&iso(chrono::Utc::now() - chrono::Duration::minutes(1)))).unwrap().0;
        let pending = service.keys.mint("Tablet", true, Some(&iso(chrono::Utc::now() + chrono::Duration::minutes(5)))).unwrap().0;
        let mut events = service.events.subscribe();

        service.start();
        assert!(service.keys.lookup(&stale).is_none());
        let rows: i64 = service.keys.db().lock().query_row("SELECT COUNT(*) FROM browser_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "the expired link is deleted, not only refused");

        expire_in(&service, -1);
        tokio::time::sleep(SWEEP_EVERY).await;
        assert_eq!(last_listed(&mut events), Some(vec![]));
        assert!(service.keys.lookup(&pending).is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_browser_is_announced_on_its_first_connection_and_keeps_its_key() {
        let (service, _dir) = linked_service();
        let other = service.link_browser(None).unwrap()["keyId"].as_str().unwrap().to_owned();
        let key_id = service.link_browser(Some("My phone")).unwrap()["keyId"].as_str().unwrap().to_owned();
        let mut events = service.events.subscribe();

        assert!(service.browser_connected(&key_id));
        let listed = last_listed(&mut events).expect("the dashboards are told");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0], (other.clone(), None));
        assert_eq!(listed[1].0, key_id);
        assert!(listed[1].1.is_some(), "the linked browser shows when it was used");

        assert!(service.browser_connected(&key_id), "it connects again");
        assert_eq!(last_listed(&mut events), None, "only the first connection is news");

        expire_in(&service, -1);
        tokio::time::sleep(SWEEP_EVERY).await;
        assert!(service.keys.lookup(&key_id).is_some(), "a used link does not expire");
        assert!(service.keys.lookup(&other).is_none());
        let names: Vec<_> = service.status().browsers.into_iter().map(|b| (b.key_id, b.label)).collect();
        assert_eq!(names, [(key_id, "My phone".to_owned())]);
    }

    #[test]
    fn an_approval_names_the_device_when_the_worker_does() {
        let approved = |body: Value| match serde_json::from_value::<PairPollResponse>(body).unwrap() {
            PairPollResponse::Approved { device_name, .. } => device_name,
            _ => panic!("not approved"),
        };
        let base = json!({ "state": "approved", "deviceId": "d_1", "deviceToken": "t", "accountEmail": "a@example.com" });
        let mut named = base.clone();
        named["deviceName"] = json!("MacBook-Pro-2");
        assert_eq!(approved(named), Some("MacBook-Pro-2".to_owned()));
        // A Worker from before names were addresses still pairs.
        assert_eq!(approved(base), None);
    }

    #[test]
    fn pushes_open_the_device_by_its_readable_name_when_the_account_gave_one() {
        assert_eq!(push_url("d_ZIZ0Gac6mtg2TvpD", Some("MacBook-Pro")), "/MacBook-Pro");
        // No name yet, or one the website could not route (a reserved word, spaces from an old version): by id.
        assert_eq!(push_url("d_ZIZ0Gac6mtg2TvpD", None), "/d/d_ZIZ0Gac6mtg2TvpD");
        assert_eq!(push_url("d_ZIZ0Gac6mtg2TvpD", Some("settings")), "/d/d_ZIZ0Gac6mtg2TvpD");
        assert_eq!(push_url("d_ZIZ0Gac6mtg2TvpD", Some("Krystian's Mac")), "/d/d_ZIZ0Gac6mtg2TvpD");
        assert_eq!(push_url("d_ZIZ0Gac6mtg2TvpD", Some("")), "/d/d_ZIZ0Gac6mtg2TvpD");
    }
}
