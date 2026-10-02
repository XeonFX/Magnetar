//! Framing between the relay (a Durable Object per device) and this device: binary frames carry a
//! 16-byte connection id and then the browser↔device payload; text frames are control messages.

use serde::{Deserialize, Serialize};

use super::encoding::{from_base64url, to_base64url};

pub const CONNECTION_ID_BYTES: usize = 16;
/// Largest message the dashboard sends, the same on the relay and the local socket.
pub const MAX_RELAY_FRAME: usize = 1024 * 1024;
/// Largest payload the relay forwards: a message of MAX_RELAY_FRAME, sealed. Bigger frames close the
/// sender (`apps/worker/src/relay.ts`).
pub const MAX_SEALED_FRAME: usize = MAX_RELAY_FRAME + 64;

/// The device was removed from its account: it forgets its pairing.
pub const CLOSE_DEVICE_REMOVED: u16 = 4001;

/// Keepalive, answered by the relay without waking it.
pub const RELAY_PING: &str = r#"{"t":"ping"}"#;

#[derive(Deserialize, Debug)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum RelayToDevice {
    Open {
        c: String,
    },
    Close {
        c: String,
    },
    Revoked,
    Pong,
    /// The device's name on the account, when it is not the one this device said hello with.
    Name {
        name: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum DeviceToRelay<'a> {
    Close { c: &'a str },
    Hello { version: &'a str, name: &'a str },
}

pub fn wrap_for_device(connection_id: &str, payload: &[u8]) -> anyhow::Result<Vec<u8>> {
    let id = from_base64url(connection_id)?;
    anyhow::ensure!(id.len() == CONNECTION_ID_BYTES, "Invalid connection id");
    let mut frame = id;
    frame.extend_from_slice(payload);
    Ok(frame)
}

/// The connection id and payload of a frame from the relay; None for a frame too short, or larger
/// than the relay passes.
pub fn unwrap_from_device(frame: &[u8]) -> Option<(String, &[u8])> {
    (CONNECTION_ID_BYTES + 1..=CONNECTION_ID_BYTES + MAX_SEALED_FRAME)
        .contains(&frame.len())
        .then(|| (to_base64url(&frame[..CONNECTION_ID_BYTES]), &frame[CONNECTION_ID_BYTES..]))
}
