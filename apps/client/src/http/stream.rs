//! `/stream/<token>`: a download's file over HTTP with byte ranges, for the dashboard's player and
//! for players like VLC on this machine. A token is a capability for one file, handed out over the
//! dashboard socket and valid for a while, so another site can't point a player at a guessed URL.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::app::App;
use crate::downloads::media::{media_type, open_reader, parse_range};
use crate::protocol::encoding::random_id;

const GRANT_LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);
const MAX_GRANTS: usize = 256;

#[derive(Default)]
pub struct StreamGrants {
    grants: Mutex<HashMap<String, (i64, usize, Instant)>>,
}

impl StreamGrants {
    /// A new token for one file of a download.
    pub fn grant(&self, download: i64, index: usize) -> String {
        let mut grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        grants.retain(|_, (_, _, expires)| *expires > now);
        if grants.len() >= MAX_GRANTS
            && let Some(oldest) = grants.iter().min_by_key(|(_, (_, _, expires))| *expires).map(|(token, _)| token.clone())
        {
            grants.remove(&oldest);
        }
        let token = random_id(24);
        grants.insert(token.clone(), (download, index, now + GRANT_LIFETIME));
        token
    }

    fn lookup(&self, token: &str) -> Option<(i64, usize)> {
        let grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        grants.get(token).filter(|(_, _, expires)| *expires > Instant::now()).map(|(download, index, _)| (*download, *index))
    }
}

fn plain(status: StatusCode, message: &str) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], message.to_owned()).into_response()
}

pub async fn serve(app: &Arc<App>, token: &str, method: &Method, headers: &HeaderMap) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let Some((download, index)) = app.streams.lookup(token) else {
        return plain(StatusCode::NOT_FOUND, "This link has expired. Open the player again.");
    };
    let file = match app.downloads.open_file(download, index) {
        Ok(file) => file,
        Err(error) => return plain(StatusCode::CONFLICT, &error.message),
    };
    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let Some((start, end)) = parse_range(range_header, file.size) else {
        return (StatusCode::RANGE_NOT_SATISFIABLE, [(header::CONTENT_RANGE, format!("bytes */{}", file.size))]).into_response();
    };
    let length = end - start + 1;
    let mut response = Response::builder()
        .status(if range_header.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_TYPE, media_type(&file.name))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length)
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .header(
            header::CONTENT_DISPOSITION,
            format!("inline; filename*=UTF-8''{}", crate::protocol::encoding::encode_uri_component(&file.name)),
        );
    if range_header.is_some() {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{}", file.size));
    }
    if method == Method::HEAD {
        return response.body(Body::empty()).unwrap();
    }
    let mut reader = match open_reader(&file).await {
        Ok(reader) => reader,
        Err(error) => return plain(StatusCode::CONFLICT, &error.message),
    };
    if let Err(error) = reader.seek(std::io::SeekFrom::Start(start)).await {
        return plain(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
    }
    response.body(Body::from_stream(ReaderStream::new(reader.take(length)))).unwrap()
}
