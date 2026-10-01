import { isPushService, loadVapidKey, MAX_TTL_SECONDS, PUSH_TTL_SECONDS, sendPush, type PushUrgency, type VapidKey } from '@codefusion-cc/web-push'
import { json, jsonError, rateLimit, readJson } from '@codefusion-cc/workers-http'
import { fromBase64Url } from '@magnetar/protocol/base64'
import { MAX_BODY, type Env } from './env.ts'
import { deviceFromToken } from './devices.ts'

/**
 * Web Push for linked browsers. The device seals each notification for the browser's subscription
 * (RFC 8291) before it gets here; this only adds the VAPID signature push services require (RFC 8292)
 * and passes the ciphertext on. The private key never leaves the Worker, the plaintext never enters it.
 */

/** One 4096-byte record, its header and a little slack; anything bigger isn't a notification. */
const MAX_BODY_BYTES = 4200
const URGENCIES = new Set<string>(['very-low', 'low', 'normal', 'high'])

let loaded: { secret: string; key: Promise<VapidKey | null> } | null = null

/** The VAPID key from its secret, read once per isolate (and again when the secret changes). */
function vapidKey(env: Env): Promise<VapidKey | null> {
  const secret = env.VAPID_PRIVATE_KEY ?? ''
  if (loaded?.secret !== secret) loaded = { secret, key: loadVapidKey(secret || null) }
  return loaded.key
}

interface PushRequest {
  endpoint?: string
  body?: string
  ttl?: number
  urgency?: string
}

export async function handlePush(request: Request, env: Env, path: string, send: typeof fetch = fetch): Promise<Response | null> {
  if (path === '/api/push/key' && request.method === 'GET') {
    const vapid = await vapidKey(env)
    if (!vapid) return jsonError(404, 'Push notifications are not set up on this server')
    return json({ publicKey: vapid.publicKey }, { headers: { 'cache-control': 'public, max-age=3600' } })
  }
  if (path !== '/api/device/push') return null
  if (request.method !== 'POST') return jsonError(405, 'Method not allowed')
  const device = await deviceFromToken(request, env)
  if (!device) return jsonError(401, 'Unknown device')
  const vapid = await vapidKey(env)
  if (!vapid) return jsonError(503, 'Push notifications are not set up on this server')
  await rateLimit(env.PUSH_LIMITER, device.id)
  const { endpoint, body, ttl = PUSH_TTL_SECONDS, urgency = 'normal' } = await readJson<PushRequest>(request, { maxBytes: MAX_BODY })
  // Only the browsers' push services: nothing else is ever fetched.
  if (!isPushService(endpoint)) return jsonError(400, 'Not a push service this server sends to')
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL_SECONDS) return jsonError(400, 'ttl must be 0 to 28 days, in seconds')
  if (!URGENCIES.has(urgency)) return jsonError(400, 'Unknown urgency')
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = fromBase64Url(String(body ?? ''))
  } catch {
    return jsonError(400, 'body must be base64url')
  }
  if (bytes.length === 0 || bytes.length > MAX_BODY_BYTES) return jsonError(400, 'body is not a Web Push message')
  const result = await sendPush({
    vapid, subject: env.VAPID_SUBJECT || env.ORIGIN, subscription: { endpoint }, body: bytes, ttl, urgency: urgency as PushUrgency, fetcher: send,
  })
  // The device only needs the status: 404 and 410 mean the browser's subscription is gone.
  return json({ status: result.status })
}
