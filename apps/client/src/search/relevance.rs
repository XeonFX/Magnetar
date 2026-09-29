/// Drops results that don't actually match the query. Some sites (notably 1337x) match loosely
/// and, sorted by seeders, float unrelated high-seed torrents to the top — so every meaningful
/// query term must appear in the title.
pub fn matches_query(query: &str, title: &str) -> bool {
    let normalized_title = normalize(title);
    tokenize(query).iter().all(|token| normalized_title.contains(token.as_str()))
}

fn normalize(text: &str) -> String {
    let lower = text.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut gap = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    out
}

fn tokenize(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for token in normalize(text).split(' ').filter(|t| t.len() >= 2) {
        if !tokens.iter().any(|t| t == token) {
            tokens.push(token.to_owned());
        }
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::matches_query;

    #[test]
    fn every_token_of_the_query_must_be_in_the_title() {
        assert!(matches_query("ubuntu 24.04", "ubuntu-24.04-desktop-amd64.iso"));
        assert!(matches_query("The Matrix 1999", "The.Matrix.1999.1080p.BluRay.x264"));
        assert!(!matches_query("matrix reloaded", "The.Matrix.1999"));
        assert!(matches_query("UBUNTU", "ubuntu"));
        assert!(matches_query("a", "anything"));
        assert!(matches_query("", "anything"));
    }
}
