import type { Database } from 'bun:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Encrypts secrets at rest (SMTP password, bot token, agent token, device token, browser keys)
 * with AES-256-GCM under a key kept in its own owner-only file beside the database. A copied
 * database alone reveals none of them.
 */
export class SecretBox {
  private readonly key: Buffer

  constructor(keyPath: string) {
    if (!existsSync(keyPath)) {
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' })
    }
    const key = readFileSync(keyPath)
    if (key.length !== 32) throw new Error(`${keyPath} is not a 32-byte key`)
    if (process.platform !== 'win32') chmodSync(keyPath, 0o600)
    this.key = key
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return ['v1', iv.toString('base64'), body.toString('base64'), cipher.getAuthTag().toString('base64')].join(':')
  }

  open(sealed: string): string {
    const [version, iv, body, tag] = sealed.split(':')
    if (version !== 'v1' || !iv || body === undefined || !tag) throw new Error('Unrecognised secret format')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
  }
}

export type SecretName = 'smtpPassword' | 'telegramBotToken' | 'agentApiToken' | 'deviceToken'

/** Named secrets in the `secrets` table, sealed by a SecretBox. */
export class SecretStore {
  constructor(private readonly db: Database, private readonly box: SecretBox) {}

  get(name: SecretName): string {
    const row = this.db.query('SELECT value FROM secrets WHERE name = ?').get(name) as { value: string } | null
    if (!row) return ''
    try {
      return this.box.open(row.value)
    } catch {
      return '' // a key file replaced underneath us: treat as unset rather than crash
    }
  }

  set(name: SecretName, value: string): void {
    if (!value) this.db.query('DELETE FROM secrets WHERE name = ?').run(name)
    else this.db.query('INSERT INTO secrets (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
      .run(name, this.box.seal(value))
  }

  has(name: SecretName): boolean {
    return this.get(name) !== ''
  }
}
