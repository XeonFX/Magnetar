use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

use axum::body::to_bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use super::agent_auth::{self, AgentAuth, AgentRequest};
use super::{assets, mcp, openapi, rest};
use crate::app::App;
use crate::config::IS_DEV;

const MAX_WS_MESSAGE: usize = 256 * 1024;
const MAX_BODY: usize = 1024 * 1024;

pub struct Server {
    pub port: u16,
    shutdown: CancellationToken,
}

impl Server {
    pub fn stop(&self) {
        self.shutdown.cancel();
    }
}

/// Who is really asking. A TLS reverse proxy on this machine may forward the real client address
/// and scheme; those headers are trusted from a loopback peer only, and only one hop deep, so a
/// LAN caller can't claim to be 127.0.0.1.
struct ClientFacts {
    loopback: bool,
    https: bool,
    forwarded: bool,
}

fn client_facts(headers: &HeaderMap, peer: SocketAddr) -> ClientFacts {
    let peer_is_loopback = peer.ip().is_loopback() || agent_auth::is_loopback_address(&peer.ip().to_string());
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    match header("x-forwarded-for") {
        Some(forwarded_for) if peer_is_loopback => {
            let hops: Vec<&str> = forwarded_for.split(',').map(str::trim).filter(|h| !h.is_empty()).collect();
            ClientFacts {
                loopback: hops.len() == 1 && agent_auth::is_loopback_address(hops[0]),
                https: header("x-forwarded-proto") == Some("https"),
                forwarded: true,
            }
        }
        _ => ClientFacts { loopback: peer_is_loopback, https: false, forwarded: false },
    }
}

fn json_response(status: u16, value: Value) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(value)).into_response()
}

fn not_found() -> Response {
    json_response(404, json!({ "error": "Not found." }))
}

/// The Vite dev server's origin, allowed to open the dashboard socket in development only.
fn dev_origin() -> Option<String> {
    IS_DEV.then(|| std::env::var("MD_DEV_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".into()))
}

async fn handle(State(app): State<Arc<App>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    let headers = request.headers().clone();
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let host = header("host");
    let hostname = host.map(agent_auth::host_name).unwrap_or_default();
    let facts = client_facts(&headers, peer);

    if agent_auth::is_agent_path(&path) {
        let token = app.agent.token();
        let result = agent_auth::evaluate(&AgentRequest {
            enabled: app.agent.enabled(),
            allow_remote: app.agent.allow_remote(),
            token: &token,
            client_is_loopback: facts.loopback,
            forwarded: facts.forwarded,
            hostname,
            is_https: facts.https,
            origin: header("origin"),
            host,
            authorization: header("authorization"),
        });
        if result != AgentAuth::Allowed {
            if result != AgentAuth::Disabled {
                tracing::warn!("Agent request to {path} refused ({result:?})");
            }
            let (status, error) = agent_auth::refusal(result);
            let mut response = json_response(status, json!({ "error": error }));
            if result == AgentAuth::InsecureTransport {
                response.headers_mut().insert(header::UPGRADE, "TLS/1.2, HTTP/1.1".parse().unwrap());
            }
            return response;
        }
        return agent(&app, request, &path).await;
    }

    // The dashboard, its socket and static files exist for this machine only, and only under a
    // loopback host name — a DNS-rebound name pointing at 127.0.0.1 gets nothing.
    if !facts.loopback || facts.forwarded || !agent_auth::is_loopback_hostname(hostname) {
        return not_found();
    }
    match path.as_str() {
        "/ws" => {
            let allowed = header("origin").is_some_and(|origin| {
                agent_auth::is_allowed_loopback_origin(origin, host) || dev_origin().as_deref() == Some(origin)
            });
            if !allowed {
                return (StatusCode::FORBIDDEN, "Forbidden").into_response();
            }
            let (mut parts, _) = request.into_parts();
            match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
                Ok(upgrade) => upgrade.max_message_size(MAX_WS_MESSAGE).on_upgrade(move |socket| dashboard_socket(app, socket)),
                Err(_) => (StatusCode::UPGRADE_REQUIRED, "Upgrade required").into_response(),
            }
        }
        "/health" => Json(json!({ "ok": true })).into_response(),
        _ if path.starts_with("/stream/") => {
            let (parts, _) = request.into_parts();
            super::stream::serve(&app, &path["/stream/".len()..], &parts.method, &parts.headers).await
        }
        "/app-config.json" => ([(header::CACHE_CONTROL, "no-store")], Json(json!({ "mode": "local" }))).into_response(),
        _ => assets::serve(&path),
    }
}

async fn agent(app: &Arc<App>, request: Request, path: &str) -> Response {
    let method = request.method().clone();
    let query = request.uri().query().map(str::to_owned);
    let Ok(bytes) = to_bytes(request.into_body(), MAX_BODY).await else {
        return json_response(413, json!({ "error": "The request body is too large." }));
    };
    // Dropped with the connection, which cancels searches and detail fetches for a caller that left.
    let cancel = CancellationToken::new();
    let _guard = cancel.clone().drop_guard();
    if path == "/mcp" {
        if method != Method::POST {
            let mut response = json_response(405, json!({ "error": "Method not allowed." }));
            response.headers_mut().insert(header::ALLOW, "POST".parse().unwrap());
            return response;
        }
        return match mcp::handle(&app.agent_actions, &bytes, &cancel).await {
            (status, Some(body)) => json_response(status, body),
            (status, None) => StatusCode::from_u16(status).unwrap_or(StatusCode::ACCEPTED).into_response(),
        };
    }
    if path == "/openapi/v1.json" {
        return Json(openapi::document()).into_response();
    }
    let (status, body) = rest::handle(&app.agent_actions, &method, path, query.as_deref(), &bytes, &cancel).await;
    let mut response = (status, Json(body)).into_response();
    if status == StatusCode::METHOD_NOT_ALLOWED
        && let Some(allow) = rest::allowed_methods(path).and_then(|a| a.parse().ok())
    {
        response.headers_mut().insert(header::ALLOW, allow);
    }
    response
}

/// The local dashboard's RPC socket.
async fn dashboard_socket(app: Arc<App>, socket: WebSocket) {
    let (session, mut outgoing) = app.rpc.connect(true);
    let (mut sink, mut stream) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing.recv().await {
            if sink.send(Message::text(message.to_string())).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Text(text) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    session.handle(value);
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    session.close();
    writer.abort();
}

async fn bind(port: u16) -> std::io::Result<Vec<TcpListener>> {
    let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
    // Browsers may resolve localhost to ::1 first; serve it too where IPv6 exists.
    match TcpListener::bind((Ipv6Addr::LOCALHOST, port)).await {
        Ok(v6) => Ok(vec![v4, v6]),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Err(error),
        Err(_) => Ok(vec![v4]),
    }
}

/// Serves the dashboard and agent API on localhost, walking forward from the preferred port if
/// another app already holds it.
pub async fn start(app: Arc<App>, preferred_port: u16) -> anyhow::Result<Server> {
    let router = Router::new().fallback(handle).with_state(app);
    for port in preferred_port..preferred_port.saturating_add(50) {
        let listeners = match bind(port).await {
            Ok(listeners) => listeners,
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => return Err(error.into()),
        };
        let shutdown = CancellationToken::new();
        for listener in listeners {
            let service = router.clone().into_make_service_with_connect_info::<SocketAddr>();
            let stop = shutdown.clone();
            tokio::spawn(async move {
                if let Err(error) = axum::serve(listener, service).with_graceful_shutdown(stop.cancelled_owned()).await {
                    tracing::error!("The dashboard server stopped: {error}");
                }
            });
        }
        tracing::info!("Dashboard at http://localhost:{port}");
        return Ok(Server { port, shutdown });
    }
    anyhow::bail!("No free port between {preferred_port} and {}", preferred_port + 49)
}
