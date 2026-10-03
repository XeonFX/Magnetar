import { base64UrlToBytes, bytesToBase64Url } from '@codefusion-cc/workers-crypto'
import { importBrowserKey } from '@magnetar/protocol/e2e'

/**
 * This browser's keys for its linked devices. Each is stored as a non-extractable CryptoKey: page
 * script can use it for the handshake, but not read it back out, so even an XSS can't exfiltrate
 * it to decrypt traffic elsewhere.
 */
export interface StoredDeviceKey {
  deviceId: string
  keyId: string
  key: CryptoKey
  linkedAt: string
}

const DB_NAME = 'magnetar'
const STORE = 'deviceKeys'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'deviceId' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Runs one request in a transaction and resolves with its result once the transaction has committed: a request
 * can succeed and its transaction still abort (a full disk), and then nothing was stored.
 */
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = run(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = tx.onabort = () => reject(tx.error ?? request.error ?? new Error('The browser could not store the key'))
    })
  } finally {
    db.close()
  }
}

export async function saveDeviceKey(deviceId: string, keyId: string, raw: Uint8Array<ArrayBuffer>): Promise<void> {
  const key = await importBrowserKey(raw)
  const record: StoredDeviceKey = { deviceId, keyId, key, linkedAt: new Date().toISOString() }
  await transaction('readwrite', store => store.put(record))
}

export function getDeviceKey(deviceId: string): Promise<StoredDeviceKey | undefined> {
  return transaction('readonly', store => store.get(deviceId) as IDBRequest<StoredDeviceKey | undefined>)
}

export async function listDeviceKeys(): Promise<StoredDeviceKey[]> {
  return transaction('readonly', store => store.getAll() as IDBRequest<StoredDeviceKey[]>)
}

export async function forgetDeviceKey(deviceId: string): Promise<void> {
  await transaction('readwrite', store => store.delete(deviceId))
}

/**
 * A key received in a link fragment, parked for the length of a sign-in redirect. Session storage
 * is per tab and cleared when it closes; it is removed as soon as the key is imported.
 */
const PENDING = 'magnetar-pending-key'

export interface PendingKey {
  /** `pair` while waiting for a pairing approval, `link` for a device that is already paired. */
  kind: 'pair' | 'link'
  /** Pairing id or device id. */
  target: string
  keyId: string
  key: string
}

export function parkKey(kind: PendingKey['kind'], target: string, keyId: string, key: Uint8Array): void {
  sessionStorage.setItem(PENDING, JSON.stringify({ kind, target, keyId, key: bytesToBase64Url(key) } satisfies PendingKey))
}

export function parkedKey(kind: PendingKey['kind'], target: string): { keyId: string; key: Uint8Array<ArrayBuffer> } | null {
  try {
    const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null') as PendingKey | null
    if (!pending || pending.kind !== kind || pending.target !== target) return null
    const key = base64UrlToBytes(pending.key)
    return key && { keyId: pending.keyId, key }
  } catch {
    return null
  }
}

export function clearParkedKey(): void {
  sessionStorage.removeItem(PENDING)
}

/**
 * Stores the key parked for `kind` and `target` as `deviceId`'s, and lets go of the parked copy only once it is
 * stored, so a failed save can be tried again. Resolves whether a key was parked.
 */
export async function adoptParkedKey(kind: PendingKey['kind'], target: string, deviceId: string): Promise<boolean> {
  const parked = parkedKey(kind, target)
  if (!parked) return false
  await saveDeviceKey(deviceId, parked.keyId, parked.key)
  clearParkedKey()
  return true
}
