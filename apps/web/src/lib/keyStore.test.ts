import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { adoptParkedKey, clearParkedKey, forgetDeviceKey, getDeviceKey, listDeviceKeys, parkedKey, parkKey, saveDeviceKey } from './keyStore.ts'

const PENDING = 'magnetar-pending-key'

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

describe('parked keys', () => {
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

type Outcome = 'commit' | 'abort-after-success' | 'request-error'

/**
 * IndexedDB as a browser runs it, for one database with inline keys: a request succeeds first, and the
 * transaction commits (or aborts) as a task after it. Writes become visible only once committed.
 */
function fakeIndexedDb() {
  const committed = new Map<string, Record<string, unknown>>()
  let created = false
  const next: Outcome[] = []
  const later = (run: () => void) => setTimeout(run, 0)

  function transaction() {
    const outcome = next.shift() ?? 'commit'
    const staged: (() => void)[] = []
    const tx = {
      error: null as DOMException | null,
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      objectStore: () => store,
    }
    const finish = () => later(() => {
      if (outcome === 'commit') {
        staged.forEach(apply => apply())
        tx.oncomplete?.()
      } else {
        tx.error = new DOMException('The disk is full', 'QuotaExceededError')
        tx.onabort?.()
      }
    })
    const request = <T,>(result: () => T, apply?: () => void) => {
      const req = { result: undefined as T | undefined, error: null as DOMException | null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null }
      later(() => {
        if (outcome === 'request-error') {
          req.error = new DOMException('Key already exists', 'ConstraintError')
          req.onerror?.()
          tx.error = req.error
          later(() => tx.onabort?.())
          return
        }
        if (apply) staged.push(apply)
        req.result = result()
        req.onsuccess?.()
        finish()
      })
      return req
    }
    const store = {
      put: (record: Record<string, unknown>) => request(() => record.deviceId, () => committed.set(String(record.deviceId), record)),
      get: (key: string) => request(() => committed.get(key)),
      getAll: () => request(() => [...committed.values()]),
      delete: (key: string) => request(() => undefined, () => committed.delete(key)),
    }
    return tx
  }

  const db = { transaction, close: vi.fn(), createObjectStore: vi.fn() }
  const indexedDB = {
    open: () => {
      const req = { result: db, error: null, onupgradeneeded: null as (() => void) | null, onsuccess: null as (() => void) | null, onerror: null }
      later(() => {
        if (!created) {
          created = true
          req.onupgradeneeded?.()
        }
        req.onsuccess?.()
      })
      return req
    },
  }
  return {
    indexedDB,
    db,
    committed,
    /** How the next transactions end, in order; the rest commit. */
    endNext: (...outcomes: Outcome[]) => next.push(...outcomes),
  }
}

describe('device keys in IndexedDB', () => {
  let idb: ReturnType<typeof fakeIndexedDb>
  const raw = () => Uint8Array.from({ length: 32 }, (_, i) => i)
  beforeEach(() => {
    idb = fakeIndexedDb()
    vi.stubGlobal('indexedDB', idb.indexedDB)
  })

  test('a saved key is there once the save resolves, and the database is closed', async () => {
    await saveDeviceKey('dev1', 'k_1', raw())
    expect(idb.committed.get('dev1')).toMatchObject({ deviceId: 'dev1', keyId: 'k_1' })
    expect(await getDeviceKey('dev1')).toMatchObject({ deviceId: 'dev1', keyId: 'k_1' })
    expect((await listDeviceKeys()).map(k => k.deviceId)).toEqual(['dev1'])
    expect(idb.db.close).toHaveBeenCalledTimes(3)
  })

  test('a save whose transaction aborts after its request succeeded rejects, and nothing is stored', async () => {
    idb.endNext('abort-after-success')
    await expect(saveDeviceKey('dev1', 'k_1', raw())).rejects.toThrow('The disk is full')
    expect(await getDeviceKey('dev1')).toBeUndefined()
    expect(idb.db.close).toHaveBeenCalledTimes(2)
  })

  test('a request that fails rejects with its error', async () => {
    idb.endNext('request-error')
    await expect(saveDeviceKey('dev1', 'k_1', raw())).rejects.toThrow('Key already exists')
  })

  test('forgetting a key resolves only once the deletion is committed', async () => {
    await saveDeviceKey('dev1', 'k_1', raw())
    idb.endNext('abort-after-success')
    await expect(forgetDeviceKey('dev1')).rejects.toThrow('The disk is full')
    expect(await getDeviceKey('dev1')).toBeDefined()
    await forgetDeviceKey('dev1')
    expect(await getDeviceKey('dev1')).toBeUndefined()
  })

  describe('adopting the key parked across a sign-in', () => {
    test('stores it for the device and only then lets go of the parked copy', async () => {
      parkKey('link', 'dev1', 'k_1', raw())
      expect(await adoptParkedKey('link', 'dev1', 'dev1')).toBe(true)
      expect(await getDeviceKey('dev1')).toMatchObject({ keyId: 'k_1' })
      expect(parkedKey('link', 'dev1')).toBeNull()
    })

    test('keeps the parked copy when storing fails, so a second try can still store it', async () => {
      parkKey('pair', 'pairing-1', 'k_1', raw())
      idb.endNext('abort-after-success')
      await expect(adoptParkedKey('pair', 'pairing-1', 'dev1')).rejects.toThrow('The disk is full')
      expect(parkedKey('pair', 'pairing-1')).toEqual({ keyId: 'k_1', key: raw() })
      expect(await adoptParkedKey('pair', 'pairing-1', 'dev1')).toBe(true)
      expect(await getDeviceKey('dev1')).toMatchObject({ keyId: 'k_1' })
    })

    test('stores nothing when no key is parked for that target, and leaves another target\'s key alone', async () => {
      parkKey('pair', 'pairing-2', 'k_2', raw())
      expect(await adoptParkedKey('pair', 'pairing-1', 'dev1')).toBe(false)
      expect(await getDeviceKey('dev1')).toBeUndefined()
      expect(parkedKey('pair', 'pairing-2')).not.toBeNull()
    })
  })
})
