//! What the engine runs with: the speed caps in force (usual or alternative, by hand or on a
//! schedule), the network interface it is bound to, and the free space left for downloads.

use std::path::Path;

use chrono::{Datelike, Timelike};

use super::engine::SpeedLimits;
use crate::protocol::{AltSpeedMode, NetworkInterfaceDto};
use crate::settings::AppSettings;

/// Whether the alternative limits apply at this local weekday (0 = Monday) and minute of the day.
pub fn alt_speed_active(settings: &AppSettings, weekday: u8, minute: u16) -> bool {
    match settings.alt_speed_mode {
        AltSpeedMode::Off => false,
        AltSpeedMode::On => true,
        AltSpeedMode::Scheduled => {
            let (from, to, days) = (settings.alt_schedule_from, settings.alt_schedule_to, &settings.alt_schedule_days);
            let on = |day: u8| days.contains(&day);
            if from == to {
                on(weekday)
            } else if from < to {
                on(weekday) && (from..to).contains(&minute)
            } else {
                // Overnight: from the start day's evening into the next morning.
                (on(weekday) && minute >= from) || (on((weekday + 6) % 7) && minute < to)
            }
        }
    }
}

/// The caps for right now, and whether they are the alternative ones.
pub fn current_limits(settings: &AppSettings) -> (SpeedLimits, bool) {
    let now = chrono::Local::now();
    let alt = alt_speed_active(settings, now.weekday().num_days_from_monday() as u8, (now.hour() * 60 + now.minute()) as u16);
    let limits = if alt {
        SpeedLimits { download: settings.alt_download_limit, upload: settings.alt_upload_limit }
    } else {
        SpeedLimits { download: settings.download_limit, upload: settings.upload_limit }
    };
    (limits, alt)
}

/// Binding to an interface is what the engine supports on macOS and Linux.
pub const INTERFACE_BINDING: bool = cfg!(any(target_os = "macos", target_os = "linux"));

/// The chosen interface, when binding applies.
pub fn wanted_interface(settings: &AppSettings) -> Option<String> {
    let name = settings.network_interface.trim();
    (INTERFACE_BINDING && !name.is_empty()).then(|| name.to_owned())
}

/// The interface's index while it exists (a VPN tunnel gets a new one each time it comes up).
pub fn interface_index(name: &str) -> Option<u32> {
    #[cfg(unix)]
    {
        let name = std::ffi::CString::new(name).ok()?;
        // SAFETY: a valid NUL-terminated string; the call only reads it.
        let index = unsafe { libc::if_nametoindex(name.as_ptr()) };
        (index != 0).then_some(index)
    }
    #[cfg(not(unix))]
    {
        let _ = name;
        None
    }
}

/// Interfaces that can reach beyond the link they are on, VPN tunnels first. macOS keeps several
/// system tunnels with only a link-local address; those are no one's VPN and are left out.
pub fn list_interfaces() -> Vec<NetworkInterfaceDto> {
    use network_interface::{NetworkInterface, NetworkInterfaceConfig};
    let mut by_name: std::collections::BTreeMap<String, Vec<std::net::IpAddr>> = Default::default();
    for interface in NetworkInterface::show().unwrap_or_default() {
        by_name.entry(interface.name).or_default().extend(interface.addr.iter().map(|a| a.ip()));
    }
    let mut list: Vec<NetworkInterfaceDto> = by_name
        .into_iter()
        .filter_map(|(name, mut addresses)| {
            addresses.retain(routable);
            addresses.sort_by_key(|ip| ip.is_ipv6());
            (!addresses.is_empty()).then(|| NetworkInterfaceDto {
                vpn: looks_like_vpn(&name),
                addresses: addresses.iter().map(ToString::to_string).collect(),
                name,
            })
        })
        .collect();
    list.sort_by_key(|i| !i.vpn);
    list
}

/// Neither loopback nor link-local: an address other networks can be reached from.
fn routable(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified(),
        std::net::IpAddr::V6(v6) => !v6.is_loopback() && !v6.is_unicast_link_local() && !v6.is_unspecified(),
    }
}

fn looks_like_vpn(name: &str) -> bool {
    ["utun", "tun", "tap", "wg", "ppp", "ipsec", "nordlynx", "proton", "mullvad"].iter().any(|p| name.starts_with(p))
}

/// Free bytes on the disk holding `path`, or its nearest existing parent.
pub fn free_space(path: &Path) -> Option<u64> {
    let existing = path.ancestors().find(|p| p.exists())?;
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c_path = std::ffi::CString::new(existing.as_os_str().as_bytes()).ok()?;
        let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: a valid path and a zeroed struct for the call to fill.
        if unsafe { libc::statvfs(c_path.as_ptr(), &mut stats) } != 0 {
            return None;
        }
        #[allow(clippy::unnecessary_cast)]
        Some(stats.f_bavail as u64 * stats.f_frsize as u64)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = existing.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free: u64 = 0;
        // SAFETY: a NUL-terminated path and a valid out pointer; the other outputs are optional.
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(free)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scheduled(from: u16, to: u16, days: &[u8]) -> AppSettings {
        AppSettings {
            alt_speed_mode: AltSpeedMode::Scheduled,
            alt_schedule_from: from,
            alt_schedule_to: to,
            alt_schedule_days: days.to_vec(),
            ..AppSettings::default()
        }
    }

    const MON: u8 = 0;
    const TUE: u8 = 1;
    const SUN: u8 = 6;

    #[test]
    fn a_daytime_window_includes_its_start_and_excludes_its_end() {
        let s = scheduled(8 * 60, 23 * 60, &[MON]);
        assert!(!alt_speed_active(&s, MON, 8 * 60 - 1));
        assert!(alt_speed_active(&s, MON, 8 * 60));
        assert!(alt_speed_active(&s, MON, 23 * 60 - 1));
        assert!(!alt_speed_active(&s, MON, 23 * 60));
        assert!(!alt_speed_active(&s, TUE, 12 * 60), "only on the chosen days");
    }

    #[test]
    fn an_overnight_window_runs_into_the_next_morning_of_its_start_day() {
        let s = scheduled(22 * 60, 6 * 60, &[SUN]);
        assert!(alt_speed_active(&s, SUN, 23 * 60));
        assert!(alt_speed_active(&s, MON, 5 * 60 + 59), "Sunday night reaches Monday morning");
        assert!(!alt_speed_active(&s, MON, 6 * 60));
        assert!(!alt_speed_active(&s, MON, 23 * 60), "Monday is not a start day");
        assert!(!alt_speed_active(&s, SUN, 5 * 60), "Sunday morning belongs to Saturday night");
    }

    #[test]
    fn equal_start_and_end_mean_the_whole_day() {
        let s = scheduled(0, 0, &[TUE]);
        assert!(alt_speed_active(&s, TUE, 0) && alt_speed_active(&s, TUE, 1439));
        assert!(!alt_speed_active(&s, MON, 720));
    }

    #[test]
    fn manual_modes_ignore_the_schedule() {
        let mut s = scheduled(0, 1, &[]);
        s.alt_speed_mode = AltSpeedMode::On;
        assert!(alt_speed_active(&s, MON, 720));
        s.alt_speed_mode = AltSpeedMode::Off;
        assert!(!alt_speed_active(&s, MON, 0));
    }

    #[test]
    fn free_space_is_read_from_the_nearest_existing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let free = free_space(&dir.path().join("not/yet/created")).expect("free space");
        assert!(free > 0);
        assert_eq!(interface_index("definitely-not-an-interface0"), None);
    }

    #[test]
    fn only_addresses_that_reach_other_networks_count() {
        for (ip, expected) in [
            ("192.168.1.5", true),
            ("10.8.0.2", true),
            ("2a01::1", true),
            ("127.0.0.1", false),
            ("169.254.3.1", false),
            ("fe80::1", false),
            ("::1", false),
        ] {
            assert_eq!(routable(&ip.parse().unwrap()), expected, "{ip}");
        }
    }
}
