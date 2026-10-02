use std::sync::LazyLock;

/// Stamped by package.ts from the release tag; dev builds report the crate version with `+dev`
/// build metadata, which compares equal to it (a dev build is never "outdated" by its own release).
pub const VERSION: &str = match option_env!("MAGNETAR_VERSION") {
    Some(version) => version,
    None => concat!(env!("CARGO_PKG_VERSION"), "+dev"),
};

/// The commit the build came from (short), stamped by package.ts; `dev` for `cargo run`.
pub const COMMIT: &str = match option_env!("MAGNETAR_COMMIT") {
    Some(commit) => commit,
    None => "dev",
};

/// How the build introduces itself: `1.2.0 (abc1234)`.
pub fn build_label() -> String {
    format!("{VERSION} ({COMMIT})")
}

/// Ed25519 public key (base64url) whose private half signs release manifests in CI.
pub const RELEASE_PUBLIC_KEY: &str = env!("MAGNETAR_RELEASE_PUBLIC_KEY");

pub const PLATFORM: &str = if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(windows) {
    "windows"
} else {
    "linux"
};

pub const ARCH: &str = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };

pub const DEFAULT_PORT: u16 = 47820;

pub const DEFAULT_CLOUD_URL: &str = "https://magnetar.codefusion.cc";

pub static IS_DEV: LazyLock<bool> =
    LazyLock::new(|| option_env!("MAGNETAR_VERSION").is_none() || std::env::var("MAGNETAR_DEV").as_deref() == Ok("1"));

/// Where the dashboard and relay live. Overridable for local development of the Worker.
pub static CLOUD_URL: LazyLock<String> = LazyLock::new(|| {
    std::env::var("MAGNETAR_CLOUD_URL").unwrap_or_else(|_| DEFAULT_CLOUD_URL.to_owned()).trim_end_matches('/').to_owned()
});

/// Where releases come from. Clients built before the move to codefusion-cc ask for XeonFX/Magnetar, which GitHub
/// redirects here as long as no repository takes that name again.
pub static GITHUB_REPO: LazyLock<String> =
    LazyLock::new(|| std::env::var("MAGNETAR_GITHUB_REPO").unwrap_or_else(|_| "codefusion-cc/magnetar".to_owned()));

pub static USER_AGENT: LazyLock<String> = LazyLock::new(|| format!("Magnetar/{VERSION}"));

/// The client every outgoing HTTP request uses, introducing itself as the app.
pub fn http_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder().user_agent(USER_AGENT.as_str()).build()
}
