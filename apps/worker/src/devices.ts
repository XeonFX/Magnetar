import type { CloudDeviceDto, PairApproveResponse, PairingInfoDto, PairPollResponse, PairStartRequest, PairStartResponse } from '@magnetar/protocol/cloud'
import { randomId } from '@magnetar/protocol/base64'
import { RELAY_CLOSE } from '@magnetar/protocol/relay'
import { requireUser } from './auth.ts'
import type { Env } from './env.ts'
import { clientIp, error, json, limit, readJson, requireSameOrigin, sha256 } from './http.ts'

const PAIRING_MS = 10 * 60_000
const MAX_DEVICES_PER_USER = 20

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

const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').trim().slice(0, max) : '')

const toDto = (d: DeviceRow): CloudDeviceDto => ({
  id: d.id, name: d.name, platform: d.platform, version: d.version, online: d.online === 1,
  lastSeenAt: d.last_seen_at ? new Date(d.last_seen_at).toISOString() : null, createdAt: new Date(d.created_at).toISOString(),
})

/** The device a bearer token belongs to, or null. */
export async function deviceFromToken(request: Request, env: Env): Promise<DeviceRow | null> {
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get('authorization') ?? '')
  if (!match) return null
  return env.DB.prepare('SELECT * FROM devices WHERE token_hash = ?').bind(await sha256(match[1]!)).first<DeviceRow>()
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

export async function handleDevices(request: Request, env: Env, path: string): Promise<Response | null> {
  const method = request.method

  // ---- Pairing: started by the device, approved by a signed-in user, collected by the device ----

  if (path === '/api/pair/start' && method === 'POST') {
    await limit(env.PAIR_LIMITER, clientIp(request))
    const body = await readJson<Partial<PairStartRequest>>(request)
    const name = clean(body.name, 60) || 'Magnetar'
    const platform = clean(body.platform, 20) || 'unknown'
    const version = clean(body.version, 40) || 'unknown'
    const pairingId = randomId(16)
    const pollSecret = randomId(32)
    const now = Date.now()
    await env.DB.prepare('INSERT INTO pairings (id, poll_secret_hash, name, platform, version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(pairingId, await sha256(pollSecret), name, platform, version, now, now + PAIRING_MS).run()
    await env.DB.prepare('DELETE FROM pairings WHERE rowid IN (SELECT rowid FROM pairings WHERE expires_at < ? LIMIT 50)').bind(now - PAIRING_MS).run()
    return json({ pairingId, pollSecret, expiresAt: new Date(now + PAIRING_MS).toISOString() } satisfies PairStartResponse)
  }

  if (path === '/api/pair/poll' && method === 'POST') {
    const body = await readJson<{ pairingId?: string; pollSecret?: string }>(request)
    const row = await env.DB.prepare('SELECT * FROM pairings WHERE id = ?').bind(String(body.pairingId ?? '')).first<{
      poll_secret_hash: string; expires_at: number; device_id: string | null; device_token: string | null; approved_by: string | null
    }>()
    if (!row || row.poll_secret_hash !== (await sha256(String(body.pollSecret ?? '')))) return error(404, 'Unknown pairing')
    if (row.device_id && row.device_token) {
      // Handed over exactly once: the plaintext token leaves the database with this answer.
      const account = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(row.approved_by).first<{ email: string }>()
      await env.DB.prepare('UPDATE pairings SET device_token = NULL WHERE id = ?').bind(body.pairingId).run()
      return json({ state: 'approved', deviceId: row.device_id, deviceToken: row.device_token, accountEmail: account?.email ?? '' } satisfies PairPollResponse)
    }
    if (row.device_id || row.expires_at < Date.now()) return json({ state: 'expired' } satisfies PairPollResponse)
    return json({ state: 'pending' } satisfies PairPollResponse)
  }

  const pairing = /^\/api\/pair\/([A-Za-z0-9_-]{10,40})(\/approve)?$/.exec(path)
  if (pairing) {
    const user = await requireUser(request, env)
    const row = await env.DB.prepare('SELECT * FROM pairings WHERE id = ?').bind(pairing[1]).first<{
      id: string; name: string; platform: string; version: string; expires_at: number; device_id: string | null
    }>()
    if (!row) return error(404, 'This pairing link is not valid')
    const state = row.device_id ? 'approved' : row.expires_at < Date.now() ? 'expired' : 'pending'
    if (!pairing[2] && method === 'GET') {
      return json({ pairingId: row.id, name: row.name, platform: row.platform, version: row.version, expiresAt: new Date(row.expires_at).toISOString(), state } satisfies PairingInfoDto)
    }
    if (pairing[2] && method === 'POST') {
      requireSameOrigin(request, env)
      if (state !== 'pending') return error(409, state === 'expired' ? 'This pairing link has expired' : 'This device is already connected')
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?').bind(user.id).first<{ n: number }>()
      if ((count?.n ?? 0) >= MAX_DEVICES_PER_USER) return error(409, 'Remove a device before adding another')
      const deviceId = `d_${randomId(12)}`
      const token = randomId(32)
      const now = Date.now()
      // Only the first approval wins, even if two tabs approve at once.
      const claimed = await env.DB.prepare('UPDATE pairings SET approved_by = ?, device_id = ?, device_token = ? WHERE id = ? AND device_id IS NULL AND expires_at > ?')
        .bind(user.id, deviceId, token, row.id, now).run()
      if (!claimed.meta.changes) return error(409, 'This device is already connected')
      await env.DB.prepare('INSERT INTO devices (id, user_id, name, platform, version, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(deviceId, user.id, row.name, row.platform, row.version, await sha256(token), now).run()
      return json({ deviceId } satisfies PairApproveResponse)
    }
    return error(405, 'Method not allowed')
  }

  // ---- The device itself, authenticated by its token ----

  if (path === '/api/device/connect') {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return error(426, 'WebSocket required')
    const device = await deviceFromToken(request, env)
    // A 401 on the upgrade looks like any network failure to the device, which would retry
    // forever; closing with 4001 tells it the pairing is gone.
    if (!device) return closedSocket(RELAY_CLOSE.deviceRemoved, 'Device removed from the account')
    return relay(env, device.id).fetch(new Request('https://relay/device', { headers: { upgrade: 'websocket', 'x-device-id': device.id } }))
  }

  if (path === '/api/device') {
    const device = await deviceFromToken(request, env)
    if (!device) return error(401, 'Unknown device')
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id).run()
      await relay(env, device.id).revoke()
      return json({ ok: true })
    }
    if (method === 'PATCH') {
      const { name } = await readJson<{ name?: string }>(request)
      const cleaned = clean(name, 60)
      if (!cleaned) return error(400, 'A name is required')
      await env.DB.prepare('UPDATE devices SET name = ? WHERE id = ?').bind(cleaned, device.id).run()
      return json({ ok: true })
    }
    return error(405, 'Method not allowed')
  }

  // ---- The signed-in user's devices ----

  if (path === '/api/devices' && method === 'GET') {
    const user = await requireUser(request, env)
    const rows = await env.DB.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at').bind(user.id).all<DeviceRow>()
    return json(rows.results.map(toDto))
  }

  const deviceRoute = /^\/api\/devices\/([A-Za-z0-9_-]{3,40})(\/connect)?$/.exec(path)
  if (deviceRoute) {
    requireSameOrigin(request, env)
    const user = await requireUser(request, env)
    const device = await env.DB.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').bind(deviceRoute[1], user.id).first<DeviceRow>()
    if (deviceRoute[2]) {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return error(426, 'WebSocket required')
      // Tell the page this device is gone for good, instead of letting it retry forever.
      if (!device) return closedSocket(RELAY_CLOSE.notOnAccount, 'Device not on this account')
      return relay(env, device.id).fetch(new Request('https://relay/browser', { headers: { upgrade: 'websocket', 'x-device-id': device.id } }))
    }
    if (!device) return error(404, 'No such device')
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id).run()
      await relay(env, device.id).revoke()
      return json({ ok: true })
    }
    return error(405, 'Method not allowed')
  }

  return null
}

