import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { testAssets } from '@codefusion-cc/workers-http/testing'
import { describe, expect, test } from 'vitest'
import worker from '../src/index.ts'
import type { Env } from '../src/env.ts'
import { SESSION_COOKIE } from '../src/auth.ts'
import { call, cookieValue, ORIGIN, signIn } from './client.ts'

const production = { ...env, APP_ENV: 'production', ORIGIN: 'https://magnetar.codefusion.cc' } as Env
/** The Worker with other bindings than the dev environment's. */
const fetchWith = (withEnv: Env, request: Request) => worker.fetch(request as Parameters<typeof worker.fetch>[0], withEnv, createExecutionContext())

describe('the website API', () => {
  test('every answer is marked nosniff and sends no referrer; unknown paths are a JSON 404', async () => {
    const response = await call('/api/nothing-here')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Not found' })
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  test("pages are the dashboard's one page, at the address exactly as written", async () => {
    // The assets answer a path that is no file with a 404 (no not_found_handling in wrangler.jsonc), so the Worker
    // answers it with the page and the address keeps a search's +, which single-page-application assets respell %2B.
    const files = { '/index.html': '<!doctype html><title>Magnetar</title>', '/sw.js': 'self.skipWaiting()', '/icon-192.png': 'png' }
    const get = async (path: string, init?: RequestInit) => {
      const assets = testAssets({ files })
      const response = await fetchWith({ ...env, ASSETS: assets }, new Request(`${ORIGIN}${path}`, init))
      return { response, paths: assets.paths }
    }
    for (const path of ['/MacBook-Pro', '/MacBook-Pro/search/house+of+the+dragon?res=720p', '/MacBook-Pro/search/AC%2FDC+%2B:1', '/MacBook-Pro/search/s01e01+1080p.mkv', '/MacBook-Pro/search/house.of.the.dragon', '/MacBook-Pro/search/...', '/MacBook-Pro/search?q=..&res=720p', '/d/d_x/settings']) {
      const { response, paths } = await get(path)
      expect([response.status, await response.text(), paths], path).toEqual([200, files['/index.html'], [path, '/']])
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    }
    // Files are the assets' own.
    for (const [path, file] of [['/', '/index.html'], ['/sw.js', '/sw.js'], ['/icon-192.png', '/icon-192.png']] as const) {
      const { response, paths } = await get(path)
      expect([response.status, await response.text(), paths], path).toEqual([200, files[file], [path]])
    }
    // Only reading a page is a page; nothing goes to the assets for anything else.
    const posted = await get('/MacBook-Pro', { method: 'POST' })
    expect([posted.response.status, await posted.response.json(), posted.paths])
      .toEqual([405, { error: 'Method not allowed.', code: 'method_not_allowed' }, []])
    // The API's and the console's unknown paths stay JSON 404s.
    for (const path of ['/api/nope', '/_console/nope']) {
      const { response, paths } = await get(path)
      expect([response.status, await response.json(), paths], path).toEqual([404, { error: 'Not found' }, []])
    }
  })

  test('a page the assets cannot serve is a 500 that reveals nothing', async () => {
    const assets = testAssets({ fail: new Error('assets unreachable: /Volumes/secret') })
    const response = await fetchWith({ ...env, ASSETS: assets }, new Request(`${ORIGIN}/MacBook-Pro`))
    expect([response.status, await response.json()]).toEqual([500, { error: 'Something went wrong. Try again.', code: 'server_error' }])
  })

  test('app-config tells the page it is the cloud site, with dev sign-in only in development', async () => {
    expect(await (await call('/app-config.json')).json()).toEqual({ mode: 'cloud', googleClientId: 'test-client.apps.googleusercontent.com', devLogin: true })
    const live = await fetchWith(production, new Request('https://magnetar.codefusion.cc/app-config.json'))
    expect(await live.json()).toEqual({ mode: 'cloud', googleClientId: 'test-client.apps.googleusercontent.com' })
    const unconfigured = await fetchWith({ ...production, GOOGLE_CLIENT_ID: '' }, new Request('https://magnetar.codefusion.cc/app-config.json'))
    expect(await unconfigured.json()).toEqual({ mode: 'cloud' })
  })

  test('dev sign-in does not exist in production', async () => {
    const request = new Request('https://magnetar.codefusion.cc/api/auth/dev', {
      method: 'POST', headers: { origin: 'https://magnetar.codefusion.cc', 'content-type': 'application/json' }, body: '{"email":"a@example.com"}',
    })
    expect((await fetchWith(production, request)).status).toBe(404)
    expect((await fetchWith({ ...production, DEV_LOGIN: 'enabled' }, request)).status).toBe(404)
  })

  test('a session lasts until sign-out, and sign-out needs our own site', async () => {
    const user = await signIn()
    expect(await (await call('/api/me', { headers: user.headers })).json()).toMatchObject({ email: user.email })
    expect((await call('/api/auth/logout', { method: 'POST', headers: { cookie: user.headers.cookie! } })).status).toBe(403)
    expect((await call('/api/me', { headers: user.headers })).status).toBe(200)

    const out = await call('/api/auth/logout', { method: 'POST', headers: user.headers })
    expect(out.headers.get('set-cookie')).toMatch(/^__Host-md_session=; .*Max-Age=0/)
    expect((await call('/api/me', { headers: user.headers })).status).toBe(401)
  })

  test('a session used in its last fifteen days is renewed for thirty, in the browser as in the database', async () => {
    const user = await signIn()
    const day = 86_400_000
    const expiry = async () => (await env.DB.prepare('SELECT expires_at FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)').bind(user.email).first<{ expires_at: number }>())!.expires_at
    const setExpiry = (at: number) => env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').bind(at, user.email).run()

    // In its first half nothing changes.
    const fresh = await expiry()
    const early = await call('/api/me', { headers: user.headers })
    expect(early.status).toBe(200)
    expect(early.headers.get('set-cookie')).toBeNull()
    expect(await expiry()).toBe(fresh)

    // Other calls never move it: the cookie the browser holds would end before the session.
    const late = Date.now() + 10 * day
    await setExpiry(late)
    expect((await call('/api/devices', { headers: user.headers })).status).toBe(200)
    expect(await expiry()).toBe(late)

    // Loading the site renews both, with the same token.
    const before = Date.now()
    const renewed = await call('/api/me', { headers: user.headers })
    expect(renewed.status).toBe(200)
    expect(cookieValue(renewed, SESSION_COOKIE)).toBe(user.headers.cookie!.slice(SESSION_COOKIE.length + 1))
    expect(renewed.headers.get('set-cookie')).toMatch(/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/)
    expect(await expiry()).toBeGreaterThanOrEqual(before + 30 * day)
    expect(await expiry()).toBeLessThanOrEqual(Date.now() + 30 * day)
  })

  test('an expired session is signed out', async () => {
    const user = await signIn()
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').bind(Date.now() - 1, user.email).run()
    expect((await call('/api/me', { headers: user.headers })).status).toBe(401)
  })

  test("the desktop app's failure reports are checked and bounded before they reach the console", async () => {
    const reports: unknown[] = []
    const withConsole = { ...production, CONSOLE_TELEMETRY: { reportBrowserFailure: async (r: unknown) => void reports.push(r) } } as Env
    const report = (body: unknown) => fetchWith(withConsole, new Request('https://magnetar.codefusion.cc/api/telemetry/failure', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' }, body: JSON.stringify(body),
    }))

    expect((await report({ source: 'error', message: 'Boom', name: 'TypeError', stack: 's'.repeat(9000), page: 'Downloads!', version: '2.1.0' })).status).toBe(204)
    expect(reports).toEqual([expect.objectContaining({
      appId: 'magnetar', env: 'production', source: 'error', name: 'TypeError', message: 'Boom', stack: 's'.repeat(8000), page: 'other', version: '2.1.0',
    })])
    expect((await report({ source: 'console', message: 'x' })).status).toBe(400)
    expect((await report({ source: 'error' })).status).toBe(400)
    expect(reports).toHaveLength(1)
  })
})
