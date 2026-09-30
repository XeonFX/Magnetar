import { describe, expect, test } from 'bun:test'
import { readVapidAuthorization, testPushService, testVapidKey } from '@codefusion-cc/web-push/testing'
import { toBase64Url } from '@magnetar/protocol/base64'
import type { Env } from '../src/env.ts'
import { handlePush } from '../src/push.ts'

const vapid = await testVapidKey()
const DEVICE_TOKEN = 'x'.repeat(40)
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc'

function env(overrides: Partial<Env> = {}): Env {
  // Just enough D1 for deviceFromToken: every token hash finds the one test device.
  const DB = { prepare: () => ({ bind: () => ({ first: async () => ({ id: 'd_1' }) }) }) }
  return {
    DB, ORIGIN: 'https://magnetar.codefusion.cc', VAPID_PRIVATE_KEY: vapid.secret,
    PUSH_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  } as unknown as Env
}

const post = (body: unknown, token = DEVICE_TOKEN) => new Request('https://magnetar.codefusion.cc/api/device/push', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
})

describe('Web Push', () => {
  test('forwards the sealed body, signed for that push service, and reports its status', async () => {
    const service = testPushService(() => 410)
    const body = toBase64Url(new Uint8Array(200).fill(7))
    const response = await handlePush(post({ endpoint: ENDPOINT, body, ttl: 60, urgency: 'high' }), env(), '/api/device/push', service.fetch)
    expect(await response!.json()).toEqual({ status: 410 })
    expect(service.pushes).toHaveLength(1)
    const [push] = service.pushes
    expect(push!.endpoint).toBe(ENDPOINT)
    expect(push!.headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '60', urgency: 'high' })
    expect([...push!.body]).toEqual(Array.from({ length: 200 }, () => 7))
    const authorization = await readVapidAuthorization(push!.headers.authorization!)
    expect(authorization).toMatchObject({ verified: true, publicKey: vapid.publicKey })
    expect(authorization.claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'https://magnetar.codefusion.cc' })
  })

  test('a push service that cannot be reached is status 0, not an error', async () => {
    const service = testPushService(() => new Error('offline'))
    const response = await handlePush(post({ endpoint: ENDPOINT, body: 'AAAA' }), env(), '/api/device/push', service.fetch)
    expect(response!.status).toBe(200)
    expect(await response!.json()).toEqual({ status: 0 })
  })

  test('new keys sign at once, instead of the old key\'s signature', async () => {
    const service = testPushService()
    await handlePush(post({ endpoint: ENDPOINT, body: 'AAAA' }), env(), '/api/device/push', service.fetch)
    const next = await testVapidKey()
    await handlePush(post({ endpoint: ENDPOINT, body: 'AAAA' }), env({ VAPID_PRIVATE_KEY: next.secret }), '/api/device/push', service.fetch)
    const signed = await Promise.all(service.pushes.map(p => readVapidAuthorization(p.headers.authorization!)))
    expect(signed.map(s => [s.verified, s.publicKey])).toEqual([[true, vapid.publicKey], [true, next.publicKey]])
  })

  test.each([
    ['another host', { endpoint: 'https://evil.example/x', body: 'AAAA' }, 400],
    ['an endpoint longer than any push service hands out', { endpoint: `${ENDPOINT}/${'a'.repeat(1100)}`, body: 'AAAA' }, 400],
    ['no endpoint', { body: 'AAAA' }, 400],
    ['an empty body', { endpoint: ENDPOINT, body: '' }, 400],
    ['a body too big to be one', { endpoint: ENDPOINT, body: toBase64Url(new Uint8Array(5000)) }, 400],
    ['a body that is not base64url', { endpoint: ENDPOINT, body: 'a+b/' }, 400],
    ['a negative ttl', { endpoint: ENDPOINT, body: 'AAAA', ttl: -1 }, 400],
    ['a ttl past four weeks', { endpoint: ENDPOINT, body: 'AAAA', ttl: 28 * 24 * 3600 + 1 }, 400],
    ['an unknown urgency', { endpoint: ENDPOINT, body: 'AAAA', urgency: 'now' }, 400],
  ])('refuses %s', async (_, request, status) => {
    const service = testPushService()
    expect((await handlePush(post(request), env(), '/api/device/push', service.fetch))!.status).toBe(status)
    expect(service.pushes).toHaveLength(0)
  })

  test('needs a device, and a key on the server', async () => {
    const unknownDevice = env({ DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as Env['DB'] })
    expect((await handlePush(post({ endpoint: ENDPOINT, body: 'AAAA' }), unknownDevice, '/api/device/push'))!.status).toBe(401)
    expect((await handlePush(post({ endpoint: ENDPOINT, body: 'AAAA' }), env({ VAPID_PRIVATE_KEY: '' }), '/api/device/push'))!.status).toBe(503)
    const key = await handlePush(new Request('https://x/api/push/key'), env(), '/api/push/key')
    expect(await key!.json()).toEqual({ publicKey: vapid.publicKey })
    expect((await handlePush(new Request('https://x/api/push/key'), env({ VAPID_PRIVATE_KEY: '' }), '/api/push/key'))!.status).toBe(404)
    expect((await handlePush(new Request('https://x/api/push/key'), env({ VAPID_PRIVATE_KEY: 'not a key' }), '/api/push/key'))!.status).toBe(404)
  })
})
