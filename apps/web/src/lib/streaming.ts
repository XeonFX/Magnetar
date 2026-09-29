import type { RpcClient } from './rpcClient.ts'

/** A file ready for a <video> or <audio>: its URL, and a way to let go of it. */
export interface OpenedStream {
  url: string
  type: string
  close: () => void
}

/** Standard base64 to bytes, natively where the browser can (it is ~450 KB a read). */
export function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> }).fromBase64
  if (native) return native(data)
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
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

/** Answers the service worker's questions about streams this page opened (see public/sw.js). */
function listen(): void {
  if (listening || !('serviceWorker' in navigator)) return
  listening = true
  navigator.serviceWorker.addEventListener('message', event => {
    const message = event.data as { type?: string; key?: string; offset?: number; length?: number }
    const port = event.ports[0]
    if (!port || !message.key) return
    const stream = relayed.get(message.key)
    if (message.type === 'md-stream-meta') return port.postMessage(stream ? { size: stream.size, type: stream.type } : null)
    if (message.type !== 'md-stream-read') return
    if (!stream) return port.postMessage({ error: 'This stream is closed.' })
    stream.connection.call('stream.read', { streamId: stream.streamId, offset: message.offset ?? 0, length: message.length ?? 1 })
      .then(({ data }) => {
        const bytes = fromBase64(data)
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        port.postMessage({ data: buffer }, [buffer])
      })
      .catch((e: unknown) => port.postMessage({ error: e instanceof Error ? e.message : String(e) }))
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
 * the relay a service-worker URL whose bytes are read from the device piece by piece.
 */
export async function openStream(connection: RpcClient, id: number, index: number, name: string): Promise<OpenedStream> {
  if (connection.kind === 'local') {
    const { url } = await connection.call('downloads.streamUrl', { id, index })
    return { url, type: '', close: () => {} }
  }
  await ensureServiceWorker()
  const opened = await connection.call('stream.open', { id, index })
  const key = crypto.randomUUID()
  relayed.set(key, { connection, streamId: opened.streamId, size: opened.size, type: opened.type })
  return {
    url: `/__stream/${key}/${encodeURIComponent(name)}`,
    type: opened.type,
    close: () => {
      relayed.delete(key)
      void connection.call('stream.close', { streamId: opened.streamId }).catch(() => {})
    },
  }
}

/** SubRip to WebVTT, which is what <track> reads. */
export function srtToVtt(srt: string): string {
  const lines = srt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  // Only timing lines change; a time quoted in the dialogue stays as written.
  const body = lines.map(line => (line.includes('-->') ? line.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2') : line)).join('\n')
  return `WEBVTT\n\n${body.trim()}\n`
}
