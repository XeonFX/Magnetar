use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use tokio_util::sync::CancellationToken;

/// A search hit as providers produce it. Lazy providers fill in magnet/description later.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TorrentSearchResult {
    pub title: String,
    pub magnet_uri: String,
    /// Real info hash, or a provider placeholder ("1337x-123") until the detail page is resolved.
    pub info_hash: String,
    pub size_bytes: u64,
    pub seeders: u32,
    pub leechers: u32,
    pub source: String,
    pub published_at: Option<DateTime<Utc>>,
    pub details_url: Option<String>,
    /// None until fetched; some providers only have it on a detail page.
    pub description: Option<String>,
}

impl TorrentSearchResult {
    pub fn new(title: impl Into<String>, source: &str) -> Self {
        Self { title: title.into(), source: source.to_owned(), ..Default::default() }
    }

    pub fn needs_resolution(&self) -> bool {
        self.magnet_uri.is_empty()
    }
}

/// A result shared between the result cache and whoever resolves its details.
pub type SharedResult = Arc<Mutex<TorrentSearchResult>>;

#[derive(Default, Debug)]
pub struct TorrentDetails {
    pub info_hash: Option<String>,
    pub magnet_uri: Option<String>,
    pub description: Option<String>,
}

pub fn is_real_info_hash(hash: &str) -> bool {
    matches!(hash.len(), 40 | 64) && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A torrent site. Add one by implementing this and listing it in `providers::all`; it then
/// appears in Search, the series-task source list and Settings automatically.
#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;

    /// A short lowercase id for addresses (`/search/dragon?source=tpb`): letters, digits and hyphens.
    fn id(&self) -> &'static str;

    /// Whether `wanted` names this site: its name or its id, in any case.
    fn is_called(&self, wanted: &str) -> bool {
        self.name().eq_ignore_ascii_case(wanted) || self.id().eq_ignore_ascii_case(wanted)
    }

    async fn search(
        &self,
        http: &reqwest::Client,
        query: &str,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Vec<TorrentSearchResult>>;

    /// For sites whose listing lacks the magnet and/or description: fetched on demand for one
    /// result (info dialog, starting a download), never during the search itself. None when the
    /// site has no detail page to fetch.
    async fn details(
        &self,
        _http: &reqwest::Client,
        _result: &TorrentSearchResult,
        _cancel: &CancellationToken,
    ) -> Option<anyhow::Result<TorrentDetails>> {
        None
    }
}
