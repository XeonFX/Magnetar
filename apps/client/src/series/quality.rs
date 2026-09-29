//! Which release of an episode a series task takes: the ones its quality rules allow, best first.

use std::sync::LazyLock;

use regex::Regex;

use crate::search::types::TorrentSearchResult;

/// The resolutions a rule can ask for, as the dashboard names them.
pub const RESOLUTIONS: [&str; 3] = ["720p", "1080p", "2160p"];

fn token(pattern: &str) -> Regex {
    // Delimited by anything but a letter or digit, so "x265" matches in "1080p.x265-GRP" and "web"
    // does not match inside "webcam" (as the dashboard's release tags do).
    Regex::new(&format!(r"(?i)(?:^|[^a-z0-9])(?:{pattern})(?:$|[^a-z0-9])")).unwrap()
}

static RESOLUTION_PATTERNS: LazyLock<[(&str, Regex); 3]> =
    LazyLock::new(|| [("2160p", token("2160p|4k|uhd")), ("1080p", token("1080[pi]")), ("720p", token("720p"))]);

/// A release title's resolution, when it names one.
pub fn resolution_of(title: &str) -> Option<&'static str> {
    RESOLUTION_PATTERNS.iter().find(|(_, pattern)| pattern.is_match(title)).map(|(name, _)| *name)
}

/// Words split on commas or spaces, lowercased: "SubsPlease, HEVC" → ["subsplease", "hevc"].
pub fn words(list: Option<&str>) -> Vec<String> {
    list.unwrap_or_default().split([',', ' ']).map(|w| w.trim().to_lowercase()).filter(|w| !w.is_empty()).collect()
}

#[derive(Debug, Default, Clone)]
pub struct QualityRule {
    pub resolution: Option<String>,
    pub min_seeders: u32,
    pub max_size_bytes: Option<u64>,
    pub prefer: Vec<String>,
    pub exclude: Vec<String>,
}

impl QualityRule {
    /// Whether a release may be taken at all. A size or seeder count the source doesn't give (0)
    /// isn't held against it, except that a dead release (no seeders) is.
    pub fn accepts(&self, result: &TorrentSearchResult) -> bool {
        let title = result.title.to_lowercase();
        if self.exclude.iter().any(|word| title.contains(word.as_str())) {
            return false;
        }
        if let Some(wanted) = &self.resolution
            && resolution_of(&result.title) != Some(wanted.as_str())
        {
            return false;
        }
        if self.max_size_bytes.is_some_and(|max| result.size_bytes > max) {
            return false;
        }
        result.seeders >= self.min_seeders.max(1)
    }

    /// Ranking among accepted releases: more preferred words first, then more seeders.
    fn rank(&self, result: &TorrentSearchResult) -> (usize, u32) {
        let title = result.title.to_lowercase();
        (self.prefer.iter().filter(|word| title.contains(word.as_str())).count(), result.seeders)
    }

    /// The best of `candidates` this rule accepts.
    pub fn best<'a>(&self, candidates: impl IntoIterator<Item = &'a TorrentSearchResult>) -> Option<&'a TorrentSearchResult> {
        candidates.into_iter().filter(|r| self.accepts(r)).max_by_key(|r| self.rank(r))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(title: &str, seeders: u32, size_mb: u64) -> TorrentSearchResult {
        TorrentSearchResult { seeders, size_bytes: size_mb * 1024 * 1024, ..TorrentSearchResult::new(title, "X") }
    }

    #[test]
    fn resolutions_are_read_as_whole_tokens() {
        assert_eq!(resolution_of("Show.S01E01.2160p.WEB.H265"), Some("2160p"));
        assert_eq!(resolution_of("Show S01E01 [4K]"), Some("2160p"));
        assert_eq!(resolution_of("[SubsPlease] Show - 06 (1080p) [ABC].mkv"), Some("1080p"));
        assert_eq!(resolution_of("Show.1080i.HDTV"), Some("1080p"));
        assert_eq!(resolution_of("Show 720p"), Some("720p"));
        assert_eq!(resolution_of("Show.S01E01.x264"), None);
        assert_eq!(resolution_of("Show.S01E01.10800p"), None);
        assert_eq!(resolution_of("uhdtv special"), None, "uhd inside another word");
    }

    #[test]
    fn words_split_on_commas_and_spaces() {
        assert_eq!(words(Some(" SubsPlease, HEVC  x265,")), ["subsplease", "hevc", "x265"]);
        assert!(words(None).is_empty() && words(Some(" , ")).is_empty());
    }

    #[test]
    fn rules_filter_then_rank_by_preference_then_seeders() {
        let rule = QualityRule {
            resolution: Some("1080p".into()),
            min_seeders: 5,
            max_size_bytes: Some(2 * 1024 * 1024 * 1024),
            prefer: words(Some("SubsPlease")),
            exclude: words(Some("CAM, HDTS")),
        };
        let candidates = [
            release("Show - 06 (1080p) [Erai]", 900, 1400),
            release("[SubsPlease] Show - 06 (1080p)", 40, 1300),
            release("[SubsPlease] Show - 06 (720p)", 2000, 700),
            release("Show - 06 1080p CAM", 5000, 1200),
            release("Show - 06 1080p REMUX", 3000, 9000),
            release("[SubsPlease] Show - 06 (1080p) dead", 4, 1300),
        ];
        assert_eq!(
            rule.best(&candidates).unwrap().title,
            "[SubsPlease] Show - 06 (1080p)",
            "a preferred group beats more seeders"
        );
        let plain = QualityRule::default();
        assert_eq!(plain.best(&candidates).unwrap().title, "Show - 06 1080p CAM", "no rules: most seeders");
        assert!(plain.best(&[release("Dead", 0, 100)]).is_none(), "a release nobody seeds is never taken");
        assert!(rule.best(&candidates[2..3]).is_none());
    }
}
