import type { DownloadFileDto } from '@magnetar/protocol'
import { fromBase64 } from '@magnetar/protocol/base64'
import { errorMessage } from './errors.ts'
import type { RpcClient } from './rpcClient.ts'

/** A file ready for a <video> or <audio>: its URL, and a way to let go of it. */
export interface OpenedStream {
  url: string
  type: string
  close: () => void
}

interface RelayStream {
  connection: RpcClient
  streamId: string
  size: number
  type: string
}

/** Streams this page has open through the relay, by the key in their /__stream/ URL. */
const relayed = new Map<string, RelayStream>()
let listening = false

/** Answers the service worker's questions about streams this page opened (see streamWorker.ts). */
function listen(): void {
  if (listening || !('serviceWorker' in navigator)) return
  listening = true
  navigator.serviceWorker.addEventListener('message', event => {
    const message = event.data as { type?: string; key?: string; offset?: number; length?: number }
    const port = event.ports[0]
    if (!port || !message.key) return
    const stream = relayed.get(message.key)
    if (message.type === 'magnetar-stream-meta') return port.postMessage(stream ? { size: stream.size, type: stream.type } : null)
    if (message.type !== 'magnetar-stream-read') return
    if (!stream) return port.postMessage({ error: 'This stream is closed.' })
    stream.connection.call('stream.read', { streamId: stream.streamId, offset: message.offset ?? 0, length: message.length ?? 1 })
      .then(({ data }) => {
        const bytes = fromBase64(data)
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        port.postMessage({ data: buffer }, [buffer])
      })
      .catch((e: unknown) => port.postMessage({ error: errorMessage(e) }))
  })
}

/** Registers the website's service worker; resolves once it controls this page. */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) throw new Error('This browser cannot play files from a remote device.')
  listen()
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
  }
  return registration
}

/**
 * Opens one file of a download for playback: on this computer a direct link to the app, through
 * the relay a service-worker URL whose bytes are read from the device piece by piece. Once `signal`
 * aborts, a stream that opens is closed at once and the call rejects with the abort reason.
 */
export async function openStream(connection: RpcClient, id: number, index: number, name: string, signal?: AbortSignal): Promise<OpenedStream> {
  let stream: OpenedStream
  if (connection.kind === 'local') {
    const { url } = await connection.call('downloads.streamUrl', { id, index })
    stream = { url, type: '', close: () => {} }
  } else {
    await ensureServiceWorker()
    const opened = await connection.call('stream.open', { id, index })
    const key = crypto.randomUUID()
    relayed.set(key, { connection, streamId: opened.streamId, size: opened.size, type: opened.type })
    stream = {
      url: `/__stream/${key}/${encodeURIComponent(name)}`,
      type: opened.type,
      close: () => {
        relayed.delete(key)
        void connection.call('stream.close', { streamId: opened.streamId }).catch(() => {})
      },
    }
  }
  if (signal?.aborted) {
    stream.close()
    throw signal.reason
  }
  return stream
}

/**
 * A download's subtitle files read into WebVTT for <track>s, as object URLs the caller revokes. Each file's stream
 * is closed once it is read. Once `signal` aborts, reads stop, streams still opening are closed as they open, and
 * every URL already made is revoked: it resolves with none. A file that can't be read is left out.
 */
export async function loadSubtitles(connection: RpcClient, id: number, files: DownloadFileDto[], signal: AbortSignal): Promise<{ file: DownloadFileDto; url: string }[]> {
  const made: string[] = []
  const loaded = await Promise.all(files.map(async file => {
    try {
      const stream = await openStream(connection, id, file.index, file.path.split('/').pop()!, signal)
      let text: string
      try {
        text = await (await fetch(stream.url, { signal })).text()
      } finally {
        stream.close()
      }
      if (signal.aborted) return null
      const url = URL.createObjectURL(new Blob([file.path.toLowerCase().endsWith('.srt') ? srtToVtt(text) : text], { type: 'text/vtt' }))
      made.push(url)
      return { file, url }
    } catch {
      return null
    }
  }))
  if (signal.aborted) {
    made.forEach(url => URL.revokeObjectURL(url))
    return []
  }
  return loaded.filter(track => track !== null)
}

/** SubRip to WebVTT, which is what <track> reads. */
export function srtToVtt(srt: string): string {
  const lines = srt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  // Only timing lines change; a time quoted in the dialogue stays as written.
  const body = lines.map(line => (line.includes('-->') ? line.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2') : line)).join('\n')
  return `WEBVTT\n\n${body.trim()}\n`
}
