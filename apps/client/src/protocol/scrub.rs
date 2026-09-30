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

static RULES: LazyLock<Rules> = LazyLock::new(|| Rules {
    url: Regex::new(r#"(?i)https?://[^\s'")]+"#).unwrap(),
    magnet: Regex::new(r#"(?i)magnet:\?[^\s'")]+"#).unwrap(),
    email: Regex::new(r"[\w.+-]+@[\w-]+\.[\w.-]+").unwrap(),
    quoted: Regex::new("\"[^\"\\n]*\"|'[^'\\n]*'|“[^”\\n]*”").unwrap(),
    path: Regex::new(r#"(?:[A-Za-z]:)?(?:[\\/][^\\/\s:'"()]+)+"#).unwrap(),
    ip: Regex::new(r"\b\d{1,3}(?:\.\d{1,3}){3}\b").unwrap(),
    hex: Regex::new(r"(?i)\b[0-9a-f]{16,}\b").unwrap(),
    token: Regex::new(r"\b[A-Za-z0-9_-]{32,}\b").unwrap(),
});

/// Strips anything that could identify the user or what they download before an error report
/// leaves their device (the same rules as `packages/protocol/src/scrub.ts`).
pub fn scrub(text: &str) -> String {
    let r = &*RULES;
    let text = r.url.replace_all(text, "<url>");
    let text = r.magnet.replace_all(&text, "<magnet>");
    let text = r.email.replace_all(&text, "<email>");
    let text = r.quoted.replace_all(&text, "\"…\"");
    let text = r.path.replace_all(&text, |caps: &regex::Captures| {
        let last = caps[0].rsplit(['/', '\\']).next().unwrap_or_default().to_owned();
        format!("…/{last}")
    });
    let text = r.ip.replace_all(&text, "<ip>");
    let text = r.hex.replace_all(&text, "<hex>");
    r.token.replace_all(&text, "<token>").into_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn removes_titles_paths_urls_addresses_hashes_and_tokens() {
        let scrubbed = super::scrub(
            "Could not resolve \"Some.Show.S01E01.1080p\" at /Users/alice/Downloads/x.mkv from https://nyaa.si/view/1 for bob@example.com 10.0.0.4 hash abcdef0123456789abcdef0123456789abcdef01 token AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-",
        );
        for leaked in ["Some.Show", "alice", "nyaa", "bob@", "10.0.0.4", "abcdef0123", "AbCdEfGh"] {
            assert!(!scrubbed.contains(leaked), "{leaked} leaked: {scrubbed}");
        }
        assert!(scrubbed.contains("Could not resolve"));
    }
}
