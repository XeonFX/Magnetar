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
use crate::protocol::encoding::{encode_uri_component, parse_iso, to_base64url};
use crate::protocol::relay::{
    CLOSE_DEVICE_REMOVED, DeviceToRelay, MAX_RELAY_FRAME, RELAY_PING, RelayToDevice, unwrap_from_device, wrap_for_device,
};
use crate::protocol::webpush::{self, SubscriptionKeys};
use crate::protocol::{NotificationEvent, PendingPairingDto, RemoteStatusDto};
use crate::rpc::RpcSession;

const POLL: Duration = Duration::from_secs(2);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const PING_EVERY: Duration = Duration::from_secs(30);
const MAX_SESSIONS: usize = 16;
const CLOUD_TIMEOUT: Duration = Duration::from_secs(15);

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
        device_name: String,
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
        Self { pushes, kv, secrets, keys, events, http, app, state: Mutex::default(), stop: CancellationToken::new() }
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
            url: format!("/d/{}", encode_uri_component(&device_id)),
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
            cloud_url: CLOUD_URL.clone(),
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
        let (key_id, key) = self.keys.mint("Browser used for pairing", false)?;
        let url = format!(
            "{}/pair/{}#i={}&k={}",
            *CLOUD_URL,
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
            let Some((pairing_id, poll_secret, key_id, expires_at)) = self
                .state()
                .pairing
                .as_ref()
                .map(|p| (p.pairing_id.clone(), p.poll_secret.clone(), p.key_id.clone(), p.expires_at.clone()))
            else {
                return;
            };
            let body = json!({ "pairingId": pairing_id, "pollSecret": poll_secret });
            match self.cloud("POST", "/api/pair/poll", Some(body), None).await.map(serde_json::from_value::<PairPollResponse>) {
                _ if cancel.is_cancelled() => return,
                Ok(Ok(PairPollResponse::Approved { device_id, device_token, device_name, account_email })) => {
                    self.kv.set("remote.deviceId", Some(&device_id));
                    // The name the account gave it, made unique there.
                    self.kv.set("remote.deviceName", Some(&device_name));
                    self.kv.set("remote.accountEmail", Some(&account_email));
                    self.secrets.set(SecretName::DeviceToken, &device_token);
                    self.keys.activate(&key_id);
                    self.state().pairing = None;
                    tracing::info!("Paired with {account_email} as device {device_id}");
                    self.connect();
                    self.changed();
                    return;
                }
                Ok(Ok(PairPollResponse::Expired)) => {
                    self.expire_pairing();
                    return;
                }
                Ok(Ok(PairPollResponse::Pending)) => {}
                Ok(Err(error)) => tracing::warn!("Pairing poll returned an unexpected answer: {error}"),
                Err(error) => tracing::warn!("Pairing poll failed: {error}"),
            }
            if parse_iso(&expires_at).is_some_and(|expires| expires < chrono::Utc::now()) {
                self.expire_pairing();
                return;
            }
        }
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

    pub fn link_browser(&self, label: Option<&str>) -> ApiResult<Value> {
        let device_id = self.device_id().ok_or_else(|| ApiError::bad("Connect this device to your account first."))?;
        let label = label.map(str::trim).filter(|l| !l.is_empty()).unwrap_or("Linked browser");
        let (key_id, key) = self.keys.mint(label, true)?;
        self.changed();
        Ok(json!({ "url": format!("{}/link#{}", *CLOUD_URL, link_fragment(&device_id, &key_id, &key)), "keyId": key_id }))
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
        self.secrets.set(SecretName::DeviceToken, "");
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
        let url = format!("{}/api/device/connect", CLOUD_URL.replacen("http", "ws", 1));
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
        if frame.len() > MAX_RELAY_FRAME + 16 {
            return;
        }
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
                if connection.session.is_some() {
                    drop(state);
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
                self.keys.touch(kid);
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
        let mut request = self.http.request(method, format!("{}{path}", *CLOUD_URL)).timeout(CLOUD_TIMEOUT);
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        let host = url::Url::parse(&CLOUD_URL).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
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
