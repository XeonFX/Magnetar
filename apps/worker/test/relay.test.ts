import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { CONNECTION_ID_BYTES, MAX_SEALED_FRAME, RELAY_CLOSE, RELAY_PING, RELAY_PONG, unwrapFromDevice, wrapForDevice } from '@magnetar/protocol/relay'
import { describe, expect, test } from 'vitest'
import { call, connectBrowser, connectDevice, deviceAuth, eventually, listDevices, openSocket, pairDevice, settle, signIn, type Device, type Socket, type User } from './client.ts'
import { SESSION_COOKIE } from '../src/auth.ts'
import type { DeviceRelay } from '../src/relay.ts'
import { sha256 } from '@codefusion-cc/workers-http'

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
    // The app is not told of a dashboard it closed itself.
    await settle()
    expect(app.pending()).toEqual([])
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
    // Signed out: told so with a close code, so the page stops retrying.
    const signedOut = await openSocket(call(`/api/devices/${own.deviceId}/connect`, { headers: { origin: owner.headers.origin!, upgrade: 'websocket' } }))
    expect(await signedOut.closed).toEqual({ code: RELAY_CLOSE.signedOut, reason: 'Signed out' })
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

/** The session behind `user`'s cookie, as the sessions table keys it. */
const sessionHash = (user: User) => sha256(user.headers.cookie!.slice(SESSION_COOKIE.length + 1), 'base64url')
/** Whether `socket` is still open after the relay had a moment to act. */
const stillOpen = async (socket: Socket) => (await Promise.race([socket.closed.then(() => false), settle().then(() => true)]))

describe('the relay and the account session that opened a dashboard', () => {
  test('signing out closes the dashboards of that browser session only; the device is told and keeps working', async () => {
    const { user, device, app } = await onlineDevice()
    const other = await signIn(user.email)
    const mine = await openDashboard(user, device, app)
    const theirs = await openDashboard(other, device, app)

    const logout = await call('/api/auth/logout', { method: 'POST', headers: user.headers })
    expect(logout.status).toBe(200)
    expect(await mine.page.closed).toMatchObject({ code: RELAY_CLOSE.signedOut })
    expect(await app.nextJson()).toEqual({ t: 'close', c: mine.connectionId })
    await settle()
    expect(app.pending()).toEqual([])

    // The other browser's dashboard still reaches the device both ways.
    expect(await stillOpen(theirs.page)).toBe(true)
    theirs.page.ws.send(bytes(4, 2))
    expect(unwrapFromDevice(await app.next() as Uint8Array).connectionId).toBe(theirs.connectionId)
    app.ws.send(wrapForDevice(theirs.connectionId, bytes(7)))
    expect([...(await theirs.page.next() as Uint8Array)]).toEqual([7])
    // And the signed-out browser cannot open a new one: it is told it is signed out, and the device hears nothing.
    expect(await (await openSocket(connectBrowser(user, device.deviceId))).closed).toMatchObject({ code: RELAY_CLOSE.signedOut })
    // Signing the account out everywhere then closes the other dashboard, and tells the device of it once.
    await env.RELAY.getByName(device.deviceId).signOut()
    expect(await theirs.page.closed).toMatchObject({ code: RELAY_CLOSE.signedOut })
    expect(await app.nextJson()).toEqual({ t: 'close', c: theirs.connectionId })
    await settle()
    expect(app.pending()).toEqual([])
  })

  test('a dashboard whose session expired or was deleted closes at the next session check; a live one stays', async () => {
    const { user, device, app } = await onlineDevice()
    const other = await signIn(user.email)
    const expiring = await openDashboard(user, device, app)
    const deleted = await openDashboard(other, device, app)
    const third = await signIn(user.email)
    const live = await openDashboard(third, device, app)

    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(Date.now() - 1, await sessionHash(user)).run()
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sessionHash(other)).run()
    expect(await runDurableObjectAlarm(env.RELAY.getByName(device.deviceId))).toBe(true)

    expect(await expiring.page.closed).toMatchObject({ code: RELAY_CLOSE.signedOut })
    expect(await deleted.page.closed).toMatchObject({ code: RELAY_CLOSE.signedOut })
    const told = [await app.nextJson<{ t: string; c: string }>(), await app.nextJson<{ t: string; c: string }>()]
    expect(told.map(m => m.c).sort()).toEqual([expiring.connectionId, deleted.connectionId].sort())
    expect(told.every(m => m.t === 'close')).toBe(true)
    await settle()
    expect(app.pending()).toEqual([])
    expect(await stillOpen(live.page)).toBe(true)
    live.page.ws.send(bytes(1))
    expect(unwrapFromDevice(await app.next() as Uint8Array).connectionId).toBe(live.connectionId)
    // The check runs again while a dashboard is open.
    expect(await runDurableObjectAlarm(env.RELAY.getByName(device.deviceId))).toBe(true)
    expect(await stillOpen(live.page)).toBe(true)
  })

  test('removing the device still closes every dashboard as removed, not as signed out', async () => {
    const { user, device, app } = await onlineDevice()
    const { page } = await openDashboard(user, device, app)
    expect((await call(`/api/devices/${device.deviceId}`, { method: 'DELETE', headers: user.headers })).status).toBe(200)
    expect(await page.closed).toMatchObject({ code: RELAY_CLOSE.notOnAccount })
  })
})

/** The relay's own sockets, as `handle` sees them, with the relay object to call. */
const insideRelay = <T>(device: Device, handle: (relay: DeviceRelay, sockets: { device: WebSocket[]; browser: WebSocket[] }) => Promise<T>) =>
  runInDurableObject(env.RELAY.getByName(device.deviceId), (relay: DeviceRelay, state) =>
    handle(relay, { device: state.getWebSockets('device'), browser: state.getWebSockets('browser') }))

const frameFrom = (connectionId: string, ...values: number[]) => wrapForDevice(connectionId, bytes(...values)).buffer

describe('the relay and sockets that are closing', () => {
  test('dashboard frames reach the new app connection while the replaced one is still closing', async () => {
    const user = await signIn()
    const device = await pairDevice(user)
    // An old connection that never answers the close, as one whose network dropped: opened, never accepted.
    expect((await connectDevice(device)).status).toBe(101)
    const page = await openSocket(connectBrowser(user, device.deviceId))
    expect(await page.nextJson()).toEqual({ t: 'device', online: true })

    const newer = await openSocket(connectDevice(device))
    const open = await newer.nextJson<{ t: string; c: string }>()
    expect(open.t).toBe('open')
    expect(await page.nextJson()).toEqual({ t: 'device', online: true })

    page.ws.send(bytes(4, 2))
    const frame = unwrapFromDevice(await newer.next() as Uint8Array)
    expect(frame.connectionId).toBe(open.c)
    expect([...frame.payload]).toEqual([4, 2])
    // And the other way.
    newer.ws.send(wrapForDevice(open.c, bytes(7)))
    expect([...(await page.next() as Uint8Array)]).toEqual([7])
    expect((await deviceRow(device.deviceId))!.online).toBe(1)

    // The app quitting takes the device offline, though the replaced connection is still listed.
    newer.ws.close(1000, 'Quit')
    expect(await page.nextJson()).toEqual({ t: 'device', online: false })
    await eventually(async () => expect((await deviceRow(device.deviceId))!.online).toBe(0))
  })

  test('a frame for a dashboard the relay is closing is dropped without an error', async () => {
    const { user, device, app } = await onlineDevice()
    const { page, connectionId } = await openDashboard(user, device, app)
    await insideRelay(device, async (relay, sockets) => {
      sockets.browser[0]!.close(RELAY_CLOSE.closedByDevice, 'Closed by the device')
      expect(sockets.browser[0]!.readyState).toBe(WebSocket.CLOSING)
      await expect(relay.webSocketMessage(sockets.device[0]!, frameFrom(connectionId, 9))).resolves.toBeUndefined()
    })
    expect((await page.closed).code).toBe(RELAY_CLOSE.closedByDevice)
    expect(page.pending()).toEqual([])
  })

  test('a dashboard frame while the app connection is closing is dropped without an error', async () => {
    const { user, device, app } = await onlineDevice()
    const { page } = await openDashboard(user, device, app)
    await insideRelay(device, async (relay, sockets) => {
      sockets.device[0]!.close(1000, 'Quit')
      await expect(relay.webSocketMessage(sockets.browser[0]!, bytes(5).buffer)).resolves.toBeUndefined()
    })
    expect((await app.closed).code).toBe(1000)
    expect(app.pending()).toEqual([])
    expect(await page.nextJson()).toEqual({ t: 'device', online: false })
  })

  test('a dashboard whose socket refuses a frame though it reads as open is closed, and the app told once', async () => {
    const { user, device, app } = await onlineDevice()
    const lost = await openDashboard(user, device, app)
    const live = await openDashboard(user, device, app)
    await insideRelay(device, async (relay, sockets) => {
      // The runtime refusing the send, as it does for a socket that closed between the lookup and the send.
      const refusing = sockets.browser.find(ws => (ws.deserializeAttachment() as { connectionId: string }).connectionId === lost.connectionId)!
      refusing.send = () => {
        throw new TypeError("Can't call WebSocket send() after close().")
      }
      await expect(relay.webSocketMessage(sockets.device[0]!, frameFrom(lost.connectionId, 1))).resolves.toBeUndefined()
    })
    expect(await lost.page.closed).toMatchObject({ code: 1011 })
    expect(await app.nextJson()).toEqual({ t: 'close', c: lost.connectionId })
    await settle()
    expect(app.pending()).toEqual([])
    // The other dashboard is untouched.
    app.ws.send(wrapForDevice(live.connectionId, bytes(3)))
    expect([...(await live.page.next() as Uint8Array)]).toEqual([3])
  })

  test('an app socket that refuses a frame though it reads as open is closed, and its dashboards told it is offline', async () => {
    const { user, device, app } = await onlineDevice()
    const { page } = await openDashboard(user, device, app)
    await insideRelay(device, async (relay, sockets) => {
      sockets.device[0]!.send = () => {
        throw new TypeError("Can't call WebSocket send() after close().")
      }
      await expect(relay.webSocketMessage(sockets.browser[0]!, bytes(6).buffer)).resolves.toBeUndefined()
    })
    expect(await app.closed).toMatchObject({ code: 1011 })
    expect(await page.nextJson()).toEqual({ t: 'device', online: false })
    await eventually(async () => expect((await deviceRow(device.deviceId))!.online).toBe(0))
    await settle()
    expect(page.pending()).toEqual([])
  })
})

describe('the relay and dashboards it closed whose connection never answers', () => {
  /** A dashboard whose network dropped: opened, never accepted, so it never answers the relay's close. */
  async function deadDashboard(user: User, device: Device, app: Socket): Promise<string> {
    expect((await connectBrowser(user, device.deviceId)).status).toBe(101)
    const open = await app.nextJson<{ t: string; c: string }>()
    expect(open.t).toBe('open')
    return open.c
  }

  test('a reconnecting app is not told to open a dashboard the relay already closed', async () => {
    const { user, device, app } = await onlineDevice()
    const dead = await deadDashboard(user, device, app)
    const other = await signIn(user.email)
    const live = await openDashboard(other, device, app)

    await env.RELAY.getByName(device.deviceId).signOut([await sessionHash(user)])
    expect(await app.nextJson()).toEqual({ t: 'close', c: dead })

    const newer = await openSocket(connectDevice(device))
    expect(await newer.nextJson()).toEqual({ t: 'open', c: live.connectionId })
    await settle()
    expect(newer.pending()).toEqual([])
  })

  test('closed dashboards that never answer do not count toward the limit of open ones', async () => {
    const { user, device, app } = await onlineDevice()
    for (let i = 0; i < 16; i++) await deadDashboard(user, device, app)
    expect((await connectBrowser(user, device.deviceId)).status).toBe(429)

    await env.RELAY.getByName(device.deviceId).signOut()
    for (let i = 0; i < 16; i++) expect(await app.nextJson()).toMatchObject({ t: 'close' })
    const other = await signIn(user.email)
    await openDashboard(other, device, app)
  })

  test('an app connection that never answers, closed for a frame too large, goes offline at once', async () => {
    const user = await signIn()
    const device = await pairDevice(user)
    expect((await connectDevice(device)).status).toBe(101)
    const page = await openSocket(connectBrowser(user, device.deviceId))
    expect(await page.nextJson()).toEqual({ t: 'device', online: true })

    await insideRelay(device, (relay, sockets) => relay.webSocketMessage(sockets.device[0]!, new ArrayBuffer(MAX_SEALED_FRAME + 1)))
    expect(await page.nextJson()).toEqual({ t: 'device', online: false })
    await eventually(async () => expect((await deviceRow(device.deviceId))!.online).toBe(0))
  })
})
