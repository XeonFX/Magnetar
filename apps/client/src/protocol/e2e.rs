//! End-to-end encryption between a browser and this device, through a relay that must learn
//! nothing but sizes and timing. The device side of `packages/protocol/src/e2e.ts`; see the design
//! notes there. In short: a per-browser key K (minted here, delivered in a link fragment) salts
//! an ephemeral P-256 ECDH handshake, and every later frame is AES-256-GCM with a counter IV that
//! the receiver requires to be exactly the next one.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hmac::{Hmac, Mac};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::encoding::{from_base64url, random_bytes, to_base64url};

pub const E2E_VERSION: u32 = 1;
const LABEL: &[u8] = b"md-e2e-v1";
pub const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 16;

/// First byte of every browser↔device payload.
pub const FRAME_HANDSHAKE: u8 = 0;
pub const FRAME_SEALED: u8 = 1;

const DIRECTION_BROWSER: u32 = 1;
const DIRECTION_DEVICE: u32 = 2;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Handshake {
    Hello { v: u32, kid: String, epk: String, n: String },
    Welcome { v: u32, epk: String, n: String, confirm: String },
    Reject { reason: String },
}

pub fn encode_handshake(message: &Handshake) -> Vec<u8> {
    let mut frame = vec![FRAME_HANDSHAKE];
    frame.extend(serde_json::to_vec(message).expect("handshake serializes"));
    frame
}

pub fn decode_handshake(frame: &[u8]) -> anyhow::Result<Handshake> {
    anyhow::ensure!(frame.first() == Some(&FRAME_HANDSHAKE), "Not a handshake frame");
    Ok(serde_json::from_slice(&frame[1..])?)
}

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

fn public_raw(secret: &SecretKey) -> Vec<u8> {
    secret.public_key().to_encoded_point(false).as_bytes().to_vec()
}

fn import_peer(raw: &[u8]) -> anyhow::Result<PublicKey> {
    anyhow::ensure!(raw.len() == 65 && raw[0] == 4, "Invalid ephemeral key");
    PublicKey::from_sec1_bytes(raw).map_err(|_| anyhow::anyhow!("Invalid ephemeral key"))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Browser,
    Device,
}

/// Keys for one connection, derived identically on both ends.
pub struct Derived {
    browser_to_device: [u8; 32],
    device_to_browser: [u8; 32],
    confirm: [u8; 32],
    pub transcript_hash: [u8; 32],
}

impl Derived {
    /// The MAC the device sends to prove it holds K.
    pub fn device_confirmation(&self) -> [u8; 32] {
        let mut data = b"device".to_vec();
        data.extend_from_slice(&self.transcript_hash);
        hmac(&self.confirm, &data)
    }
}

#[allow(clippy::too_many_arguments)]
pub fn derive(
    browser_key: &[u8],
    own: &SecretKey,
    peer: &PublicKey,
    kid: &str,
    browser_epk: &[u8],
    browser_nonce: &[u8],
    device_epk: &[u8],
    device_nonce: &[u8],
) -> anyhow::Result<Derived> {
    anyhow::ensure!(kid.len() <= u16::MAX as usize, "Key id too long");
    let mut transcript = LABEL.to_vec();
    transcript.extend_from_slice(&(kid.len() as u16).to_be_bytes());
    transcript.extend_from_slice(kid.as_bytes());
    for part in [browser_epk, browser_nonce, device_epk, device_nonce] {
        transcript.extend_from_slice(part);
    }
    let transcript_hash: [u8; 32] = Sha256::digest(&transcript).into();
    let salt = hmac(browser_key, &transcript_hash);
    let shared = p256::ecdh::diffie_hellman(own.to_nonzero_scalar(), peer.as_affine());
    let mut okm = [0u8; 96];
    hkdf::Hkdf::<Sha256>::new(Some(&salt), shared.raw_secret_bytes())
        .expand(b"md-e2e-v1 keys", &mut okm)
        .map_err(|_| anyhow::anyhow!("HKDF output length"))?;
    let part = |i: usize| -> [u8; 32] { okm[i * 32..(i + 1) * 32].try_into().unwrap() };
    Ok(Derived { browser_to_device: part(0), device_to_browser: part(1), confirm: part(2), transcript_hash })
}

/// One direction-aware encrypted channel. Callers seal and open frames in order.
pub struct E2ESession {
    role: Role,
    send: Aes256Gcm,
    receive: Aes256Gcm,
    transcript_hash: [u8; 32],
    send_counter: u64,
    receive_counter: u64,
}

fn iv(direction: u32, counter: u64) -> [u8; 12] {
    let mut iv = [0u8; 12];
    iv[..4].copy_from_slice(&direction.to_be_bytes());
    iv[4..].copy_from_slice(&counter.to_be_bytes());
    iv
}

impl E2ESession {
    pub fn new(role: Role, keys: &Derived) -> Self {
        let (send, receive) = match role {
            Role::Browser => (&keys.browser_to_device, &keys.device_to_browser),
            Role::Device => (&keys.device_to_browser, &keys.browser_to_device),
        };
        Self {
            role,
            send: Aes256Gcm::new(send.into()),
            receive: Aes256Gcm::new(receive.into()),
            transcript_hash: keys.transcript_hash,
            send_counter: 0,
            receive_counter: 0,
        }
    }

    fn directions(&self) -> (u32, u32) {
        match self.role {
            Role::Browser => (DIRECTION_BROWSER, DIRECTION_DEVICE),
            Role::Device => (DIRECTION_DEVICE, DIRECTION_BROWSER),
        }
    }

    /// Encrypts a JSON value into a sealed frame.
    pub fn seal(&mut self, value: &Value) -> Vec<u8> {
        self.seal_bytes(&serde_json::to_vec(value).expect("JSON serializes"))
    }

    pub fn seal_bytes(&mut self, plaintext: &[u8]) -> Vec<u8> {
        let counter = self.send_counter;
        self.send_counter += 1;
        let nonce = iv(self.directions().0, counter);
        let ciphertext = self
            .send
            .encrypt(&Nonce::from(nonce), Payload { msg: plaintext, aad: &self.transcript_hash })
            .expect("AES-GCM encryption cannot fail for in-memory input");
        let mut frame = Vec::with_capacity(9 + ciphertext.len());
        frame.push(FRAME_SEALED);
        frame.extend_from_slice(&counter.to_be_bytes());
        frame.extend_from_slice(&ciphertext);
        frame
    }

    /// Decrypts the next sealed frame. Fails on tampering, replay, reordering or a dropped frame.
    pub fn open(&mut self, frame: &[u8]) -> anyhow::Result<Value> {
        anyhow::ensure!(frame.len() >= 9 + 16 && frame[0] == FRAME_SEALED, "Not a sealed frame");
        let counter = u64::from_be_bytes(frame[1..9].try_into().unwrap());
        anyhow::ensure!(counter == self.receive_counter, "Out-of-sequence frame");
        let nonce = iv(self.directions().1, counter);
        let plaintext = self
            .receive
            .decrypt(&Nonce::from(nonce), Payload { msg: &frame[9..], aad: &self.transcript_hash })
            .map_err(|_| anyhow::anyhow!("Frame failed authentication"))?;
        self.receive_counter += 1;
        Ok(serde_json::from_slice(&plaintext)?)
    }
}

/// Device side: answers a hello for a browser whose key K it holds.
pub fn accept_browser_handshake(hello: &Handshake, browser_key: &[u8]) -> anyhow::Result<(Handshake, E2ESession)> {
    let Handshake::Hello { v, kid, epk, n } = hello else { anyhow::bail!("Expected hello") };
    anyhow::ensure!(*v == E2E_VERSION, "Unsupported protocol version");
    let browser_epk = from_base64url(epk)?;
    let browser_nonce = from_base64url(n)?;
    anyhow::ensure!(browser_nonce.len() == NONCE_BYTES, "Invalid browser nonce");
    let peer = import_peer(&browser_epk)?;
    let own = SecretKey::random(&mut rand::rngs::OsRng);
    let own_public = public_raw(&own);
    let nonce = random_bytes(NONCE_BYTES);
    let keys = derive(browser_key, &own, &peer, kid, &browser_epk, &browser_nonce, &own_public, &nonce)?;
    let welcome = Handshake::Welcome {
        v: E2E_VERSION,
        epk: to_base64url(&own_public),
        n: to_base64url(&nonce),
        confirm: to_base64url(&keys.device_confirmation()),
    };
    Ok((welcome, E2ESession::new(Role::Device, &keys)))
}

/// The fragment that carries a browser key: `d=<deviceId>&i=<keyId>&k=<key>`.
pub fn link_fragment(device_id: &str, key_id: &str, key: &[u8]) -> String {
    use super::encoding::encode_uri_component as enc;
    format!("d={}&i={}&k={}", enc(device_id), enc(key_id), to_base64url(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Browser side, as the dashboard runs it, for round-trip tests.
    fn browser_finish(kid: &str, key: &[u8], own: &SecretKey, nonce: &[u8], welcome: &Handshake) -> anyhow::Result<E2ESession> {
        let Handshake::Welcome { epk, n, confirm, .. } = welcome else { anyhow::bail!("not a welcome") };
        let device_epk = from_base64url(epk)?;
        let device_nonce = from_base64url(n)?;
        let keys = derive(key, own, &import_peer(&device_epk)?, kid, &public_raw(own), nonce, &device_epk, &device_nonce)?;
        anyhow::ensure!(keys.device_confirmation().to_vec() == from_base64url(confirm)?, "confirmation mismatch");
        Ok(E2ESession::new(Role::Browser, &keys))
    }

    fn hello(kid: &str) -> (Handshake, SecretKey, Vec<u8>) {
        let own = SecretKey::random(&mut rand::rngs::OsRng);
        let nonce = random_bytes(NONCE_BYTES);
        let hello = Handshake::Hello { v: 1, kid: kid.into(), epk: to_base64url(&public_raw(&own)), n: to_base64url(&nonce) };
        (hello, own, nonce)
    }

    #[test]
    fn round_trip_and_sequence_checks() {
        let key = random_bytes(32);
        let (hello, own, nonce) = hello("kid1");
        let (welcome, mut device) = accept_browser_handshake(&hello, &key).unwrap();
        let mut browser = browser_finish("kid1", &key, &own, &nonce, &welcome).unwrap();

        let first = browser.seal(&serde_json::json!({ "id": 1, "method": "app.info" }));
        let second = browser.seal(&serde_json::json!({ "id": 2 }));
        // A dropped or reordered frame is refused.
        assert!(device.open(&second).is_err());
        assert_eq!(device.open(&first).unwrap()["method"], "app.info");
        assert_eq!(device.open(&second).unwrap()["id"], 2);
        assert!(device.open(&second).is_err(), "replay");

        let reply = device.seal(&serde_json::json!({ "id": 1, "result": null }));
        assert_eq!(browser.open(&reply).unwrap()["id"], 1);
    }

    #[test]
    fn a_wrong_browser_key_fails_the_confirmation() {
        let (hello, own, nonce) = hello("kid1");
        let (welcome, _) = accept_browser_handshake(&hello, &random_bytes(32)).unwrap();
        assert!(browser_finish("kid1", &random_bytes(32), &own, &nonce, &welcome).is_err());
    }

    #[test]
    fn tampering_is_detected() {
        let key = random_bytes(32);
        let (hello, own, nonce) = hello("k");
        let (welcome, mut device) = accept_browser_handshake(&hello, &key).unwrap();
        let mut browser = browser_finish("k", &key, &own, &nonce, &welcome).unwrap();
        let mut frame = browser.seal(&serde_json::json!({ "id": 1 }));
        let last = frame.len() - 1;
        frame[last] ^= 1;
        assert!(device.open(&frame).is_err());
    }

    /// Fixed inputs computed by the TypeScript implementation (packages/protocol/src/e2e-vector.json):
    /// both ends must derive the same keys and seal the same bytes.
    #[test]
    fn matches_the_typescript_vector() {
        let vector: Value = serde_json::from_str(include_str!("../../../../packages/protocol/src/e2e-vector.json")).unwrap();
        let bytes = |name: &str| from_base64url(vector[name].as_str().unwrap()).unwrap();
        let secret = |name: &str| SecretKey::from_slice(&bytes(name)).unwrap();
        let kid = vector["kid"].as_str().unwrap();
        let (browser_secret, device_secret) = (secret("browserPrivate"), secret("devicePrivate"));
        let (browser_epk, device_epk) = (public_raw(&browser_secret), public_raw(&device_secret));
        assert_eq!(browser_epk, bytes("browserEpk"));
        assert_eq!(device_epk, bytes("deviceEpk"));

        let keys = derive(
            &bytes("browserKey"),
            &device_secret,
            &import_peer(&browser_epk).unwrap(),
            kid,
            &browser_epk,
            &bytes("browserNonce"),
            &device_epk,
            &bytes("deviceNonce"),
        )
        .unwrap();
        assert_eq!(keys.transcript_hash.to_vec(), bytes("transcriptHash"));
        assert_eq!(keys.device_confirmation().to_vec(), bytes("confirm"));

        let mut device = E2ESession::new(Role::Device, &keys);
        let request = device.open(&bytes("browserFrame")).unwrap();
        assert_eq!(request, vector["browserMessage"]);
        let reply = device.seal_bytes(vector["deviceMessageJson"].as_str().unwrap().as_bytes());
        assert_eq!(reply, bytes("deviceFrame"));
    }
}
