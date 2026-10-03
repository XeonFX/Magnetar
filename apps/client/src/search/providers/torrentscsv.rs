use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::protocol::encoding::encode_uri_component;
use crate::search::http::{as_trimmed_str, fetch_text, from_unix_seconds, to_int, to_number};
use crate::search::magnet::{DEFAULT_TRACKERS, build_magnet};
use crate::search::types::{Provider, TorrentSearchResult};

const NAME: &str = "Torrents-CSV";

/// The torrents-csv.com open index, which aggregates The Pirate Bay and others.
pub struct TorrentsCsv;

#[async_trait]
impl Provider for TorrentsCsv {
    fn name(&self) -> &'static str {
        NAME
    }

    fn id(&self) -> &'static str {
        "torrents-csv"
    }

    async fn search(
        &self,
        http: &reqwest::Client,
        query: &str,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Vec<TorrentSearchResult>> {
        let url = format!("https://torrents-csv.com/service/search?q={}&size=100", encode_uri_component(query));
        parse(&fetch_text(http, &url, cancel).await?)
    }
}

pub fn parse(json: &str) -> anyhow::Result<Vec<TorrentSearchResult>> {
    let root: Value = serde_json::from_str(json)?;
    let rows = root["torrents"].as_array().cloned().unwrap_or_default();
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = row["name"].as_str().unwrap_or_default();
            let magnet = build_magnet(as_trimmed_str(&row["infohash"]), name, &DEFAULT_TRACKERS)?;
            Some(TorrentSearchResult {
                info_hash: magnet.info_hash,
                magnet_uri: magnet.uri,
                size_bytes: to_number(&row["size_bytes"]).max(0.0) as u64,
                seeders: to_int(&row["seeders"]),
                leechers: to_int(&row["leechers"]),
                published_at: from_unix_seconds(&row["created_unix"]),
                ..TorrentSearchResult::new(name, NAME)
            })
        })
        .collect())
}
