//! Device names, as `packages/protocol/src/deviceName.ts` has them: the first part of the device's address on the
//! website, so ASCII letters and digits joined by single hyphens, at most 40 characters, and none of the website's
//! own paths. Both read the rules from `device-names.json`. The account makes a name unique and spells any other
//! text as a name; the app only checks what it is about to send and offers its hostname.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rules {
    max_length: usize,
    reserved: HashSet<String>,
}

static RULES: LazyLock<Rules> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../packages/protocol/src/device-names.json")).expect("device-names.json")
});

/// Whether `name` may be a device's name as it is.
pub fn is_device_name(name: &str) -> bool {
    name.len() <= RULES.max_length
        && name.split('-').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric()))
        && !RULES.reserved.contains(&name.to_ascii_lowercase())
}

/// A name from a hostname (`Krystians-MacBook-Pro.local` → `Krystians-MacBook-Pro`), or `None` when nothing of it
/// makes one. Other characters become hyphens; the account spells anything else when the device pairs.
pub fn from_hostname(host: &str) -> Option<String> {
    let host = host.strip_suffix(".local").unwrap_or(host);
    let spelled: String = host.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let joined = spelled.split('-').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("-");
    let name = joined[..joined.len().min(RULES.max_length)].trim_end_matches('-');
    is_device_name(name).then(|| name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Cases {
        valid: Vec<String>,
        invalid: Vec<String>,
    }

    #[test]
    fn agrees_with_the_shared_cases() {
        let cases: Cases = serde_json::from_str(include_str!("../../../../packages/protocol/src/device-names.json")).unwrap();
        for name in &cases.valid {
            assert!(is_device_name(name), "{name:?} should be valid");
        }
        for name in &cases.invalid {
            assert!(!is_device_name(name), "{name:?} should be invalid");
        }
    }

    #[test]
    fn names_from_hostnames() {
        assert_eq!(from_hostname("Krystians-MacBook-Pro.local").as_deref(), Some("Krystians-MacBook-Pro"));
        assert_eq!(from_hostname("DESKTOP-4F2K9QX").as_deref(), Some("DESKTOP-4F2K9QX"));
        assert_eq!(from_hostname("my_box.lan").as_deref(), Some("my-box-lan"));
        assert_eq!(from_hostname(&"a".repeat(60)).as_deref(), Some("a".repeat(40).as_str()));
        assert_eq!(from_hostname(&format!("{} b", "a".repeat(39))).as_deref(), Some("a".repeat(39).as_str()));
        assert_eq!(from_hostname("łódź-pc").as_deref(), Some("d-pc"));
        assert_eq!(from_hostname("łódź"), None);
        assert_eq!(from_hostname(""), None);
        assert_eq!(from_hostname("---"), None);
        assert_eq!(from_hostname("login"), None);
    }
}
