pub mod cache;
pub mod http;
pub mod magnet;
pub mod mirrors;
pub mod providers;
pub mod relevance;
pub mod types;

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use futures::future::join_all;
use regex::Regex;
use tokio_util::sync::CancellationToken;

use crate::protocol::SourceOutcomeDto;
use crate::settings::SettingsService;
use http::{FetchError, describe_failure};
use relevance::matches_query;
use types::{Provider, SharedResult, TorrentSearchResult};

/// One row per info hash, keeping the best-seeded, sorted by seeders. Rows without a hash (lazy
/// sources not resolved yet) pass through: grouping blanks would merge unrelated torrents.
pub fn merge_results(rows: Vec<TorrentSearchResult>) -> Vec<TorrentSearchResult> {
    let mut hashless = Vec::new();
    let mut by_hash: Vec<TorrentSearchResult> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for row in rows {
        if row.info_hash.is_empty() {
            hashless.push(row);
            continue;
        }
        match index.get(&row.info_hash.to_lowercase()) {
            Some(&i) if row.seeders > by_hash[i].seeders => by_hash[i] = row,
            Some(_) => {}
            None => {
                index.insert(row.info_hash.to_lowercase(), by_hash.len());
                by_hash.push(row);
            }
        }
    }
    hashless.extend(by_hash);
    hashless.sort_by_key(|r| std::cmp::Reverse(r.seeders));
    hashless
}

static BLOCK_BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<(br|/p|/div|/li)\s*/?>").unwrap());
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
static BLANK_LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

/// Strips a scraped HTML description block to readable plain text.
pub fn html_to_plain_text(html: &str) -> Option<String> {
    if html.trim().is_empty() {
        return None;
    }
    let with_breaks = BLOCK_BREAK.replace_all(html, "\n");
    let stripped = TAG.replace_all(&with_breaks, "");
    let decoded = html_escape::decode_html_entities(&stripped);
    let collapsed = BLANK_LINES.replace_all(&decoded, "\n\n").trim().to_owned();
    (!collapsed.is_empty()).then_some(collapsed)
}

/// Aggregates every provider: parallel fan-out, per-source outcomes, lazy detail resolution.
pub struct SearchService {
    pub providers: Vec<Arc<dyn Provider>>,
    settings: Arc<SettingsService>,
    http: reqwest::Client,
}

pub struct Collected {
    pub results: Vec<TorrentSearchResult>,
    pub outcomes: Vec<SourceOutcomeDto>,
}

impl SearchService {
    pub fn new(providers: Vec<Arc<dyn Provider>>, settings: Arc<SettingsService>, http: reqwest::Client) -> Self {
        Self { providers, settings, http }
    }

    pub fn find_provider(&self, name: &str) -> Option<&Arc<dyn Provider>> {
        self.providers.iter().find(|p| p.name().eq_ignore_ascii_case(name))
    }

    /// A whole search, merged, with every source's outcome.
    pub async fn collect(
        &self,
        query: &str,
        provider: Option<&str>,
        cancel: &CancellationToken,
        filter_relevance: bool,
    ) -> anyhow::Result<Collected> {
        let all = std::sync::Mutex::new(Vec::new());
        let outcomes = self
            .search_stream(query, provider, &|batch| all.lock().unwrap().extend(batch), &|_| {}, cancel, filter_relevance)
            .await?;
        Ok(Collected { results: merge_results(all.into_inner().unwrap()), outcomes })
    }

    /// Searches enabled providers in parallel, handing each provider's rows to `on_results` as soon
    /// as it answers. Every provider reports an outcome, so "this site failed" and "everything was
    /// filtered out" stay distinguishable from "there is nothing to find". Fails only when cancelled.
    pub async fn search_stream(
        &self,
        query: &str,
        provider: Option<&str>,
        on_results: &(dyn Fn(Vec<TorrentSearchResult>) + Sync),
        on_outcome: &(dyn Fn(&SourceOutcomeDto) + Sync),
        cancel: &CancellationToken,
        filter_relevance: bool,
    ) -> anyhow::Result<Vec<SourceOutcomeDto>> {
        let targets = self.providers.iter().filter(|p| {
            provider.is_none_or(|wanted| p.name().eq_ignore_ascii_case(wanted)) && self.settings.is_provider_enabled(p.name())
        });
        let outcomes = join_all(targets.map(|p| async move {
            let outcome = match p.search(&self.http, query, cancel).await {
                Ok(results) => {
                    let returned = results.len();
                    let kept: Vec<_> =
                        results.into_iter().filter(|r| !filter_relevance || matches_query(query, &r.title)).collect();
                    let filtered = returned - kept.len();
                    if !kept.is_empty() {
                        on_results(kept);
                    }
                    SourceOutcomeDto { source: p.name().into(), status: "ok", returned, filtered, error: None }
                }
                // The caller moving on is not a provider fault.
                Err(_) if cancel.is_cancelled() => return None,
                Err(error) => {
                    tracing::warn!("Search on {} failed: {}", p.name(), describe_failure(&error));
                    SourceOutcomeDto {
                        source: p.name().into(),
                        status: "failed",
                        returned: 0,
                        filtered: 0,
                        error: Some(describe_failure(&error)),
                    }
                }
            };
            on_outcome(&outcome);
            Some(outcome)
        }))
        .await;
        if cancel.is_cancelled() {
            return Err(FetchError::Cancelled.into());
        }
        Ok(outcomes.into_iter().flatten().collect())
    }

    /// Fills in a lazy result's magnet and description; a no-op once there is nothing left to fetch.
    pub async fn ensure_details(&self, shared: &SharedResult, cancel: &CancellationToken) {
        let result = shared.lock().unwrap().clone();
        if !result.needs_resolution() && result.description.is_some() {
            return;
        }
        let Some(provider) = self.find_provider(&result.source) else { return };
        match provider.details(&self.http, &result, cancel).await {
            None => {}
            Some(Ok(details)) => {
                let mut result = shared.lock().unwrap();
                if let Some(hash) = details.info_hash {
                    result.info_hash = hash;
                }
                if let Some(magnet) = details.magnet_uri {
                    result.magnet_uri = magnet;
                }
                if details.description.is_some() {
                    result.description = details.description;
                }
            }
            Some(Err(error)) => {
                tracing::warn!("Could not fetch details from {}: {}", result.source, describe_failure(&error))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_one_row_per_hash_and_hashless_rows_sorted_by_seeders() {
        let row = |title: &str, hash: &str, seeders| TorrentSearchResult {
            info_hash: hash.into(),
            seeders,
            ..TorrentSearchResult::new(title, "X")
        };
        let merged = merge_results(vec![row("a", "AAAA", 5), row("a2", "aaaa", 9), row("lazy", "", 1), row("lazy2", "", 3)]);
        assert_eq!(merged.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), ["a2", "lazy2", "lazy"]);
    }

    #[test]
    fn html_descriptions_become_plain_text() {
        assert_eq!(
            html_to_plain_text("<p>One</p><p>Two &amp; three</p>\n\n\n\n<b>x</b>").as_deref(),
            Some("One\nTwo & three\n\nx")
        );
        assert_eq!(html_to_plain_text("   "), None);
    }
}
