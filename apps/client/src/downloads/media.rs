//! Reading a download's file from any position, for playback: from disk once it is complete, or
//! through the engine while it downloads (which fetches the pieces a reader reaches first).

use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt};

use super::engine::Engine;
use super::manager::{DownloadFile, FileSource};
use crate::error::{ApiError, ApiResult};

pub trait MediaRead: AsyncRead + AsyncSeek + Send + Unpin {}
impl<T: AsyncRead + AsyncSeek + Send + Unpin> MediaRead for T {}

pub type MediaReader = Box<dyn MediaRead>;

/// How long one read may wait for pieces nobody is sending yet.
pub const READ_TIMEOUT: Duration = Duration::from_secs(60);

pub async fn open_reader(file: &DownloadFile) -> ApiResult<MediaReader> {
    Ok(match &file.source {
        FileSource::Disk(path) => Box::new(tokio::fs::File::open(path).await?),
        FileSource::Engine(handle, index) => Box::new(Engine::stream(handle, *index).await?),
    })
}

/// Up to `length` bytes from `offset`, fewer at the end of the file.
pub async fn read_at(reader: &mut MediaReader, offset: u64, length: usize) -> ApiResult<Vec<u8>> {
    reader.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut buffer = vec![0; length];
    let mut filled = 0;
    let reading = async {
        while filled < length {
            let n = reader.read(&mut buffer[filled..]).await?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        Ok::<_, std::io::Error>(())
    };
    match tokio::time::timeout(READ_TIMEOUT, reading).await {
        Ok(result) => result?,
        Err(_) if filled > 0 => {}
        Err(_) => return Err(ApiError::bad("No peer has sent this part of the file yet.")),
    }
    buffer.truncate(filled);
    Ok(buffer)
}

/// The type a browser needs to play the file. Matroska goes out as WebM, which is the Matroska
/// subset browsers name; they play the rest of it too where they support the codecs.
pub fn media_type(name: &str) -> &'static str {
    let extension = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mkv" | "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ts" | "m2ts" => "video/mp2t",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "srt" => "application/x-subrip",
        "vtt" => "text/vtt",
        _ => "application/octet-stream",
    }
}

/// A `Range: bytes=…` header against a file of `size` bytes: the first and last byte to send.
/// None when it can't be satisfied (416); no header, or one we don't understand, means all of it.
pub fn parse_range(header: Option<&str>, size: u64) -> Option<(u64, u64)> {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return (size > 0).then(|| (0, size - 1));
    };
    // Only the first range of a multi-range request is served, as most servers do.
    let first = spec.split(',').next().unwrap_or_default().trim();
    let (start, end) = first.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let suffix: u64 = suffix.parse().ok()?;
            if suffix == 0 {
                return None;
            }
            (size.saturating_sub(suffix), size.checked_sub(1)?)
        }
        (start, "") => (start.parse().ok()?, size.checked_sub(1)?),
        (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.min(size.checked_sub(1)?)),
    };
    (start <= end && start < size).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_follow_rfc_9110() {
        assert_eq!(parse_range(None, 1000), Some((0, 999)));
        assert_eq!(parse_range(Some("bytes=0-"), 1000), Some((0, 999)));
        assert_eq!(parse_range(Some("bytes=0-1"), 1000), Some((0, 1)));
        assert_eq!(parse_range(Some("bytes=500-2000"), 1000), Some((500, 999)), "an end past the file is clipped");
        assert_eq!(parse_range(Some("bytes=-100"), 1000), Some((900, 999)));
        assert_eq!(parse_range(Some("bytes=-5000"), 1000), Some((0, 999)), "a suffix longer than the file is all of it");
        assert_eq!(parse_range(Some("bytes=999-999"), 1000), Some((999, 999)));
        assert_eq!(parse_range(Some("bytes=10-20, 30-40"), 1000), Some((10, 20)));
        for unsatisfiable in ["bytes=1000-", "bytes=5-4", "bytes=-0", "bytes=abc-", "bytes=1-x"] {
            assert_eq!(parse_range(Some(unsatisfiable), 1000), None, "{unsatisfiable}");
        }
        assert_eq!(parse_range(Some("items=0-5"), 1000), Some((0, 999)), "another unit is ignored");
        assert_eq!(parse_range(None, 0), None, "nothing to send from an empty file");
        assert_eq!(parse_range(Some("bytes=0-"), 0), None);
    }

    #[test]
    fn browsers_get_a_type_they_play() {
        assert_eq!(media_type("Show.S01E01.MKV"), "video/webm");
        assert_eq!(media_type("a.mp4"), "video/mp4");
        assert_eq!(media_type("noext"), "application/octet-stream");
    }

    #[tokio::test]
    async fn reads_stop_at_the_end_of_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        std::fs::write(&path, (0..100u8).collect::<Vec<_>>()).unwrap();
        let mut reader: MediaReader = Box::new(tokio::fs::File::open(&path).await.unwrap());
        assert_eq!(read_at(&mut reader, 90, 50).await.unwrap(), (90..100u8).collect::<Vec<_>>());
        assert_eq!(read_at(&mut reader, 10, 3).await.unwrap(), vec![10, 11, 12], "seeks back");
        assert!(read_at(&mut reader, 100, 10).await.unwrap().is_empty());
    }
}
