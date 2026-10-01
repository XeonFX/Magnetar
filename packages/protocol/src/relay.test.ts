import { describe, expect, test } from 'vitest'
import { CONNECTION_ID_BYTES, unwrapFromDevice, wrapForDevice } from './relay.ts'

describe('device frames', () => {
  test('carry the connection id ahead of the payload, and back', () => {
    const connectionId = 'AAECAwQFBgcICQoLDA0ODw'
    const frame = wrapForDevice(connectionId, new Uint8Array([7, 8]))
    expect([...frame]).toEqual([...Array.from({ length: CONNECTION_ID_BYTES }, (_, i) => i), 7, 8])
    const { connectionId: id, payload } = unwrapFromDevice(frame)
    expect(id).toBe(connectionId)
    expect([...payload]).toEqual([7, 8])
  })

  test('refuse a connection id that is not 16 bytes of base64url', () => {
    for (const connectionId of ['', 'AAECAwQFBgcICQoLDA0O', 'AAECAwQFBgcICQoLDA0ODxA', 'AAECAwQFBgcICQoLDA0O+w', 'AAECAwQFBgcICQoLDA0ODw==']) {
      expect(() => wrapForDevice(connectionId, new Uint8Array(1)), connectionId).toThrow('Invalid connection id')
    }
  })
})
