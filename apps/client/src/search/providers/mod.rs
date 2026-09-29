pub mod eztv;
pub mod leetx;
pub mod nyaa;
pub mod piratebay;
pub mod rarbg;
pub mod torrentscsv;

use std::sync::Arc;

use scraper::{ElementRef, Selector};

use super::types::Provider;

/// Every search source. Add a provider here and it shows up in Search, Series and Settings.
pub fn all() -> Vec<Arc<dyn Provider>> {
    vec![
        Arc::new(eztv::Eztv),
        Arc::new(leetx::Leetx),
        Arc::new(nyaa::Nyaa),
        Arc::new(piratebay::PirateBay),
        Arc::new(rarbg::Rarbg),
        Arc::new(torrentscsv::TorrentsCsv),
    ]
}

pub(crate) fn selector(css: &str) -> Selector {
    Selector::parse(css).expect("valid selector")
}

/// An element's text content, trimmed (cheerio's `.text().trim()`).
pub(crate) fn text(element: ElementRef<'_>) -> String {
    element.text().collect::<String>().trim().to_owned()
}
