//! Show details from TVmaze (free, no key): the poster, whether the show is still running, and when
//! the next episode airs. Looked up by the task's name when it is created or renamed, then refreshed
//! twice a day. Only the device talks to TVmaze; browsers get the poster from the device.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::config::USER_AGENT;
use crate::protocol::encoding::encode_uri_component;
use crate::protocol::{AiringDto, ShowInfoDto};

const API: &str = "https://api.tvmaze.com";
const TIMEOUT: Duration = Duration::from_secs(15);
/// A medium poster is ~30–60 KB; anything much bigger isn't one.
const MAX_POSTER_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
struct Show {
    id: i64,
    name: String,
    url: Option<String>,
    status: Option<String>,
    premiered: Option<String>,
    network: Option<Named>,
    #[serde(rename = "webChannel")]
    web_channel: Option<Named>,
    image: Option<Image>,
    #[serde(rename = "_embedded")]
    embedded: Option<Embedded>,
}

#[derive(Deserialize)]
struct Named {
    name: String,
}

#[derive(Deserialize)]
struct Image {
    medium: Option<String>,
}

#[derive(Deserialize)]
struct Embedded {
    nextepisode: Option<Episode>,
    previousepisode: Option<Episode>,
}

#[derive(Deserialize)]
struct Episode {
    season: Option<i64>,
    number: Option<i64>,
    name: Option<String>,
    airstamp: Option<String>,
}

impl From<Episode> for AiringDto {
    fn from(e: Episode) -> Self {
        AiringDto { season: e.season, number: e.number, name: e.name, airstamp: e.airstamp }
    }
}

/// The show TVmaze thinks `name` is, with its latest and next episode, and its poster's URL.
pub async fn lookup(http: &reqwest::Client, name: &str) -> anyhow::Result<Option<(ShowInfoDto, Option<String>)>> {
    let url =
        format!("{API}/singlesearch/shows?q={}&embed[]=nextepisode&embed[]=previousepisode", encode_uri_component(name.trim()));
    let response = http.get(url).header("user-agent", USER_AGENT.as_str()).timeout(TIMEOUT).send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    anyhow::ensure!(response.status().is_success(), "TVmaze answered HTTP {}", response.status().as_u16());
    Ok(Some(parse(response.json().await?)))
}

fn parse(show: Show) -> (ShowInfoDto, Option<String>) {
    let embedded = show.embedded.unwrap_or(Embedded { nextepisode: None, previousepisode: None });
    let poster = show.image.and_then(|i| i.medium).filter(|u| u.starts_with("https://"));
    let info = ShowInfoDto {
        tvmaze_id: show.id,
        name: show.name,
        url: show.url,
        status: show.status,
        premiered: show.premiered,
        network: show.network.or(show.web_channel).map(|n| n.name),
        has_poster: false,
        next_episode: embedded.nextepisode.map(Into::into),
        previous_episode: embedded.previousepisode.map(Into::into),
    };
    (info, poster)
}

pub fn poster_path(posters: &Path, tvmaze_id: i64) -> PathBuf {
    posters.join(format!("{tvmaze_id}.jpg"))
}

/// Saves the poster once; later refreshes keep the file.
pub async fn save_poster(http: &reqwest::Client, url: &str, target: &Path) -> anyhow::Result<()> {
    if target.exists() {
        return Ok(());
    }
    let parsed = url::Url::parse(url)?;
    anyhow::ensure!(
        parsed.host_str().is_some_and(|h| h == "static.tvmaze.com" || h.ends_with(".tvmaze.com")),
        "not a TVmaze image"
    );
    let bytes = http
        .get(url)
        .header("user-agent", USER_AGENT.as_str())
        .timeout(TIMEOUT)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    anyhow::ensure!(bytes.len() <= MAX_POSTER_BYTES && bytes.starts_with(&[0xFF, 0xD8]), "not a JPEG poster");
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(target, &bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_show_with_its_episodes_and_poster() {
        let json = r#"{"id":44778,"name":"Mushoku Tensei: Jobless Reincarnation","url":"https://www.tvmaze.com/shows/44778/x",
            "status":"Running","premiered":"2021-01-11","network":null,"webChannel":{"name":"Crunchyroll"},
            "image":{"medium":"https://static.tvmaze.com/uploads/images/medium_portrait/1/2.jpg","original":"x"},
            "_embedded":{"nextepisode":{"season":3,"number":15,"name":"N","airstamp":"2026-10-02T15:00:00+00:00"},
                         "previousepisode":{"season":3,"number":14,"name":"P","airstamp":"2026-09-25T15:00:00+00:00"}}}"#;
        let (info, poster) = parse(serde_json::from_str(json).unwrap());
        assert_eq!(
            (info.tvmaze_id, info.network.as_deref(), info.status.as_deref()),
            (44778, Some("Crunchyroll"), Some("Running"))
        );
        assert_eq!(info.next_episode.as_ref().map(|e| (e.season, e.number)), Some((Some(3), Some(15))));
        assert_eq!(info.previous_episode.as_ref().and_then(|e| e.airstamp.as_deref()), Some("2026-09-25T15:00:00+00:00"));
        assert_eq!(poster.as_deref(), Some("https://static.tvmaze.com/uploads/images/medium_portrait/1/2.jpg"));
    }

    #[test]
    fn an_ended_show_without_extras_still_reads() {
        let (info, poster) = parse(
            serde_json::from_str(r#"{"id":1,"name":"Old","status":"Ended","image":{"medium":"http://insecure/x.jpg"}}"#).unwrap(),
        );
        assert!(info.next_episode.is_none() && info.network.is_none());
        assert_eq!(poster, None, "only https posters");
    }
}
