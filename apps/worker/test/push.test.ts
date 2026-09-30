import { beforeEach, describe, expect, test } from 'bun:test'
import { fromBase64Url, toBase64Url } from '@magnetar/protocol/base64'
import type { Env } from '../src/env.ts'
import { handlePush, isPushService, resetPushCaches, vapidJwt } from '../src/push.ts'

const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey)
const DEVICE_TOKEN = 'x'.repeat(40)
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc'

function env(overrides: Partial<Env> = {}): Env {
  // Just enough D1 for deviceFromToken: every token hash finds the one test device.
  const DB = { prepare: () => ({ bind: () => ({ first: async () => ({ id: 'd_1' }) }) }) }
  return {
    DB, ORIGIN: 'https://magnetar.codefusion.cc', VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: d,
    PUSH_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  } as unknown as Env
}

const post = (body: unknown, token = DEVICE_TOKEN) => new Request('https://magnetar.codefusion.cc/api/device/push', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
})

describe('Web Push', () => {
  beforeEach(() => resetPushCaches())

  test('only the browsers\' push services are reachable', () => {
    expect(isPushService(ENDPOINT)).toBe(true)
    expect(isPushService('https://web.push.apple.com/abc')).toBe(true)
    expect(isPushService('https://wns2-par02p.notify.windows.com/w/?token=1')).toBe(true)
    for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com.evil.example/x',
      'https://evil.example/fcm.googleapis.com', 'https://push.apple.com.evil.example/', 'https://169.254.169.254/', 'nope']) {
      expect(isPushService(bad)).toBe(false)
    }
  })

  test('the VAPID signature verifies with the public key and names the push service', async () => {
    const now = Date.UTC(2026, 8, 29)
    const jwt = await vapidJwt(env(), 'https://fcm.googleapis.com', now)
    const [header, claims, signature] = jwt.split('.')
    const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as Record<string, unknown>
    expect(decode(header!)).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(decode(claims!)).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://magnetar.codefusion.cc' })
    const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, fromBase64Url(signature!), new TextEncoder().encode(`${header}.${claims}`))
    expect(verified).toBe(true)
    expect(await vapidJwt(env(), 'https://fcm.googleapis.com', now + 60_000)).toBe(jwt)
  })

  test('new VAPID keys sign at once, instead of the old key\'s cached signature', async () => {
    const now = Date.UTC(2026, 8, 29)
    const old = await vapidJwt(env(), 'https://fcm.googleapis.com', now)
    const next = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const rotated = env({
      VAPID_PUBLIC_KEY: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', next.publicKey))),
      VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', next.privateKey)).d,
    })
    const jwt = await vapidJwt(rotated, 'https://fcm.googleapis.com', now + 60_000)
    expect(jwt).not.toBe(old)
    const [header, claims, signature] = jwt.split('.')
    const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, next.publicKey, fromBase64Url(signature!), new TextEncoder().encode(`${header}.${claims}`))
    expect(verified).toBe(true)
  })

  test('forwards the sealed body with VAPID headers and reports the push service status', async () => {
    const sent: Request[] = []
    const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Request(input as string, init))
      return new Response(null, { status: 410 })
    }) as typeof fetch
    const body = toBase64Url(new Uint8Array(200).fill(7))
    const response = await handlePush(post({ endpoint: ENDPOINT, body, ttl: 60, urgency: 'high' }), env(), '/api/device/push', send)
    expect(await response!.json()).toEqual({ status: 410 })
    expect(sent).toHaveLength(1)
    const request = sent[0]!
    expect(request.url).toBe(ENDPOINT)
    expect(request.headers.get('content-encoding')).toBe('aes128gcm')
    expect(request.headers.get('ttl')).toBe('60')
    expect(request.headers.get('urgency')).toBe('high')
    expect(request.headers.get('authorization')).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${publicKey}$`))
    expect([...new Uint8Array(await request.arrayBuffer())]).toEqual(Array.from({ length: 200 }, () => 7))
  })

  test.each([
    ['another host', { endpoint: 'https://evil.example/x', body: 'AAAA' }, 400],
    ['an empty body', { endpoint: ENDPOINT, body: '' }, 400],
    ['a body too big to be one', { endpoint: ENDPOINT, body: toBase64Url(new Uint8Array(5000)) }, 400],
    ['a body that is not base64url', { endpoint: ENDPOINT, body: 'a+b/' }, 400],
    ['a negative ttl', { endpoint: ENDPOINT, body: 'AAAA', ttl: -1 }, 400],
    ['an unknown urgency', { endpoint: ENDPOINT, body: 'AAAA', urgency: 'now' }, 400],
  ])('refuses %s', async (_, request, status) => {
    const send = (async () => { throw new Error('must not send') }) as unknown as typeof fetch
    expect((await handlePush(post(request), env(), '/api/device/push', send))!.status).toBe(status)
  })

  test('needs a device, and keys on the server', async () => {
    const unknownDevice = env({ DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as Env['DB'] })
    expect((await handlePush(post({ endpoint: ENDPOINT, body: 'AAAA' }), unknownDevice, '/api/device/push'))!.status).toBe(401)
    expect((await handlePush(post({ endpoint: ENDPOINT, body: 'AAAA' }), env({ VAPID_PRIVATE_KEY: '' }), '/api/device/push'))!.status).toBe(503)
    const key = await handlePush(new Request('https://x/api/push/key'), env(), '/api/push/key')
    expect(await key!.json()).toEqual({ publicKey })
    expect((await handlePush(new Request('https://x/api/push/key'), env({ VAPID_PUBLIC_KEY: '' }), '/api/push/key'))!.status).toBe(404)
  })
})
