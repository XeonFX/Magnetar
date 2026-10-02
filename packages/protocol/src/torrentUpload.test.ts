import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { MAX_TORRENT_FILE, TORRENT_UPLOAD_CHUNK } from './limits.ts'
import { acceptBrowserHandshake, importBrowserKey, newBrowserKey, startBrowserHandshake } from './e2e.ts'
import { MAX_RELAY_FRAME, MAX_SEALED_FRAME } from './relay.ts'
import { torrentCalls, type TorrentCall } from './torrentUpload.ts'

const KB = 1000
const MiB = 1024 * 1024

function file(size: number, seed = 1): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1_103_515_245 + 12_345) >>> 0
    bytes[i] = x >>> 24
  }
  return bytes
}

/** What the device puts back together from the calls, checking them as it goes. */
function reassemble(calls: TorrentCall[]): Buffer {
  const last = calls.at(-1)!
  if (last.method === 'downloads.start') {
    expect(calls).toHaveLength(1)
    return Buffer.from(last.params.torrent!, 'base64')
  }
  expect(last.method).toBe('downloads.startUpload')
  const uploads = calls.slice(0, -1)
  const parts: Buffer[] = []
  let offset = 0
  for (const call of uploads) {
    if (call.method !== 'downloads.upload') throw new Error(`unexpected ${call.method}`)
    expect(call.params.uploadId).toBe(last.params.uploadId)
    expect(call.params.offset).toBe(offset)
    const part = Buffer.from(call.params.data, 'base64')
    expect(part.length).toBeGreaterThan(0)
    expect(part.length).toBeLessThanOrEqual(TORRENT_UPLOAD_CHUNK)
    offset += part.length
    parts.push(part)
  }
  for (const call of uploads) expect(call.method === 'downloads.upload' && call.params.size).toBe(offset)
  return Buffer.concat(parts)
}

/** The biggest message any of the calls makes, as the dashboard sends it (UTF-8 JSON with an id). */
const largestMessage = (calls: TorrentCall[]) =>
  Math.max(...calls.map(call => Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ...call }))))

describe('the calls that hand a .torrent file to the device', () => {
  test('send a small file (190 KB) whole, in one downloads.start, with the folder', () => {
    const bytes = file(190 * KB)
    const calls = [...torrentCalls(bytes, 'up1', '/Volumes/Media/Ubuntu')]
    expect(calls.map(c => c.method)).toEqual(['downloads.start'])
    expect(calls[0]!.params).toEqual({ torrent: Buffer.from(bytes).toString('base64'), folder: '/Volumes/Media/Ubuntu' })
  })

  test('send a file of exactly one piece whole, and one byte more in two pieces', () => {
    expect([...torrentCalls(file(TORRENT_UPLOAD_CHUNK), 'a')].map(c => c.method)).toEqual(['downloads.start'])
    const calls = [...torrentCalls(file(TORRENT_UPLOAD_CHUNK + 1), 'a')]
    expect(calls.map(c => c.method)).toEqual(['downloads.upload', 'downloads.upload', 'downloads.startUpload'])
    expect(calls.map(c => c.method === 'downloads.upload' && Buffer.from(c.params.data, 'base64').length)).toEqual([TORRENT_UPLOAD_CHUNK, 1, false])
  })

  test('send 750 KB in pieces that each fit through the relay and add up to the file', () => {
    const bytes = file(750 * KB)
    const calls = [...torrentCalls(bytes, 'up2', 'D:\\Filme')]
    expect(calls.map(c => c.method)).toEqual(['downloads.upload', 'downloads.upload', 'downloads.startUpload'])
    expect(calls.at(-1)!.params).toEqual({ uploadId: 'up2', folder: 'D:\\Filme' })
    expect(largestMessage(calls)).toBeLessThanOrEqual(MAX_RELAY_FRAME)
    expect(reassemble(calls).equals(bytes)).toBe(true)
  })

  test('send the largest file allowed (exactly 4 MiB) in pieces that each fit through the relay', () => {
    const bytes = file(MAX_TORRENT_FILE)
    expect(MAX_TORRENT_FILE).toBe(4 * MiB)
    const calls = [...torrentCalls(bytes, 'up3')]
    expect(calls).toHaveLength(Math.ceil(MAX_TORRENT_FILE / TORRENT_UPLOAD_CHUNK) + 1)
    expect(largestMessage(calls)).toBeLessThanOrEqual(MAX_RELAY_FRAME)
    expect(calls.at(-1)!.params).toEqual({ uploadId: 'up3' })
    expect(reassemble(calls).equals(bytes)).toBe(true)
  })

  test('sealed end to end, are frames the relay passes, and open in order on the device', async () => {
    const key = await importBrowserKey(newBrowserKey())
    const handshake = await startBrowserHandshake('kid', key)
    const { welcome, session: device } = await acceptBrowserHandshake(handshake.hello, key)
    const browser = await handshake.finish(welcome)
    const bytes = file(MAX_TORRENT_FILE, 7)
    const calls = [...torrentCalls(bytes, 'sealed')]
    const frames = await Promise.all(calls.map((call, id) => browser.seal({ id, ...call })))
    expect(Math.max(...frames.map(f => f.length))).toBeLessThanOrEqual(MAX_SEALED_FRAME)
    const opened = [] as TorrentCall[]
    for (const frame of frames) opened.push(await device.open(frame) as TorrentCall)
    expect(reassemble(opened).equals(bytes)).toBe(true)
  })

  test('refuse one byte over the limit, and an empty file, before making any call', () => {
    expect(() => torrentCalls(file(MAX_TORRENT_FILE + 1), 'x')).toThrow(RangeError)
    expect(() => torrentCalls(new Uint8Array(0), 'x')).toThrow(RangeError)
  })

  test('keep a folder with any characters as it is, and leave it out when there is none', () => {
    const folder = '/Users/zoë/Загрузки/映画 "x"'
    const calls = [...torrentCalls(file(TORRENT_UPLOAD_CHUNK * 2), 'id', folder)]
    expect(calls.at(-1)!.params).toEqual({ uploadId: 'id', folder })
    expect('folder' in [...torrentCalls(file(10), 'id')][0]!.params).toBe(false)
  })

  test('put any file size back together exactly, in order', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 * TORRENT_UPLOAD_CHUNK + 7 }), fc.integer(), (size, seed) => {
      const bytes = file(size, seed)
      const calls = [...torrentCalls(bytes, 'p')]
      expect(reassemble(calls).equals(bytes)).toBe(true)
      expect(largestMessage(calls)).toBeLessThanOrEqual(MAX_RELAY_FRAME)
    }), { numRuns: 12 })
  })
})
