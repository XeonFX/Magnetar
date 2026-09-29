use std::sync::LazyLock;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Datelike, TimeZone, Utc};
use regex::Regex;
use scraper::Html;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{selector, text};
use crate::protocol::bytes::parse_bytes;
use crate::protocol::encoding::encode_uri_component;
use crate::search::http::{fetch_text, from_unix_seconds, text_to_int, to_int, to_number};
use crate::search::magnet::{DEFAULT_TRACKERS, build_magnet, extract_info_hash};
use crate::search::mirrors::MirrorRotator;
use crate::search::types::{Provider, TorrentSearchResult};

const NAME: &str = "The Pirate Bay";

/// Prefers the apibay.org JSON API and falls back to HTML mirrors: some ISPs block the official
/// domains (the maintainer's blackholes apibay after the TLS handshake).
static SOURCES: LazyLock<MirrorRotator<(&'static str, bool)>> = LazyLock::new(|| {
    MirrorRotator::new(vec![("apibay.org", false), ("tpb.party", true), ("piratebay.live", true)], Duration::from_millis(1500))
});

pub struct PirateBay;

#[async_trait]
impl Provider for PirateBay {
    fn name(&self) -> &'static str {
        NAME
    }

    async fn search(
        &self,
        http: &reqwest::Client,
        query: &str,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Vec<TorrentSearchResult>> {
        SOURCES
            .fetch(
                |(host, html), token| async move {
                    let q = encode_uri_component(query);
                    let url =
                        if html { format!("https://{host}/search/{q}/1/99/0") } else { format!("https://{host}/q.php?q={q}") };
                    let body = fetch_text(http, &url, &token).await?;
                    if html { Ok(parse_mirror_html(&body, Utc::now())) } else { parse_api(&body) }
                },
                cancel,
            )
            .await
    }
}

pub fn parse_api(json: &str) -> anyhow::Result<Vec<TorrentSearchResult>> {
    let rows: Vec<Value> = serde_json::from_str(json)?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = match &row["name"] {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            };
            // apibay answers "nothing found" with a single placeholder row.
            let id = match &row["id"] {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            if id == "0" || name == "No results returned" {
                return None;
            }
            let hash = row["info_hash"].as_str().map(str::trim).unwrap_or_default();
            if hash.is_empty() {
                return None;
            }
            Some(TorrentSearchResult {
                info_hash: hash.to_owned(),
                magnet_uri: build_magnet(hash, &name, &DEFAULT_TRACKERS),
                size_bytes: to_number(&row["size"]).max(0.0) as u64,
                seeders: to_int(&row["seeders"]),
                leechers: to_int(&row["leechers"]),
                published_at: from_unix_seconds(&row["added"]),
                ..TorrentSearchResult::new(name, NAME)
            })
        })
        .collect())
}

static DET_DESC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Uploaded\s+([^,]+),\s*Size\s+([^,]+),").unwrap());
static UPLOAD_DATE_CELL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(Today|Y-day|[0-9]{2}-[0-9]{2})").unwrap());

/// The mirrors serve one of two classic layouts (piratebay.live a compact "Single" view, tpb.party
/// a "Double" one). Double: title, a date cell, magnet, then size/seeders/leechers right-aligned.
/// Single: title + magnet + a "Uploaded X, Size Y, ULed by Z" blob, then only seeders/leechers.
/// Seeders and leechers are always the last two right-aligned cells.
pub fn parse_mirror_html(html: &str, now: DateTime<Utc>) -> Vec<TorrentSearchResult> {
    let document = Html::parse_document(html);
    let (title_links, magnets) = (selector("a[title^='Details for ']"), selector("a[href^='magnet:']"));
    let (right_cells, cells, desc) = (selector("td[align='right']"), selector("td"), selector("font.detDesc"));
    document
        .select(&selector("tr"))
        .filter_map(|row| {
            let title_link = row.select(&title_links).next()?;
            let hash = extract_info_hash(row.select(&magnets).next()?.value().attr("href")?)?;
            let title = text(title_link);
            let right: Vec<String> = row.select(&right_cells).map(text).collect();
            let from_end = |n: usize| right.len().checked_sub(n).map(|i| right[i].as_str());
            let (mut size_bytes, mut published_at) = (0, None);
            if right.len() >= 3 {
                size_bytes = parse_bytes(from_end(3).unwrap_or_default());
                published_at = row
                    .select(&cells)
                    .map(text)
                    .find(|t| UPLOAD_DATE_CELL.is_match(t))
                    .and_then(|cell| parse_uploaded(&cell, now));
            } else if let Some(m) = row
                .select(&desc)
                .next()
                .map(text)
                .and_then(|d| DET_DESC.captures(&d).map(|m| (m[1].trim().to_owned(), m[2].trim().to_owned())))
            {
                size_bytes = parse_bytes(&m.1);
                published_at = parse_uploaded(&m.0, now);
            }
            Some(TorrentSearchResult {
                magnet_uri: build_magnet(&hash, &title, &DEFAULT_TRACKERS),
                info_hash: hash,
                size_bytes,
                seeders: from_end(2).map(text_to_int).unwrap_or(0),
                leechers: from_end(1).map(text_to_int).unwrap_or(0),
                published_at,
                ..TorrentSearchResult::new(title, NAME)
            })
        })
        .collect()
}

static DAY_YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]{2})-([0-9]{2}) ([0-9]{4})$").unwrap());
static DAY_TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2})$").unwrap());

/// "04-25 16:35" (this year), "09-08 2024", "Today 16:35", "Y-day 16:35" — all UTC.
pub fn parse_uploaded(text: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let value = text.replace('\u{a0}', " ");
    let value = value.trim();
    let today = Utc.with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0).single()?;
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("today") {
        return Some(today);
    }
    if lower.starts_with("y-day") {
        return Some(today - chrono::Duration::days(1));
    }
    let num = |s: &str| s.parse::<u32>().ok();
    if let Some(m) = DAY_YEAR.captures(value) {
        return Utc.with_ymd_and_hms(m[3].parse().ok()?, num(&m[1])?, num(&m[2])?, 0, 0, 0).single();
    }
    let m = DAY_TIME.captures(value)?;
    Utc.with_ymd_and_hms(now.year(), num(&m[1])?, num(&m[2])?, num(&m[3])?, num(&m[4])?, 0).single()
}
