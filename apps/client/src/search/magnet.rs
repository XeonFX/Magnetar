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

/// A magnet of our own making, and the info hash in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Magnet {
    /// 40 lowercase hex characters.
    pub info_hash: String,
    pub uri: String,
}

/// The magnet for a torrent from its info hash, its name and the trackers we choose. Nothing else gets
/// in: the hash is checked to be one (40 hex or 32 base32 characters) before it goes into the link, so
/// a source can't append its own trackers (`tr=`), exact sources (`xs=`) or anything else to it. None
/// for anything that is not an info hash.
pub fn build_magnet(info_hash: &str, name: &str, trackers: &[&str]) -> Option<Magnet> {
    let info_hash = normalize_info_hash(info_hash)?;
    let mut uri = format!("magnet:?xt=urn:btih:{info_hash}&dn={}", encode_uri_component(name));
    for tracker in trackers {
        uri.push_str("&tr=");
        uri.push_str(&encode_uri_component(tracker));
    }
    Some(Magnet { info_hash, uri })
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

/// Normalises a v1 info hash, 40 hex or 32 base32 characters, to 40 lowercase hex. None for anything else.
pub fn normalize_info_hash(hash: &str) -> Option<String> {
    if hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
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
    use proptest::prelude::*;

    use super::*;

    const HEX: &str = "abcdef0123456789abcdef0123456789abcdef01";

    /// Every parameter of a magnet, decoded, in order.
    fn parameters(magnet: &str) -> Vec<(String, String)> {
        let query = magnet.strip_prefix("magnet:?").expect("a magnet");
        url::form_urlencoded::parse(query.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect()
    }

    /// What a magnet for `hash` named `name` should hold, and nothing more.
    fn expected(hash: &str, name: &str) -> Vec<(String, String)> {
        let head = [("xt".to_owned(), format!("urn:btih:{hash}")), ("dn".to_owned(), name.to_owned())];
        head.into_iter().chain(DEFAULT_TRACKERS.iter().map(|t| ("tr".to_owned(), (*t).to_owned()))).collect()
    }

    #[test]
    fn build_extract_and_normalise() {
        let magnet = build_magnet(&HEX.to_uppercase(), "Some Name", &DEFAULT_TRACKERS).unwrap();
        assert_eq!(magnet.info_hash, HEX);
        assert_eq!(extract_info_hash(&magnet.uri).as_deref(), Some(HEX));
        assert_eq!(magnet_name(&magnet.uri).as_deref(), Some("Some Name"));
        assert_eq!(magnet_name("magnet:?xt=urn:btih:x&dn=Some+Name").as_deref(), Some("Some Name"));
        // The base32 form of the same 20 bytes, in either case.
        assert_eq!(normalize_info_hash("VPG66AJDIVTYTK6N54ASGRLHRGV433YB").as_deref(), Some(HEX));
        assert_eq!(normalize_info_hash("vpg66ajdivtytk6n54asgrlhrgv433yb").as_deref(), Some(HEX));
        assert_eq!(normalize_info_hash("nope"), None);
    }

    #[test]
    fn only_the_hash_the_name_and_our_trackers_make_the_magnet() {
        let name = "A & B=C?tr=udp://x&xs=y";
        assert_eq!(parameters(&build_magnet(HEX, name, &DEFAULT_TRACKERS).unwrap().uri), expected(HEX, name));
    }

    #[test]
    fn a_hash_with_anything_around_it_is_refused() {
        for hostile in [
            format!("{HEX}&tr=http://evil.example/announce"),
            format!("{HEX}&xs=http://evil.example/x.torrent"),
            format!("{HEX}&as=http://evil.example/x.torrent"),
            format!("{HEX}&ws=http://evil.example/"),
            format!("{HEX}%26tr%3Dhttp%3A%2F%2Fevil"),
            format!("{HEX}#tr=x"),
            format!("{HEX}\n"),
            format!(" {HEX}"),
            format!("{HEX}0"),
            format!("{HEX}{HEX}"),
            "VPG66AJDIVTYTK6N54ASGRLHRGV433YB&tr=x".to_owned(),
            // 39 and 41 hex, 31 base32, a letter outside each alphabet.
            HEX[..39].to_owned(),
            format!("{}g", &HEX[..39]),
            "VPG66AJDIVTYTK6N54ASGRLHRGV433Y".to_owned(),
            "VPG66AJDIVTYTK6N54ASGRLHRGV433Y1".to_owned(),
            // A Cyrillic "а" in place of the first "a": 41 bytes, and not hex.
            format!("\u{0430}{}", &HEX[1..]),
            // A v2 hash (64 hex) is not a v1 one.
            "ab".repeat(32),
            String::new(),
        ] {
            assert_eq!(build_magnet(&hostile, "x", &DEFAULT_TRACKERS), None, "{hostile:?}");
            assert_eq!(normalize_info_hash(&hostile), None, "{hostile:?}");
        }
    }

    proptest! {
        #[test]
        fn every_hash_normalises_to_lowercase_hex_and_stays_so(bytes in prop::array::uniform20(any::<u8>())) {
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            prop_assert_eq!(normalize_info_hash(&hex.to_uppercase()), Some(hex.clone()));
            prop_assert_eq!(normalize_info_hash(&hex), Some(hex));
        }

        #[test]
        fn whatever_a_source_sends_a_magnet_holds_one_hash_its_name_and_our_trackers(
            bytes in prop::array::uniform20(any::<u8>()),
            before in "([0-9A-Za-z&=%:/?#. ]|tr=|xs=){0,4}",
            after in "([0-9A-Za-z&=%:/?#. ]|&tr=udp://e|&xs=http://e){0,4}",
            name in any::<String>(),
        ) {
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let sent = format!("{before}{}{after}", hex.to_uppercase());
            match build_magnet(&sent, &name, &DEFAULT_TRACKERS) {
                Some(magnet) => {
                    prop_assert!(before.is_empty() && after.is_empty(), "{sent:?} made a magnet");
                    prop_assert_eq!(parameters(&magnet.uri), expected(&hex, &name));
                }
                None => prop_assert!(!before.is_empty() || !after.is_empty(), "{sent:?} made none"),
            }
        }
    }
}
