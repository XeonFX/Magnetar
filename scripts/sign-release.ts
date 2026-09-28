/**
 * Signs a release manifest: bun scripts/sign-release.ts <dir-with-SHA256SUMS.txt>
 * Reads the private key from RELEASE_SIGNING_KEY and writes SHA256SUMS.txt.sig next to it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromBase64Url, toBase64Url } from '../packages/protocol/src/base64.ts'

const dir = process.argv[2] ?? '.'
const secret = process.env.RELEASE_SIGNING_KEY
if (!secret) throw new Error('RELEASE_SIGNING_KEY is not set')
const key = await crypto.subtle.importKey('pkcs8', fromBase64Url(secret.trim()), 'Ed25519', false, ['sign'])
const manifest = readFileSync(join(dir, 'SHA256SUMS.txt'))
const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, manifest))
writeFileSync(join(dir, 'SHA256SUMS.txt.sig'), toBase64Url(signature) + '\n')
console.log('Signed SHA256SUMS.txt')
