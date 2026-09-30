use std::sync::Mutex;

use crate::error::{ApiError, ErrorCode};
use crate::protocol::encoding::{Clock, system_clock};

const BURST: f64 = 10.0;
const REFILL_MS: f64 = 3000.0;

/// Caps how fast agents make the app hit torrent sites. One search fans out to every source, and
/// these sites answer sustained load with Cloudflare challenges — which is how RARBG stopped
/// working. A token bucket lets a few calls through back to back but not a sustained stream, and
/// refuses fast with a wait hint instead of blocking.
pub struct RateLimiter {
    state: Mutex<(f64, u64)>,
    now: Clock,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::with_clock(system_clock())
    }
}

impl RateLimiter {
    pub fn with_clock(now: Clock) -> Self {
        let start = now();
        Self { state: Mutex::new((BURST, start)), now }
    }

    pub fn ensure_allowed(&self, operation: &str) -> Result<(), ApiError> {
        let now = (self.now)();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let (tokens, last) = *state;
        let tokens = BURST.min(tokens + now.saturating_sub(last) as f64 / REFILL_MS);
        *state = (tokens, now);
        if tokens < 1.0 {
            let wait = (REFILL_MS * (1.0 - tokens) / 1000.0).ceil();
            return Err(ApiError::new(
                ErrorCode::RateLimited,
                format!(
                    "Too many {operation} requests in a short time — each one queries every enabled torrent site, and hammering them gets this app blocked. Wait about {wait}s and try again."
                ),
            ));
        }
        state.0 = tokens - 1.0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    #[test]
    fn allows_a_burst_of_10_then_refills_one_per_3s() {
        let now = Arc::new(AtomicU64::new(0));
        let clock = now.clone();
        let limiter = RateLimiter::with_clock(Box::new(move || clock.load(Ordering::Relaxed)));
        for _ in 0..10 {
            limiter.ensure_allowed("search").unwrap();
        }
        assert!(limiter.ensure_allowed("search").unwrap_err().message.contains("Wait about 3s"));
        now.fetch_add(3000, Ordering::Relaxed);
        limiter.ensure_allowed("search").unwrap();
    }
}
