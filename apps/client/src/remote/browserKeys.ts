import type { Database } from 'bun:sqlite'
import type { LinkedBrowserDto } from '@md/protocol'
import { fromBase64Url, randomId, toBase64Url } from '@md/protocol/base64'
import { importBrowserKey, newBrowserKey } from '@md/protocol/e2e'
import type { SecretBox } from '../db/secrets.ts'

interface KeyRow {
  key_id: string
  key: string
  label: string
  created_at: string
  last_seen_at: string | null
  active: number
}

/**
 * The keys of browsers allowed to reach this device through the relay, sealed at rest. A key is
 * minted here and leaves only inside a link fragment, so the relay never holds one.
 */
export class BrowserKeyStore {
  constructor(private readonly db: Database, private readonly box: SecretBox) {}

  /** Mints a key; `active` false keeps it unusable until pairing completes. */
  mint(label: string, active = true): { keyId: string; key: Uint8Array } {
    const keyId = randomId(9)
    const key = newBrowserKey()
    this.db.query('INSERT INTO browser_keys (key_id, key, label, created_at, active) VALUES (?, ?, ?, ?, ?)')
      .run(keyId, this.box.seal(toBase64Url(key)), label, new Date().toISOString(), active ? 1 : 0)
    return { keyId, key }
  }

  activate(keyId: string): void {
    this.db.query('UPDATE browser_keys SET active = 1 WHERE key_id = ?').run(keyId)
  }

  /** The key for a handshake, or null when unknown, inactive or revoked. */
  async lookup(keyId: string): Promise<CryptoKey | null> {
    const row = this.db.query('SELECT * FROM browser_keys WHERE key_id = ? AND active = 1').get(keyId) as KeyRow | null
    if (!row) return null
    try {
      return await importBrowserKey(fromBase64Url(this.box.open(row.key)))
    } catch {
      return null
    }
  }

  touch(keyId: string): void {
    this.db.query('UPDATE browser_keys SET last_seen_at = ? WHERE key_id = ?').run(new Date().toISOString(), keyId)
  }

  revoke(keyId: string): void {
    this.db.query('DELETE FROM browser_keys WHERE key_id = ?').run(keyId)
  }

  revokeInactive(): void {
    this.db.query('DELETE FROM browser_keys WHERE active = 0').run()
  }

  revokeAll(): void {
    this.db.query('DELETE FROM browser_keys').run()
  }

  list(): LinkedBrowserDto[] {
    return (this.db.query('SELECT * FROM browser_keys WHERE active = 1 ORDER BY created_at').all() as KeyRow[])
      .map(row => ({ keyId: row.key_id, label: row.label, createdAt: row.created_at, lastSeenAt: row.last_seen_at }))
  }
}
