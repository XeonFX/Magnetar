/**
 * Framing between the relay (a Durable Object per device) and the two ends it joins.
 *
 * Browser ↔ relay: binary frames are opaque browser↔device payloads (see e2e.ts); text frames are
 * relay status (`RelayToBrowser`).
 * Device ↔ relay: binary frames carry a 16-byte connection id and then the payload, so one device
 * socket multiplexes every browser; text frames are control messages.
 */
import { fromBase64Url, toBase64Url } from './base64.ts'

export const CONNECTION_ID_BYTES = 16
/** Largest payload the relay forwards; bigger frames close the sender. */
export const MAX_RELAY_FRAME = 1024 * 1024

export type RelayToBrowser = { t: 'device'; online: boolean }
export type RelayToDevice =
  | { t: 'open'; c: string }
  | { t: 'close'; c: string }
  | { t: 'revoked' }
export type DeviceToRelay = { t: 'close'; c: string } | { t: 'hello'; version: string; name: string }

export function wrapForDevice(connectionId: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const id = fromBase64Url(connectionId)
  if (id.length !== CONNECTION_ID_BYTES) throw new Error('Invalid connection id')
  const frame = new Uint8Array(CONNECTION_ID_BYTES + payload.length)
  frame.set(id)
  frame.set(payload, CONNECTION_ID_BYTES)
  return frame
}

export function unwrapFromDevice(frame: Uint8Array): { connectionId: string; payload: Uint8Array } {
  if (frame.length <= CONNECTION_ID_BYTES) throw new Error('Frame too short')
  return {
    connectionId: toBase64Url(frame.subarray(0, CONNECTION_ID_BYTES)),
    payload: frame.subarray(CONNECTION_ID_BYTES),
  }
}
