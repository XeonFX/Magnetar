import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import worker from '../src/index.ts'
import type { Env } from '../src/env.ts'
import { call, signIn } from './client.ts'

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

  test('app-config tells the page it is the cloud site, with dev sign-in only in development', async () => {
    expect(await (await call('/app-config.json')).json()).toEqual({ mode: 'cloud', devLogin: true })
    const live = await fetchWith(production, new Request('https://magnetar.codefusion.cc/app-config.json'))
    expect(await live.json()).toEqual({ mode: 'cloud' })
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
