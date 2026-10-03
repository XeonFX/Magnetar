use std::sync::LazyLock;

use regex::Regex;

struct Rules {
    url: Regex,
    magnet: Regex,
    email: Regex,
    quoted: Regex,
    path: Regex,
    ip: Regex,
    hex: Regex,
    token: Regex,
}

/// Written as `scrub.ts` writes them, with no class or boundary whose meaning differs between Rust and JavaScript:
/// white space spelled out, and ASCII word boundaries (`(?-u:\b)` here, `\b` there).
static RULES: LazyLock<Rules> = LazyLock::new(|| Rules {
    url: Regex::new(r#"(?i)https?://[^\t\n\v\f\r '")]+"#).unwrap(),
    magnet: Regex::new(r#"(?i)magnet:\?[^\t\n\v\f\r '")]+"#).unwrap(),
    email: Regex::new(r#"[^\t\n\v\f\r "'<>()@:,;]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+"#).unwrap(),
    quoted: Regex::new("\"[^\"\\n]*\"|'[^'\\n]*'|“[^”\\n]*”").unwrap(),
    path: Regex::new(r#"(?:[A-Za-z]:|[^\t\n\v\f\r "'():\\/]+)?(?:[\\/][^\n"'():\\/]*)+"#).unwrap(),
    ip: Regex::new(r"(?-u:\b)[0-9]{1,3}(?:\.[0-9]{1,3}){3}(?-u:\b)").unwrap(),
    hex: Regex::new(r"(?i)(?-u:\b)[0-9a-f]{16,}(?-u:\b)").unwrap(),
    token: Regex::new(r"(?-u:\b)[A-Za-z0-9_-]{32,}(?-u:\b)").unwrap(),
});

/// Strips anything that could identify the user or what they download before an error report
/// leaves their device (the same rules as `packages/protocol/src/scrub.ts`).
pub fn scrub(text: &str) -> String {
    let r = &*RULES;
    let text = r.url.replace_all(text, "<url>");
    let text = r.magnet.replace_all(&text, "<magnet>");
    let text = r.email.replace_all(&text, "<email>");
    let text = r.quoted.replace_all(&text, "\"…\"");
    // All of it, names with spaces and relative paths too, up to a colon, quote or bracket: a file's or folder's name
    // is often the torrent's.
    let text = r.path.replace_all(&text, |caps: &regex::Captures| {
        let path = &caps[0];
        format!("<path>{}", &path[path.trim_end_matches([' ', '\t', '\r']).len()..])
    });
    let text = r.ip.replace_all(&text, "<ip>");
    let text = r.hex.replace_all(&text, "<hex>");
    r.token.replace_all(&text, "<token>").into_owned()
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use serde_json::Value;

    use super::scrub;

    /// The cases `packages/protocol/src/scrub.ts` is held to as well.
    #[test]
    fn scrubs_as_the_shared_vector_says() {
        let vector: Value = serde_json::from_str(include_str!("../../../../packages/protocol/src/scrub-vector.json")).unwrap();
        for case in vector["cases"].as_array().unwrap() {
            assert_eq!(scrub(case["input"].as_str().unwrap()), case["output"].as_str().unwrap());
        }
    }

    proptest! {
        #[test]
        fn no_part_of_a_path_is_left(
            start in "([A-Z]:|[A-Za-z0-9._-]{1,12})?",
            separator in "[/\\\\]",
            parts in prop::collection::vec(r"[A-Za-z0-9._\[\] -]{0,23}[A-Za-z0-9._\[\]-]", 1..6),
        ) {
            let path = format!("{start}{separator}{}", parts.join(&separator));
            prop_assert_eq!(scrub(&format!("could not open {path}: denied")), "could not open <path>: denied");
        }
    }
}
