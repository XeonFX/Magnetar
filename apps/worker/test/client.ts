import { env, exports } from 'cloudflare:workers'
import type { CloudDeviceDto } from '@magnetar/protocol/cloud'
import { SESSION_COOKIE } from '../src/auth.ts'

/**
 * The Worker as its callers reach it: the website (a signed-in browser on the dev origin) and the
 * Magnetar app (a device token). Requests go through the real Worker, D1 and relay.
 */

export const ORIGIN = 'http://localhost:8790'

/**
 * A client network of its own, so one test's requests never count against another's rate limit. Limits count
 * an IPv6 address's whole /64, so the random part is in the first four groups.
 */
export const freshIp = () => `2001:db8:${crypto.randomUUID().slice(0, 4)}:${crypto.randomUUID().slice(0, 4)}::1`

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

/** The value `response` sets for cookie `name` ('' when it clears it), or undefined when it does not set it. */
export const cookieValue = (response: Response, name: string) =>
  response.headers.getSetCookie().find(line => line.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1)

let users = 0
/** Signs a new user in through the dev sign-in. */
export async function signIn(): Promise<User> {
  const email = `user${++users}.${crypto.randomUUID().slice(0, 8)}@example.com`
  const response = await call('/api/auth/dev', { method: 'POST', headers: { origin: ORIGIN }, json: { email } })
  if (response.status !== 200) throw new Error(`Sign-in failed: ${response.status}`)
  const session = cookieValue(response, SESSION_COOKIE)
  if (!session) throw new Error('No session cookie')
  return { email, headers: { cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN } }
}

/** The id of `user`'s account. */
export const userId = async (user: User) =>
  (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(user.email).first<{ id: string }>())!.id

/** A device row written straight to D1, bypassing the Worker's name rules (as rows written before a migration). */
export const insertDevice = (id: string, owner: string, name: string, createdAt: number) =>
  env.DB.prepare('INSERT INTO devices (id, user_id, name, platform, version, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, owner, name, 'macos', '1.0.0', `hash-${id}`, createdAt).run()

interface Pairing {
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

/** Headers of a request from the app, authenticated by its device token. */
export const deviceAuth = (device: Pick<Device, 'deviceToken'>) => ({ authorization: `Bearer ${device.deviceToken}` })

/** The account's device list, as the website shows it. */
export const listDevices = async (user: User) => (await call('/api/devices', { headers: user.headers })).json<CloudDeviceDto[]>()

/** A device paired to the user's account the way the app and the website do it. */
export async function pairDevice(user: User, device?: Parameters<typeof startPairing>[0]): Promise<Device> {
  const pairing = await startPairing(device)
  const approved = await approve(user, pairing.pairingId)
  if (approved.status !== 200) throw new Error(`Approval failed: ${approved.status}`)
  const collected = await (await poll(pairing)).json<{ state: string; deviceId: string; deviceToken: string }>()
  if (collected.state !== 'approved') throw new Error(`Pairing is ${collected.state}`)
  return { deviceId: collected.deviceId, deviceToken: collected.deviceToken }
}

/**
 * How long a test waits for the relay to deliver or apply something. Slow CI runners take seconds
 * where a laptop takes milliseconds; a passing test never waits it out.
 */
const PATIENCE_MS = 10_000

type Message = string | Uint8Array

/** One end of a relay connection, as the app or a dashboard holds it. */
export interface Socket {
  ws: WebSocket
  /** The next message, in arrival order; fails after `PATIENCE_MS` without one. */
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
  const closed = Promise.withResolvers<{ code: number; reason: string }>()
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
  ws.addEventListener('close', event => closed.resolve({ code: event.code, reason: event.reason }))
  ws.accept()
  const next = () => {
    const queued = queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise<Message>((resolve, reject) => {
      const waiter = (message: Message) => {
        clearTimeout(timer)
        resolve(message)
      }
      // A wait that gave up leaves the queue, so the message it missed goes to the next taker.
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1)
        reject(new Error(`No message within ${PATIENCE_MS / 1000} s`))
      }, PATIENCE_MS)
      waiters.push(waiter)
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
    closed: closed.promise,
    pending: () => [...queue],
  }
}

export const connectDevice = (device: Device) =>
  call('/api/device/connect', { headers: { upgrade: 'websocket', ...deviceAuth(device) } })

export const connectBrowser = (user: User, deviceId: string, headers: Record<string, string> = {}) =>
  call(`/api/devices/${deviceId}/connect`, { headers: { ...user.headers, upgrade: 'websocket', ...headers } })

/** Lets messages already sent through the relay arrive, before checking that nothing else did. */
export const settle = () => new Promise(resolve => setTimeout(resolve, 50))

/** Retries `check` until it passes or `PATIENCE_MS` is up, for effects the relay applies after a socket event. */
export async function eventually(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + PATIENCE_MS
  for (;;) {
    try {
      return await check()
    } catch (e) {
      if (Date.now() > deadline) throw e
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}
