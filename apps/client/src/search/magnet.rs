use std::sync::LazyLock;

use regex::Regex;

use crate::protocol::encoding::encode_uri_component;

/// A broad set of well-known public trackers. Providers rebuild magnets with these rather than
/// trusting the tracker list served by a (possibly untrusted) mirror.
pub const DEFAULT_TRACKERS: [&str; 5] = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.dler.org:6969/announce",
];

pub fn build_magnet(info_hash: &str, name: &str, trackers: &[&str]) -> String {
    let mut magnet = format!("magnet:?xt=urn:btih:{info_hash}&dn={}", encode_uri_component(name));
    for tracker in trackers {
        magnet.push_str("&tr=");
        magnet.push_str(&encode_uri_component(tracker));
    }
    magnet
}

static BTIH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)xt=urn:btih:([0-9A-Za-z]+)").unwrap());

pub fn extract_info_hash(magnet_uri: &str) -> Option<String> {
    BTIH.captures(magnet_uri).map(|c| c[1].to_owned())
}

/// The `dn` display name of a magnet, if it has one.
pub fn magnet_name(magnet_uri: &str) -> Option<String> {
    let query = magnet_uri.split_once('?').map_or(magnet_uri, |(_, q)| q);
    url::form_urlencoded::parse(query.as_bytes()).find(|(k, _)| k == "dn").map(|(_, v)| v.into_owned())
}

/// Normalises a btih to 40-char lowercase hex; base32 v1 hashes are converted. None if invalid.
pub fn normalize_info_hash(hash: &str) -> Option<String> {
    if matches!(hash.len(), 40 | 64) && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(hash.to_ascii_lowercase());
    }
    if hash.len() == 32 {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        let mut bits: u64 = 0;
        let mut count = 0;
        let mut hex = String::with_capacity(40);
        for byte in hash.to_ascii_uppercase().bytes() {
            let value = ALPHABET.iter().position(|&c| c == byte)? as u64;
            bits = (bits << 5) | value;
            count += 5;
            while count >= 4 {
                count -= 4;
                hex.push(char::from_digit(((bits >> count) & 0xf) as u32, 16).unwrap());
            }
        }
        return Some(hex);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_extract_and_normalise() {
        let magnet = build_magnet("ABCDEF0123456789ABCDEF0123456789ABCDEF01", "Some Name", &DEFAULT_TRACKERS);
        assert_eq!(extract_info_hash(&magnet).as_deref(), Some("ABCDEF0123456789ABCDEF0123456789ABCDEF01"));
        assert_eq!(magnet_name(&magnet).as_deref(), Some("Some Name"));
        assert_eq!(magnet_name("magnet:?xt=urn:btih:x&dn=Some+Name").as_deref(), Some("Some Name"));
        let expected = Some("abcdef0123456789abcdef0123456789abcdef01".to_owned());
        assert_eq!(normalize_info_hash("ABCDEF0123456789ABCDEF0123456789ABCDEF01"), expected);
        // The base32 form of the same 20 bytes.
        assert_eq!(normalize_info_hash("VPG66AJDIVTYTK6N54ASGRLHRGV433YB"), expected);
        assert_eq!(normalize_info_hash("nope"), None);
    }
}
