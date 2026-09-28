import { describe, expect, test } from 'bun:test'
import {
  acceptBrowserHandshake, decodeHandshake, encodeHandshake, importBrowserKey, linkFragment, newBrowserKey,
  parseLinkFragment, startBrowserHandshake, type E2ESession,
} from './e2e.ts'
import { toBase64Url } from './base64.ts'

async function pair(): Promise<{ browser: E2ESession; device: E2ESession }> {
  const raw = newBrowserKey()
  const browserKey = await importBrowserKey(raw)
  const deviceKey = await importBrowserKey(raw.slice())
  const pending = await startBrowserHandshake('kid-1', browserKey)
  const { welcome, session: device } = await acceptBrowserHandshake(pending.hello, deviceKey)
  const browser = await pending.finish(welcome)
  return { browser, device }
}

describe('e2e handshake', () => {
  test('both sides derive working keys in both directions', async () => {
    const { browser, device } = await pair()
    expect(await device.open(await browser.seal({ id: 1, method: 'downloads.list' }))).toEqual({ id: 1, method: 'downloads.list' })
    expect(await browser.open(await device.seal({ id: 1, result: [] }))).toEqual({ id: 1, result: [] })
  })

  test('a device with a different key cannot complete the handshake', async () => {
    const pending = await startBrowserHandshake('kid-1', await importBrowserKey(newBrowserKey()))
    const { welcome } = await acceptBrowserHandshake(pending.hello, await importBrowserKey(newBrowserKey()))
    await expect(pending.finish(welcome)).rejects.toThrow(/could not prove/)
  })

  test('a relay that swaps the device ephemeral key is detected', async () => {
    const raw = newBrowserKey()
    const pending = await startBrowserHandshake('kid-1', await importBrowserKey(raw))
    const { welcome } = await acceptBrowserHandshake(pending.hello, await importBrowserKey(raw.slice()))
    // A man in the middle answering with its own key pair, without K.
    const { welcome: forged } = await acceptBrowserHandshake(pending.hello, await importBrowserKey(newBrowserKey()))
    await expect(pending.finish({ ...welcome, epk: forged.epk })).rejects.toThrow()
  })

  test('frames are rejected when replayed, reordered or tampered with', async () => {
    const { browser, device } = await pair()
    const first = await browser.seal('a')
    const second = await browser.seal('b')
    await expect(device.open(second)).rejects.toThrow(/Out-of-sequence/)
    expect(await device.open(first)).toBe('a')
    await expect(device.open(first)).rejects.toThrow(/Out-of-sequence/)
    const tampered = second.slice()
    tampered[tampered.length - 1]! ^= 1
    await expect(device.open(tampered)).rejects.toThrow()
    expect(await device.open(second)).toBe('b')
  })

  test('frames from one connection do not open in another', async () => {
    const raw = newBrowserKey()
    const key = await importBrowserKey(raw)
    const connect = async () => {
      const pending = await startBrowserHandshake('kid', key)
      const { welcome, session } = await acceptBrowserHandshake(pending.hello, key)
      return { browser: await pending.finish(welcome), device: session }
    }
    const one = await connect()
    const two = await connect()
    await expect(two.device.open(await one.browser.seal('x'))).rejects.toThrow()
  })

  test('concurrent seals keep counter order', async () => {
    const { browser, device } = await pair()
    const frames = await Promise.all(Array.from({ length: 20 }, (_, i) => browser.seal(i)))
    for (let i = 0; i < 20; i++) expect(await device.open(frames[i]!)).toBe(i)
  })
})

describe('handshake framing', () => {
  test('round-trips', () => {
    const message = { t: 'reject', reason: 'unknown-key' } as const
    expect(decodeHandshake(encodeHandshake(message))).toEqual(message)
  })
})

describe('link fragments', () => {
  test('round-trip a key without it reaching the query string', () => {
    const key = newBrowserKey()
    const fragment = linkFragment('dev_1', 'k_1', key)
    const parsed = parseLinkFragment('#' + fragment)
    expect(parsed?.deviceId).toBe('dev_1')
    expect(toBase64Url(parsed!.key)).toBe(toBase64Url(key))
  })

  test('reject a key of the wrong length', () => {
    expect(parseLinkFragment('d=a&i=b&k=AAAA')).toBeNull()
  })
})
