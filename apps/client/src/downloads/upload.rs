//! .torrent files too large for one dashboard message, arriving in pieces (`downloads.upload`, see
//! `packages/protocol/src/torrentUpload.ts`). Each connection keeps its own, and lets them go when it
//! closes.

use super::manager::{MAX_TORRENT_FILE, torrent_too_large};
use crate::error::{ApiError, ApiResult};

/// The largest piece: base64 in JSON, sealed, it stays under the relay's 1 MiB.
pub const TORRENT_UPLOAD_CHUNK: usize = 512 * 1024;
/// Files one connection may have arriving at once; starting another drops the oldest.
const MAX_UPLOADS: usize = 2;
/// Longest `uploadId`, as `packages/protocol/src/rpc.ts` has it.
const MAX_UPLOAD_ID: usize = 64;

struct Upload {
    id: String,
    size: usize,
    bytes: Vec<u8>,
}

/// The files a connection is receiving, oldest first.
#[derive(Default)]
pub struct TorrentUploads(Vec<Upload>);

impl TorrentUploads {
    /// Adds the piece at `offset` of the file `id`, `size` bytes in all, and says how many bytes
    /// have arrived. Offset 0 starts the file, again if it was under way. A piece that is out of
    /// order, of another size or past the end drops the file, so a broken one never starts.
    pub fn receive(&mut self, id: &str, offset: usize, size: usize, data: &[u8]) -> ApiResult<usize> {
        if id.is_empty() || id.len() > MAX_UPLOAD_ID {
            return Err(ApiError::bad(format!("uploadId: 1 to {MAX_UPLOAD_ID} characters")));
        }
        if size > MAX_TORRENT_FILE {
            self.remove(id);
            return Err(torrent_too_large());
        }
        if data.is_empty() || data.len() > TORRENT_UPLOAD_CHUNK {
            self.remove(id);
            return Err(ApiError::bad(format!("data: 1 to {TORRENT_UPLOAD_CHUNK} bytes")));
        }
        if offset == 0 {
            self.remove(id);
            if self.0.len() >= MAX_UPLOADS {
                self.0.remove(0);
            }
            self.0.push(Upload { id: id.to_owned(), size, bytes: Vec::with_capacity(size) });
        }
        let index = self.0.iter().position(|u| u.id == id).ok_or_else(gone)?;
        let upload = &mut self.0[index];
        if upload.size != size || upload.bytes.len() != offset || offset + data.len() > size {
            self.0.remove(index);
            return Err(ApiError::bad("Part of the .torrent file got lost on the way. Add it again."));
        }
        upload.bytes.extend_from_slice(data);
        Ok(upload.bytes.len())
    }

    /// The whole file `id`, which leaves the connection; an error, and the file dropped, when some
    /// of it hasn't arrived.
    pub fn take(&mut self, id: &str) -> ApiResult<Vec<u8>> {
        let upload = self.remove(id).ok_or_else(gone)?;
        if upload.bytes.len() != upload.size {
            return Err(ApiError::bad("Only part of the .torrent file arrived. Add it again."));
        }
        Ok(upload.bytes)
    }

    fn remove(&mut self, id: &str) -> Option<Upload> {
        let index = self.0.iter().position(|u| u.id == id)?;
        Some(self.0.remove(index))
    }
}

fn gone() -> ApiError {
    ApiError::not_found("That .torrent file is no longer being received. Add it again.")
}
