use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use rand::RngCore;

/// base64url without padding, for keys and ids that travel in URLs and JSON.
pub fn to_base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn from_base64url(value: &str) -> anyhow::Result<Vec<u8>> {
    Ok(URL_SAFE_NO_PAD.decode(value.trim_end_matches('='))?)
}

/// Standard base64, for file contents and mail headers.
pub fn to_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn from_base64(value: &str) -> anyhow::Result<Vec<u8>> {
    Ok(STANDARD.decode(value)?)
}

/// Milliseconds since the epoch, as a replaceable source so tests can move time.
pub type Clock = Box<dyn Fn() -> u64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Box::new(|| chrono::Utc::now().timestamp_millis() as u64)
}

pub fn random_bytes(length: usize) -> Vec<u8> {
    let mut bytes = vec![0; length];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
}

/// Bitcoin's base58 alphabet: digits and letters without 0, O, I and l.
const BASE58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Bytes in base58 the way `@codefusion-cc/base58` spells them: one big-endian number, left-padded with `1` to
/// the width every value of that many bytes fits in (17 characters for 12 bytes, 22 for 16).
fn to_base58(bytes: &[u8]) -> String {
    // 58^L >= 256^n never holds with equality (58 has the factor 29), so the ceiling is exact.
    let width = (bytes.len() as f64 * 8.0 / 58f64.log2()).ceil() as usize;
    let mut number = bytes.to_vec();
    let mut digits = vec![0u8; width];
    for digit in digits.iter_mut().rev() {
        let mut remainder = 0u32;
        for byte in number.iter_mut() {
            let value = (remainder << 8) | u32::from(*byte);
            *byte = (value / 58) as u8;
            remainder = value % 58;
        }
        *digit = BASE58_ALPHABET[remainder as usize];
    }
    digits.into_iter().map(char::from).collect()
}

/// A random base58 id with `bytes` of entropy: no look-alikes, nothing a double-click stops at.
pub fn random_id(bytes: usize) -> String {
    to_base58(&random_bytes(bytes))
}

/// A random base64url secret with `bytes` of entropy.
pub fn random_token(bytes: usize) -> String {
    to_base64url(&random_bytes(bytes))
}

/// `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is percent-encoded.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// An ISO-8601 UTC timestamp with milliseconds, as JavaScript's `toISOString` writes it.
pub fn iso(time: chrono::DateTime<chrono::Utc>) -> String {
    time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn now_iso() -> String {
    iso(chrono::Utc::now())
}

pub fn parse_iso(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(value).ok().map(|d| d.with_timezone(&chrono::Utc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_component_matches_javascript() {
        assert_eq!(encode_uri_component("Some Name/ä?&"), "Some%20Name%2F%C3%A4%3F%26");
        assert_eq!(encode_uri_component("udp://x:1/announce"), "udp%3A%2F%2Fx%3A1%2Fannounce");
    }

    #[test]
    fn base64url_round_trip() {
        let bytes = [0xfb, 0xff, 0x00, 0x10];
        assert_eq!(to_base64url(&bytes), "-_8AEA");
        assert_eq!(from_base64url("-_8AEA").unwrap(), bytes);
        assert!(from_base64url("+/==").is_err());
    }

    #[test]
    fn base58_matches_the_shared_package() {
        // The vectors of @codefusion-cc/base58: Bitcoin's spelling at full width, padded with 1 below it.
        assert_eq!(to_base58(b"Hello World!"), "2NEpo7TZRRrLZSi2U");
        assert_eq!(to_base58(&[255; 16]), "YcVfxkQb6JRzqk5kF2tNLv");
        assert_eq!(to_base58(&[0; 16]), "1".repeat(22));
        assert_eq!(to_base58(&[0, 0, 0x28, 0x7f, 0xb4, 0xcd]), "111233QC4");
        assert_eq!(
            to_base58(b"The quick brown fox jumps over the lazy dog."),
            "1USm3fpXnKG5EUBx2ndxBDMPVciP5hGey2Jh4NDv6gmeo1LkMeiKrLJUUBk6Z"
        );
        assert_eq!(to_base58(&[255]), "5Q");
        assert_eq!(to_base58(&[]), "");
        let widths: Vec<_> = [0, 1, 2, 6, 8, 9, 12, 16, 24, 32].iter().map(|&n| to_base58(&vec![0; n]).len()).collect();
        assert_eq!(widths, [0, 2, 3, 9, 11, 13, 17, 22, 33, 44]);
    }

    #[test]
    fn random_ids_are_base58_at_their_width() {
        let ids: std::collections::HashSet<_> = (0..2000).map(|_| random_id(9)).collect();
        assert_eq!(ids.len(), 2000);
        assert!(ids.iter().all(|id| id.bytes().all(|b| BASE58_ALPHABET.contains(&b))));
        assert_eq!(random_token(32).len(), 43);
    }
}
