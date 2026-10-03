import { afterEach, describe, expect, test, vi } from 'vitest'
import { encryptPayload } from '@codefusion-cc/web-push'
import { testBrowser } from '@codefusion-cc/web-push/testing'
import { base64UrlToBytes, bytesToBase64Url } from '@codefusion-cc/workers-crypto'
// Sealed by the app's Rust encryption from fixed keys and salt (apps/client/src/protocol/webpush.rs holds it to the
// same file): what the device sends, a browser must read, and the TypeScript sender must produce byte for byte.
import vector from '../../../../packages/protocol/src/webpush-vector.json'

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }

function bytes(text: string): Uint8Array<ArrayBuffer> {
  const decoded = base64UrlToBytes(text, { padded: true })
  if (!decoded) throw new Error(`not base64url: ${text}`)
  return decoded as Uint8Array<ArrayBuffer>
}

/** The key pair whose private half is `d` and public half the uncompressed point `point`. */
async function keyPair(d: string, point: string): Promise<CryptoKeyPair> {
  const raw = bytes(point)
  const jwk = { kty: 'EC', crv: 'P-256', d, x: bytesToBase64Url(raw.subarray(1, 33)), y: bytesToBase64Url(raw.subarray(33)) }
  return {
    privateKey: await crypto.subtle.importKey('jwk', jwk, ECDH, true, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('raw', raw, ECDH, true, []),
  }
}

/** The next key generated is `pair`, and the next random bytes are `random`: the vector's fixed inputs. */
function fixRandomness(pair: CryptoKeyPair, random: Uint8Array) {
  vi.spyOn(crypto.subtle, 'generateKey').mockResolvedValueOnce(pair as never)
  vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(<T extends ArrayBufferView | null>(array: T): T => {
    new Uint8Array(array!.buffer, array!.byteOffset, array!.byteLength).set(random)
    return array
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Web Push encryption shared with the app (RFC 8291, aes128gcm)', () => {
  test('a browser reads what the app sealed for it', async () => {
    fixRandomness(await keyPair(vector.receiverPrivateKey, vector.p256dh), bytes(vector.auth))
    const browser = await testBrowser()
    expect(browser.subscription).toMatchObject({ p256dh: vector.p256dh, auth: vector.auth })
    const read = await browser.read(bytes(vector.body))
    expect(read.text).toBe(vector.plaintext)
    expect(read.recordSize).toBe(4096)
    expect(read.keyLength).toBe(65)
    expect(await browser.json(bytes(vector.body))).toMatchObject({ title: 'Download finished', body: 'Ünïcødé ✓ 🎉' })
  })

  test('a body changed on the way is refused', async () => {
    fixRandomness(await keyPair(vector.receiverPrivateKey, vector.p256dh), bytes(vector.auth))
    const browser = await testBrowser()
    const tampered = bytes(vector.body)
    tampered[tampered.length - 1]! ^= 1
    await expect(browser.read(tampered)).rejects.toThrow()
  })

  test('the TypeScript sender seals the same input to the same bytes', async () => {
    fixRandomness(await keyPair(vector.senderPrivateKey, vector.senderPublicKey), bytes(vector.salt))
    const body = await encryptPayload({ p256dh: vector.p256dh, auth: vector.auth }, vector.plaintext)
    expect(bytesToBase64Url(body)).toBe(vector.body)
  })
})
