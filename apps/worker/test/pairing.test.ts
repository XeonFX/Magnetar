import { base58ToBytes } from '@codefusion-cc/base58'
import { env } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import { handleDevices } from '../src/devices.ts'
import { ack, approve, call, connectDevice, deviceAuth, freshIp, insertDevice, listDevices, openSocket, ORIGIN, pairDevice, poll, signIn, startPairing, type User, userId } from './client.ts'

/** Whether `id` is `prefix` and then `bytes` random bytes in base58, as ids people see are. */
const isBase58Id = (id: string, prefix: string, bytes: number) => id.startsWith(prefix) && base58ToBytes(id.slice(prefix.length), bytes) !== null

/**
 * D1 whose first `count` batches (an approval's claim and new device) wait until all of them are ready, so racing
 * approvals really race. `waited` counts the batches held, so a reworded handler can't quietly stop the race.
 */
function batchesTogether(db: D1Database, count: number): { db: D1Database; waited: () => number } {
  const waiting: (() => void)[] = []
  const together = () => new Promise<void>(resolve => {
    waiting.push(resolve)
    if (waiting.length === count) waiting.forEach(release => release())
  })
  const racing = {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      if (waiting.length < count) await together()
      return db.batch(statements)
    },
  } as unknown as D1Database
  return { db: racing, waited: () => waiting.length }
}

/** The plaintext token the pairing still holds for its app, or null. */
const storedToken = async (pairingId: string) =>
  (await env.DB.prepare('SELECT device_token FROM pairings WHERE id = ?').bind(pairingId).first<{ device_token: string | null }>())!.device_token

describe('pairing', () => {
  test('the app starts, the signed-in user approves, and the app collects its token until it confirms it', async () => {
    const user = await signIn()
    const pairing = await startPairing({ name: 'Studio Mac', platform: 'macos', version: '2.1.0' })
    expect(isBase58Id(pairing.pairingId, '', 16)).toBe(true)
    expect(isBase58Id(await userId(user), 'u_', 12)).toBe(true)
    expect(await (await poll(pairing)).json()).toEqual({ state: 'pending' })

    const info = await call(`/api/pair/${pairing.pairingId}`, { headers: user.headers })
    // Shown as the address will spell it.
    expect(await info.json()).toMatchObject({ pairingId: pairing.pairingId, name: 'Studio-Mac', platform: 'macos', version: '2.1.0', state: 'pending' })

    const approved = await approve(user, pairing.pairingId)
    expect(approved.status).toBe(200)
    const { deviceId, deviceName } = await approved.json<{ deviceId: string; deviceName: string }>()
    expect(deviceName).toBe('Studio-Mac')
    expect(isBase58Id(deviceId, 'd_', 12)).toBe(true)

    const collected = await (await poll(pairing)).json<Record<string, string>>()
    expect(collected).toEqual({ state: 'approved', deviceId, deviceToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), deviceName: 'Studio-Mac', accountEmail: user.email })
    // The answer was lost on the way: the next poll gets the same one.
    expect(await (await poll(pairing)).json()).toEqual(collected)
    const confirmed = await ack(pairing)
    expect(confirmed.status).toBe(200)
    expect(await confirmed.json()).toEqual({ ok: true })
    // Confirmed: no poll gets it again, and confirming twice is no error.
    expect(await (await poll(pairing)).json()).toEqual({ state: 'expired' })
    expect((await ack(pairing)).status).toBe(200)

    // Stored only as a hash, and it works as the device's credential.
    const row = await env.DB.prepare('SELECT token_hash, device_token FROM devices d JOIN pairings p ON p.device_id = d.id WHERE d.id = ?').bind(deviceId).first<Record<string, string | null>>()
    expect(row!.device_token).toBeNull()
    expect(row!.token_hash).not.toContain(collected.deviceToken)
    const renamed = await call('/api/device', { method: 'PATCH', headers: deviceAuth({ deviceToken: collected.deviceToken! }), json: { name: 'Office' } })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toEqual({ ok: true, name: 'Office' })
    expect(await listDevices(user)).toEqual([expect.objectContaining({ id: deviceId, name: 'Office', platform: 'macos', online: false })])
  })

  test('two polls at once both get the one token', async () => {
    const user = await signIn()
    const pairing = await startPairing()
    expect((await approve(user, pairing.pairingId)).status).toBe(200)
    const [one, two] = await Promise.all([poll(pairing), poll(pairing)].map(async p => (await p).json<Record<string, string>>()))
    expect(one!.state).toBe('approved')
    expect(two).toEqual(one)
    expect((await call('/api/device', { method: 'PATCH', headers: deviceAuth({ deviceToken: one!.deviceToken! }), json: { name: 'Same' } })).status).toBe(200)
  })

  test('an app that never confirms gets its token until the handoff ends; then it leaves the database', async () => {
    // Apps from before /api/pair/ack poll until they get the token and never confirm it.
    const user = await signIn()
    const pairing = await startPairing()
    expect((await approve(user, pairing.pairingId)).status).toBe(200)
    const setExpiry = (at: number) => env.DB.prepare('UPDATE pairings SET expires_at = ? WHERE id = ?').bind(at, pairing.pairingId).run()

    // The pairing itself has ended, its handoff not yet: the app still collects.
    await setExpiry(Date.now() - 10 * 60_000 + 5_000)
    expect(await (await poll(pairing)).json()).toMatchObject({ state: 'approved' })
    expect(await storedToken(pairing.pairingId)).not.toBeNull()

    await setExpiry(Date.now() - 10 * 60_000 - 1)
    expect(await (await poll(pairing)).json()).toEqual({ state: 'expired' })
    expect(await storedToken(pairing.pairingId)).toBeNull()
  })

  test('an app that connects with its token without confirming it leaves no plaintext behind', async () => {
    // Apps from before /api/pair/ack never confirm; their first connection does.
    const user = await signIn()
    const pairing = await startPairing()
    expect((await approve(user, pairing.pairingId)).status).toBe(200)
    const collected = await (await poll(pairing)).json<{ deviceId: string; deviceToken: string }>()
    const socket = await openSocket(connectDevice(collected))
    expect(await storedToken(pairing.pairingId)).toBeNull()
    expect(await (await poll(pairing)).json()).toEqual({ state: 'expired' })
    socket.ws.close()
  })

  test('the token of a device removed before its app collected it is not handed over', async () => {
    const user = await signIn()
    const pairing = await startPairing()
    const { deviceId } = await (await approve(user, pairing.pairingId)).json<{ deviceId: string }>()
    expect((await call(`/api/devices/${deviceId}`, { method: 'DELETE', headers: user.headers })).status).toBe(200)
    expect(await (await poll(pairing)).json()).toEqual({ state: 'expired' })
    expect(await storedToken(pairing.pairingId)).toBeNull()
  })

  test('confirming needs the secret that started the pairing, and an approved pairing', async () => {
    const user = await signIn()
    const pairing = await startPairing()
    expect((await ack({ ...pairing, pollSecret: 'guessed' })).status).toBe(404)
    expect((await ack({ pairingId: 'nope', pollSecret: pairing.pollSecret })).status).toBe(404)
    const early = await ack(pairing)
    expect(early.status).toBe(409)
    expect(await early.json()).toEqual({ error: 'This pairing is not approved' })
    expect((await approve(user, pairing.pairingId)).status).toBe(200)
    // A wrong secret does not end the handoff.
    expect((await ack({ ...pairing, pollSecret: 'guessed' })).status).toBe(404)
    expect(await (await poll(pairing)).json()).toMatchObject({ state: 'approved' })
  })

  test('a device paired while ids were base64url keeps working', async () => {
    const user = await signIn()
    const legacyId = 'd_ZIZ0-ac6m_g2TvpD'
    await insertDevice(legacyId, await userId(user), 'Old Mac', Date.now())
    expect(await listDevices(user)).toEqual([expect.objectContaining({ id: legacyId, name: 'Old Mac' })])
    const connect = await call(`/api/devices/${legacyId}/connect`, { headers: { ...user.headers, upgrade: 'websocket' } })
    expect(connect.status).toBe(101)
    connect.webSocket!.accept()
    connect.webSocket!.close()
    expect((await call(`/api/devices/${legacyId}`, { method: 'DELETE', headers: user.headers })).status).toBe(200)
    expect(await listDevices(user)).toEqual([])
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
    const { db, waited } = batchesTogether(env.DB, 2)
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

  test('approving again from the browser that approved answers with the same device; anyone else hears it is taken', async () => {
    const user = await signIn()
    const pairing = await startPairing({ name: 'Studio Mac' })
    const first = await approve(user, pairing.pairingId)
    expect(first.status).toBe(200)
    const device = await first.json<{ deviceId: string; deviceName: string }>()
    // A retry after the answer got lost, or a second click.
    const again = await approve(user, pairing.pairingId)
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(device)
    expect(await listDevices(user)).toEqual([expect.objectContaining({ id: device.deviceId, name: 'Studio-Mac' })])

    // The same account in another browser, and another account.
    for (const someoneElse of [await signIn(user.email), await signIn()]) {
      const taken = await approve(someoneElse, pairing.pairingId)
      expect(taken.status).toBe(409)
      expect(await taken.json()).toEqual({ error: 'This device is already connected' })
    }
    // A device the person removed meanwhile is not brought back.
    expect((await call(`/api/devices/${device.deviceId}`, { method: 'DELETE', headers: user.headers })).status).toBe(200)
    expect((await approve(user, pairing.pairingId)).status).toBe(409)
    expect(await listDevices(user)).toEqual([])
  })

  test('two tabs of one browser approving at once both hear of the one device', async () => {
    const user = await signIn()
    const pairing = await startPairing()
    const { db, waited } = batchesTogether(env.DB, 2)
    const approveNow = () => handleDevices(
      new Request(`${ORIGIN}/api/pair/${pairing.pairingId}/approve`, { method: 'POST', headers: user.headers }),
      { ...env, DB: db }, `/api/pair/${pairing.pairingId}/approve`,
    )
    const results = await Promise.all([approveNow(), approveNow()])
    expect(waited()).toBe(2)
    expect(results.map(r => r!.status)).toEqual([200, 200])
    const [one, two] = await Promise.all(results.map(r => r!.json<{ deviceId: string }>()))
    expect(two).toEqual(one)
    expect(await listDevices(user)).toEqual([expect.objectContaining({ id: one!.deviceId })])
  })

  test('a device whose app never collected its token stays on the account until the person removes it', async () => {
    const user = await signIn()
    const pairing = await startPairing()
    const { deviceId } = await (await approve(user, pairing.pairingId)).json<{ deviceId: string }>()
    // Long past the handoff, and after another pairing's start has swept the old ones out.
    await env.DB.prepare('UPDATE pairings SET expires_at = ? WHERE id = ?').bind(Date.now() - 365 * 86_400_000, pairing.pairingId).run()
    await startPairing()
    expect(await env.DB.prepare('SELECT id FROM pairings WHERE id = ?').bind(pairing.pairingId).first()).toBeNull()
    expect(await listDevices(user)).toEqual([expect.objectContaining({ id: deviceId, online: false })])

    expect((await call(`/api/devices/${deviceId}`, { method: 'DELETE', headers: user.headers })).status).toBe(200)
    expect(await listDevices(user)).toEqual([])
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

  test('two approvals racing for the last free place make one device; the other pairing waits for a free one', async () => {
    const user = await signIn()
    const owner = await userId(user)
    const tag = crypto.randomUUID().slice(0, 8)
    for (let i = 0; i < 19; i++) await insertDevice(`d_${tag}${i}`, owner, `Device-${i}`, i)
    const pairings = await Promise.all([startPairing({ name: 'Left' }), startPairing({ name: 'Right' })])
    // Both approvals have counted 19 devices before either stores its own.
    const { db, waited } = batchesTogether(env.DB, 2)
    const results = await Promise.all(pairings.map(p => handleDevices(
      new Request(`${ORIGIN}/api/pair/${p.pairingId}/approve`, { method: 'POST', headers: user.headers }),
      { ...env, DB: db }, `/api/pair/${p.pairingId}/approve`,
    )))
    expect(waited()).toBe(2)
    expect(results.map(r => r!.status).sort()).toEqual([200, 409])
    const lost = results.findIndex(r => r!.status === 409)
    expect(await results[lost]!.json()).toEqual({ error: 'Remove a device before adding another' })
    expect(await listDevices(user)).toHaveLength(20)

    // The pairing that lost is still pending, and goes through once a device is removed.
    const waiting = pairings[lost]!
    expect(await (await call(`/api/pair/${waiting.pairingId}`, { headers: user.headers })).json()).toMatchObject({ state: 'pending' })
    expect(await (await poll(waiting)).json()).toEqual({ state: 'pending' })
    expect((await call(`/api/devices/d_${tag}0`, { method: 'DELETE', headers: user.headers })).status).toBe(200)
    expect((await approve(user, waiting.pairingId)).status).toBe(200)
    expect(await (await poll(waiting)).json()).toMatchObject({ state: 'approved' })
    expect(await listDevices(user)).toHaveLength(20)
  })

  test('names and versions from the app are cleaned and bounded', async () => {
    const user = await signIn()
    const long = await pairDevice(user, { name: `  Łódź\u0000\u0007 ${'m'.repeat(100)}  `, platform: 'x'.repeat(50), version: 42 })
    const blank = await pairDevice(user, { name: '\u0001 \t ', platform: '', version: null })
    const list = await listDevices(user)
    const byId = Object.fromEntries(list.map(d => [d.id, d]))
    expect(byId[long.deviceId]).toMatchObject({ name: `Lodz-${'m'.repeat(35)}`, platform: 'x'.repeat(20), version: 'unknown' })
    expect(byId[blank.deviceId]).toMatchObject({ name: 'Magnetar', platform: 'unknown', version: 'unknown' })
  })

  test('a name already on the account gets the next free number, in any case', async () => {
    const user = await signIn()
    const first = await pairDevice(user, { name: 'MacBook-Pro' })
    const second = await startPairing({ name: 'macbook pro' })
    const approved = await approve(user, second.pairingId)
    expect(await approved.json()).toMatchObject({ deviceName: 'macbook-pro-2' })
    expect(await (await poll(second)).json()).toMatchObject({ state: 'approved', deviceName: 'macbook-pro-2' })
    // Another account may use the same name.
    const other = await signIn()
    const theirs = await startPairing({ name: 'MacBook-Pro' })
    expect(await (await approve(other, theirs.pairingId)).json()).toMatchObject({ deviceName: 'MacBook-Pro' })
    expect((await listDevices(user)).map(d => [d.id, d.name])).toEqual([[first.deviceId, 'MacBook-Pro'], [expect.any(String), 'macbook-pro-2']])
  })

  test('two devices with one name approved at once both get in, under different names', async () => {
    const user = await signIn()
    const pairings = await Promise.all([startPairing({ name: 'Twin' }), startPairing({ name: 'Twin' })])
    // Both approvals pick their name before either is stored, so the second store hits the unique name.
    const { db, waited } = batchesTogether(env.DB, 2)
    const results = await Promise.all(pairings.map(p => handleDevices(
      new Request(`${ORIGIN}/api/pair/${p.pairingId}/approve`, { method: 'POST', headers: user.headers }),
      { ...env, DB: db }, `/api/pair/${p.pairingId}/approve`,
    )))
    expect(waited()).toBeGreaterThanOrEqual(2)
    expect(results.map(r => r!.status)).toEqual([200, 200])
    const names = await Promise.all(results.map(async r => (await r!.json<{ deviceName: string }>()).deviceName))
    expect(names.sort()).toEqual(['Twin', 'Twin-2'])
    expect((await listDevices(user)).map(d => d.name).sort()).toEqual(['Twin', 'Twin-2'])
    for (const p of pairings) expect(await (await poll(p)).json()).toMatchObject({ state: 'approved' })
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

  test('the app renaming itself gets an address-safe name no other device of the account has', async () => {
    const user = await signIn()
    const [desk, laptop] = [await pairDevice(user, { name: 'Desk' }), await pairDevice(user, { name: 'Laptop' })]
    const rename = (device: typeof desk, name: string) => call('/api/device', { method: 'PATCH', headers: deviceAuth(device), json: { name } })

    const spelled = await rename(laptop, "Paweł's Laptop")
    expect(await spelled.json()).toEqual({ ok: true, name: 'Pawels-Laptop' })
    const taken = await rename(laptop, 'desk')
    expect(taken.status).toBe(409)
    expect(await taken.json()).toEqual({ error: 'Another device on this account is already called desk' })
    // Its own name in another case is no clash.
    expect(await (await rename(desk, 'DESK')).json()).toEqual({ ok: true, name: 'DESK' })
    expect((await listDevices(user)).map(d => d.name).sort()).toEqual(['DESK', 'Pawels-Laptop'])
    // A device of another account may have it.
    const other = await pairDevice(await signIn(), { name: 'x' })
    expect(await (await rename(other, 'DESK')).json()).toEqual({ ok: true, name: 'DESK' })
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
