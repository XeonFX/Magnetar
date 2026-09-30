/**
 * Generates the Ed25519 key pair that signs release manifests. Run once:
 *
 *   node scripts/release-key.ts
 *
 * Commit the public key file it writes; store the private key as the GitHub Actions secret
 * RELEASE_SIGNING_KEY (it is printed once and written nowhere). Installed apps only accept updates
 * whose SHA256SUMS.txt is signed by this key.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { toBase64Url } from '../packages/protocol/src/base64.ts'

const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
const privateKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)))
writeFileSync(join(import.meta.dirname, '..', 'apps', 'client', 'release-public-key.txt'), publicKey + '\n')
console.log('Wrote apps/client/release-public-key.txt — commit it.')
console.log('\nStore this as the RELEASE_SIGNING_KEY repository secret, then forget it:\n')
console.log(privateKey)
