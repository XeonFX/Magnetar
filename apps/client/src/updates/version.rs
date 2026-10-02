//! Versions as Semantic Versioning 2.0 reads them (the `semver` crate), the same way the dashboard
//! and the website do (`@codefusion-cc/app-update`): `1.2.0-rc.1` comes before `1.2.0`, build
//! metadata (`1.2.0+dev`) changes nothing, and a leading `v` is allowed. A tag that is not a
//! version never counts as newer.

use std::cmp::Ordering;

pub use semver::Version;

/// Reads `1.2.0`, `v1.2.0-rc.1` or `1.2.0+dev`; None for anything else.
pub fn parse(text: &str) -> Option<Version> {
    let text = text.trim();
    Version::parse(text.strip_prefix(['v', 'V']).unwrap_or(text)).ok()
}

/// Which comes first, build metadata aside.
pub fn precedence(a: &Version, b: &Version) -> Ordering {
    a.cmp_precedence(b)
}

/// Whether `running` is older than `latest`; never when either is not a version.
pub fn is_outdated(running: &str, latest: &str) -> bool {
    matches!((parse(running), parse(latest)), (Some(r), Some(l)) if precedence(&r, &l).is_lt())
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn v(text: &str) -> Version {
        parse(text).unwrap_or_else(|| panic!("{text} is a version"))
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
                assert_eq!(precedence(&v(a), &v(b)), i.cmp(&j), "{a} vs {b}");
            }
        }
    }

    #[test]
    fn build_metadata_and_a_v_change_nothing() {
        assert_eq!(precedence(&v("1.2.0+dev"), &v("1.2.0")), Ordering::Equal);
        assert_eq!(precedence(&v("v1.2.0"), &v("1.2.0+sha.abc")), Ordering::Equal);
        assert_eq!(precedence(&v(" V1.2.0\n"), &v("1.2.0")), Ordering::Equal);
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
            assert_eq!(parse(text), None, "{text:?}");
        }
        assert!(!v("1.2.3-rc.1").pre.is_empty());
        assert!(v("1.2.3+build").pre.is_empty());
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

    proptest! {
        #[test]
        fn a_prerelease_comes_before_its_release(a in 0u64..50, b in 0u64..50, c in 0u64..50, pre in "[a-z][a-z0-9]{0,4}") {
            let (prerelease, release) = (format!("{a}.{b}.{c}-{pre}"), format!("{a}.{b}.{c}"));
            prop_assert!(is_outdated(&prerelease, &release));
        }
    }
}
