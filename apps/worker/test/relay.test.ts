import { env } from 'cloudflare:workers'
import { CONNECTION_ID_BYTES, MAX_SEALED_FRAME, RELAY_CLOSE, RELAY_PING, RELAY_PONG, unwrapFromDevice, wrapForDevice } from '@magnetar/protocol/relay'
import { describe, expect, test } from 'vitest'
import { call, connectBrowser, connectDevice, deviceAuth, eventually, listDevices, openSocket, pairDevice, settle, signIn, type Device, type Socket, type User } from './client.ts'

const deviceRow = (id: string) =>
  env.DB.prepare('SELECT online, last_seen_at, version FROM devices WHERE id = ?').bind(id).first<{ online: number; last_seen_at: number | null; version: string }>()

/** A paired device with its app connected to the relay. */
async function onlineDevice(): Promise<{ user: User; device: Device; app: Socket }> {
  const user = await signIn()
  const device = await pairDevice(user)
  const app = await openSocket(connectDevice(device))
  return { user, device, app }
}

/** Opens a dashboard on the device and takes the connection id the app is told about. */
async function openDashboard(user: User, device: Device, app: Socket): Promise<{ page: Socket; connectionId: string }> {
  const page = await openSocket(connectBrowser(user, device.deviceId))
  expect(await page.nextJson()).toEqual({ t: 'device', online: true })
  const open = await app.nextJson<{ t: string; c: string }>()
  expect(open.t).toBe('open')
  return { page, connectionId: open.c }
}

const bytes = (...values: number[]) => new Uint8Array(values)

describe('the relay', () => {
  test('marks the device online in the device list while its app is connected', async () => {
    const { user, device, app } = await onlineDevice()
    expect((await deviceRow(device.deviceId))!.online).toBe(1)
    expect((await listDevices(user))[0]!.online).toBe(true)

    const before = Date.now()
    app.ws.close(1000, 'Quit')
    await eventually(async () => {
      const row = await deviceRow(device.deviceId)
      expect(row!.online).toBe(0)
      expect(row!.last_seen_at).toBeGreaterThanOrEqual(before)
    })
  })

  test('passes dashboard frames to the app byte for byte, tagged with the connection', async () => {
    const { user, device, app } = await onlineDevice()
    const { page, connectionId } = await openDashboard(user, device, app)
    const payload = crypto.getRandomValues(new Uint8Array(4096))
    page.ws.send(payload)
    const frame = unwrapFromDevice(await app.next() as Uint8Array)
    expect(frame.connectionId).toBe(connectionId)
    expect([...frame.payload]).toEqual([...payload])
  })

  test('sends each app frame only to the dashboard it is addressed to', async () => {
    const { user, device, app } = await onlineDevice()
    const one = await openDashboard(user, device, app)
    const two = await openDashboard(user, device, app)
    expect(one.connectionId).not.toBe(two.connectionId)

    app.ws.send(wrapForDevice(two.connectionId, bytes(1, 2, 3)))
    app.ws.send(wrapForDevice(one.connectionId, bytes(9)))
    expect([...(await two.page.next() as Uint8Array)]).toEqual([1, 2, 3])
    expect([...(await one.page.next() as Uint8Array)]).toEqual([9])
    await settle()
    expect(one.page.pending()).toEqual([])
    expect(two.page.pending()).toEqual([])
  })

  test('drops what it cannot forward instead of guessing', async () => {
    const { user, device, app } = await onlineDevice()
    const { page } = await openDashboard(user, device, app)
    page.ws.send('{"t":"hello"}')
    app.ws.send(bytes(1, 2, 3))
    app.ws.send(wrapForDevice('A'.repeat(22), bytes(7)))
    app.ws.send('not json')
    await settle()
    expect(app.pending()).toEqual([])
    expect(page.pending()).toEqual([])
    // Both ends still work.
    page.ws.send(bytes(5))
    expect((await app.next() as Uint8Array).at(-1)).toBe(5)
  })

  test('closes a sender whose frame is over the limit', async () => {
    const { user, device, app } = await onlineDevice()
    const { page, connectionId } = await openDashboard(user, device, app)
    page.ws.send(new Uint8Array(MAX_SEALED_FRAME + 1))
    expect((await page.closed).code).toBe(1009)
    expect(await app.nextJson()).toEqual({ t: 'close', c: connectionId })
    // The largest frame allowed still goes through.
    const second = await openDashboard(user, device, app)
    second.page.ws.send(new Uint8Array(MAX_SEALED_FRAME))
    expect((await app.next() as Uint8Array).length).toBe(MAX_SEALED_FRAME + CONNECTION_ID_BYTES)
  })

  test('tells the app when a dashboard leaves, and closes one the app drops', async () => {
    const { user, device, app } = await onlineDevice()
    const one = await openDashboard(user, device, app)
    const two = await openDashboard(user, device, app)

    one.page.ws.close(1000, 'Tab closed')
    expect(await app.nextJson()).toEqual({ t: 'close', c: one.connectionId })

    app.ws.send(JSON.stringify({ t: 'close', c: two.connectionId }))
    expect(await two.page.closed).toEqual({ code: RELAY_CLOSE.closedByDevice, reason: 'Closed by the device' })
  })

  test('a dashboard opened while the app is away hears when it comes back', async () => {
    const user = await signIn()
    const device = await pairDevice(user)
    const page = await openSocket(connectBrowser(user, device.deviceId))
    expect(await page.nextJson()).toEqual({ t: 'device', online: false })

    const app = await openSocket(connectDevice(device))
    expect(await page.nextJson()).toEqual({ t: 'device', online: true })
    expect(await app.nextJson()).toMatchObject({ t: 'open' })

    app.ws.close(1000, 'Quit')
    expect(await page.nextJson()).toEqual({ t: 'device', online: false })
  })

  test('a reconnecting app replaces its old connection and keeps its dashboards', async () => {
    const { user, device, app } = await onlineDevice()
    const { page, connectionId } = await openDashboard(user, device, app)

    const newer = await openSocket(connectDevice(device))
    expect((await app.closed).code).toBe(RELAY_CLOSE.replaced)
    expect(await newer.nextJson()).toEqual({ t: 'open', c: connectionId })
    expect(await page.nextJson()).toEqual({ t: 'device', online: true })
    await settle()
    // The replaced connection closing does not mark the device offline.
    expect((await deviceRow(device.deviceId))!.online).toBe(1)
    expect(page.pending()).toEqual([])

    page.ws.send(bytes(4))
    expect((await newer.next() as Uint8Array).at(-1)).toBe(4)
  })

  test('records the version the app says hello with, bounded', async () => {
    const { device, app } = await onlineDevice()
    app.ws.send(JSON.stringify({ t: 'hello', version: `2.2.0-${'x'.repeat(100)}`, name: 'Studio' }))
    await eventually(async () => expect((await deviceRow(device.deviceId))!.version).toBe(`2.2.0-${'x'.repeat(34)}`))
    // A version that is not text is ignored.
    app.ws.send(JSON.stringify({ t: 'hello', version: 3 }))
    await settle()
    expect((await deviceRow(device.deviceId))!.version).toBe(`2.2.0-${'x'.repeat(34)}`)
  })

  test("tells an app saying hello with another name the account's name for it", async () => {
    const { device, app } = await onlineDevice()
    app.ws.send(JSON.stringify({ t: 'hello', version: '2.2.0', name: 'Studio-Mac' }))
    await eventually(async () => expect((await deviceRow(device.deviceId))!.version).toBe('2.2.0'))
    await settle()
    expect(app.pending()).toEqual([])
    // Named before names were addresses, or renamed by the account since.
    app.ws.send(JSON.stringify({ t: 'hello', version: '2.2.0', name: 'Studio Mac' }))
    expect(await app.nextJson()).toEqual({ t: 'name', name: 'Studio-Mac' })
  })

  test('answers keepalive pings', async () => {
    const { user, device, app } = await onlineDevice()
    app.ws.send(RELAY_PING)
    expect(await app.next()).toBe(RELAY_PONG)
    const { page } = await openDashboard(user, device, app)
    page.ws.send(RELAY_PING)
    expect(await page.next()).toBe(RELAY_PONG)
  })

  test('holds sixteen dashboards per device', async () => {
    const { user, device, app } = await onlineDevice()
    for (let i = 0; i < 16; i++) await openDashboard(user, device, app)
    const refused = await connectBrowser(user, device.deviceId)
    expect(refused.status).toBe(429)
  })
})

describe('reaching a device', () => {
  test('a dashboard needs a signed-in owner on our own site', async () => {
    const { device } = await onlineDevice()
    const stranger = await signIn()
    const notOurs = await openSocket(connectBrowser(stranger, device.deviceId))
    expect(await notOurs.closed).toEqual({ code: RELAY_CLOSE.notOnAccount, reason: 'Device not on this account' })

    const owner = await signIn()
    const own = await pairDevice(owner)
    // Cookies ride along on cross-site WebSocket upgrades; the origin check stops them.
    expect((await connectBrowser(owner, own.deviceId, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await call(`/api/devices/${own.deviceId}/connect`, { headers: { origin: owner.headers.origin!, upgrade: 'websocket' } })).status).toBe(401)
    expect((await call(`/api/devices/${own.deviceId}/connect`, { headers: owner.headers })).status).toBe(426)
  })

  test('an app with an unknown token is told its pairing is gone', async () => {
    const unknown = await openSocket(connectDevice({ deviceId: 'd_x', deviceToken: 'x'.repeat(43) }))
    expect((await unknown.closed).code).toBe(RELAY_CLOSE.deviceRemoved)
    const malformed = await openSocket(connectDevice({ deviceId: 'd_x', deviceToken: 'short' }))
    expect((await malformed.closed).code).toBe(RELAY_CLOSE.deviceRemoved)
    expect((await call('/api/device/connect', { headers: deviceAuth({ deviceToken: 'x'.repeat(43) }) })).status).toBe(426)
  })
})

describe('removing a device', () => {
  test('from the website disconnects the app and every dashboard, and voids its token', async () => {
    const { user, device, app } = await onlineDevice()
    const { page } = await openDashboard(user, device, app)

    expect((await call(`/api/devices/${device.deviceId}`, { method: 'DELETE', headers: user.headers })).status).toBe(200)
    expect(await app.nextJson()).toEqual({ t: 'revoked' })
    expect((await app.closed).code).toBe(RELAY_CLOSE.deviceRemoved)
    expect((await page.closed).code).toBe(RELAY_CLOSE.notOnAccount)
    expect(await deviceRow(device.deviceId)).toBeNull()

    const retry = await openSocket(connectDevice(device))
    expect((await retry.closed).code).toBe(RELAY_CLOSE.deviceRemoved)
    const again = await openSocket(connectBrowser(user, device.deviceId))
    expect((await again.closed).code).toBe(RELAY_CLOSE.notOnAccount)
  })

  test('from the app itself does the same', async () => {
    const { user, device, app } = await onlineDevice()
    const { page } = await openDashboard(user, device, app)

    expect((await call('/api/device', { method: 'DELETE', headers: deviceAuth(device) })).status).toBe(200)
    expect((await app.closed).code).toBe(RELAY_CLOSE.deviceRemoved)
    expect((await page.closed).code).toBe(RELAY_CLOSE.notOnAccount)
    expect(await listDevices(user)).toEqual([])
  })

  test('a device paired again after removal starts clean', async () => {
    const { user, device, app } = await onlineDevice()
    await call(`/api/devices/${device.deviceId}`, { method: 'DELETE', headers: user.headers })
    await app.closed
    const next = await pairDevice(user)
    expect(next.deviceId).not.toBe(device.deviceId)
    const nextApp = await openSocket(connectDevice(next))
    const { page } = await openDashboard(user, next, nextApp)
    page.ws.send(bytes(8))
    expect((await nextApp.next() as Uint8Array).at(-1)).toBe(8)
  })
})
