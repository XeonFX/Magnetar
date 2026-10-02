import type { DownloadDto } from '@magnetar/protocol'
import { MAX_TORRENT_FILE } from '@magnetar/protocol/limits'
import { torrentCalls } from '@magnetar/protocol/torrent-upload'
import { RpcError, type RpcClient } from './rpcClient.ts'

/**
 * Hands a .torrent file to the device and starts it: whole when it fits in one message, else in
 * pieces (`torrentCalls`), one call at a time so a failure stops the rest. `onProgress` hears how
 * many bytes the device has after each piece. Rejects with an RpcError: `too_large` for a file over
 * `MAX_TORRENT_FILE` (nothing is sent), `update_needed` when the device's app predates pieces, or
 * whatever the connection or the device answered.
 */
export async function sendTorrent(connection: RpcClient, bytes: Uint8Array, folder?: string, onProgress?: (sent: number) => void): Promise<DownloadDto> {
  if (bytes.length > MAX_TORRENT_FILE) throw new RpcError('too_large', `Larger than ${MAX_TORRENT_FILE >> 20} MB`)
  if (bytes.length === 0) throw new RpcError('bad_request', 'That is not a valid .torrent file.')
  for (const call of torrentCalls(bytes, crypto.randomUUID(), folder)) {
    switch (call.method) {
      case 'downloads.start':
        return connection.call(call.method, call.params)
      case 'downloads.startUpload':
        return connection.call(call.method, call.params)
      case 'downloads.upload':
        try {
          const { received } = await connection.call(call.method, call.params)
          onProgress?.(received)
        } catch (error) {
          if (error instanceof RpcError && error.code === 'not_found' && error.message.startsWith('Unknown method')) {
            throw new RpcError('update_needed', 'The app on this device is too old to take .torrent files this large')
          }
          throw error
        }
    }
  }
  throw new Error('torrentCalls ends with a call that starts the download')
}
