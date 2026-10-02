/**
 * Framing between the relay (a Durable Object per device) and the two ends it joins.
 *
 * Browser ↔ relay: binary frames are opaque browser↔device payloads (see e2e.ts); text frames are
 * relay status (`RelayToBrowser`).
 * Device ↔ relay: binary frames carry a 16-byte connection id and then the payload, so one device
 * socket multiplexes every browser; text frames are control messages.
 */
import { base64UrlToBytes, bytesToBase64Url } from '@codefusion-cc/workers-crypto'

export const CONNECTION_ID_BYTES = 16
/** Largest message the dashboard sends, the same through the relay and on the app's own socket. */
export const MAX_RELAY_FRAME = 1024 * 1024
/** Largest payload the relay forwards: a message of MAX_RELAY_FRAME, sealed. Bigger frames close the sender. */
export const MAX_SEALED_FRAME = MAX_RELAY_FRAME + 64

/** WebSocket close codes each side acts on. */
export const RELAY_CLOSE = {
  /** A newer device connection took over. */
  replaced: 4000,
  /** The device was removed from its account: it forgets its pairing. */
  deviceRemoved: 4001,
  /** The device dropped this browser (a revoked key, a failed handshake); the browser may retry. */
  closedByDevice: 4002,
  /** The device is not on this account: the browser stops retrying. */
  notOnAccount: 4003,
} as const

/** Keepalive, answered by the relay without waking it. */
export const RELAY_PING = '{"t":"ping"}'
export const RELAY_PONG = '{"t":"pong"}'

export type RelayToBrowser = { t: 'device'; online: boolean }
export type RelayToDevice =
  | { t: 'open'; c: string }
  | { t: 'close'; c: string }
  | { t: 'revoked' }
  /** The device's name on the account, when it is not the one the device said hello with. */
  | { t: 'name'; name: string }
export type DeviceToRelay = { t: 'close'; c: string } | { t: 'hello'; version: string; name: string }

export function wrapForDevice(connectionId: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const id = base64UrlToBytes(connectionId)
  if (id?.length !== CONNECTION_ID_BYTES) throw new Error('Invalid connection id')
  const frame = new Uint8Array(CONNECTION_ID_BYTES + payload.length)
  frame.set(id)
  frame.set(payload, CONNECTION_ID_BYTES)
  return frame
}

export function unwrapFromDevice(frame: Uint8Array): { connectionId: string; payload: Uint8Array } {
  if (frame.length <= CONNECTION_ID_BYTES) throw new Error('Frame too short')
  return {
    connectionId: bytesToBase64Url(frame.subarray(0, CONNECTION_ID_BYTES)),
    payload: frame.subarray(CONNECTION_ID_BYTES),
  }
}
