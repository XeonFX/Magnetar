import { randomId } from '@codefusion-cc/base58'
import { clientNetwork, json, jsonError, rateLimit, readJson, requireSameOrigin, sha256 } from '@codefusion-cc/workers-http'
import type { CloudDeviceDto, PairApproveResponse, PairingInfoDto, PairPollRequest, PairPollResponse, PairStartRequest, PairStartResponse } from '@magnetar/protocol/cloud'
import { randomToken } from '@codefusion-cc/workers-crypto'
import { toDeviceName, uniqueDeviceName } from '@magnetar/protocol/device-name'
import { RELAY_CLOSE } from '@magnetar/protocol/relay'
import { currentUser, liveSessions, requireUser } from './auth.ts'
import { allowedOrigins, marks, MAX_BODY, type Env } from './env.ts'

const PAIRING_MS = 10 * 60_000
/**
 * How long after its pairing ends an approved device's token still waits for the app to collect it, unless the app
 * confirms it has it first. Then the pairing leaves the database.
 */
const HANDOFF_MS = PAIRING_MS
const MAX_DEVICES_PER_USER = 20
const FULL = 'Remove a device before adding another'

interface DeviceRow {
  id: string
  user_id: string
  name: string
  platform: string
  version: string
  created_at: number
  last_seen_at: number | null
  online: number
}

/** Whether a D1 write failed on the one-name-per-account index. */
const nameTaken = (e: unknown) => e instanceof Error && /UNIQUE constraint failed: devices\.user_id, devices\.name/.test(e.message)

const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').trim().slice(0, max) : '')

const toDto = (d: DeviceRow): CloudDeviceDto => ({
  id: d.id, name: d.name, platform: d.platform, version: d.version, online: d.online === 1,
  lastSeenAt: d.last_seen_at ? new Date(d.last_seen_at).toISOString() : null, createdAt: new Date(d.created_at).toISOString(),
})

/** The device a bearer token belongs to, or null. */
export async function deviceFromToken(request: Request, env: Env): Promise<DeviceRow | null> {
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get('authorization') ?? '')
  if (!match) return null
  return env.DB.prepare('SELECT * FROM devices WHERE token_hash = ?').bind(await sha256(match[1]!, 'base64url')).first<DeviceRow>()
}

/** Completes a WebSocket upgrade only to close it with a code the other side acts on. */
function closedSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair()
  pair[1].accept()
  pair[1].close(code, reason)
  return new Response(null, { status: 101, webSocket: pair[0] })
}

function relay(env: Env, deviceId: string) {
  return env.RELAY.getByName(deviceId)
}

/** The ids of the devices whose `column` is one of `values`. */
export async function deviceIds(env: Env, column: 'id' | 'user_id', values: string[]): Promise<string[]> {
  if (!values.length) return []
  const { results } = await env.DB.prepare(`SELECT id FROM devices WHERE ${column} IN (${marks(values)})`).bind(...values).all<{ id: string }>()
  return results.map(row => row.id)
}

/**
 * Closes the open dashboards on `userIds`' devices that were opened with one of `sessions` (every one without it), as
 * their account sessions end. The devices stay paired. Best effort: the sessions have ended already, so a failure here
 * must not fail the sign-out, and each relay's session check closes what this misses.
 */
export async function signOutDashboards(env: Env, userIds: string[], sessions?: string[]): Promise<void> {
  try {
    await Promise.all((await deviceIds(env, 'user_id', userIds)).map(id => relay(env, id).signOut(sessions)))
  } catch (e) {
    console.error('Could not close the signed-out dashboards', e)
  }
}

/**
 * Joins a dashboard to the device's relay, bound to the browser's account session. A browser that is signed out or
 * not the owner is told so with a close code, so the page stops retrying instead of retrying an HTTP error forever.
 */
async function connectDashboard(request: Request, env: Env, deviceId: string): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return jsonError(426, 'WebSocket required')
  const user = await currentUser(request, env)
  if (!user) return closedSocket(RELAY_CLOSE.signedOut, 'Signed out')
  const device = await env.DB.prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?').bind(deviceId, user.id).first<{ id: string }>()
  if (!device) return closedSocket(RELAY_CLOSE.notOnAccount, 'Device not on this account')
  const relayStub = relay(env, device.id)
  // Signing out or the session's expiry closes the dashboard (DeviceRelay).
  const response = await relayStub.fetch(new Request('https://relay/browser', { headers: { upgrade: 'websocket', 'x-device-id': device.id, 'x-session': user.tokenHash } }))
  // A sign-out between the check above and the relay taking the socket missed it: close it now.
  if (response.webSocket && !(await liveSessions(env, [user.tokenHash])).has(user.tokenHash)) await relayStub.signOut([user.tokenHash])
  return response
}

interface DevicePairingRow {
  id: string
  expires_at: number
  device_id: string | null
  device_token: string | null
  /** The approved device's name; null before approval, or when the device was removed since. */
  device_name: string | null
  account_email: string | null
}

/** The pairing the app polling for it names, with what the approval made; null without its poll secret. */
async function pairingOfDevice(request: Request, env: Env): Promise<DevicePairingRow | null> {
  const body = await readJson<Partial<PairPollRequest>>(request, { maxBytes: MAX_BODY })
  const row = await env.DB.prepare(`SELECT p.id, p.poll_secret_hash, p.expires_at, p.device_id, p.device_token, d.name AS device_name, u.email AS account_email
    FROM pairings p LEFT JOIN devices d ON d.id = p.device_id LEFT JOIN users u ON u.id = p.approved_by WHERE p.id = ?`)
    .bind(String(body.pairingId ?? '')).first<DevicePairingRow & { poll_secret_hash: string }>()
  if (!row || row.poll_secret_hash !== (await sha256(String(body.pollSecret ?? ''), 'base64url'))) return null
  return row
}

/** Unpairs a device: its token stops working and its open connections close with "device removed". */
export async function removeDevice(env: Env, deviceId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(deviceId).run()
  await relay(env, deviceId).revoke()
}

const ALREADY_CONNECTED = 'This device is already connected'

/**
 * An approval of a pairing that is approved already. From the browser and account that approved it (a retry after
 * its answer got lost, a second click) it answers as the first approval did, with the device it made, as long as that
 * device is still there. Anyone else hears it is taken.
 */
async function approvedAgain(
  env: Env,
  pairing: { device_id: string | null; approved_by: string | null; approved_session: string | null },
  user: { id: string; tokenHash: string },
): Promise<Response> {
  if (pairing.approved_by === user.id && pairing.approved_session === user.tokenHash) {
    const device = await env.DB.prepare('SELECT id, name FROM devices WHERE id = ? AND user_id = ?').bind(pairing.device_id, user.id)
      .first<{ id: string; name: string }>()
    if (device) return json({ deviceId: device.id, deviceName: device.name } satisfies PairApproveResponse)
  }
  return jsonError(409, ALREADY_CONNECTED)
}

export async function handleDevices(request: Request, env: Env, path: string): Promise<Response | null> {
  const method = request.method

  // ---- Pairing: started by the device, approved by a signed-in user, collected by the device ----

  if (path === '/api/pair/start' && method === 'POST') {
    await rateLimit(env.PAIR_LIMITER, clientNetwork(request))
    const body = await readJson<Partial<PairStartRequest>>(request, { maxBytes: MAX_BODY })
    // Spelled as an address at once, so the approval page shows the name the device will have.
    const name = toDeviceName(clean(body.name, 60))
    const platform = clean(body.platform, 20) || 'unknown'
    const version = clean(body.version, 40) || 'unknown'
    const pairingId = randomId(16)
    const pollSecret = randomToken(32)
    const now = Date.now()
    await env.DB.prepare('INSERT INTO pairings (id, poll_secret_hash, name, platform, version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(pairingId, await sha256(pollSecret, 'base64url'), name, platform, version, now, now + PAIRING_MS).run()
    await env.DB.prepare('DELETE FROM pairings WHERE rowid IN (SELECT rowid FROM pairings WHERE expires_at < ? LIMIT 50)').bind(now - HANDOFF_MS).run()
    return json({ pairingId, pollSecret, expiresAt: new Date(now + PAIRING_MS).toISOString() } satisfies PairStartResponse)
  }

  if (path === '/api/pair/poll' && method === 'POST') {
    const row = await pairingOfDevice(request, env)
    if (!row) return jsonError(404, 'Unknown pairing')
    const now = Date.now()
    if (row.device_token && row.device_name !== null && now < row.expires_at + HANDOFF_MS) {
      // The same answer to every poll until the app confirms it (/api/pair/ack): an answer lost on the way is not
      // the end of the pairing, and two polls at once get one token.
      return json({
        state: 'approved', deviceId: row.device_id!, deviceToken: row.device_token, deviceName: row.device_name, accountEmail: row.account_email ?? '',
      } satisfies PairPollResponse)
    }
    // A token past its handoff, or of a device removed meanwhile, leaves the database unused.
    if (row.device_token) await env.DB.prepare('UPDATE pairings SET device_token = NULL WHERE id = ?').bind(row.id).run()
    if (row.device_id || row.expires_at < now) return json({ state: 'expired' } satisfies PairPollResponse)
    return json({ state: 'pending' } satisfies PairPollResponse)
  }

  if (path === '/api/pair/ack' && method === 'POST') {
    const row = await pairingOfDevice(request, env)
    if (!row) return jsonError(404, 'Unknown pairing')
    if (!row.device_id) return jsonError(409, 'This pairing is not approved')
    // The app has its token: the plaintext leaves the database.
    await env.DB.prepare('UPDATE pairings SET device_token = NULL WHERE id = ?').bind(row.id).run()
    return json({ ok: true })
  }

  const pairing = /^\/api\/pair\/([A-Za-z0-9_-]{10,40})(\/approve)?$/.exec(path)
  if (pairing) {
    const user = await requireUser(request, env)
    const row = await env.DB.prepare('SELECT * FROM pairings WHERE id = ?').bind(pairing[1]).first<{
      id: string; name: string; platform: string; version: string; expires_at: number; device_id: string | null
      approved_by: string | null; approved_session: string | null
    }>()
    if (!row) return jsonError(404, 'This pairing link is not valid')
    const state = row.device_id ? 'approved' : row.expires_at < Date.now() ? 'expired' : 'pending'
    if (!pairing[2] && method === 'GET') {
      return json({ pairingId: row.id, name: row.name, platform: row.platform, version: row.version, expiresAt: new Date(row.expires_at).toISOString(), state } satisfies PairingInfoDto)
    }
    if (pairing[2] && method === 'POST') {
      requireSameOrigin(request, allowedOrigins(env))
      if (state === 'approved') return approvedAgain(env, row, user)
      if (state !== 'pending') return jsonError(409, 'This pairing link has expired')
      const deviceId = `d_${randomId(12)}`
      const token = randomToken(32)
      const tokenHash = await sha256(token, 'base64url')
      // The claim and the device go in together, and only while the account has room: two approvals at once can't
      // both take its last place, and the one that finds it full leaves its pairing pending. Only the first approval
      // of a pairing claims it, even if two tabs approve at once; a name another approval took meanwhile undoes both,
      // and the next free one is tried. Each lost try means another device joined the account, so an account's
      // limit bounds the tries.
      for (let attempt = 1; ; attempt++) {
        const taken = await env.DB.prepare('SELECT name FROM devices WHERE user_id = ?').bind(user.id).all<{ name: string }>()
        if (taken.results.length >= MAX_DEVICES_PER_USER) return jsonError(409, FULL)
        const name = uniqueDeviceName(toDeviceName(row.name), taken.results.map(d => d.name))
        const now = Date.now()
        try {
          const [claimed] = await env.DB.batch([
            env.DB.prepare(`UPDATE pairings SET approved_by = ?, approved_session = ?, device_id = ?, device_token = ? WHERE id = ?
              AND device_id IS NULL AND expires_at > ? AND (SELECT COUNT(*) FROM devices WHERE user_id = ?) < ?`)
              .bind(user.id, user.tokenHash, deviceId, token, row.id, now, user.id, MAX_DEVICES_PER_USER),
            env.DB.prepare(`INSERT INTO devices (id, user_id, name, platform, version, token_hash, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pairings WHERE id = ? AND device_id = ?)`)
              .bind(deviceId, user.id, name, row.platform, row.version, tokenHash, now, row.id, deviceId),
          ])
          if (claimed!.meta.changes) return json({ deviceId, deviceName: name } satisfies PairApproveResponse)
          // Not claimed: another approval took the pairing, it expired, or the account filled up meanwhile.
          const current = await env.DB.prepare('SELECT device_id, expires_at, approved_by, approved_session FROM pairings WHERE id = ?').bind(row.id)
            .first<{ device_id: string | null; expires_at: number; approved_by: string | null; approved_session: string | null }>()
          if (current?.device_id) return approvedAgain(env, current, user)
          if (!current) return jsonError(409, ALREADY_CONNECTED)
          return jsonError(409, current.expires_at <= now ? 'This pairing link has expired' : FULL)
        } catch (e) {
          if (!nameTaken(e) || attempt > MAX_DEVICES_PER_USER) throw e
        }
      }
    }
    return jsonError(405, 'Method not allowed')
  }

  // ---- The device itself, authenticated by its token ----

  if (path === '/api/device/connect') {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return jsonError(426, 'WebSocket required')
    const device = await deviceFromToken(request, env)
    // A 401 on the upgrade looks like any network failure to the device, which would retry
    // forever; closing with 4001 tells it the pairing is gone.
    if (!device) return closedSocket(RELAY_CLOSE.deviceRemoved, 'Device removed from the account')
    // Connecting proves the app has its token, also an app from before /api/pair/ack: the plaintext leaves the database.
    // Only a device paired within its pairing's lifetime and handoff can still have one waiting.
    if (device.created_at > Date.now() - PAIRING_MS - HANDOFF_MS) {
      await env.DB.prepare('UPDATE pairings SET device_token = NULL WHERE device_id = ? AND device_token IS NOT NULL').bind(device.id).run()
    }
    return relay(env, device.id).fetch(new Request('https://relay/device', { headers: { upgrade: 'websocket', 'x-device-id': device.id } }))
  }

  if (path === '/api/device') {
    const device = await deviceFromToken(request, env)
    if (!device) return jsonError(401, 'Unknown device')
    if (method === 'DELETE') {
      await removeDevice(env, device.id)
      return json({ ok: true })
    }
    if (method === 'PATCH') {
      const cleaned = clean((await readJson<{ name?: string }>(request, { maxBytes: MAX_BODY })).name, 60)
      if (!cleaned) return jsonError(400, 'A name is required')
      // Apps from before names were addresses send any text; it is spelled as one, and the app keeps what comes back.
      const name = toDeviceName(cleaned)
      try {
        await env.DB.prepare('UPDATE devices SET name = ? WHERE id = ?').bind(name, device.id).run()
      } catch (e) {
        if (nameTaken(e)) return jsonError(409, `Another device on this account is already called ${name}`)
        throw e
      }
      return json({ ok: true, name })
    }
    return jsonError(405, 'Method not allowed')
  }

  // ---- The signed-in user's devices ----

  if (path === '/api/devices' && method === 'GET') {
    const user = await requireUser(request, env)
    const rows = await env.DB.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at').bind(user.id).all<DeviceRow>()
    return json(rows.results.map(toDto))
  }

  const deviceRoute = /^\/api\/devices\/([A-Za-z0-9_-]{3,40})(\/connect)?$/.exec(path)
  if (deviceRoute) {
    requireSameOrigin(request, allowedOrigins(env))
    if (deviceRoute[2]) return connectDashboard(request, env, deviceRoute[1]!)
    const user = await requireUser(request, env)
    const device = await env.DB.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').bind(deviceRoute[1], user.id).first<DeviceRow>()
    if (!device) return jsonError(404, 'No such device')
    if (method === 'DELETE') {
      await removeDevice(env, device.id)
      return json({ ok: true })
    }
    return jsonError(405, 'Method not allowed')
  }

  return null
}

