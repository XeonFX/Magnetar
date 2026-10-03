//! Web Push message encryption (RFC 8291, the aes128gcm content coding of RFC 8188): a notification
//! is sealed on the device for one browser's push subscription, so neither the Worker that sends it
//! on nor the browser vendor's push service can read it.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;

use super::encoding::{from_base64url, random_bytes};

/// One record carries the whole message; notifications are far smaller.
const RECORD_SIZE: u32 = 4096;
/// Push services accept at least this much payload.
pub const MAX_PLAINTEXT: usize = 3993;

/// A browser's subscription keys, as its PushSubscription reports them (base64url).
pub struct SubscriptionKeys<'a> {
    pub p256dh: &'a str,
    pub auth: &'a str,
}

pub fn encrypt(keys: &SubscriptionKeys<'_>, plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
    let ephemeral = SecretKey::random(&mut rand::thread_rng());
    let salt: [u8; 16] = random_bytes(16).try_into().expect("16 bytes");
    encrypt_with(keys, plaintext, &ephemeral, &salt)
}

fn encrypt_with(
    keys: &SubscriptionKeys<'_>,
    plaintext: &[u8],
    ephemeral: &SecretKey,
    salt: &[u8; 16],
) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(plaintext.len() <= MAX_PLAINTEXT, "A push message can carry at most {MAX_PLAINTEXT} bytes");
    let receiver_bytes =
        from_base64url(keys.p256dh).map_err(|_| anyhow::anyhow!("The subscription's p256dh key is not base64url"))?;
    let receiver = PublicKey::from_sec1_bytes(&receiver_bytes)
        .map_err(|_| anyhow::anyhow!("The subscription's p256dh key is not a P-256 point"))?;
    let auth = from_base64url(keys.auth).map_err(|_| anyhow::anyhow!("The subscription's auth secret is not base64url"))?;
    anyhow::ensure!(auth.len() == 16, "The subscription's auth secret is not 16 bytes");
    let receiver_point = receiver.to_encoded_point(false);
    let sender_point = ephemeral.public_key().to_encoded_point(false);

    let shared = p256::ecdh::diffie_hellman(ephemeral.to_nonzero_scalar(), receiver.as_affine());
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(receiver_point.as_bytes());
    key_info.extend_from_slice(sender_point.as_bytes());
    let mut ikm = [0u8; 32];
    hkdf::Hkdf::<Sha256>::new(Some(&auth), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| anyhow::anyhow!("HKDF"))?;
    let prk = hkdf::Hkdf::<Sha256>::new(Some(salt), &ikm);
    let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|_| anyhow::anyhow!("HKDF"))?;
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|_| anyhow::anyhow!("HKDF"))?;

    // The last (only) record ends with the 0x02 delimiter and no padding.
    let mut padded = plaintext.to_vec();
    padded.push(2);
    let sealed =
        Aes128Gcm::new(&cek.into()).encrypt(&Nonce::from(nonce), padded.as_slice()).map_err(|_| anyhow::anyhow!("AES-GCM"))?;

    let mut body = Vec::with_capacity(16 + 4 + 1 + 65 + sealed.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(sender_point.as_bytes().len() as u8);
    body.extend_from_slice(sender_point.as_bytes());
    body.extend_from_slice(&sealed);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::encoding::to_base64url;

    /// What the browser does with the message: the receiving half, for checking the sending one.
    fn decrypt(body: &[u8], receiver: &SecretKey, auth: &[u8]) -> Vec<u8> {
        let (salt, rest) = body.split_at(16);
        let id_len = rest[4] as usize;
        let sender = PublicKey::from_sec1_bytes(&rest[5..5 + id_len]).unwrap();
        let ciphertext = &rest[5 + id_len..];
        let shared = p256::ecdh::diffie_hellman(receiver.to_nonzero_scalar(), sender.as_affine());
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(receiver.public_key().to_encoded_point(false).as_bytes());
        info.extend_from_slice(sender.to_encoded_point(false).as_bytes());
        let mut ikm = [0u8; 32];
        hkdf::Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes()).expand(&info, &mut ikm).unwrap();
        let prk = hkdf::Hkdf::<Sha256>::new(Some(salt), &ikm);
        let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
        prk.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();
        let mut plain = Aes128Gcm::new(&cek.into()).decrypt(&Nonce::from(nonce), ciphertext).unwrap();
        assert_eq!(plain.pop(), Some(2), "the last record's delimiter");
        plain
    }

    #[test]
    fn matches_the_rfc_8291_example() {
        let keys = SubscriptionKeys {
            p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
            auth: "BTBZMqHH6r4Tts7J_aSIgg",
        };
        let ephemeral = SecretKey::from_slice(&from_base64url("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw").unwrap()).unwrap();
        let salt: [u8; 16] = from_base64url("DGv6ra1nlYgDCS1FRnbzlw").unwrap().try_into().unwrap();
        let body = encrypt_with(&keys, b"When I grow up, I want to be a watermelon", &ephemeral, &salt).unwrap();
        assert_eq!(
            to_base64url(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn the_browser_reads_back_what_was_sealed_and_each_message_differs() {
        let receiver = SecretKey::random(&mut rand::thread_rng());
        let auth = random_bytes(16);
        let p256dh = to_base64url(receiver.public_key().to_encoded_point(false).as_bytes());
        let keys = SubscriptionKeys { p256dh: &p256dh, auth: &to_base64url(&auth) };
        let message = "{\"title\":\"Download finished\",\"body\":\"Ünïcødé ✓\"}".as_bytes();
        let first = encrypt(&keys, message).unwrap();
        assert_eq!(decrypt(&first, &receiver, &auth), message);
        assert_ne!(encrypt(&keys, message).unwrap(), first, "fresh salt and key each time");
        assert_eq!(decrypt(&encrypt(&keys, b"").unwrap(), &receiver, &auth), b"");
    }

    #[test]
    fn refuses_bad_keys_and_oversized_messages() {
        let receiver = SecretKey::random(&mut rand::thread_rng());
        let p256dh = to_base64url(receiver.public_key().to_encoded_point(false).as_bytes());
        let good_auth = to_base64url(&random_bytes(16));
        assert!(encrypt(&SubscriptionKeys { p256dh: &p256dh, auth: &good_auth }, &vec![b'x'; MAX_PLAINTEXT]).is_ok());
        assert!(encrypt(&SubscriptionKeys { p256dh: &p256dh, auth: &good_auth }, &vec![b'x'; MAX_PLAINTEXT + 1]).is_err());
        assert!(encrypt(&SubscriptionKeys { p256dh: "BAAA", auth: &good_auth }, b"x").is_err());
        assert!(encrypt(&SubscriptionKeys { p256dh: &p256dh, auth: "AAAA" }, b"x").is_err());
        assert!(encrypt(&SubscriptionKeys { p256dh: "not base64!", auth: &good_auth }, b"x").is_err());
    }

    /// The vector the browser side's tests decrypt with `@codefusion-cc/web-push/testing` and the TypeScript sender
    /// must produce too (`apps/web/src/lib/webPushVector.test.ts`): both implementations are held to this one file.
    /// Made by this code from fixed keys and salt; replace it only together with that test.
    #[test]
    fn matches_the_shared_vector() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../../../../packages/protocol/src/webpush-vector.json")).unwrap();
        let field = |name: &str| vector[name].as_str().unwrap();
        let bytes = |name: &str| from_base64url(field(name)).unwrap();
        let receiver = SecretKey::from_slice(&bytes("receiverPrivateKey")).unwrap();
        let sender = SecretKey::from_slice(&bytes("senderPrivateKey")).unwrap();
        assert_eq!(to_base64url(receiver.public_key().to_encoded_point(false).as_bytes()), field("p256dh"));
        assert_eq!(to_base64url(sender.public_key().to_encoded_point(false).as_bytes()), field("senderPublicKey"));
        let keys = SubscriptionKeys { p256dh: field("p256dh"), auth: field("auth") };
        let salt: [u8; 16] = bytes("salt").try_into().unwrap();
        let body = encrypt_with(&keys, field("plaintext").as_bytes(), &sender, &salt).unwrap();
        assert_eq!(to_base64url(&body), field("body"));
        assert_eq!(decrypt(&body, &receiver, &bytes("auth")), field("plaintext").as_bytes());
    }
}
