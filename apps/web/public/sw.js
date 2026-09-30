/*
 * Magnetar's service worker, on the website only.
 *
 * Playback through the relay: a <video> on the page asks for /__stream/<key>/<name> with byte
 * ranges; this worker asks the page for the bytes, which reads them from the device over its
 * end-to-end encrypted connection, and answers the video with a 206 response. The relay never
 * sees the file, and the keys never leave the page.
 */

/** One device read, the most a sealed relay frame carries. */
const CHUNK = 448 * 1024
/** A media element asks again for the rest, so each answer stays short and a seek stays cheap. */
const MAX_RANGE = 4 * CHUNK
const ASK_TIMEOUT_MS = 90_000

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/__stream/')) return
  event.respondWith(stream(event, url.pathname.split('/')[2] ?? ''))
})

/** Asks a page for something and waits for its answer on a private channel. */
function ask(client, message) {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS)
    channel.port1.onmessage = event => {
      clearTimeout(timer)
      resolve(event.data)
    }
    client.postMessage(message, [channel.port2])
  })
}

/** The page that opened the stream: the requester, or any open page that knows the key. */
async function pageFor(event, key) {
  const own = event.clientId ? await self.clients.get(event.clientId) : null
  const candidates = own ? [own] : await self.clients.matchAll({ type: 'window' })
  for (const client of candidates) {
    const meta = await ask(client, { type: 'magnetar-stream-meta', key })
    if (meta) return { client, meta }
  }
  return null
}

function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)/.exec(header.trim())
  if (!match) return { start: 0, end: size - 1, partial: false }
  let start = match[1] === '' ? size - Number(match[2]) : Number(match[1])
  let end = match[1] === '' || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  start = Math.max(0, start)
  return start <= end && start < size ? { start, end, partial: true } : null
}

async function stream(event, key) {
  const found = await pageFor(event, key)
  if (!found) return new Response('This stream is closed. Open the player again.', { status: 404 })
  const { client, meta } = found
  const range = parseRange(event.request.headers.get('range'), meta.size)
  if (!range) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${meta.size}` } })
  const end = range.partial ? Math.min(range.end, range.start + MAX_RANGE - 1) : range.end
  let offset = range.start
  const body = new ReadableStream({
    async pull(controller) {
      if (offset > end) return controller.close()
      const reply = await ask(client, { type: 'magnetar-stream-read', key, offset, length: Math.min(CHUNK, end - offset + 1) })
      if (!reply || reply.error) return controller.error(new Error(reply?.error ?? 'The device did not answer'))
      const bytes = new Uint8Array(reply.data)
      if (bytes.length === 0) return controller.close()
      controller.enqueue(bytes)
      offset += bytes.length
    },
  }, { highWaterMark: 1 })
  const headers = {
    'content-type': meta.type,
    'content-length': String(end - range.start + 1),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  if (range.partial) headers['content-range'] = `bytes ${range.start}-${end}/${meta.size}`
  return new Response(body, { status: range.partial ? 206 : 200, headers })
}

/*
 * Notifications from linked devices, sealed on the device for this browser and opened by the
 * browser's push service before they arrive here.
 */
self.addEventListener('push', event => {
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    message = { body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(self.registration.showNotification(message.title || 'Magnetar', {
    body: message.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: message.kind === 'completed' ? `md-${message.body}` : undefined,
    data: { url: typeof message.url === 'string' && message.url.startsWith('/') ? message.url : '/' },
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = pages.find(page => page.url === target) || pages[0]
    if (open) {
      await open.focus()
      if (open.url !== target) await open.navigate(target)
      return
    }
    await self.clients.openWindow(target)
  })())
})
