/**
 * End-to-end encryption between a browser and a device, through a relay that must learn nothing
 * but sizes and timing.
 *
 * Trust comes from a per-browser key K (32 random bytes) that the device mints and hands to the
 * browser out of band: in the fragment of a link opened from the device's own dashboard, or of a
 * QR code shown by it or by an already-linked browser. URL fragments never reach a server, so the
 * relay never sees K.
 *
 * Each connection runs a handshake: both sides send an ephemeral P-256 key and a nonce; the ECDH
 * secret is expanded with HKDF, salted with HMAC(K, transcript hash). A relay that substitutes
 * either ephemeral key cannot compute that salt, so the device's confirmation (and every sealed
 * frame after it) fails. Fresh ephemeral keys give each connection its own keys, so frames can't
 * be replayed into another connection and a stolen K doesn't decrypt recorded traffic.
 *
 * Sealed frames are AES-256-GCM with a per-direction key; the 96-bit IV is a direction tag plus a
 * 64-bit counter, and the receiver insists on exactly the next counter, which rejects replays,
 * drops and reordering within a connection. The transcript hash is the associated data.
 */
import { fromBase64Url, randomBytes, toBase64Url } from './base64.ts'

export const E2E_VERSION = 1
const LABEL = 'magnetar-e2e-v1'
const KEY_BYTES = 32
const NONCE_BYTES = 16

/** First byte of every browser↔device payload. */
export const FRAME_HANDSHAKE = 0
export const FRAME_SEALED = 1

export type HelloMessage = { t: 'hello'; v: number; kid: string; epk: string; n: string }
export type WelcomeMessage = { t: 'welcome'; v: number; epk: string; n: string; confirm: string }
export type RejectMessage = { t: 'reject'; reason: 'unknown-key' | 'bad-hello' | 'version' }
export type HandshakeMessage = HelloMessage | WelcomeMessage | RejectMessage

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const subtle = crypto.subtle

/** A new browser key: 32 random bytes, to be carried in a link fragment. */
export function newBrowserKey(): Uint8Array<ArrayBuffer> {
  return randomBytes(KEY_BYTES)
}

/** Imports K as a non-extractable HMAC key, safe to keep in IndexedDB. */
export function importBrowserKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) throw new Error('A browser key is 32 bytes')
  return subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  return concat(new Uint8Array([bytes.length >> 8, bytes.length & 0xff]), bytes)
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

async function hmac(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.sign('HMAC', key, data))
}

async function newEphemeral(): Promise<{ pair: CryptoKeyPair; publicRaw: Uint8Array<ArrayBuffer> }> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair
  return { pair, publicRaw: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) }
}

function importPeer(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('Invalid ephemeral key')
  return subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
}

export interface Derived {
  send: CryptoKey
  receive: CryptoKey
  confirm: CryptoKey
  transcriptHash: Uint8Array<ArrayBuffer>
}

/** Exported for the cross-implementation test vector (e2e-vector.json); the handshakes below use it. */
export async function deriveKeys(
  role: 'browser' | 'device', browserKey: CryptoKey, ownPrivate: CryptoKey, peerPublic: CryptoKey,
  kid: string, browserEpk: Uint8Array, browserNonce: Uint8Array, deviceEpk: Uint8Array, deviceNonce: Uint8Array,
): Promise<Derived> {
  const transcript = concat(
    encoder.encode(LABEL), lengthPrefixed(encoder.encode(kid)),
    browserEpk, browserNonce, deviceEpk, deviceNonce,
  )
  const transcriptHash = new Uint8Array(await subtle.digest('SHA-256', transcript))
  const salt = await hmac(browserKey, transcriptHash)
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peerPublic }, ownPrivate, 256)
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits'])
  const okm = new Uint8Array(await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(`${LABEL} keys`) }, ikm, 96 * 8,
  ))
  const aes = (bytes: Uint8Array<ArrayBuffer>) => subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
  const browserToDevice = await aes(okm.slice(0, 32))
  const deviceToBrowser = await aes(okm.slice(32, 64))
  const confirm = await subtle.importKey('raw', okm.slice(64, 96), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return role === 'browser'
    ? { send: browserToDevice, receive: deviceToBrowser, confirm, transcriptHash }
    : { send: deviceToBrowser, receive: browserToDevice, confirm, transcriptHash }
}

const DIRECTION = { browser: 1, device: 2 } as const

/**
 * One direction-aware encrypted channel. `seal` and `open` are serialised internally, so frames
 * are numbered and consumed in call order even though WebCrypto is asynchronous.
 */
export class E2ESession {
  private sendCounter = 0n
  private receiveCounter = 0n
  private sealChain: Promise<unknown> = Promise.resolve()
  private openChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly role: 'browser' | 'device', private readonly keys: Derived) {}

  private iv(direction: number, counter: bigint): Uint8Array<ArrayBuffer> {
    const iv = new Uint8Array(12)
    const view = new DataView(iv.buffer)
    view.setUint32(0, direction)
    view.setBigUint64(4, counter)
    return iv
  }

  /** Encrypts a JSON value into a sealed frame. */
  seal(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
    const run = this.sealChain.then(async () => {
      const counter = this.sendCounter++
      const plaintext = encoder.encode(JSON.stringify(value))
      const ciphertext = new Uint8Array(await subtle.encrypt(
        { name: 'AES-GCM', iv: this.iv(DIRECTION[this.role], counter), additionalData: this.keys.transcriptHash },
        this.keys.send, plaintext,
      ))
      const frame = new Uint8Array(9 + ciphertext.length)
      frame[0] = FRAME_SEALED
      new DataView(frame.buffer).setBigUint64(1, counter)
      frame.set(ciphertext, 9)
      return frame
    })
    this.sealChain = run.catch(() => {})
    return run
  }

  /** Decrypts the next sealed frame. Throws on tampering, replay, reordering or a dropped frame. */
  open(frame: Uint8Array): Promise<unknown> {
    const run = this.openChain.then(async () => {
      if (frame.length < 9 + 16 || frame[0] !== FRAME_SEALED) throw new Error('Not a sealed frame')
      const counter = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(1)
      if (counter !== this.receiveCounter) throw new Error('Out-of-sequence frame')
      const peer = this.role === 'browser' ? DIRECTION.device : DIRECTION.browser
      const plaintext = await subtle.decrypt(
        { name: 'AES-GCM', iv: this.iv(peer, counter), additionalData: this.keys.transcriptHash },
        this.keys.receive, frame.slice(9),
      )
      this.receiveCounter++
      return JSON.parse(decoder.decode(plaintext)) as unknown
    })
    this.openChain = run.catch(() => {})
    return run
  }
}

export function encodeHandshake(message: HandshakeMessage): Uint8Array<ArrayBuffer> {
  return concat(new Uint8Array([FRAME_HANDSHAKE]), encoder.encode(JSON.stringify(message)))
}

export function decodeHandshake(frame: Uint8Array): HandshakeMessage {
  if (frame[0] !== FRAME_HANDSHAKE) throw new Error('Not a handshake frame')
  const value = JSON.parse(decoder.decode(frame.subarray(1))) as HandshakeMessage
  if (!value || typeof value !== 'object' || !['hello', 'welcome', 'reject'].includes(value.t)) {
    throw new Error('Unknown handshake message')
  }
  return value
}

export interface PendingBrowserHandshake {
  hello: HelloMessage
  finish(welcome: WelcomeMessage): Promise<E2ESession>
}

/** Browser side, step 1: the hello to send, and how to finish once the device answers. */
export async function startBrowserHandshake(kid: string, browserKey: CryptoKey): Promise<PendingBrowserHandshake> {
  const own = await newEphemeral()
  const nonce = randomBytes(NONCE_BYTES)
  const hello: HelloMessage = { t: 'hello', v: E2E_VERSION, kid, epk: toBase64Url(own.publicRaw), n: toBase64Url(nonce) }
  return {
    hello,
    async finish(welcome) {
      if (welcome.v !== E2E_VERSION) throw new Error('Unsupported protocol version')
      const deviceEpk = fromBase64Url(welcome.epk)
      const deviceNonce = fromBase64Url(welcome.n)
      if (deviceNonce.length !== NONCE_BYTES) throw new Error('Invalid device nonce')
      const keys = await deriveKeys('browser', browserKey, own.pair.privateKey, await importPeer(deviceEpk),
        kid, own.publicRaw, nonce, deviceEpk, deviceNonce)
      const expected = await hmac(keys.confirm, concat(encoder.encode('device'), keys.transcriptHash))
      if (!equalBytes(expected, fromBase64Url(welcome.confirm))) {
        throw new Error('The device could not prove it holds this browser’s key')
      }
      return new E2ESession('browser', keys)
    },
  }
}

/** Device side: answers a hello for a browser whose key it holds. */
export async function acceptBrowserHandshake(
  hello: HelloMessage, browserKey: CryptoKey,
): Promise<{ welcome: WelcomeMessage; session: E2ESession }> {
  if (hello.v !== E2E_VERSION) throw new Error('Unsupported protocol version')
  const browserEpk = fromBase64Url(hello.epk)
  const browserNonce = fromBase64Url(hello.n)
  if (browserNonce.length !== NONCE_BYTES) throw new Error('Invalid browser nonce')
  const own = await newEphemeral()
  const nonce = randomBytes(NONCE_BYTES)
  const keys = await deriveKeys('device', browserKey, own.pair.privateKey, await importPeer(browserEpk),
    hello.kid, browserEpk, browserNonce, own.publicRaw, nonce)
  const confirm = await hmac(keys.confirm, concat(encoder.encode('device'), keys.transcriptHash))
  return {
    welcome: { t: 'welcome', v: E2E_VERSION, epk: toBase64Url(own.publicRaw), n: toBase64Url(nonce), confirm: toBase64Url(confirm) },
    session: new E2ESession('device', keys),
  }
}

/** The fragment that carries a browser key: `#d=<deviceId>&i=<keyId>&k=<key>`. */
export function linkFragment(deviceId: string, keyId: string, key: Uint8Array): string {
  return `d=${encodeURIComponent(deviceId)}&i=${encodeURIComponent(keyId)}&k=${toBase64Url(key)}`
}

export function parseLinkFragment(fragment: string): { deviceId: string; keyId: string; key: Uint8Array<ArrayBuffer> } | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''))
  const deviceId = params.get('d')
  const keyId = params.get('i')
  const key = params.get('k')
  if (!deviceId || !keyId || !key) return null
  try {
    const raw = fromBase64Url(key)
    return raw.length === KEY_BYTES ? { deviceId, keyId, key: raw } : null
  } catch {
    return null
  }
}
