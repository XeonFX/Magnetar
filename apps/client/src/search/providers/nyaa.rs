use async_trait::async_trait;
use scraper::Html;
use tokio_util::sync::CancellationToken;

use super::{selector, text};
use crate::protocol::bytes::parse_bytes;
use crate::protocol::encoding::encode_uri_component;
use crate::search::http::{fetch_extra_pages, fetch_text, from_unix_seconds, text_to_int};
use crate::search::magnet::{build_magnet, extract_info_hash};
use crate::search::types::{Provider, TorrentSearchResult};

const NAME: &str = "Nyaa";
/// Nyaa's own tracker plus the generic public ones.
const TRACKERS: [&str; 4] = [
    "http://nyaa.tracker.wf:7777/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://exodus.desync.com:6969/announce",
];
const PAGE_SIZE: usize = 75;
/// Enough for a series check hunting an older, low-seed episode past row 75.
const MAX_PAGES: usize = 2;

/// nyaa.si's HTML search, not its RSS feed: RSS ignores the sort-by-seeders parameters and returns
/// a fixed 75-item window in another order, so popular torrents can be missing from it entirely.
pub struct Nyaa;

#[async_trait]
impl Provider for Nyaa {
    fn name(&self) -> &'static str {
        NAME
    }

    fn id(&self) -> &'static str {
        "nyaa"
    }

    async fn search(
        &self,
        http: &reqwest::Client,
        query: &str,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Vec<TorrentSearchResult>> {
        let mut results = parse_rows(&fetch_text(http, &page_url(query, 1), cancel).await?);
        if results.len() >= PAGE_SIZE {
            let more = fetch_extra_pages(
                MAX_PAGES - 1,
                |page| async move { Ok(parse_rows(&fetch_text(http, &page_url(query, page), cancel).await?)) },
                cancel,
            )
            .await?;
            results.extend(more);
        }
        Ok(results)
    }
}

fn page_url(query: &str, page: usize) -> String {
    let url = format!("https://nyaa.si/?f=0&c=0_0&q={}&s=seeders&o=desc", encode_uri_component(query));
    if page > 1 { format!("{url}&p={page}") } else { url }
}

pub fn parse_rows(html: &str) -> Vec<TorrentSearchResult> {
    let document = Html::parse_document(html);
    // A commented torrent has a "/view/<id>#comments" link before the title, whose text is the
    // comment count — skip it or the torrent gets named "12".
    let title_links = selector("a[href^='/view/']:not(.comments)");
    let magnets = selector("a[href^='magnet:']");
    let centered = selector("td.text-center");
    let timestamp = selector("td[data-timestamp]");
    document
        .select(&selector("tr"))
        .filter_map(|row| {
            let title_link = row.select(&title_links).next()?;
            let hash = extract_info_hash(row.select(&magnets).next()?.value().attr("href")?)?;
            let cells: Vec<String> = row.select(&centered).map(text).collect();
            if cells.len() < 5 {
                return None; // links, size, date, seeders, leechers
            }
            let name = text(title_link);
            Some(TorrentSearchResult {
                magnet_uri: build_magnet(&hash, &name, &TRACKERS),
                info_hash: hash,
                size_bytes: parse_bytes(&cells[1]),
                seeders: text_to_int(&cells[3]),
                leechers: text_to_int(&cells[4]),
                published_at: row
                    .select(&timestamp)
                    .next()
                    .and_then(|td| td.value().attr("data-timestamp"))
                    .and_then(|t| from_unix_seconds(&t.into())),
                details_url: Some(format!("https://nyaa.si{}", title_link.value().attr("href").unwrap_or_default())),
                ..TorrentSearchResult::new(name, NAME)
            })
        })
        .collect()
}
