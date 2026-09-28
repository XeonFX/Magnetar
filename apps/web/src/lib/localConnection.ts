import type { ClientMessage, ServerMessage } from '@md/protocol'
import { backoff, RpcClient } from './rpcClient.ts'

/** The dashboard served by the device itself: a plain same-origin socket, loopback only. */
export class LocalConnection extends RpcClient {
  readonly kind = 'local'
  private socket: WebSocket | null = null
  private attempt = 0
  private closed = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    super()
    this.connect()
  }

  private connect(): void {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    this.socket = socket
    socket.onopen = () => {
      this.attempt = 0
      this.setState({ status: 'open' })
    }
    socket.onmessage = event => {
      try {
        this.receive(JSON.parse(event.data as string) as ServerMessage)
      } catch {
        // Ignore anything that isn't a protocol message.
      }
    }
    socket.onclose = () => {
      if (this.socket !== socket || this.closed) return
      // The app restarts after an update; keep trying until it is back.
      this.setState({ status: 'reconnecting' })
      this.timer = setTimeout(() => this.connect(), backoff(this.attempt++))
    }
  }

  protected transmit(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message))
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.socket?.close()
    this.setState({ status: 'closed' })
  }
}
