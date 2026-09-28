import type { ClientMessage, ServerMessage } from '@md/protocol'
import {
  decodeHandshake, encodeHandshake, FRAME_HANDSHAKE, FRAME_SEALED, startBrowserHandshake, type E2ESession,
  type PendingBrowserHandshake,
} from '@md/protocol/e2e'
import { RELAY_CLOSE, RELAY_PING, type RelayToBrowser } from '@md/protocol/relay'
import type { StoredDeviceKey } from './keyStore.ts'
import { backoff, RpcClient } from './rpcClient.ts'

/**
 * A device reached through mediadownloader.codefusion.cc. The relay authenticates the account;
 * everything after the handshake is sealed with keys only this browser and the device can derive,
 * so the relay forwards ciphertext it cannot read or forge.
 */
export class RelayConnection extends RpcClient {
  override readonly keyId: string
  private socket: WebSocket | null = null
  private session: E2ESession | null = null
  private handshake: PendingBrowserHandshake | null = null
  private attempt = 0
  private closed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deviceId: string, private readonly deviceKey: StoredDeviceKey) {
    super()
    this.keyId = deviceKey.keyId
    this.connect()
  }

  private connect(): void {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/devices/${encodeURIComponent(this.deviceId)}/connect`)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.session = null
    socket.onmessage = event => void this.onMessage(socket, event.data as string | ArrayBuffer)
    socket.onopen = () => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(RELAY_PING), 30_000)
    }
    socket.onclose = event => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      if (this.socket !== socket || this.closed) return
      this.session = null
      if (event.code === RELAY_CLOSE.notOnAccount) {
        this.setState({ status: 'rejected', reason: 'remote.removed' })
        return
      }
      this.setState({ status: 'reconnecting' })
      this.timer = setTimeout(() => this.connect(), backoff(this.attempt++))
    }
  }

  private async onMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (socket !== this.socket) return
    if (typeof data === 'string') {
      let status: RelayToBrowser
      try {
        status = JSON.parse(data) as RelayToBrowser
      } catch {
        return
      }
      if (status.t === 'device') {
        if (!status.online) {
          this.session = null
          this.setState({ status: 'device-offline' })
        } else {
          await this.startHandshake(socket)
        }
      }
      return
    }

    const frame = new Uint8Array(data)
    if (frame[0] === FRAME_HANDSHAKE) {
      const message = decodeHandshake(frame)
      if (message.t === 'reject') {
        this.setState({ status: 'rejected', reason: message.reason === 'unknown-key' ? 'remote.rejectedKey' : 'remote.rejectedRefused' })
        this.closed = true
        socket.close()
        return
      }
      if (message.t === 'welcome' && this.handshake) {
        try {
          this.session = await this.handshake.finish(message)
          this.handshake = null
          this.attempt = 0
          this.setState({ status: 'open' })
        } catch {
          this.setState({ status: 'rejected', reason: 'remote.handshakeFailed' })
          this.closed = true
          socket.close()
        }
      }
      return
    }

    if (frame[0] === FRAME_SEALED && this.session) {
      try {
        this.receive((await this.session.open(frame)) as ServerMessage)
      } catch {
        // A frame that doesn't authenticate means tampering or loss: start a fresh connection.
        socket.close()
      }
    }
  }

  private async startHandshake(socket: WebSocket): Promise<void> {
    this.session = null
    this.setState({ status: 'connecting' })
    this.handshake = await startBrowserHandshake(this.deviceKey.keyId, this.deviceKey.key)
    if (socket === this.socket && socket.readyState === WebSocket.OPEN) socket.send(encodeHandshake(this.handshake.hello))
  }

  protected transmit(message: ClientMessage): void {
    const session = this.session
    const socket = this.socket
    if (!session || !socket) return
    // seal() numbers frames in call order, so sends stay ordered.
    void session.seal(message).then(frame => {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame)
    }).catch(() => {})
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.socket?.close()
    this.setState({ status: 'closed' })
  }
}
