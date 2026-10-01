//! Magnetar: torrent search, downloads and series rules behind a local dashboard, reachable
//! remotely through an end-to-end encrypted relay. `main.rs` adds the process lifecycle and tray.

pub mod api;
pub mod app;
pub mod bridge;
pub mod config;
pub mod db;
pub mod downloads;
pub mod error;
pub mod events;
pub mod http;
pub mod instance;
pub mod legacy;
pub mod log;
pub mod notifications;
pub mod paths;
pub mod protocol;
pub mod remote;
pub mod rpc;
pub mod search;
pub mod series;
pub mod settings;
pub mod system;
pub mod telemetry;
#[cfg(any(target_os = "macos", windows))]
pub mod tray;
pub mod updates;
