use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use regex::Regex;
use scraper::Html;
use tokio_util::sync::CancellationToken;

use super::{selector, text};
use crate::protocol::bytes::parse_bytes;
use crate::protocol::encoding::encode_uri_component;
use crate::search::http::{fetch_extra_pages, fetch_text, text_to_int};
use crate::search::magnet::{DEFAULT_TRACKERS, build_magnet, extract_info_hash};
use crate::search::mirrors::MirrorRotator;
use crate::search::types::{Provider, TorrentDetails, TorrentSearchResult};
use crate::search::{html_to_plain_text, repair_mojibake};

const NAME: &str = "1337x";

/// The real site first: it answers plain HTML on networks Cloudflare trusts, and a challenge (403)
/// hands over to the next host at once. www.1337xx.to is a copy that always answers but matches any
/// word of the query, so it comes last.
static MIRRORS: LazyLock<MirrorRotator<&'static str>> =
    LazyLock::new(|| MirrorRotator::new(vec!["1337x.to", "x1337x.ws", "www.1337xx.to"], Duration::from_millis(1500)));
/// A full listing page; a shorter one is the last.
const PAGE_SIZE: usize = 20;

/// The listing has every column except the magnet and description, which live on each torrent's
/// detail page — fetched lazily, once, for the torrent the user actually opens.
pub struct Leetx;

#[async_trait]
impl Provider for Leetx {
    fn name(&self) -> &'static str {
        NAME
    }

    fn id(&self) -> &'static str {
        "1337x"
    }

    async fn search(
        &self,
        http: &reqwest::Client,
        query: &str,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Vec<TorrentSearchResult>> {
        MIRRORS
            .fetch(
                |host, token| async move {
                    let q = encode_uri_component(query);
                    let page = |sort: &str, n: usize| format!("https://{host}/sort-search/{q}/{sort}/desc/{n}/");
                    let mut rows = parse_rows(&fetch_text(http, &page("seeders", 1), &token).await?, host);
                    if rows.len() >= PAGE_SIZE {
                        // Relevance filtering happens later and a copy that matches any word fills the
                        // first page with near misses: more pages, and the newest, leave enough to keep.
                        let more = fetch_extra_pages(
                            3,
                            |n| {
                                let url = if n <= 3 { page("seeders", n) } else { page("time", 1) };
                                let token = &token;
                                async move { Ok(parse_rows(&fetch_text(http, &url, token).await?, host)) }
                            },
                            &token,
                        )
                        .await?;
                        let mut seen: HashSet<String> = rows.iter().map(|r| r.info_hash.clone()).collect();
                        rows.extend(more.into_iter().filter(|row| seen.insert(row.info_hash.clone())));
                    }
                    Ok(rows)
                },
                cancel,
            )
            .await
    }

    async fn details(
        &self,
        http: &reqwest::Client,
        result: &TorrentSearchResult,
        cancel: &CancellationToken,
    ) -> Option<anyhow::Result<TorrentDetails>> {
        let url = result.details_url.as_deref()?;
        Some(fetch_text(http, url, cancel).await.map(|html| parse_detail_page(&html, &result.title)))
    }
}

pub fn parse_rows(html: &str, host: &str) -> Vec<TorrentSearchResult> {
    let document = Html::parse_document(html);
    let (rows, title_links) = (selector("tbody tr"), selector("td.coll-1 a[href^='/torrent/']"));
    let cell = |row: scraper::ElementRef<'_>, css: &str| row.select(&selector(css)).next().map(text).unwrap_or_default();
    document
        .select(&rows)
        .filter_map(|row| {
            // The name cell has an icon-only category link and the real title link; pick the one with text.
            let title_link = row.select(&title_links).find(|a| !text(*a).is_empty())?;
            let path = title_link.value().attr("href").unwrap_or_default();
            let id = path.trim_matches('/').split('/').nth(1).unwrap_or(path);
            let title = clean_title(&text(title_link));
            Some(TorrentSearchResult {
                // Stands in for the real hash until the detail page is resolved, keeping dedup stable.
                info_hash: format!("1337x-{id}"),
                size_bytes: parse_bytes(&cell(row, "td.coll-4")),
                seeders: text_to_int(&cell(row, "td.coll-2")),
                leechers: text_to_int(&cell(row, "td.coll-3")),
                published_at: parse_date(&cell(row, "td.coll-date")),
                details_url: Some(format!("https://{host}{path}")),
                ..TorrentSearchResult::new(title, NAME)
            })
        })
        .collect()
}

static SCRAPED_FROM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\(Torrent\)\s*-\s*[A-Za-z0-9 .]+$").unwrap());

/// The copy re-encodes some titles twice and tags others with where it scraped them from.
fn clean_title(title: &str) -> String {
    SCRAPED_FROM.replace(&repair_mojibake(title), "").trim().to_owned()
}

static DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([A-Za-z]{3,})\.?\s+([0-9]{1,2})(?:st|nd|rd|th)?\s+'?([0-9]{2})").unwrap());
const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// "Jan. 17th '26", "Apr. 3rd '25" or "5:42am Jan. 3rd '26" → UTC midnight of that day.
pub fn parse_date(text: &str) -> Option<DateTime<Utc>> {
    let m = DATE.captures(text)?;
    let month = MONTHS.iter().position(|name| m[1].to_ascii_lowercase().starts_with(name))? as u32 + 1;
    Utc.with_ymd_and_hms(2000 + m[3].parse::<i32>().ok()?, month, m[2].parse().ok()?, 0, 0, 0).single()
}

/// Magnet (rebuilt from its hash with our own trackers) and description from a detail page.
pub fn parse_detail_page(html: &str, title: &str) -> TorrentDetails {
    let document = Html::parse_document(html);
    let hash =
        document.select(&selector("a[href^='magnet:']")).next().and_then(|a| a.value().attr("href")).and_then(extract_info_hash);
    TorrentDetails {
        magnet_uri: hash.as_deref().map(|h| build_magnet(h, title, &DEFAULT_TRACKERS)),
        description: document.select(&selector("#description")).next().and_then(|d| html_to_plain_text(&d.inner_html())),
        info_hash: hash,
    }
}
