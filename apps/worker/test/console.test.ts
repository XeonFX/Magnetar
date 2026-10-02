import { consoleAdminErrors, type Actor, type AppAdmin } from '@codefusion-cc/console/worker'
import { RELAY_CLOSE } from '@magnetar/protocol/relay'
import { createExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import worker from '../src/index.ts'
import { consoleResources } from '../src/console/admin.ts'
import { manifest } from '../src/console/manifest.ts'
import type { Env } from '../src/env.ts'
import { call, connectBrowser, connectDevice, eventually, listDevices, openSocket, ORIGIN, pairDevice, signIn, userId } from './client.ts'

/** CodeFusion Console reaches the Worker the way these tests do: its ConsoleAdmin entrypoint, over a service binding. */
const admin = exports.ConsoleAdmin as unknown as AppAdmin

const member = (permissions: Actor['permissions']): Actor => ({ memberId: `m-${permissions.length}`, email: 'staff@example.com', role: 'admin', permissions })
const OWNER = member(['records:read', 'records:moderate', 'records:manage', 'pii:read'])
const MODERATOR = member(['records:read', 'records:moderate'])
const READER = member(['records:read'])

const run = (resource: string, action: string, ids: string[], actor: Actor, reason?: string) =>
  admin.runAction({ resource, action, ids, input: {}, reason, actor })

describe('the console manifest', () => {
  test('declares only what has a handler, and every handler is declared', () => {
    expect(consoleAdminErrors({ manifest, resources: consoleResources })).toEqual([])
  })

  test('is what the console is given', async () => {
    expect(await admin.manifest()).toEqual(manifest)
  })
})

describe('accounts in the console', () => {
  test('are found by email only by members who may read personal data, and by id by anyone', async () => {
    const user = await signIn()
    const id = await userId(user)

    const byEmail = await admin.list('accounts', { search: user.email, limit: 25 }, OWNER)
    expect(byEmail.items).toEqual([expect.objectContaining({ id, email: user.email, devices: 0, sessions: 1 })])
    expect(byEmail.total).toBe(1)
    expect(Date.parse(String(byEmail.items[0]!.last_login_at))).toBeGreaterThan(Date.now() - 60_000)

    expect((await admin.list('accounts', { search: user.email, limit: 25 }, MODERATOR)).items).toEqual([])
    expect((await admin.list('accounts', { search: id, limit: 25 }, MODERATOR)).items.map(a => a.id)).toEqual([id])
  })

  test('a search with LIKE wildcards matches them literally', async () => {
    await signIn()
    expect((await admin.list('accounts', { search: '%', limit: 25 }, OWNER)).items).toEqual([])
    // Emails here start "user1.", which "user_" would match as a pattern.
    expect((await admin.list('accounts', { search: 'user_', limit: 25 }, OWNER)).items).toEqual([])
  })

  test('page through every account once, with the total, whatever the page size asked for', async () => {
    await Promise.all([signIn(), signIn(), signIn()])
    const all = await admin.list('accounts', { limit: 1000 }, OWNER)
    expect(all.items.length).toBe(all.total)
    expect(all.items.length).toBeLessThanOrEqual(100)

    const seen: unknown[] = []
    let cursor: string | undefined
    do {
      const page = await admin.list('accounts', { limit: 2, cursor, sort: { key: 'created_at', dir: 'asc' } }, OWNER)
      expect(page.items.length).toBeLessThanOrEqual(2)
      seen.push(...page.items.map(a => a.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(new Set(seen).size).toBe(all.total)
    expect(seen).toHaveLength(all.total!)
  })

  test('an unknown account is null', async () => {
    expect(await admin.get('accounts', 'u_nobody', OWNER)).toBeNull()
  })

  test('signing out everywhere ends every browser session, closes its open dashboards and keeps the devices', async () => {
    const user = await signIn()
    const device = await pairDevice(user)
    const app = await openSocket(connectDevice(device))
    const page = await openSocket(connectBrowser(user, device.deviceId))
    expect(await page.nextJson()).toEqual({ t: 'device', online: true })
    const { c: connection } = await app.nextJson<{ c: string }>()
    expect((await run('accounts', 'sign-out', [await userId(user)], MODERATOR)).ok).toBe(true)

    expect((await call('/api/me', { headers: user.headers })).status).toBe(401)
    // The dashboard that was already open stops controlling the device; the device is told and stays connected.
    expect(await page.closed).toMatchObject({ code: RELAY_CLOSE.signedOut })
    expect(await app.nextJson()).toEqual({ t: 'close', c: connection })
    expect((await openSocket(connectBrowser(user, device.deviceId)).catch((e: Error) => e.message))).toMatch(/401/)
    const left = await env.DB.prepare('SELECT id FROM devices WHERE id = ?').bind(device.deviceId).first()
    expect(left).not.toBeNull()
    expect((await run('accounts', 'sign-out', [await userId(user)], READER))).toEqual({ ok: false, message: 'Not allowed' })
  })

  test('deleting one needs records:manage and a reason, and disconnects its devices for good', async () => {
    const user = await signIn()
    const id = await userId(user)
    const device = await pairDevice(user)
    const app = await openSocket(connectDevice(device))

    expect(await run('accounts', 'delete', [id], MODERATOR, 'spam')).toEqual({ ok: false, message: 'Not allowed' })
    expect(await run('accounts', 'delete', [id], OWNER)).toEqual({ ok: false, message: 'Give a reason' })
    expect(await run('accounts', 'delete', [id], OWNER, 'Asked to be forgotten')).toEqual({ ok: true, message: 'Deleted the account and 1 device' })

    expect(await app.closed).toMatchObject({ code: RELAY_CLOSE.deviceRemoved })
    expect(await admin.get('accounts', id, OWNER)).toBeNull()
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(id).first('n')).toBe(0)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?').bind(id).first('n')).toBe(0)
    expect(await run('accounts', 'delete', [id], OWNER, 'again')).toEqual({ ok: false, message: 'No such account' })
  })
})

describe('devices in the console', () => {
  test('show their owner, state and dates, and filter by online', async () => {
    const user = await signIn()
    const online = await pairDevice(user, { name: 'Studio Mac', platform: 'macos', version: '1.0.0' })
    const offline = await pairDevice(user, { name: 'Old PC', platform: 'windows', version: '0.9.0' })
    const app = await openSocket(connectDevice(online))
    await eventually(async () => expect(await admin.get('devices', online.deviceId, OWNER)).toMatchObject({ online: true }))

    const record = await admin.get('devices', online.deviceId, OWNER)
    expect(record).toMatchObject({ id: online.deviceId, name: 'Studio-Mac', platform: 'macos', version: '1.0.0', online: true, account: await userId(user) })
    expect(Date.parse(String(record!.created_at))).toBeGreaterThan(Date.now() - 60_000)

    const onlineIds = (await admin.list('devices', { filters: { online: 'yes' }, limit: 100 }, OWNER)).items.map(d => d.id)
    const offlineIds = (await admin.list('devices', { filters: { online: 'no' }, limit: 100 }, OWNER)).items.map(d => d.id)
    expect(onlineIds).toContain(online.deviceId)
    expect(onlineIds).not.toContain(offline.deviceId)
    expect(offlineIds).toContain(offline.deviceId)
    expect(offlineIds).not.toContain(online.deviceId)
    // An unknown filter value is ignored rather than matching nothing.
    expect((await admin.list('devices', { filters: { online: 'maybe' }, limit: 100 }, OWNER)).items.map(d => d.id)).toEqual(expect.arrayContaining([online.deviceId, offline.deviceId]))
    app.ws.close()
  })

  test('are found by name only by members who may read personal data', async () => {
    const user = await signIn()
    const name = `Desk-${crypto.randomUUID().slice(0, 8)}`
    const device = await pairDevice(user, { name })
    expect((await admin.list('devices', { search: name, limit: 25 }, OWNER)).items.map(d => d.id)).toEqual([device.deviceId])
    expect((await admin.list('devices', { search: name, limit: 25 }, MODERATOR)).items).toEqual([])
  })

  test('removing some, with a reason, disconnects the app and its dashboards as its owner removing it would', async () => {
    const user = await signIn()
    const first = await pairDevice(user)
    const second = await pairDevice(user)
    const app = await openSocket(connectDevice(first))
    const dashboard = await openSocket(connectBrowser(user, first.deviceId))

    expect(await run('devices', 'remove', [first.deviceId, second.deviceId], MODERATOR)).toEqual({ ok: false, message: 'Give a reason' })
    expect(await run('devices', 'remove', [first.deviceId, second.deviceId], MODERATOR, 'Stolen laptop')).toEqual({ ok: true, message: 'Removed 2 devices' })

    expect(await app.closed).toMatchObject({ code: RELAY_CLOSE.deviceRemoved })
    expect(await dashboard.closed).toMatchObject({ code: RELAY_CLOSE.notOnAccount })
    expect(await listDevices(user)).toEqual([])
    expect(await run('devices', 'remove', [first.deviceId], MODERATOR, 'again')).toEqual({ ok: false, message: 'Already removed' })
  })
})

describe("the website's console routes", () => {
  const production = { ...env, APP_ENV: 'production', ORIGIN: 'https://magnetar.codefusion.cc' } as Env
  const failure = (origin: string, page: string) => new Request('https://magnetar.codefusion.cc/api/browser-failures', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin, 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/140.0' },
    body: JSON.stringify({ source: 'error', name: 'TypeError', message: 'x is undefined', stack: null, page, version: '1.0.0' }),
  })

  test("take failures from the site's own pages only, filed under a known page name", async () => {
    const reports: Record<string, unknown>[] = []
    const withConsole = { ...production, CONSOLE_TELEMETRY: { reportBrowserFailure: async (r: Record<string, unknown>) => void reports.push(r) } } as unknown as Env
    const send = async (request: Request) => {
      return worker.fetch(request as Parameters<typeof worker.fetch>[0], withConsole, createExecutionContext())
    }

    expect((await send(failure('https://magnetar.codefusion.cc', 'device-search'))).status).toBe(204)
    expect((await send(failure('https://evil.example', 'device-search'))).status).toBe(204)
    expect((await send(failure('https://magnetar.codefusion.cc', 'a-page-we-do-not-have'))).status).toBe(204)
    await expect.poll(() => reports.length).toBe(2)
    expect(reports.map(r => [r.appId, r.page, r.message])).toEqual([
      ['magnetar', 'device-search', 'x is undefined'],
      ['magnetar', 'other', 'x is undefined'],
    ])
  })

  test('refuse to serve the build\'s private source maps', async () => {
    const response = await call('/_console/source-maps/index.js.map')
    expect(response.status).toBe(404)
  })

  test('leave every other route to the Worker', async () => {
    expect(await (await call('/app-config.json', { headers: { origin: ORIGIN } })).json()).toMatchObject({ mode: 'cloud' })
  })
})
