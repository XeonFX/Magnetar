use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::search::http::{as_trimmed_str, fetch_extra_pages, fetch_text, from_unix_seconds, to_int, to_number};
use crate::search::magnet::{DEFAULT_TRACKERS, build_magnet};
use crate::search::relevance::matches_query;
use crate::search::types::{Provider, TorrentSearchResult};

const NAME: &str = "EZTV";
const BASE_URL: &str = "https://eztvx.to";
const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = 5;
const MAX_RESULTS: usize = 50;

/// EZTV's search page is behind a Cloudflare challenge and its API has no keyword filter, so this
/// pages through the newest-first feed and keeps matching titles. It only finds recent releases.
pub struct Eztv;

#[async_trait]
impl Provider for Eztv {
    fn name(&self) -> &'static str {
        NAME
    }

    fn id(&self) -> &'static str {
        "eztv"
    }

    async fn search(
        &self,
        http: &reqwest::Client,
        query: &str,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Vec<TorrentSearchResult>> {
        let first = parse_page(&fetch_text(http, &page_url(1), cancel).await?)?;
        let mut matches: Vec<_> = first.torrents.iter().filter(|t| matches_query(query, &t.title)).cloned().collect();
        let more_pages = MAX_PAGES.min(first.total_count.div_ceil(PAGE_SIZE)).saturating_sub(1);
        if matches.len() < MAX_RESULTS && !first.torrents.is_empty() && more_pages > 0 {
            let rest = fetch_extra_pages(
                more_pages,
                |page| async move { Ok(parse_page(&fetch_text(http, &page_url(page), cancel).await?)?.torrents) },
                cancel,
            )
            .await?;
            matches.extend(rest.into_iter().filter(|t| matches_query(query, &t.title)));
        }
        matches.truncate(MAX_RESULTS);
        Ok(matches)
    }
}

fn page_url(page: usize) -> String {
    format!("{BASE_URL}/api/get-torrents?page={page}&limit={PAGE_SIZE}")
}

pub struct Page {
    pub torrents: Vec<TorrentSearchResult>,
    pub total_count: usize,
}

pub fn parse_page(json: &str) -> anyhow::Result<Page> {
    let root: Value = serde_json::from_str(json)?;
    let total_count = to_number(&root["torrents_count"]).max(0.0) as usize;
    let rows = root["torrents"].as_array().cloned().unwrap_or_default();
    let torrents = rows
        .iter()
        .filter_map(|row| {
            let hash = as_trimmed_str(&row["hash"]);
            let title = row["title"].as_str().unwrap_or_default();
            // From the hash alone: the site's own `magnet_url` could carry trackers or sources of its choosing.
            let magnet = build_magnet(hash, if title.is_empty() { hash } else { title }, &DEFAULT_TRACKERS)?;
            Some(TorrentSearchResult {
                info_hash: magnet.info_hash,
                magnet_uri: magnet.uri,
                size_bytes: to_number(&row["size_bytes"]).max(0.0) as u64,
                seeders: to_int(&row["seeds"]),
                leechers: to_int(&row["peers"]),
                published_at: from_unix_seconds(&row["date_released_unix"]),
                ..TorrentSearchResult::new(title, NAME)
            })
        })
        .collect();
    Ok(Page { torrents, total_count })
}
