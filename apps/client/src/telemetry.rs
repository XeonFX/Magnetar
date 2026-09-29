//! Error reports go to the Worker, which forwards them to CodeFusion Console. Scrubbed of anything
//! identifying, capped at 10 an hour, off in development and when the user turns them off.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::config::{ARCH, CLOUD_URL, IS_DEV, PLATFORM, USER_AGENT, VERSION};
use crate::protocol::scrub::scrub;
use crate::settings::SettingsService;

const MAX_PER_HOUR: usize = 10;

pub fn start(settings: Arc<SettingsService>, http: reqwest::Client) {
    if *IS_DEV {
        return;
    }
    let sent: Mutex<VecDeque<Instant>> = Mutex::default();
    let runtime = tokio::runtime::Handle::current();
    crate::log::set_error_sink(move |scope, message| {
        if !settings.get().error_reports_enabled {
            return;
        }
        {
            let mut sent = sent.lock().unwrap();
            while sent.front().is_some_and(|t| t.elapsed() > Duration::from_secs(3600)) {
                sent.pop_front();
            }
            if sent.len() >= MAX_PER_HOUR {
                return;
            }
            sent.push_back(Instant::now());
        }
        let page: String = format!("client-{scope}")
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' { c } else { '-' })
            .take(40)
            .collect();
        let report = json!({
            "source": "error",
            "name": "Error",
            "message": scrub(message).chars().take(1000).collect::<String>(),
            "stack": null,
            "page": page,
            "version": VERSION,
            "client": format!("MediaDownloader {VERSION} · {PLATFORM} {ARCH} · desktop"),
        });
        let request = http
            .post(format!("{}/api/telemetry/failure", *CLOUD_URL))
            .header("user-agent", USER_AGENT.as_str())
            .json(&report)
            .timeout(Duration::from_secs(10));
        runtime.spawn(async move {
            let _ = request.send().await;
        });
    });
}
