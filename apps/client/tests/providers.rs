//! Parsers against pages captured from each site.

use chrono::{DateTime, Datelike, TimeZone, Utc};
use magnetar::search::providers::{eztv, leetx, nyaa, piratebay, rarbg, torrentscsv};
use magnetar::search::types::{TorrentSearchResult, is_real_info_hash};

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> Option<DateTime<Utc>> {
    Utc.with_ymd_and_hms(y, m, d, h, min, 0).single()
}

#[test]
fn piratebay_api_keeps_usable_rows() {
    let results = piratebay::parse_api(&fixture("piratebay-api.json")).unwrap();
    assert_eq!(results.len(), 1);
    let r = &results[0];
    assert_eq!(r.title, "ubuntu-26.04-desktop-amd64.iso");
    assert_eq!(r.info_hash, "dafc8c076ca2f3ed376eeae7c76a0d6be2415c45");
    assert_eq!((r.size_bytes, r.seeders, r.leechers), (6517612871, 137, 18));
    assert_eq!(r.source, "The Pirate Bay");
}

#[test]
fn piratebay_mirror_layouts() {
    for layout in ["double", "single"] {
        let results = piratebay::parse_mirror_html(&fixture(&format!("piratebay-mirror-{layout}.html")), Utc::now());
        assert_eq!(results.len(), 2, "{layout}");
        let first = &results[0];
        assert_eq!(first.title, "ubuntu-26.04-desktop-amd64.iso");
        assert_eq!(first.info_hash, "dafc8c076ca2f3ed376eeae7c76a0d6be2415c45");
        assert_eq!((first.size_bytes, first.seeders, first.leechers), (6517612871, 137, 18), "{layout}");
        assert_eq!(first.published_at, utc(Utc::now().year(), 4, 25, 16, 35), "{layout}");
        assert_eq!((results[1].size_bytes, results[1].seeders, results[1].leechers), (6216965160, 42, 12));
        assert_eq!(results[1].published_at, utc(2024, 9, 8, 0, 0));
    }
}

#[test]
fn piratebay_upload_dates() {
    let now = utc(2026, 6, 15, 12, 0).unwrap();
    assert_eq!(piratebay::parse_uploaded("Today 16:35", now), utc(2026, 6, 15, 0, 0));
    assert_eq!(piratebay::parse_uploaded("Y-day 16:35", now), utc(2026, 6, 14, 0, 0));
    assert_eq!(piratebay::parse_uploaded("09-08 2024", now), utc(2024, 9, 8, 0, 0));
    assert_eq!(piratebay::parse_uploaded("nonsense", now), None);
}

#[test]
fn leetx_rows_placeholder_hashes_and_details() {
    let rows = leetx::parse_rows(&fixture("leetx-search.html"), "1337x.to");
    assert_eq!(rows.len(), 2);
    let first = &rows[0];
    // The title anchor, not the category icon.
    assert_eq!(first.title, "Ubuntu MATE 16.04.2 [MATE][armhf][img.xz][Uzerus]");
    assert_eq!(
        first.details_url.as_deref(),
        Some("https://1337x.to/torrent/2099267/Ubuntu-MATE-16-04-2-MATE-armhf-img-xz-Uzerus/")
    );
    assert_eq!((first.size_bytes, first.seeders, first.leechers), (1181116006, 260, 2));
    assert_eq!(first.published_at, utc(2017, 6, 20, 0, 0));
    // A placeholder hash until the detail page is resolved.
    assert_eq!(first.info_hash, "1337x-2099267");
    assert!(first.needs_resolution());

    let details = leetx::parse_detail_page(
        r#"<a href="magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&tr=udp://evil">m</a><div id="description"><p>Line one</p><br>Line &amp; two</div>"#,
        "Title",
    );
    assert_eq!(details.info_hash.as_deref(), Some("abcdef0123456789abcdef0123456789abcdef01"));
    let magnet = details.magnet_uri.unwrap();
    assert!(magnet.starts_with("magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn=Title"));
    assert!(!magnet.contains("evil"));
    assert_eq!(details.description.as_deref(), Some("Line one\n\nLine & two"));
}

#[test]
fn leetx_copy_titles_are_repaired_and_untagged() {
    let rows = leetx::parse_rows(&fixture("leetx-copy-search.html"), "www.1337xx.to");
    assert_eq!(rows.len(), 20);
    let titles: Vec<&str> = rows.iter().map(|r| r.title.as_str()).collect();
    assert!(
        titles.contains(&"[pasta] This is a video of Roxy from Mushoku Tensei. / [ぱすた] 【無職転生】ロキシー動画です"),
        "{titles:#?}"
    );
    assert!(titles.contains(&"[Erai-raws] Tensei shitara Slime Datta Ken - 21 [1080p][Multiple Subtitle].mkv"), "{titles:#?}");
    assert!(titles.iter().all(|t| !t.contains("(Torrent) -") && !t.contains('Ã')), "{titles:#?}");
}

#[test]
fn leetx_dates() {
    assert_eq!(leetx::parse_date("Jan. 17th '26"), utc(2026, 1, 17, 0, 0));
    assert_eq!(leetx::parse_date("5:42am Jan. 3rd '26"), utc(2026, 1, 3, 0, 0));
    assert_eq!(leetx::parse_date("yesterday"), None);
}

#[test]
fn nyaa_rows() {
    let results = nyaa::parse_rows(&fixture("nyaa-search.html"));
    assert_eq!(results.len(), 2);
    let first = &results[0];
    assert_eq!(first.title, "Koha Live CD Release 3 (3.0.4 Ubuntu 9.10 Desktop x86)");
    assert_eq!(first.info_hash, "45008e48c8800b7d7643337b2e70a634e4c69f6a");
    assert_eq!((first.size_bytes, first.seeders, first.leechers), (654311424, 42, 3));
    assert_eq!(first.details_url.as_deref(), Some("https://nyaa.si/view/96659"));
    assert_eq!(first.published_at, utc(2009, 11, 3, 7, 3));
    assert!(first.magnet_uri.contains("http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce"));
    // The comments link is not mistaken for the title.
    let second = &results[1];
    assert_eq!(second.title, "[SubsPlease] Mushoku Tensei S3 - 06 (1080p) [FB09F4CC].mkv");
    assert_eq!(second.details_url.as_deref(), Some("https://nyaa.si/view/2140895"));
    assert_eq!((second.seeders, second.leechers), (1234, 56));
}

#[test]
fn rarbg_pages_and_details() {
    let page = rarbg::parse_page(&fixture("rarbg-search.json")).unwrap();
    assert_eq!(page.results.len(), 43);
    assert_eq!(page.total, 43.0);
    let first = &page.results[0];
    assert_eq!(first.title, "ubuntucinnamon-26.04-desktop-amd64.iso");
    assert_eq!(first.info_hash, "8586fe65d6b589aca262dbbc164570c335bd7d37");
    assert_eq!((first.size_bytes, first.seeders, first.leechers), (5659195392, 40, 11));
    assert_eq!(first.details_url.as_deref(), Some("https://therarbg.com/post-detail/8a715c/x/"));
    assert_eq!(first.published_at, DateTime::from_timestamp(1777054855, 0));
    assert!(page.results.iter().all(|r| is_real_info_hash(&r.info_hash) && !r.needs_resolution()));

    let json = r#"{"total":2,"results":[{"pk":"a1","n":"Has hash","h":"8586FE65D6B589ACA262DBBC164570C335BD7D37","s":10,"se":1,"le":0,"a":1700000000},{"pk":"a2","n":"No hash","h":null}]}"#;
    assert_eq!(rarbg::parse_page(json).unwrap().results.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), ["Has hash"]);
    assert!(rarbg::parse_page(r#"{"detail":"Not found"}"#).unwrap().results.is_empty());
    assert!(rarbg::parse_detail(&fixture("rarbg-detail.json")).description.unwrap().starts_with("Ubuntu 26.04 LTS"));
    assert_eq!(rarbg::parse_detail(r#"{"descr":"   "}"#).description, None);
}

#[test]
fn eztv_pages() {
    let page = eztv::parse_page(&fixture("eztv-api.json")).unwrap();
    assert_eq!(page.torrents.len(), 2);
    assert_eq!(page.total_count, 219);
    let first = &page.torrents[0];
    assert_eq!(first.title, "Law and Order S06E11 Corpus Delicti 720p HEVC x265-MeGusta EZTV");
    assert_eq!(first.info_hash, "2fa9d6729a9cf935e4e53cc3c8cd16d619561c06");
    assert_eq!((first.size_bytes, first.seeders, first.leechers), (281349973, 41, 3));
    assert_eq!(page.torrents[1].info_hash, "fe8f7271b12545e07dbff0a265d2bc40dc5861ef");
    assert!(eztv::parse_page(r#"{"torrents_count": 0}"#).unwrap().torrents.is_empty());
}

/// A source's hash reaches a magnet only once it is checked to be one, and the magnet is ours: the
/// hash, the name and our trackers. Rows whose hash carries anything else are dropped; a source's own
/// magnet, trackers and exact sources never get in.
#[test]
fn hostile_hashes_and_magnets_from_a_source_never_reach_a_magnet() {
    use magnetar::search::magnet::{DEFAULT_TRACKERS, build_magnet};
    let good = "8586fe65d6b589aca262dbbc164570c335bd7d37";
    let ours = |name: &str| build_magnet(good, name, &DEFAULT_TRACKERS).unwrap().uri;
    let evil = "&tr=http%3A%2F%2Fevil.example%2Fannounce&xs=http%3A%2F%2Fevil.example%2Fx.torrent";
    let hostile = [
        format!("{good}{evil}"),
        format!("{good}&tr=http://evil.example/announce"),
        format!("{good}&xs=http://evil.example/x.torrent"),
        format!("{}0", good),
        good[..39].to_owned(),
        "VPG66AJDIVTYTK6N54ASGRLHRGV433Y1".to_owned(),
    ];
    let kept = |results: Vec<TorrentSearchResult>| -> Vec<(String, String, String)> {
        results.into_iter().map(|r| (r.title, r.info_hash, r.magnet_uri)).collect()
    };
    let fine = vec![("Fine".to_owned(), good.to_owned(), ours("Fine"))];

    let rows = |key: &str, extra: &str| {
        let rows: Vec<String> = hostile
            .iter()
            .map(|h| format!(r#"{{"id":"1","name":"Evil","n":"Evil","title":"Evil",{extra}"{key}":{}}}"#, serde_json::json!(h)))
            .chain([format!(r#"{{"id":"2","name":"Fine","n":"Fine","title":"Fine",{extra}"{key}":"{}"}}"#, good.to_uppercase())])
            .collect();
        format!("[{}]", rows.join(","))
    };
    assert_eq!(kept(piratebay::parse_api(&rows("info_hash", "")).unwrap()), fine, "The Pirate Bay");
    let wrap = |list: String| format!(r#"{{"total":7,"torrents_count":7,"results":{list},"torrents":{list}}}"#);
    assert_eq!(kept(rarbg::parse_page(&wrap(rows("h", ""))).unwrap().results), fine, "RARBG");
    assert_eq!(kept(torrentscsv::parse(&wrap(rows("infohash", ""))).unwrap()), fine, "Torrents-CSV");
    // EZTV also sends a magnet of its own, which is ignored even with a good hash beside it.
    let site_magnet = format!(r#""magnet_url":"magnet:?xt=urn:btih:{good}{evil}","#);
    assert_eq!(kept(eztv::parse_page(&wrap(rows("hash", &site_magnet))).unwrap().torrents), fine, "EZTV");

    // The mirrors' and 1337x's magnet links: only the hash is taken from them, and only a whole one.
    let links: String = hostile[3..]
        .iter()
        .map(|h| format!(r#"<tr><td><a title="Details for Evil">Evil</a><a href="magnet:?xt=urn:btih:{h}">m</a></td></tr>"#))
        .chain([format!(
            r#"<tr><td><a title="Details for Fine">Fine</a><a href="magnet:?xt=urn:btih:{good}{evil}">m</a></td></tr>"#
        )])
        .collect();
    let mirror = kept(piratebay::parse_mirror_html(&format!("<table>{links}</table>"), Utc::now()));
    assert_eq!(mirror, fine, "The Pirate Bay mirror");
    let details = leetx::parse_detail_page(&format!(r#"<a href="magnet:?xt=urn:btih:{good}0{evil}">m</a>"#), "Fine");
    assert_eq!((details.info_hash, details.magnet_uri), (None, None), "1337x");
    let details = leetx::parse_detail_page(&format!(r#"<a href="magnet:?xt=urn:btih:{good}{evil}">m</a>"#), "Fine");
    assert_eq!((details.info_hash.as_deref(), details.magnet_uri), (Some(good), Some(ours("Fine"))), "1337x");
}

/// Full, unedited pages captured from each live site. Assertions are structural so they survive a
/// site re-ranking results and fail when a selector stops matching.
#[test]
fn live_page_sanity() {
    let pages: Vec<(&str, Vec<TorrentSearchResult>)> = vec![
        ("Nyaa", nyaa::parse_rows(&fixture("live-nyaa-search.html"))),
        ("The Pirate Bay", piratebay::parse_api(&fixture("live-piratebay-api.json")).unwrap()),
        ("The Pirate Bay", piratebay::parse_mirror_html(&fixture("live-piratebay-mirror.html"), Utc::now())),
        ("EZTV", eztv::parse_page(&fixture("live-eztv-api.json")).unwrap().torrents),
        ("RARBG", rarbg::parse_page(&fixture("live-rarbg-search.json")).unwrap().results),
        ("1337x", leetx::parse_rows(&fixture("live-leetx-search.html"), "1337x.to")),
        ("Torrents-CSV", torrentscsv::parse(&fixture("live-torrentscsv.json")).unwrap()),
    ];
    for (source, results) in pages {
        assert!(results.len() > 10, "{source}: {} rows", results.len());
        for r in &results {
            assert!(r.title.trim().chars().count() > 3, "{source}: {:?}", r.title);
            assert!(!r.title.chars().all(|c| c.is_ascii_digit()), "{source}: {:?}", r.title);
            assert!(!r.title.contains('<') && !r.title.contains("&nbsp"), "{source}: {:?}", r.title);
            assert!(is_real_info_hash(&r.info_hash) || r.info_hash.contains('-'), "{source}: {}", r.info_hash);
            assert_eq!(r.source, source);
        }
        assert!(results.iter().filter(|r| r.size_bytes > 0).count() * 2 > results.len(), "{source}: sizes");
        let dated: Vec<_> = results.iter().filter_map(|r| r.published_at).collect();
        assert!(!dated.is_empty(), "{source}: dates");
        for d in dated {
            assert!(d.year() >= 2000 && d <= Utc::now() + chrono::Duration::days(2), "{source}: {d}");
        }
    }
    let nyaa = nyaa::parse_rows(&fixture("live-nyaa-search.html"));
    // Titles survive on the 31 rows that have comments.
    assert_eq!(nyaa.len(), 75);
    assert!(nyaa.iter().all(|r| r.title.contains('[') || r.title.contains('.')));
    assert!(
        nyaa.iter().all(|r| r.details_url.as_deref().is_some_and(|u| u.starts_with("https://nyaa.si/view/") && !u.contains('#')))
    );
}

/// Hits the real sites: fails when a provider returns nothing or unparseable rows. Runs only with
/// MAGNETAR_LIVE_TESTS=1 (the weekly Provider health workflow sets it).
#[tokio::test]
async fn live_providers() {
    if std::env::var("MAGNETAR_LIVE_TESTS").as_deref() != Ok("1") {
        return;
    }
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let http = magnetar::config::http_client().unwrap();
    let mut failures = Vec::new();
    for provider in magnetar::search::providers::all() {
        // EZTV only pages through recent TV releases, so it needs a query that is always airing.
        let query = match provider.name() {
            "EZTV" => "S01",
            "Nyaa" => "1080p",
            _ => "ubuntu",
        };
        let cancel = tokio_util::sync::CancellationToken::new();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(45), provider.search(&http, query, &cancel)).await;
        match outcome {
            Ok(Ok(results)) if !results.is_empty() => {
                for r in &results {
                    assert!(r.title.trim().chars().count() > 3);
                    assert!(is_real_info_hash(&r.info_hash) || r.info_hash.contains('-'));
                }
            }
            Ok(Ok(_)) => failures.push(format!("{}: no results", provider.name())),
            Ok(Err(error)) => failures.push(format!("{}: {error:#}", provider.name())),
            Err(_) => failures.push(format!("{}: timed out", provider.name())),
        }
    }
    assert!(failures.is_empty(), "{failures:?}");
}
