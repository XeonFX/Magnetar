import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { GOOGLE_CALLBACK_PATH } from '@codefusion-cc/google-sign-in'
import { signInState, testGoogleIssuer } from '@codefusion-cc/google-sign-in/testing'
import worker from '../src/index.ts'
import { NONCE_COOKIE, SESSION_COOKIE } from '../src/auth.ts'
import type { Env } from '../src/env.ts'
import { call, cookieValue, freshIp, ORIGIN } from './client.ts'

// Google as the Worker meets it: its keys come through the global fetch, which this file points at a fake
// Google. One for the whole file, since the Worker keeps Google's keys for every request of the isolate.
const google = await testGoogleIssuer({ clientId: env.GOOGLE_CLIENT_ID })
const realFetch = globalThis.fetch
beforeAll(() => { globalThis.fetch = google.fetch })
afterAll(() => { globalThis.fetch = realFetch })
afterEach(() => {
  google.answerKeys('ok')
  vi.useRealTimers()
})

/** A browser that pressed "Continue with Google": its address, and the nonce cookie the Worker gave it. */
async function startSignIn() {
  const ip = freshIp()
  const response = await call('/api/auth/start', { method: 'POST', headers: { origin: ORIGIN, 'cf-connecting-ip': ip }, json: {} })
  expect(response.status).toBe(200)
  const { nonce, clientId } = await response.json<{ nonce: string; clientId: string }>()
  expect(clientId).toBe(google.clientId)
  expect(cookieValue(response, NONCE_COOKIE)).toBe(nonce)
  return { nonce, ip }
}

/** The browser posting `credential` back to the Worker, from `origin` (default: the site's own). */
function complete(credential: string | undefined, { nonce, ip }: { nonce?: string; ip: string }, origin = ORIGIN) {
  return call('/api/auth/google', {
    method: 'POST',
    headers: { origin, 'cf-connecting-ip': ip, ...(nonce ? { cookie: `${NONCE_COOKIE}=${nonce}` } : {}) },
    json: credential === undefined ? {} : { credential },
  })
}

describe('signing in with Google', () => {
  test('a token from Google for this browser signs the person in, once', async () => {
    const browser = await startSignIn()
    const response = await complete(await google.token({ nonce: browser.nonce, email: 'ada@example.com', name: 'Ada' }), browser)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ email: 'ada@example.com', name: 'Ada', picture: 'https://lh3.googleusercontent.com/a/test-person' })
    expect(cookieValue(response, NONCE_COOKIE)).toBe('')
    const session = cookieValue(response, SESSION_COOKIE)!
    const me = await call('/api/me', { headers: { cookie: `${SESSION_COOKIE}=${session}` } })
    expect(await me.json()).toMatchObject({ email: 'ada@example.com' })
  })

  test('the same Google account comes back as the same account, with its new address', async () => {
    const first = await startSignIn()
    const one = await (await complete(await google.token({ nonce: first.nonce, sub: '4242', email: 'old@example.com' }), first)).json<{ id: string }>()
    const second = await startSignIn()
    const two = await (await complete(await google.token({ nonce: second.nonce, sub: '4242', email: 'new@example.com' }), second)).json<{ id: string; email: string }>()
    expect(two).toMatchObject({ id: one.id, email: 'new@example.com' })
  })

  test.each([
    ['for another app', { aud: 'another-client.apps.googleusercontent.com' }, {}],
    ['that expired', { exp: Math.floor(Date.now() / 1000) - 1 }, {}],
    ['from another issuer', { iss: 'https://accounts.google.com.evil.test' }, {}],
    ['with an address Google did not verify', { email_verified: false }, {}],
    ['signed with alg none', {}, { signedWith: 'none' as const }],
    ["signed with another key under Google's key id", {}, { signedWith: 'stranger' as const }],
    ['signed as HMAC with the public key', {}, { signedWith: 'hmac-public-key' as const }],
  ])('a token %s is refused, and the nonce is spent', async (_, claims, options) => {
    const browser = await startSignIn()
    const response = await complete(await google.token({ nonce: browser.nonce, ...claims }, options), browser)
    expect(response.status).toBe(401)
    expect(cookieValue(response, SESSION_COOKIE)).toBeUndefined()
    expect(cookieValue(response, NONCE_COOKIE)).toBe('')
  })

  test("a token from another browser's sign-in is refused here", async () => {
    const victim = await startSignIn()
    const stolen = await google.token({ nonce: victim.nonce })
    const attacker = await startSignIn()
    expect((await complete(stolen, attacker)).status).toBe(401)
    expect((await complete(stolen, { ip: attacker.ip })).status).toBe(401)
  })

  test('a token is refused for a sign-in that already used its nonce', async () => {
    const browser = await startSignIn()
    const first = await complete(await google.token({ nonce: browser.nonce }), browser)
    expect(first.status).toBe(200)
    // The browser forgot the nonce: a replay has none, and a new sign-in has another.
    const replayed = await google.token({ nonce: browser.nonce })
    expect((await complete(replayed, { ip: browser.ip })).status).toBe(401)
    expect((await complete(replayed, await startSignIn())).status).toBe(401)
  })

  test('a sign-in signed with the key Google just rotated to works at once', async () => {
    await google.rotate()
    const browser = await startSignIn()
    expect((await complete(await google.token({ nonce: browser.nonce }), browser)).status).toBe(200)
  })

  test("while Google's keys cannot be read the Worker says try again, and the last good keys serve for a day", async () => {
    google.answerKeys('network')
    vi.useFakeTimers({ now: Date.now() + 6 * 60_000, toFake: ['Date'] })
    const browser = await startSignIn()
    expect((await complete(await google.token({ nonce: browser.nonce }), browser)).status).toBe(200)
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000)
    const later = await startSignIn()
    const response = await complete(await google.token({ nonce: later.nonce }), later)
    expect(response.status).toBe(503)
    expect(cookieValue(response, NONCE_COOKIE)).toBe('')
    google.answerKeys('ok')
    vi.setSystemTime(Date.now() + 60_000)
    const recovered = await startSignIn()
    expect((await complete(await google.token({ nonce: recovered.nonce }), recovered)).status).toBe(200)
  })

  test('a credential that is not a token, or none, is refused', async () => {
    const browser = await startSignIn()
    expect((await complete('not a token', browser)).status).toBe(401)
    expect((await complete(undefined, browser)).status).toBe(401)
  })

  test('a sign-in from another site is refused before any token is read', async () => {
    const browser = await startSignIn()
    expect((await complete(await google.token({ nonce: browser.nonce }), browser, 'https://evil.example')).status).toBe(403)
  })
})

describe("Google's way back to the site", () => {
  /** The callback page posting what Google sent back, to the Worker with `environment` at `origin`. */
  const handOn = (fields: Record<string, string>, environment: Env = env, origin = ORIGIN) =>
    worker.fetch(new Request(`${origin}${GOOGLE_CALLBACK_PATH}`, {
      method: 'POST', body: new URLSearchParams(fields), headers: { 'sec-fetch-site': 'same-origin' },
    }) as Parameters<typeof worker.fetch>[0], environment, createExecutionContext())

  test("lands on a page in the dashboard's colours that hands the token to /login", async () => {
    const page = await call(GOOGLE_CALLBACK_PATH)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toMatch(/^default-src 'none'; script-src 'sha256-/)
    expect(await page.text()).toContain('html{color-scheme:light dark;background:#f6f7fb}@media (prefers-color-scheme:dark){html{background:#0f1117}}')
    const response = await handOn({ state: signInState(ORIGIN, '/login?next=%2Fd%2Fx'), id_token: 'aaa.bbb.ccc' })
    const location = new URL((await response.json<{ location: string }>()).location)
    expect(location.origin + location.pathname + location.search).toBe(`${ORIGIN}/login?next=%2Fd%2Fx`)
    expect(new URLSearchParams(location.hash.slice(1)).get('google_id_token')).toBe('aaa.bbb.ccc')
  })

  test('sends a token only to our own login page', async () => {
    for (const bad of [signInState('https://evil.example', '/login'), signInState(ORIGIN, '/pair/x'), signInState(ORIGIN, '//evil.example/login'), 'garbage']) {
      expect((await handOn({ state: bad, id_token: 'aaa.bbb.ccc' })).status, bad).toBe(400)
    }
  })

  test('the Vite dev origin only in development with dev sign-in', async () => {
    const production = { ...env, ORIGIN: 'https://magnetar.codefusion.cc', APP_ENV: 'production', DEV_LOGIN: undefined }
    const fromVite = { state: signInState('http://localhost:5173', '/login'), id_token: 'aaa.bbb.ccc' }
    expect((await handOn(fromVite, production, production.ORIGIN)).status).toBe(400)
    expect((await handOn(fromVite)).status).toBe(200)
  })
})
