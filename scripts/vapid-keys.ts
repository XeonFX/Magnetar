/**
 * Prints a new Web Push (VAPID) key pair for the Worker:
 *   bun scripts/vapid-keys.ts
 * Put VAPID_PUBLIC_KEY in wrangler.jsonc's vars and the private key in a secret:
 *   wrangler secret put VAPID_PRIVATE_KEY
 * For `wrangler dev`, put both lines in apps/worker/.dev.vars. Changing the pair makes every
 * browser subscribe again.
 */
import { toBase64Url } from '../packages/protocol/src/base64.ts'

const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey)
console.log(`VAPID_PUBLIC_KEY=${toBase64Url(publicKey)}`)
console.log(`VAPID_PRIVATE_KEY=${d}`)
