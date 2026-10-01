use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::protocol::encoding::encode_uri_component;
use crate::search::http::{as_trimmed_str, fetch_extra_pages, fetch_text, from_unix_seconds, to_int, to_number};
use crate::search::magnet::{DEFAULT_TRACKERS, build_magnet};
use crate::search::types::{Provider, TorrentDetails, TorrentSearchResult};

// "RARBG", not "TheRARBG": the name keys the per-source toggle, so renaming it would reset it.
const NAME: &str = "RARBG";
const BASE_URL: &str = "https://therarbg.com";
const PAGE_SIZE: usize = 50;
/// The endpoint ignores sort order, so fetch a second page rather than strand a popular release.
const MAX_PAGES: usize = 2;

/// The RARBG catalogue through TheRARBG's JSON endpoint, which hands back real info hashes so
/// magnets are built during the search. Only the description needs a lazy detail fetch.
pub struct Rarbg;

#[async_trait]
impl Provider for Rarbg {
    fn name(&self) -> &'static str {
        NAME
    }

    fn id(&self) -> &'static str {
        "rarbg"
    }

    async fn search(
        &self,
        http: &reqwest::Client,
        query: &str,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Vec<TorrentSearchResult>> {
        let mut first = parse_page(&fetch_text(http, &search_url(query, 1), cancel).await?)?;
        if first.results.len() < PAGE_SIZE || first.total <= PAGE_SIZE as f64 {
            return Ok(first.results);
        }
        let more = fetch_extra_pages(
            MAX_PAGES - 1,
            |page| async move { Ok(parse_page(&fetch_text(http, &search_url(query, page), cancel).await?)?.results) },
            cancel,
        )
        .await?;
        first.results.extend(more);
        Ok(first.results)
    }

    async fn details(
        &self,
        http: &reqwest::Client,
        result: &TorrentSearchResult,
        cancel: &CancellationToken,
    ) -> Option<anyhow::Result<TorrentDetails>> {
        let url = result.details_url.as_deref()?;
        let details = fetch_text(http, &format!("{url}?format=json"), cancel).await.ok().map(|json| parse_detail(&json));
        Some(Ok(details.unwrap_or_default()))
    }
}

fn search_url(query: &str, page: usize) -> String {
    let url = format!("{BASE_URL}/get-posts/keywords:{}/?format=json", encode_uri_component(query));
    if page > 1 { format!("{url}&page={page}") } else { url }
}

pub struct Page {
    pub results: Vec<TorrentSearchResult>,
    pub total: f64,
}

pub fn parse_page(json: &str) -> anyhow::Result<Page> {
    let root: Value = serde_json::from_str(json)?;
    let rows = root["results"].as_array().cloned().unwrap_or_default();
    let results = rows
        .iter()
        .filter_map(|row| {
            // n=name, h=info hash, s=size, se=seeders, le=leechers, a=added (unix), pk=detail id
            let hash = as_trimmed_str(&row["h"]);
            let name = row["n"].as_str().unwrap_or_default();
            if hash.is_empty() || name.trim().is_empty() {
                return None;
            }
            // The slug is required by the route but not validated.
            let details_url = match &row["pk"] {
                Value::String(pk) => Some(format!("{BASE_URL}/post-detail/{pk}/x/")),
                Value::Number(pk) => Some(format!("{BASE_URL}/post-detail/{pk}/x/")),
                _ => None,
            };
            Some(TorrentSearchResult {
                info_hash: hash.to_owned(),
                magnet_uri: build_magnet(hash, name, &DEFAULT_TRACKERS),
                size_bytes: to_number(&row["s"]).max(0.0) as u64,
                seeders: to_int(&row["se"]),
                leechers: to_int(&row["le"]),
                published_at: from_unix_seconds(&row["a"]),
                details_url,
                ..TorrentSearchResult::new(name, NAME)
            })
        })
        .collect();
    Ok(Page { results, total: to_number(&root["total"]) })
}

pub fn parse_detail(json: &str) -> TorrentDetails {
    let description = serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|root| root["descr"].as_str().map(|d| d.trim().to_owned()))
        .filter(|d| !d.is_empty());
    TorrentDetails { description, ..Default::default() }
}
