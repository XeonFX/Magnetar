//! Versions as Semantic Versioning 2.0 reads them, the same way the dashboard and the website do
//! (`@codefusion-cc/app-update`): `1.2.0-rc.1` comes before `1.2.0`, build metadata (`1.2.0+dev`)
//! changes nothing, and a leading `v` is allowed. A tag that is not a version never counts as newer.

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    core: [u64; 3],
    /// Pre-release identifiers as written: `["rc", "1"]` for `1.2.0-rc.1`.
    prerelease: Vec<String>,
}

fn is_numeric(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())
}

fn valid_identifier(id: &str, build: bool) -> bool {
    !id.is_empty()
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        // A numeric pre-release identifier has no leading zero; build metadata may.
        && (build || !is_numeric(id) || id == "0" || !id.starts_with('0'))
}

fn number(part: &str) -> Option<u64> {
    (is_numeric(part) && (part == "0" || !part.starts_with('0'))).then(|| part.parse().ok()).flatten()
}

impl Version {
    /// Reads `1.2.0`, `v1.2.0-rc.1` or `1.2.0+dev`; None for anything else.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        if text.len() > 256 {
            return None;
        }
        let text = text.strip_prefix(['v', 'V']).unwrap_or(text);
        let (rest, build) = match text.split_once('+') {
            Some((rest, build)) => (rest, Some(build)),
            None => (text, None),
        };
        if let Some(build) = build
            && !build.split('.').all(|id| valid_identifier(id, true))
        {
            return None;
        }
        let (core, prerelease) = match rest.split_once('-') {
            Some((core, prerelease)) => (core, Some(prerelease)),
            None => (rest, None),
        };
        let parts: Vec<u64> = core.split('.').map(number).collect::<Option<_>>()?;
        let core: [u64; 3] = parts.try_into().ok()?;
        let prerelease = match prerelease {
            Some(text) => {
                let ids: Vec<String> = text.split('.').map(str::to_owned).collect();
                if !ids.iter().all(|id| valid_identifier(id, false)) {
                    return None;
                }
                ids
            }
            None => Vec::new(),
        };
        Some(Self { core, prerelease })
    }

    pub fn is_prerelease(&self) -> bool {
        !self.prerelease.is_empty()
    }
}

fn compare_identifiers(a: &str, b: &str) -> Ordering {
    match (is_numeric(a), is_numeric(b)) {
        // Numbers of any size: no leading zeros, so the longer is the larger.
        (true, true) => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.cmp(b),
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core.cmp(&other.core).then_with(|| match (self.is_prerelease(), other.is_prerelease()) {
            // A pre-release comes before the release it names.
            (false, false) => Ordering::Equal,
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (true, true) => self
                .prerelease
                .iter()
                .zip(&other.prerelease)
                .map(|(a, b)| compare_identifiers(a, b))
                .find(|o| o.is_ne())
                .unwrap_or_else(|| self.prerelease.len().cmp(&other.prerelease.len())),
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Whether `running` is older than `latest`; never when either is not a version.
pub fn is_outdated(running: &str, latest: &str) -> bool {
    matches!((Version::parse(running), Version::parse(latest)), (Some(r), Some(l)) if r < l)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap_or_else(|| panic!("{text} is a version"))
    }

    #[test]
    fn orders_versions_as_semantic_versioning_lists_them() {
        let ordered = [
            "0.9.9",
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
            "1.0.1",
            "1.9.0",
            "1.10.0",
            "2.0.0",
        ];
        for (i, a) in ordered.iter().enumerate() {
            for (j, b) in ordered.iter().enumerate() {
                assert_eq!(v(a).cmp(&v(b)), i.cmp(&j), "{a} vs {b}");
            }
        }
    }

    #[test]
    fn build_metadata_and_a_v_change_nothing() {
        assert_eq!(v("1.2.0+dev"), v("1.2.0"));
        assert_eq!(v("v1.2.0").cmp(&v("1.2.0+sha.abc")), Ordering::Equal);
        assert_eq!(v("1.0.0-rc.99999999999999999999").cmp(&v("1.0.0-rc.100000000000000000000")), Ordering::Less);
    }

    #[test]
    fn reads_only_versions() {
        for text in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "nightly",
            "01.2.3",
            "1.2.3-",
            "1.2.3-01",
            "1.2.3-a..b",
            "1.2.3+",
            "1.2.3-é",
            "-1.2.3",
            "1.2.3 beta",
            "vv1.2.3",
            "99999999999999999999.0.0",
        ] {
            assert_eq!(Version::parse(text), None, "{text:?}");
        }
        assert!(v("1.2.3-rc.1").is_prerelease());
        assert!(!v("1.2.3+build").is_prerelease());
    }

    #[test]
    fn outdated_only_when_behind_and_both_are_versions() {
        assert!(is_outdated("1.0.0", "1.1.0"));
        assert!(is_outdated("1.1.0-rc.1", "1.1.0"));
        assert!(!is_outdated("1.1.0", "1.1.0"));
        assert!(!is_outdated("1.1.0+dev", "1.1.0"));
        assert!(!is_outdated("1.2.0-rc.1", "1.1.0"));
        assert!(!is_outdated("garbage", "1.1.0"));
        assert!(!is_outdated("1.0.0", "nightly"));
    }

    fn version() -> impl Strategy<Value = String> {
        let id = prop_oneof!["(0|[1-9][0-9]{0,2})", "[a-z][a-z0-9-]{0,4}"];
        (0u64..20, 0u64..20, 0u64..20, prop::collection::vec(id, 0..3), prop::bool::ANY).prop_map(|(a, b, c, pre, build)| {
            let pre = if pre.is_empty() { String::new() } else { format!("-{}", pre.join(".")) };
            format!("{a}.{b}.{c}{pre}{}", if build { "+dev" } else { "" })
        })
    }

    proptest! {
        #[test]
        fn is_a_total_order(a in version(), b in version(), c in version()) {
            let (a, b, c) = (v(&a), v(&b), v(&c));
            prop_assert_eq!(a.cmp(&a), Ordering::Equal);
            prop_assert_eq!(a.cmp(&b), b.cmp(&a).reverse());
            if a <= b && b <= c {
                prop_assert!(a <= c);
            }
        }

        #[test]
        fn a_prerelease_comes_before_its_release(a in 0u64..50, b in 0u64..50, c in 0u64..50, pre in "[a-z][a-z0-9]{0,4}") {
            let (prerelease, release) = (format!("{a}.{b}.{c}-{pre}"), format!("{a}.{b}.{c}"));
            prop_assert!(is_outdated(&prerelease, &release));
        }
    }
}
