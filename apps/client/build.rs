//! Stamps the release build: `MAGNETAR_VERSION` (set by package.ts from the release tag) and the update
//! signing key, from `MAGNETAR_RELEASE_PUBLIC_KEY` or the committed `release-public-key.txt`. On Windows
//! it also embeds the icon and version resource.

fn main() {
    println!("cargo:rerun-if-env-changed=MAGNETAR_VERSION");
    println!("cargo:rerun-if-env-changed=MAGNETAR_RELEASE_PUBLIC_KEY");
    println!("cargo:rerun-if-changed=release-public-key.txt");

    let key = std::env::var("MAGNETAR_RELEASE_PUBLIC_KEY")
        .ok()
        .or_else(|| std::fs::read_to_string("release-public-key.txt").ok())
        .map(|k| k.trim().to_owned())
        .unwrap_or_default();
    println!("cargo:rustc-env=MAGNETAR_RELEASE_PUBLIC_KEY={key}");

    #[cfg(windows)]
    windows_resources();
}

#[cfg(windows)]
fn windows_resources() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let version = std::env::var("MAGNETAR_VERSION").unwrap_or_else(|_| std::env::var("CARGO_PKG_VERSION").unwrap());
    let plain = version.split('-').next().unwrap_or("0.0.0").to_owned();
    let mut res = winresource::WindowsResource::new();
    // Ordinal 1 is also what the notification-area icon loads.
    res.set_icon_with_id("assets/TrayIcon.ico", "1")
        .set("ProductName", "Magnetar")
        .set("FileDescription", "Magnetar")
        .set("CompanyName", "CodeFusion")
        .set("ProductVersion", &version)
        .set("FileVersion", &plain);
    res.compile().expect("Windows resources");
}
