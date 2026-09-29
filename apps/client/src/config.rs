use std::sync::LazyLock;

/// Stamped by package.ts from the release tag; dev builds report the crate version.
pub const VERSION: &str = match option_env!("MD_VERSION") {
    Some(version) => version,
    None => concat!(env!("CARGO_PKG_VERSION"), "-dev"),
};

/// Ed25519 public key (base64url) whose private half signs release manifests in CI.
pub const RELEASE_PUBLIC_KEY: &str = env!("MD_RELEASE_PUBLIC_KEY");

pub const PLATFORM: &str = if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(windows) {
    "windows"
} else {
    "linux"
};

pub const ARCH: &str = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };

pub const DEFAULT_PORT: u16 = 47820;

pub const DEFAULT_CLOUD_URL: &str = "https://mediadownloader.codefusion.cc";

pub static IS_DEV: LazyLock<bool> =
    LazyLock::new(|| option_env!("MD_VERSION").is_none() || std::env::var("MD_DEV").as_deref() == Ok("1"));

/// Where the dashboard and relay live. Overridable for local development of the Worker.
pub static CLOUD_URL: LazyLock<String> = LazyLock::new(|| {
    std::env::var("MD_CLOUD_URL").unwrap_or_else(|_| DEFAULT_CLOUD_URL.to_owned()).trim_end_matches('/').to_owned()
});

pub static GITHUB_REPO: LazyLock<String> =
    LazyLock::new(|| std::env::var("MD_GITHUB_REPO").unwrap_or_else(|_| "XeonFX/MediaDownloader".to_owned()));

pub static USER_AGENT: LazyLock<String> = LazyLock::new(|| format!("MediaDownloader/{VERSION}"));
