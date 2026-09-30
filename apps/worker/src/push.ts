import { fromBase64Url, toBase64Url } from '@magnetar/protocol/base64'
import type { Env } from './env.ts'
import { deviceFromToken } from './devices.ts'
import { error, json, limit, readJson } from './http.ts'

/**
 * Web Push for linked browsers. The device seals each notification for the browser's subscription
 * (RFC 8291) before it gets here; this only adds the VAPID signature push services require (RFC 8292)
 * and passes the ciphertext on. The private key never leaves the Worker, the plaintext never enters it.
 */

/** The push services of the browsers people use; nothing else is ever fetched. */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com']
/** One 4096-byte record, its header and a little slack; anything bigger isn't a notification. */
const MAX_BODY_BYTES = 4200
const MAX_TTL = 28 * 24 * 60 * 60
const URGENCIES = new Set(['very-low', 'low', 'normal', 'high'])
/** A signature is good for up to 24 hours; one is reused for 12 per push service. */
const JWT_LIFETIME_S = 12 * 60 * 60

export function isPushService(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.port === ''
    && PUSH_HOSTS.some(host => (host.startsWith('.') ? url.hostname.endsWith(host) : url.hostname === host))
}

const pushConfigured = (env: Env) => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)

let signingKey: { raw: string; key: CryptoKey } | null = null
const signatures = new Map<string, { jwt: string; expires: number }>()

async function privateKey(env: Env): Promise<CryptoKey> {
  if (signingKey && signingKey.raw === env.VAPID_PRIVATE_KEY) return signingKey.key
  const point = fromBase64Url(env.VAPID_PUBLIC_KEY!)
  if (point.length !== 65 || point[0] !== 4) throw new Error('VAPID_PUBLIC_KEY is not an uncompressed P-256 point')
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x: toBase64Url(point.subarray(1, 33)), y: toBase64Url(point.subarray(33)),
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  signingKey = { raw: env.VAPID_PRIVATE_KEY!, key }
  return key
}

/** The VAPID JWT for one push service (its origin is the audience), cached while it stays valid. */
export async function vapidJwt(env: Env, audience: string, now = Date.now()): Promise<string> {
  const cached = signatures.get(audience)
  if (cached && cached.expires - 60_000 > now) return cached.jwt
  const encode = (value: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)))
  const exp = Math.floor(now / 1000) + JWT_LIFETIME_S
  const input = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({ aud: audience, exp, sub: env.VAPID_SUBJECT || env.ORIGIN })}`
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await privateKey(env), new TextEncoder().encode(input))
  const jwt = `${input}.${toBase64Url(new Uint8Array(signature))}`
  signatures.set(audience, { jwt, expires: exp * 1000 })
  return jwt
}

export function resetPushCaches(): void {
  signingKey = null
  signatures.clear()
}

interface PushRequest {
  endpoint?: string
  body?: string
  ttl?: number
  urgency?: string
}

export async function handlePush(request: Request, env: Env, path: string, send: typeof fetch = fetch): Promise<Response | null> {
  if (path === '/api/push/key' && request.method === 'GET') {
    if (!pushConfigured(env)) return error(404, 'Push notifications are not set up on this server')
    return json({ publicKey: env.VAPID_PUBLIC_KEY }, { headers: { 'cache-control': 'public, max-age=3600' } })
  }
  if (path !== '/api/device/push') return null
  if (request.method !== 'POST') return error(405, 'Method not allowed')
  const device = await deviceFromToken(request, env)
  if (!device) return error(401, 'Unknown device')
  if (!pushConfigured(env)) return error(503, 'Push notifications are not set up on this server')
  await limit(env.PUSH_LIMITER, device.id)
  const { endpoint, body, ttl = 86_400, urgency = 'normal' } = await readJson<PushRequest>(request)
  if (typeof endpoint !== 'string' || endpoint.length > 1000 || !isPushService(endpoint)) return error(400, 'Not a push service this server sends to')
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL) return error(400, 'ttl must be 0 to 28 days, in seconds')
  if (!URGENCIES.has(urgency)) return error(400, 'Unknown urgency')
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = fromBase64Url(String(body ?? ''))
  } catch {
    return error(400, 'body must be base64url')
  }
  if (bytes.length === 0 || bytes.length > MAX_BODY_BYTES) return error(400, 'body is not a Web Push message')
  const jwt = await vapidJwt(env, new URL(endpoint).origin)
  const answer = await send(endpoint, {
    method: 'POST',
    headers: {
      authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency,
    },
    body: bytes,
  })
  // The device only needs the status: 404 and 410 mean the browser's subscription is gone.
  return json({ status: answer.status })
}
