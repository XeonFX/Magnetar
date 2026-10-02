/**
 * Signs a release manifest: node scripts/sign-release.ts <dir-with-SHA256SUMS.txt>
 * Reads the private key from RELEASE_SIGNING_KEY and writes SHA256SUMS.txt.sig next to it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? '.'
const secret = process.env.RELEASE_SIGNING_KEY
if (!secret) throw new Error('RELEASE_SIGNING_KEY is not set')
const key = await crypto.subtle.importKey('pkcs8', Buffer.from(secret.trim(), 'base64url'), 'Ed25519', false, ['sign'])
const manifest = readFileSync(join(dir, 'SHA256SUMS.txt'))
const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, manifest))
writeFileSync(join(dir, 'SHA256SUMS.txt.sig'), Buffer.from(signature).toString('base64url') + '\n')
console.log('Signed SHA256SUMS.txt')
