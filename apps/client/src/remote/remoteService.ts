import { hostname } from 'node:os'
import type { ClientMessage, RemoteStatusDto } from '@md/protocol'
import { ApiError } from '../api/errors.ts'
import type { PairPollResponse, PairStartResponse } from '@md/protocol/cloud'
import { toBase64Url } from '@md/protocol/base64'
import {
  acceptBrowserHandshake, decodeHandshake, encodeHandshake, FRAME_HANDSHAKE, FRAME_SEALED, linkFragment, type E2ESession,
} from '@md/protocol/e2e'
import { MAX_RELAY_FRAME, RELAY_CLOSE, RELAY_PING, unwrapFromDevice, wrapForDevice, type RelayToDevice } from '@md/protocol/relay'
import { CLOUD_URL, PLATFORM, USER_AGENT, VERSION } from '../config.ts'
import type { KeyValue } from '../db/database.ts'
import type { SecretStore } from '../db/secrets.ts'
import type { EventBus } from '../events.ts'
import { logger } from '../log.ts'
import type { RpcServer, RpcSession } from '../rpc/rpcServer.ts'
import type { BrowserKeyStore } from './browserKeys.ts'

const log = logger('remote')
const POLL_MS = 2000
const MAX_BACKOFF_MS = 60_000
const MAX_SESSIONS = 16

interface Connection {
  keyId: string | null
  session: E2ESession | null
  rpc: RpcSession | null
}

/**
 * Pairing with mediadownloader.codefusion.cc and the relay connection that lets linked browsers
 * reach this device. Everything after the handshake is sealed end to end; the Worker only moves
 * opaque frames between sockets.
 */
export class RemoteService {
  private socket: WebSocket | null = null
  private connected = false
  private backoff = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pairing: { pairingId: string; pollSecret: string; keyId: string; url: string; expiresAt: string; timer: ReturnType<typeof setTimeout> | null } | null = null
  private readonly connections = new Map<string, Connection>()
  private lastError: string | null = null
  private stopped = false
  private pingTimer: ReturnType<typeof setInterval> | null = null
  rpc: RpcServer | null = null

  constructor(
    private readonly kv: KeyValue,
    private readonly secrets: SecretStore,
    private readonly keys: BrowserKeyStore,
    private readonly events: EventBus,
  ) {}

  get deviceId(): string | null {
    return this.kv.get('remote.deviceId')
  }

  get deviceName(): string {
    return this.kv.get('remote.deviceName') ?? defaultDeviceName()
  }

  start(): void {
    if (this.deviceId && this.secrets.has('deviceToken')) this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pairing?.timer) clearTimeout(this.pairing.timer)
    this.socket?.close(1000, 'shutting down')
  }

  status(): RemoteStatusDto {
    return {
      cloudUrl: CLOUD_URL,
      paired: this.deviceId !== null,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      accountEmail: this.kv.get('remote.accountEmail'),
      connected: this.connected,
      pendingPairing: this.pairing ? { url: this.pairing.url, expiresAt: this.pairing.expiresAt } : null,
      browsers: this.deviceId ? this.keys.list() : [],
      lastError: this.lastError,
    }
  }

  /**
   * Starts pairing and returns the link to open. The browser that opens it signs in, approves,
   * and receives its key in the link fragment — so it is linked the moment pairing completes.
   */
  async pair(deviceName?: string): Promise<RemoteStatusDto> {
    if (this.deviceId) throw new ApiError('This device is already connected. Disconnect it first.')
    this.cancelPairing()
    if (deviceName) this.kv.set('remote.deviceName', deviceName)
    const response = await cloudFetch('/api/pair/start', {
      method: 'POST',
      body: JSON.stringify({ name: this.deviceName, platform: PLATFORM, version: VERSION }),
    })
    const started = (await response.json()) as PairStartResponse
    const { keyId, key } = this.keys.mint('Browser used for pairing', false)
    const url = `${CLOUD_URL}/pair/${encodeURIComponent(started.pairingId)}#i=${encodeURIComponent(keyId)}&k=${toBase64Url(key)}`
    this.pairing = { pairingId: started.pairingId, pollSecret: started.pollSecret, keyId, url, expiresAt: started.expiresAt, timer: null }
    this.lastError = null
    this.schedulePoll()
    this.changed()
    return this.status()
  }

  cancelPairing(): RemoteStatusDto {
    if (this.pairing?.timer) clearTimeout(this.pairing.timer)
    this.pairing = null
    this.keys.revokeInactive()
    this.changed()
    return this.status()
  }

  private schedulePoll(): void {
    const pairing = this.pairing
    if (!pairing) return
    pairing.timer = setTimeout(async () => {
      if (this.pairing !== pairing) return
      try {
        const response = await cloudFetch('/api/pair/poll', {
          method: 'POST',
          body: JSON.stringify({ pairingId: pairing.pairingId, pollSecret: pairing.pollSecret }),
        })
        const result = (await response.json()) as PairPollResponse
        if (this.pairing !== pairing) return
        if (result.state === 'approved') {
          this.kv.set('remote.deviceId', result.deviceId)
          this.kv.set('remote.accountEmail', result.accountEmail)
          this.secrets.set('deviceToken', result.deviceToken)
          this.keys.activate(pairing.keyId)
          this.pairing = null
          log.info(`Paired with ${result.accountEmail} as device ${result.deviceId}`)
          this.connect()
          this.changed()
          return
        }
        if (result.state === 'expired') {
          this.lastError = 'The pairing link expired. Start again.'
          this.cancelPairing()
          return
        }
      } catch (error) {
        log.warn('Pairing poll failed', error)
      }
      if (Date.parse(pairing.expiresAt) < Date.now()) {
        this.lastError = 'The pairing link expired. Start again.'
        this.cancelPairing()
        return
      }
      this.schedulePoll()
    }, POLL_MS)
  }

  /** Disconnects from the account: revokes the device on the server and forgets every browser key. */
  async unpair(): Promise<RemoteStatusDto> {
    const token = this.secrets.get('deviceToken')
    if (token) {
      try {
        await cloudFetch('/api/device', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
      } catch (error) {
        log.warn('Could not revoke the device on the server; forgetting it locally anyway', error)
      }
    }
    this.forget()
    return this.status()
  }

  async rename(deviceName: string): Promise<RemoteStatusDto> {
    this.kv.set('remote.deviceName', deviceName)
    const token = this.secrets.get('deviceToken')
    if (token) {
      await cloudFetch('/api/device', { method: 'PATCH', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: deviceName }) })
    }
    this.changed()
    return this.status()
  }

  linkBrowser(label: string | undefined): { url: string; keyId: string } {
    const deviceId = this.deviceId
    if (!deviceId) throw new ApiError('Connect this device to your account first.')
    const { keyId, key } = this.keys.mint(label?.trim() || 'Linked browser')
    this.changed()
    return { url: `${CLOUD_URL}/link#${linkFragment(deviceId, keyId, key)}`, keyId }
  }

  revokeBrowser(keyId: string): RemoteStatusDto {
    this.keys.revoke(keyId)
    for (const [connectionId, connection] of this.connections) {
      if (connection.keyId === keyId) this.dropConnection(connectionId, true)
    }
    this.changed()
    return this.status()
  }

  private forget(): void {
    this.kv.set('remote.deviceId', null)
    this.kv.set('remote.accountEmail', null)
    this.secrets.set('deviceToken', '')
    this.keys.revokeAll()
    for (const id of this.connections.keys()) this.dropConnection(id, false)
    const socket = this.socket
    this.socket = null
    socket?.close(1000, 'unpaired')
    this.connected = false
    this.changed()
  }

  private connect(): void {
    if (this.stopped || this.socket) return
    const token = this.secrets.get('deviceToken')
    if (!token) return
    const url = `${CLOUD_URL.replace(/^http/, 'ws')}/api/device/connect`
    // Bun's WebSocket accepts headers, so the token never appears in a URL or a log line.
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}`, 'user-agent': USER_AGENT } } as unknown as string[])
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.addEventListener('open', () => {
      this.connected = true
      this.backoff = 1000
      this.lastError = null
      socket.send(JSON.stringify({ t: 'hello', version: VERSION, name: this.deviceName }))
      // Keeps NAT mappings and proxies from dropping an idle socket; the relay answers without waking.
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(RELAY_PING), 30_000)
      log.info('Connected to the relay')
      this.changed()
    })
    socket.addEventListener('message', event => void this.onMessage(socket, event.data as string | ArrayBuffer))
    socket.addEventListener('close', event => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      if (this.socket === socket) this.socket = null
      this.connected = false
      for (const id of this.connections.keys()) this.dropConnection(id, false)
      if (event.code === RELAY_CLOSE.deviceRemoved) {
        log.warn('The server no longer accepts this device; forgetting the pairing')
        this.lastError = 'This device was removed from your account.'
        this.forget()
        return
      }
      this.changed()
      if (this.stopped || !this.deviceId) return
      const delay = this.backoff
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
      this.reconnectTimer = setTimeout(() => this.connect(), delay + Math.random() * 500)
    })
    socket.addEventListener('error', () => {
      this.lastError = 'Could not reach the relay; retrying.'
    })
  }

  private async onMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data === 'string') {
      let message: RelayToDevice
      try {
        message = JSON.parse(data) as RelayToDevice
      } catch {
        return
      }
      if (message.t === 'open') {
        if (this.connections.size >= MAX_SESSIONS) socket.send(JSON.stringify({ t: 'close', c: message.c }))
        else this.connections.set(message.c, { keyId: null, session: null, rpc: null })
      } else if (message.t === 'close') {
        this.dropConnection(message.c, false)
      } else if (message.t === 'revoked') {
        this.lastError = 'This device was removed from your account.'
        this.forget()
      }
      return
    }

    const frame = new Uint8Array(data)
    if (frame.length > MAX_RELAY_FRAME + 16) return
    let connectionId: string
    let payload: Uint8Array
    try {
      ({ connectionId, payload } = unwrapFromDevice(frame))
    } catch {
      return
    }
    const connection = this.connections.get(connectionId)
    if (!connection) return

    if (payload[0] === FRAME_HANDSHAKE) {
      if (connection.session) return this.dropConnection(connectionId, true)
      try {
        const hello = decodeHandshake(payload)
        if (hello.t !== 'hello') throw new Error('Expected hello')
        const key = await this.keys.lookup(hello.kid)
        if (!key) {
          this.sendTo(connectionId, encodeHandshake({ t: 'reject', reason: 'unknown-key' }))
          return
        }
        const { welcome, session } = await acceptBrowserHandshake(hello, key)
        if (this.connections.get(connectionId) !== connection) return
        connection.keyId = hello.kid
        connection.session = session
        connection.rpc = this.rpc!.connect({
          local: false,
          send: message => void session.seal(message).then(sealed => this.sendTo(connectionId, sealed)),
        })
        this.keys.touch(hello.kid)
        this.sendTo(connectionId, encodeHandshake(welcome))
      } catch (error) {
        log.warn('Rejected a browser handshake', error)
        this.sendTo(connectionId, encodeHandshake({ t: 'reject', reason: 'bad-hello' }))
      }
      return
    }

    if (payload[0] === FRAME_SEALED && connection.session && connection.rpc) {
      try {
        const message = (await connection.session.open(payload)) as ClientMessage
        void connection.rpc.handle(message)
      } catch {
        // Tampering, replay or a dropped frame: this connection can't be trusted any more.
        this.dropConnection(connectionId, true)
      }
    }
  }

  private sendTo(connectionId: string, payload: Uint8Array): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(wrapForDevice(connectionId, payload))
  }

  private dropConnection(connectionId: string, notifyRelay: boolean): void {
    const connection = this.connections.get(connectionId)
    if (!connection) return
    connection.rpc?.close()
    this.connections.delete(connectionId)
    if (notifyRelay && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ t: 'close', c: connectionId }))
  }

  private changed(): void {
    this.events.emit('remote.changed', this.status())
  }
}

function defaultDeviceName(): string {
  const host = hostname().replace(/\.local$/i, '')
  return host || (PLATFORM === 'macos' ? 'Mac' : PLATFORM === 'windows' ? 'Windows PC' : 'Linux')
}

async function cloudFetch(path: string, init: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${CLOUD_URL}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new ApiError(`Could not reach ${new URL(CLOUD_URL).host}. Check the internet connection.`)
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      message = ((await response.json()) as { error?: string }).error ?? message
    } catch {
      // Not JSON; keep the status.
    }
    throw new ApiError(message)
  }
  return response
}

