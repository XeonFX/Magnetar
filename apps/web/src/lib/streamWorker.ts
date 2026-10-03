/**
 * The service worker's side of playback through the relay (the page's side is streaming.ts). A <video> on the page
 * asks for /__stream/<key>/<name> with byte ranges; the worker asks the page for the bytes, which reads them from
 * the device over its end-to-end encrypted connection, and answers the video with a 206 response. The relay never
 * sees the file, and the keys never leave the page.
 */

/** One device read, the most a sealed relay frame carries. */
export const CHUNK = 448 * 1024
/** A media element asks again for the rest, so each answer stays short and a seek stays cheap. */
export const MAX_RANGE = 4 * CHUNK
const ASK_TIMEOUT_MS = 90_000

/** A page, as far as the worker talks to it. */
interface PageClient {
  postMessage(message: unknown, transfer: Transferable[]): void
}

/** The parts of the service worker's global this uses; the real `self` fits. */
export interface StreamWorkerScope {
  location: { origin: string }
  addEventListener(type: 'fetch', listener: (event: StreamFetchEvent) => void): void
  clients: {
    get(id: string): Promise<PageClient | undefined>
    matchAll(options: { type: 'window' }): Promise<readonly PageClient[]>
  }
}

export interface StreamFetchEvent {
  request: Request
  clientId: string
  respondWith(response: Promise<Response>): void
}

interface StreamMeta {
  size: number
  type: string
}

/** Asks a page something and waits for its answer on a private channel; null when it does not answer in time. */
function ask<T>(client: PageClient, message: unknown): Promise<T | null> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => {
      channel.port1.close()
      resolve(null)
    }, ASK_TIMEOUT_MS)
    channel.port1.onmessage = event => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(event.data as T)
    }
    client.postMessage(message, [channel.port2])
  })
}

/** The page that opened the stream: the requester, or any open page that knows the key. */
async function pageFor(scope: StreamWorkerScope, clientId: string, key: string): Promise<{ client: PageClient; meta: StreamMeta } | null> {
  const own = clientId ? await scope.clients.get(clientId) : undefined
  const candidates = own ? [own] : await scope.clients.matchAll({ type: 'window' })
  for (const client of candidates) {
    const meta = await ask<StreamMeta | null>(client, { type: 'magnetar-stream-meta', key })
    if (meta) return { client, meta }
  }
  return null
}

/**
 * The bytes a Range header asks for in a file of `size`: the whole file without one (or with one this doesn't
 * read), null when it lies outside the file.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number; partial: boolean } | null {
  if (!header) return { start: 0, end: size - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '')) return { start: 0, end: size - 1, partial: false }
  const start = Math.max(0, match[1] === '' ? size - Number(match[2]) : Number(match[1]))
  const end = match[1] === '' || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  return start <= end && start < size ? { start, end, partial: true } : null
}

async function stream(scope: StreamWorkerScope, event: StreamFetchEvent, key: string): Promise<Response> {
  const found = await pageFor(scope, event.clientId, key)
  if (!found) return new Response('This stream is closed. Open the player again.', { status: 404 })
  const { client, meta } = found
  const range = parseRange(event.request.headers.get('range'), meta.size)
  if (!range) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${meta.size}` } })
  const end = range.partial ? Math.min(range.end, range.start + MAX_RANGE - 1) : range.end
  let offset = range.start
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset > end) return controller.close()
      const reply = await ask<{ data?: ArrayBuffer; error?: string }>(client, { type: 'magnetar-stream-read', key, offset, length: Math.min(CHUNK, end - offset + 1) })
      if (!reply || reply.error || !reply.data) return controller.error(new Error(reply?.error ?? 'The device did not answer'))
      const bytes = new Uint8Array(reply.data)
      if (bytes.length === 0) return controller.close()
      controller.enqueue(bytes)
      offset += bytes.length
    },
  }, { highWaterMark: 1 })
  const headers: Record<string, string> = {
    'content-type': meta.type,
    'content-length': String(end - range.start + 1),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  if (range.partial) headers['content-range'] = `bytes ${range.start}-${end}/${meta.size}`
  return new Response(body, { status: range.partial ? 206 : 200, headers })
}

/** Makes the service worker answer /__stream/ requests with bytes the page reads from the device. */
export function handleStreams(scope: StreamWorkerScope = globalThis as unknown as StreamWorkerScope): void {
  const { origin } = scope.location
  scope.addEventListener('fetch', event => {
    const url = new URL(event.request.url)
    if (url.origin !== origin || !url.pathname.startsWith('/__stream/')) return
    event.respondWith(stream(scope, event, url.pathname.split('/')[2] ?? ''))
  })
}
