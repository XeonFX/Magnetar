/**
 * How the dashboard hands a .torrent file to the device. A file that fits in one message goes whole
 * in `downloads.start`, which every version of the app understands. A larger one would not fit
 * through the relay (`MAX_RELAY_FRAME`), so it goes in `downloads.upload` pieces, each its own
 * sealed call, and `downloads.startUpload` then starts it; the device checks that the pieces arrive
 * in order and add up to the size announced with each.
 */
import { toBase64 } from './base64.ts'
import { MAX_TORRENT_FILE, TORRENT_UPLOAD_CHUNK } from './limits.ts'
import type { RpcParams } from './rpc.ts'

export type TorrentCall =
  | { method: 'downloads.start'; params: RpcParams<'downloads.start'> }
  | { method: 'downloads.upload'; params: RpcParams<'downloads.upload'> }
  | { method: 'downloads.startUpload'; params: RpcParams<'downloads.startUpload'> }

/**
 * The calls, in order, that give the device `bytes` and start the download in `folder` (the
 * device's default folder when absent). `uploadId` names the pieces on this connection. Throws a
 * RangeError for an empty file or one over `MAX_TORRENT_FILE`: callers refuse those up front.
 */
export function torrentCalls(bytes: Uint8Array, uploadId: string, folder?: string): Generator<TorrentCall, void> {
  if (bytes.length === 0 || bytes.length > MAX_TORRENT_FILE) throw new RangeError(`A .torrent file is 1 to ${MAX_TORRENT_FILE} bytes`)
  const at = folder === undefined ? {} : { folder }
  return (function* () {
    if (bytes.length <= TORRENT_UPLOAD_CHUNK) {
      yield { method: 'downloads.start', params: { torrent: toBase64(bytes), ...at } }
      return
    }
    for (let offset = 0; offset < bytes.length; offset += TORRENT_UPLOAD_CHUNK) {
      const data = toBase64(bytes.subarray(offset, offset + TORRENT_UPLOAD_CHUNK))
      yield { method: 'downloads.upload', params: { uploadId, offset, size: bytes.length, data } }
    }
    yield { method: 'downloads.startUpload', params: { uploadId, ...at } }
  })()
}
