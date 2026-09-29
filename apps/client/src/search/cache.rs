use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::error::{ApiError, ApiResult};
use crate::protocol::SearchResultDto;
use crate::protocol::encoding::{iso, random_id};

use super::types::{SharedResult, TorrentSearchResult, is_real_info_hash};

const LIFETIME_MS: u64 = 30 * 60_000;
const MAX_ENTRIES: usize = 2000;

struct Entry {
    result: SharedResult,
    last_used: u64,
    order: u64,
}

#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    next_order: u64,
    last_prune: u64,
}

pub type Clock = Box<dyn Fn() -> u64 + Send + Sync>;

/// Short-lived handles for search results. Starting a download needs the live result — a 1337x row
/// only has a placeholder hash until its detail page is fetched — and a dashboard or an agent over
/// HTTP has no other way to point back at it. Entries expire on a sliding window and the cache is
/// bounded, so a long-running app doesn't accumulate them.
pub struct SearchResultCache {
    state: Mutex<State>,
    now: Clock,
}

impl Default for SearchResultCache {
    fn default() -> Self {
        Self::with_clock(Box::new(|| chrono::Utc::now().timestamp_millis() as u64))
    }
}

impl SearchResultCache {
    pub fn with_clock(now: Clock) -> Self {
        Self { state: Mutex::default(), now }
    }

    pub fn add(&self, result: TorrentSearchResult) -> (String, SharedResult) {
        let now = (self.now)();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        // Scans for expired entries at most once a minute; the size cap is enforced on every add.
        if now.saturating_sub(state.last_prune) >= 60_000 {
            state.last_prune = now;
            state.entries.retain(|_, e| now.saturating_sub(e.last_used) <= LIFETIME_MS);
        }
        while state.entries.len() >= MAX_ENTRIES {
            let oldest = state.entries.iter().min_by_key(|(_, e)| e.order).map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                state.entries.remove(&id);
            }
        }
        let id = format!("r_{}", random_id(8));
        let shared = Arc::new(Mutex::new(result));
        let order = state.next_order;
        state.next_order += 1;
        state.entries.insert(id.clone(), Entry { result: shared.clone(), last_used: now, order });
        (id, shared)
    }

    pub fn get(&self, result_id: &str) -> ApiResult<SharedResult> {
        let now = (self.now)();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = state.entries.get_mut(result_id)
            && now.saturating_sub(entry.last_used) <= LIFETIME_MS
        {
            entry.last_used = now;
            return Ok(entry.result.clone());
        }
        state.entries.remove(result_id);
        Err(ApiError::not_found(format!(
            "Search result '{result_id}' is unknown or has expired (results are kept for 30 minutes). Run the search again to get fresh result ids."
        )))
    }
}

pub fn to_result_dto(result: &TorrentSearchResult, result_id: &str) -> SearchResultDto {
    SearchResultDto {
        result_id: result_id.to_owned(),
        title: result.title.clone(),
        source: result.source.clone(),
        size_bytes: result.size_bytes,
        seeders: result.seeders,
        leechers: result.leechers,
        published_at: result.published_at.map(iso),
        details_url: result.details_url.clone(),
        info_hash: is_real_info_hash(&result.info_hash).then(|| result.info_hash.clone()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    #[test]
    fn ids_expire_after_30_idle_minutes() {
        let now = Arc::new(AtomicU64::new(0));
        let clock = now.clone();
        let cache = SearchResultCache::with_clock(Box::new(move || clock.load(Ordering::Relaxed)));
        let (id, _) = cache.add(TorrentSearchResult::new("t", "s"));
        now.store(29 * 60_000, Ordering::Relaxed);
        assert_eq!(cache.get(&id).unwrap().lock().unwrap().title, "t");
        now.fetch_add(31 * 60_000, Ordering::Relaxed);
        assert!(cache.get(&id).unwrap_err().message.contains("expired"));
    }
}
