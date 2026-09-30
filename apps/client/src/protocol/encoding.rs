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

/// A random base64url id with `bytes` of entropy.
pub fn random_id(bytes: usize) -> String {
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
}
