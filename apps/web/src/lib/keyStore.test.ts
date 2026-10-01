import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { clearParkedKey, parkedKey, parkKey } from './keyStore.ts'

const PENDING = 'magnetar-pending-key'

describe('parked keys', () => {
  let stored: Map<string, string>
  beforeEach(() => {
    stored = new Map()
    vi.stubGlobal('sessionStorage', {
      getItem: (name: string) => stored.get(name) ?? null,
      setItem: (name: string, value: string) => stored.set(name, value),
      removeItem: (name: string) => stored.delete(name),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  test('give back the key parked for the same kind and target, until cleared', () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
    parkKey('pair', 'pairing-1', 'k_1', key)
    expect(parkedKey('pair', 'pairing-1')).toEqual({ keyId: 'k_1', key })
    expect(parkedKey('link', 'pairing-1')).toBeNull()
    expect(parkedKey('pair', 'pairing-2')).toBeNull()
    clearParkedKey()
    expect(parkedKey('pair', 'pairing-1')).toBeNull()
  })

  test('give nothing for a parked key that is not base64url, or for storage that is not JSON', () => {
    for (const key of ['not base64url!', 'AAAA=', 'A', 5]) {
      stored.set(PENDING, JSON.stringify({ kind: 'pair', target: 'pairing-1', keyId: 'k_1', key }))
      expect(parkedKey('pair', 'pairing-1'), String(key)).toBeNull()
    }
    stored.set(PENDING, '{')
    expect(parkedKey('pair', 'pairing-1')).toBeNull()
  })
})
