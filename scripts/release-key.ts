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

const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64url')
writeFileSync(join(import.meta.dirname, '..', 'apps', 'client', 'release-public-key.txt'), publicKey + '\n')
console.log('Wrote apps/client/release-public-key.txt — commit it.')
console.log('\nStore this as the RELEASE_SIGNING_KEY repository secret, then forget it:\n')
console.log(privateKey)
