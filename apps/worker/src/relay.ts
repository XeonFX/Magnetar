import { DurableObject } from 'cloudflare:workers'
import { randomToken } from '@codefusion-cc/workers-crypto'
import {
  MAX_SEALED_FRAME, RELAY_CLOSE, RELAY_PING, RELAY_PONG, unwrapFromDevice, wrapForDevice, type DeviceToRelay, type RelayToBrowser,
  type RelayToDevice,
} from '@magnetar/protocol/relay'
import type { Env } from './env.ts'

const MAX_BROWSERS = 16
/**
 * How often the account sessions of open dashboards are checked again while any is open. Sign-outs close their dashboards
 * at once (`signOut`); this catches expiry and any session that ended another way.
 */
export const SESSION_CHECK_MS = 60 * 60_000

/**
 * `session`: the hash of the account session that opened the dashboard (missing on sockets from before it was kept);
 * `closed`: the relay closed it and has told the device already.
 */
type Attachment = { role: 'device' } | { role: 'browser'; connectionId: string; session?: string; closed?: true }

/**
 * One per device: joins that device's socket to its browsers' sockets. It forwards opaque frames
 * — sealed end to end between browser and device — and knows only who is connected. Hibernatable
 * sockets keep idle connections free of charge; pings are answered without waking the object.
 */
export class DeviceRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG))
  }

  private device(): WebSocket | undefined {
    return this.ctx.getWebSockets('device')[0]
  }

  private sendJson(ws: WebSocket, message: RelayToBrowser | RelayToDevice): void {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // Closing sockets can throw; their close handler cleans up.
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).pathname === '/device' ? 'device' : 'browser'
    const deviceId = request.headers.get('x-device-id') ?? ''
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    if (role === 'device') {
      // A reconnecting device replaces its old socket.
      for (const old of this.ctx.getWebSockets('device')) old.close(RELAY_CLOSE.replaced, 'Replaced by a newer connection')
      this.ctx.acceptWebSocket(server, ['device'])
      server.serializeAttachment({ role: 'device' } satisfies Attachment)
      await this.ctx.storage.put('deviceId', deviceId)
      for (const browser of this.ctx.getWebSockets('browser')) {
        const attachment = browser.deserializeAttachment() as Attachment
        if (attachment.role === 'browser') this.sendJson(server, { t: 'open', c: attachment.connectionId })
        this.sendJson(browser, { t: 'device', online: true })
      }
      await this.setOnline(deviceId, true)
    } else {
      if (this.ctx.getWebSockets('browser').length >= MAX_BROWSERS) return new Response('Too many open dashboards', { status: 429 })
      // Raw bytes on the wire (the frame prefix), so base64url rather than a base58 id.
      const connectionId = randomToken(16)
      this.ctx.acceptWebSocket(server, ['browser', `b:${connectionId}`])
      server.serializeAttachment({ role: 'browser', connectionId, session: request.headers.get('x-session') ?? '' } satisfies Attachment)
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SESSION_CHECK_MS)
      const device = this.device()
      this.sendJson(server, { t: 'device', online: Boolean(device) })
      if (device) this.sendJson(device, { t: 'open', c: connectionId })
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment
    const size = typeof message === 'string' ? message.length : message.byteLength
    if (size > MAX_SEALED_FRAME) return ws.close(1009, 'Frame too large')

    if (attachment.role === 'browser') {
      if (typeof message === 'string') return
      const device = this.device()
      if (device) device.send(wrapForDevice(attachment.connectionId, new Uint8Array(message)))
      return
    }

    if (typeof message === 'string') {
      let control: DeviceToRelay
      try {
        control = JSON.parse(message) as DeviceToRelay
      } catch {
        return
      }
      if (control.t === 'close') {
        for (const browser of this.ctx.getWebSockets(`b:${control.c}`)) browser.close(RELAY_CLOSE.closedByDevice, 'Closed by the device')
      } else if (control.t === 'hello') {
        const deviceId = await this.ctx.storage.get<string>('deviceId')
        if (deviceId && typeof control.version === 'string') {
          const row = await this.env.DB.prepare('UPDATE devices SET version = ? WHERE id = ? RETURNING name').bind(control.version.slice(0, 40), deviceId).first<{ name: string }>()
          // The account's name wins: one spelled for the address, or made unique, reaches the app this way.
          if (row && row.name !== control.name) this.sendJson(ws, { t: 'name', name: row.name } satisfies RelayToDevice)
        }
      }
      return
    }

    let unwrapped
    try {
      unwrapped = unwrapFromDevice(new Uint8Array(message))
    } catch {
      return
    }
    for (const browser of this.ctx.getWebSockets(`b:${unwrapped.connectionId}`)) browser.send(unwrapped.payload)
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment
    if (attachment.role === 'device') {
      // A replaced socket closing must not mark the device offline.
      if (code === RELAY_CLOSE.replaced || this.ctx.getWebSockets('device').some(other => other !== ws)) return
      for (const browser of this.ctx.getWebSockets('browser')) this.sendJson(browser, { t: 'device', online: false })
      const deviceId = await this.ctx.storage.get<string>('deviceId')
      if (deviceId) await this.setOnline(deviceId, false)
    } else if (!attachment.closed) {
      const device = this.device()
      if (device) this.sendJson(device, { t: 'close', c: attachment.connectionId })
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011)
  }

  /** The device was removed from its account: drop everyone. */
  async revoke(): Promise<void> {
    for (const device of this.ctx.getWebSockets('device')) {
      this.sendJson(device, { t: 'revoked' })
      device.close(RELAY_CLOSE.deviceRemoved, 'Device removed from the account')
    }
    for (const browser of this.ctx.getWebSockets('browser')) browser.close(RELAY_CLOSE.notOnAccount, 'Device removed from the account')
    await this.ctx.storage.deleteAll()
  }

  /** The account signed out: closes its dashboards opened with one of `sessions` (every one, for null). */
  async signOut(sessions: string[] | null): Promise<void> {
    for (const browser of this.ctx.getWebSockets('browser')) {
      const attachment = browser.deserializeAttachment() as Attachment
      if (attachment.role === 'browser' && (!sessions || sessions.includes(attachment.session ?? ''))) this.closeBrowser(browser, attachment.connectionId, RELAY_CLOSE.signedOut, 'Signed out')
    }
  }

  /** Checks the account session of every open dashboard and closes those whose session has ended. */
  override async alarm(): Promise<void> {
    const browsers = this.ctx.getWebSockets('browser').map(ws => ({ ws, attachment: ws.deserializeAttachment() as Attachment }))
    if (!browsers.length) return
    const sessions = [...new Set(browsers.flatMap(({ attachment }) => attachment.role === 'browser' && attachment.session ? [attachment.session] : []))]
    const live = new Set(sessions.length
      ? (await this.env.DB.prepare(`SELECT token_hash FROM sessions WHERE token_hash IN (${sessions.map(() => '?').join(', ')}) AND expires_at > ?`)
        .bind(...sessions, Date.now()).all<{ token_hash: string }>()).results.map(row => row.token_hash)
      : [])
    for (const { ws, attachment } of browsers) {
      if (attachment.role !== 'browser') continue
      // A socket from before sessions were kept reconnects and comes back bound to its session.
      if (!attachment.session) this.closeBrowser(ws, attachment.connectionId, 1012, 'Reconnect')
      else if (!live.has(attachment.session)) this.closeBrowser(ws, attachment.connectionId, RELAY_CLOSE.signedOut, 'Signed out')
    }
    if (this.ctx.getWebSockets('browser').length) await this.ctx.storage.setAlarm(Date.now() + SESSION_CHECK_MS)
  }

  /** Closes a dashboard and tells the device, as the dashboard closing itself would. */
  private closeBrowser(ws: WebSocket, connectionId: string, code: number, reason: string): void {
    ws.serializeAttachment({ ...(ws.deserializeAttachment() as Attachment), closed: true })
    ws.close(code, reason)
    const device = this.device()
    if (device) this.sendJson(device, { t: 'close', c: connectionId })
  }

  private async setOnline(deviceId: string, online: boolean): Promise<void> {
    await this.env.DB.prepare('UPDATE devices SET online = ?, last_seen_at = ? WHERE id = ?').bind(online ? 1 : 0, Date.now(), deviceId).run()
  }
}
