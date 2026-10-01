import { env } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import { handleDevices } from '../src/devices.ts'
import { approve, call, deviceAuth, freshIp, listDevices, ORIGIN, pairDevice, poll, signIn, startPairing, type User } from './client.ts'

/**
 * D1 whose pairing claims wait until `count` of them are ready, so racing approvals really race.
 * `waited` counts the claims held, so a reworded query can't quietly stop the race.
 */
function claimsTogether(db: D1Database, count: number): { db: D1Database; waited: () => number } {
  const waiting: (() => void)[] = []
  const together = () => new Promise<void>(resolve => {
    waiting.push(resolve)
    if (waiting.length === count) waiting.forEach(release => release())
  })
  const racing = {
    prepare(sql: string) {
      const statement = db.prepare(sql)
      if (!sql.startsWith('UPDATE pairings SET approved_by')) return statement
      return { bind: (...values: unknown[]) => ({ run: async () => (await together(), statement.bind(...values).run()) }) }
    },
  } as unknown as D1Database
  return { db: racing, waited: () => waiting.length }
}

describe('pairing', () => {
  test('the app starts, the signed-in user approves, and the app collects its token once', async () => {
    const user = await signIn()
    const pairing = await startPairing({ name: 'Studio Mac', platform: 'macos', version: '2.1.0' })
    expect(pairing.pairingId).toMatch(/^[A-Za-z0-9_-]{10,40}$/)
    expect(await (await poll(pairing)).json()).toEqual({ state: 'pending' })

    const info = await call(`/api/pair/${pairing.pairingId}`, { headers: user.headers })
    expect(await info.json()).toMatchObject({ pairingId: pairing.pairingId, name: 'Studio Mac', platform: 'macos', version: '2.1.0', state: 'pending' })

    const approved = await approve(user, pairing.pairingId)
    expect(approved.status).toBe(200)
    const { deviceId } = await approved.json<{ deviceId: string }>()

    const collected = await (await poll(pairing)).json<Record<string, string>>()
    expect(collected).toMatchObject({ state: 'approved', deviceId, accountEmail: user.email })
    expect(collected.deviceToken).toMatch(/^[A-Za-z0-9_-]{20,100}$/)
    // Handed over exactly once: a second poll, by anyone holding the secret, gets nothing.
    expect(await (await poll(pairing)).json()).toEqual({ state: 'expired' })

    // Stored only as a hash, and it works as the device's credential.
    const row = await env.DB.prepare('SELECT token_hash, device_token FROM devices d JOIN pairings p ON p.device_id = d.id WHERE d.id = ?').bind(deviceId).first<Record<string, string | null>>()
    expect(row!.device_token).toBeNull()
    expect(row!.token_hash).not.toContain(collected.deviceToken)
    const renamed = await call('/api/device', { method: 'PATCH', headers: deviceAuth({ deviceToken: collected.deviceToken! }), json: { name: 'Office' } })
    expect(renamed.status).toBe(200)
    expect(await listDevices(user)).toEqual([expect.objectContaining({ id: deviceId, name: 'Office', platform: 'macos', online: false })])
  })

  test('polling needs the secret that started the pairing', async () => {
    const pairing = await startPairing()
    expect((await poll({ ...pairing, pollSecret: 'guessed' })).status).toBe(404)
    expect((await poll({ pairingId: 'nope', pollSecret: pairing.pollSecret })).status).toBe(404)
    expect((await call('/api/pair/poll', { method: 'POST', json: {} })).status).toBe(404)
  })

  test('approving needs a signed-in user on our own site', async () => {
    const user = await signIn()
    const { pairingId } = await startPairing()
    expect((await call(`/api/pair/${pairingId}/approve`, { method: 'POST', headers: { origin: ORIGIN } })).status).toBe(401)
    expect((await call(`/api/pair/${pairingId}/approve`, { method: 'POST', headers: { cookie: user.headers.cookie! } })).status).toBe(403)
    expect((await call(`/api/pair/${pairingId}/approve`, { method: 'POST', headers: { ...user.headers, origin: 'https://evil.example' } })).status).toBe(403)
    expect((await call(`/api/pair/${pairingId}`, { headers: user.headers })).status).toBe(200)
    expect((await call(`/api/pair/${pairingId}`, {})).status).toBe(401)
    expect(await listDevices(user)).toEqual([])
  })

  test('two tabs approving at once make one device, and the second hears it is taken', async () => {
    const [first, second] = await Promise.all([signIn(), signIn()])
    const pairing = await startPairing()
    // Both approvals have read the pairing as pending before either claims it.
    const { db, waited } = claimsTogether(env.DB, 2)
    const approveNow = (user: User) => handleDevices(
      new Request(`${ORIGIN}/api/pair/${pairing.pairingId}/approve`, { method: 'POST', headers: user.headers }),
      { ...env, DB: db }, `/api/pair/${pairing.pairingId}/approve`,
    )
    const results = await Promise.all([approveNow(first), approveNow(second)])
    expect(waited()).toBe(2)
    expect(results.map(r => r!.status).sort()).toEqual([200, 409])
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id IN (SELECT id FROM users WHERE email IN (?, ?))').bind(first.email, second.email).first<{ n: number }>()
    expect(count!.n).toBe(1)
  })

  test('an expired pairing cannot be approved or collected', async () => {
    const user = await signIn()
    const pairing = await startPairing()
    await env.DB.prepare('UPDATE pairings SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, pairing.pairingId).run()
    expect(await (await call(`/api/pair/${pairing.pairingId}`, { headers: user.headers })).json()).toMatchObject({ state: 'expired' })
    const approved = await approve(user, pairing.pairingId)
    expect(approved.status).toBe(409)
    expect(await approved.json()).toEqual({ error: 'This pairing link has expired' })
    expect(await (await poll(pairing)).json()).toEqual({ state: 'expired' })
  })

  test('an approved pairing link cannot be approved again, not even by its owner', async () => {
    const user = await signIn()
    const pairing = await startPairing()
    expect((await approve(user, pairing.pairingId)).status).toBe(200)
    const again = await approve(user, pairing.pairingId)
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'This device is already connected' })
  })

  test('an account holds twenty devices; the twenty-first waits for one to be removed', async () => {
    const user = await signIn()
    const paired = await Promise.all(Array.from({ length: 20 }, () => pairDevice(user)))
    const pairing = await startPairing()
    const refused = await approve(user, pairing.pairingId)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'Remove a device before adding another' })

    expect((await call(`/api/devices/${paired[0]!.deviceId}`, { method: 'DELETE', headers: user.headers })).status).toBe(200)
    expect((await approve(user, pairing.pairingId)).status).toBe(200)
    expect(await listDevices(user)).toHaveLength(20)
  })

  test('names and versions from the app are cleaned and bounded', async () => {
    const user = await signIn()
    const long = await pairDevice(user, { name: `  Łódź\u0000\u0007 ${'m'.repeat(100)}  `, platform: 'x'.repeat(50), version: 42 })
    const blank = await pairDevice(user, { name: '\u0001 \t ', platform: '', version: null })
    const list = await listDevices(user)
    const byId = Object.fromEntries(list.map(d => [d.id, d]))
    expect(byId[long.deviceId]).toMatchObject({ name: `Łódź ${'m'.repeat(55)}`, platform: 'x'.repeat(20), version: 'unknown' })
    expect(byId[blank.deviceId]).toMatchObject({ name: 'Magnetar', platform: 'unknown', version: 'unknown' })
  })

  test('starting pairings is rate limited per address', async () => {
    // The dev environment allows 100 a minute: all of them at once pass, the next one doesn't.
    // Local rate limits count per wall-clock minute, so a burst that runs into the next minute is
    // sent again from a new address; starting just after the turnover, the retry has the minute to itself.
    const minute = () => Math.floor(Date.now() / 60_000)
    async function burst() {
      const ip = freshIp()
      const start = async () => (await call('/api/pair/start', { method: 'POST', headers: { 'cf-connecting-ip': ip }, json: {} })).status
      const started = minute()
      const statuses = await Promise.all(Array.from({ length: 100 }, start))
      const extra = await start()
      return minute() === started ? { statuses, extra } : null
    }
    const { statuses, extra } = await burst() ?? await burst() ?? expect.unreachable('Both bursts ran into the next minute')
    expect(statuses.filter(s => s === 200)).toHaveLength(100)
    expect(extra).toBe(429)
    // Another address still gets through.
    await startPairing()
  })

  test('refuses bodies that are not JSON, or too big', async () => {
    expect((await call('/api/pair/start', { method: 'POST', body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415)
    expect((await call('/api/pair/start', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } })).status).toBe(400)
    expect((await call('/api/pair/start', { method: 'POST', json: { name: 'x'.repeat(17_000) } })).status).toBe(413)
  })
})

describe('devices on an account', () => {
  test('another account cannot see, remove or reach them', async () => {
    const [owner, stranger] = await Promise.all([signIn(), signIn()])
    const { deviceId } = await pairDevice(owner)
    expect(await listDevices(stranger)).toEqual([])
    expect((await call(`/api/devices/${deviceId}`, { method: 'DELETE', headers: stranger.headers })).status).toBe(404)
    expect(await listDevices(owner)).toHaveLength(1)
  })

  test('removing one needs our own site', async () => {
    const user = await signIn()
    const { deviceId } = await pairDevice(user)
    expect((await call(`/api/devices/${deviceId}`, { method: 'DELETE', headers: { cookie: user.headers.cookie! } })).status).toBe(403)
    expect(await listDevices(user)).toHaveLength(1)
  })

  test('the app renaming itself needs a non-empty name', async () => {
    const user = await signIn()
    const device = await pairDevice(user)
    const auth = deviceAuth(device)
    expect((await call('/api/device', { method: 'PATCH', headers: auth, json: { name: ' \u0000 ' } })).status).toBe(400)
    expect((await call('/api/device', { method: 'PATCH', headers: deviceAuth({ deviceToken: 'nope' }), json: { name: 'x' } })).status).toBe(401)
    expect((await call('/api/device', { method: 'PUT', headers: auth })).status).toBe(405)
  })
})
