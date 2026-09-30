import { exports } from 'cloudflare:workers'

/**
 * The Worker as its callers reach it: the website (a signed-in browser on the dev origin) and the
 * Magnetar app (a device token). Requests go through the real Worker, D1 and relay.
 */

export const ORIGIN = 'http://localhost:8790'

let ip = 0
/** A fresh client address, so one test's requests never count against another's rate limit. */
export const freshIp = () => `203.0.113.${++ip % 250}`

export function call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  let body = init.body
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(init.json)
  }
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, body }))
}

export interface User {
  email: string
  /** Headers of a same-origin request from this user's browser. */
  headers: Record<string, string>
}

let users = 0
/** Signs a new user in through the dev sign-in. */
export async function signIn(): Promise<User> {
  const email = `user${++users}.${crypto.randomUUID().slice(0, 8)}@example.com`
  const response = await call('/api/auth/dev', { method: 'POST', headers: { origin: ORIGIN }, json: { email } })
  if (response.status !== 200) throw new Error(`Sign-in failed: ${response.status}`)
  const session = /^(__Host-md_session=[^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1]
  if (!session) throw new Error('No session cookie')
  return { email, headers: { cookie: session, origin: ORIGIN } }
}

export interface Pairing {
  pairingId: string
  pollSecret: string
}

export async function startPairing(device: { name?: unknown; platform?: unknown; version?: unknown } = {}): Promise<Pairing> {
  const response = await call('/api/pair/start', { method: 'POST', headers: { 'cf-connecting-ip': freshIp() }, json: { name: 'Studio Mac', platform: 'macos', version: '2.1.0', ...device } })
  if (response.status !== 200) throw new Error(`Pairing failed: ${response.status}`)
  return response.json()
}

export const poll = (pairing: Pairing) => call('/api/pair/poll', { method: 'POST', json: pairing })

export const approve = (user: User, pairingId: string) => call(`/api/pair/${pairingId}/approve`, { method: 'POST', headers: user.headers })

export interface Device {
  deviceId: string
  deviceToken: string
}

/** A device paired to the user's account the way the app and the website do it. */
export async function pairDevice(user: User, device?: Parameters<typeof startPairing>[0]): Promise<Device> {
  const pairing = await startPairing(device)
  const approved = await approve(user, pairing.pairingId)
  if (approved.status !== 200) throw new Error(`Approval failed: ${approved.status}`)
  const collected = await (await poll(pairing)).json<{ state: string; deviceId: string; deviceToken: string }>()
  if (collected.state !== 'approved') throw new Error(`Pairing is ${collected.state}`)
  return { deviceId: collected.deviceId, deviceToken: collected.deviceToken }
}

type Message = string | Uint8Array

/** One end of a relay connection, as the app or a dashboard holds it. */
export interface Socket {
  ws: WebSocket
  /** The next message, in arrival order; fails after a second without one. */
  next(): Promise<Message>
  /** The next text message, parsed. */
  nextJson<T = Record<string, unknown>>(): Promise<T>
  /** Resolves when the other side closes the connection. */
  closed: Promise<{ code: number; reason: string }>
  /** Messages received and not yet taken. */
  pending(): Message[]
}

export async function openSocket(response: Response | Promise<Response>): Promise<Socket> {
  const resolved = await response
  if (resolved.status !== 101 || !resolved.webSocket) throw new Error(`Expected a WebSocket, got ${resolved.status}`)
  const ws = resolved.webSocket
  const queue: Message[] = []
  const waiters: ((message: Message) => void)[] = []
  let onClose: (event: { code: number; reason: string }) => void = () => {}
  const closed = new Promise<{ code: number; reason: string }>(resolve => (onClose = resolve))
  // Binary messages arrive as Blobs, read asynchronously; the chain keeps them in order.
  let reading = Promise.resolve()
  ws.addEventListener('message', event => {
    const data = event.data as string | Blob | ArrayBuffer
    reading = reading.then(async () => {
      const message = typeof data === 'string' ? data : new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data)
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else queue.push(message)
    })
  })
  ws.addEventListener('close', event => onClose({ code: event.code, reason: event.reason }))
  ws.accept()
  const next = () => {
    const queued = queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No message within a second')), 1000)
      waiters.push(message => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }
  return {
    ws,
    next,
    async nextJson<T>() {
      const message = await next()
      if (typeof message !== 'string') throw new Error('Expected a text message')
      return JSON.parse(message) as T
    },
    closed,
    pending: () => [...queue],
  }
}

export const connectDevice = (device: Device) =>
  call('/api/device/connect', { headers: { upgrade: 'websocket', authorization: `Bearer ${device.deviceToken}` } })

export const connectBrowser = (user: User, deviceId: string, headers: Record<string, string> = {}) =>
  call(`/api/devices/${deviceId}/connect`, { headers: { ...user.headers, upgrade: 'websocket', ...headers } })

/** Lets messages already sent through the relay arrive. */
export const settle = () => new Promise(resolve => setTimeout(resolve, 50))
