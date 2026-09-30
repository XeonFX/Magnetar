import { DurableObject } from 'cloudflare:workers'
import { randomId } from '@magnetar/protocol/base64'
import {
  MAX_RELAY_FRAME, RELAY_CLOSE, RELAY_PING, RELAY_PONG, unwrapFromDevice, wrapForDevice, type DeviceToRelay, type RelayToBrowser,
  type RelayToDevice,
} from '@magnetar/protocol/relay'
import type { Env } from './env.ts'

const MAX_BROWSERS = 16

type Attachment = { role: 'device' } | { role: 'browser'; connectionId: string }

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
      const connectionId = randomId(16)
      this.ctx.acceptWebSocket(server, ['browser', `b:${connectionId}`])
      server.serializeAttachment({ role: 'browser', connectionId } satisfies Attachment)
      const device = this.device()
      this.sendJson(server, { t: 'device', online: Boolean(device) })
      if (device) this.sendJson(device, { t: 'open', c: connectionId })
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment
    const size = typeof message === 'string' ? message.length : message.byteLength
    if (size > MAX_RELAY_FRAME + 64) return ws.close(1009, 'Frame too large')

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
          await this.env.DB.prepare('UPDATE devices SET version = ? WHERE id = ?').bind(control.version.slice(0, 40), deviceId).run()
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
    } else {
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

  private async setOnline(deviceId: string, online: boolean): Promise<void> {
    await this.env.DB.prepare('UPDATE devices SET online = ?, last_seen_at = ? WHERE id = ?').bind(online ? 1 : 0, Date.now(), deviceId).run()
  }
}
