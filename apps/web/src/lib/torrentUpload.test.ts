import type { ClientMessage, DownloadDto } from '@magnetar/protocol'
import { MAX_TORRENT_FILE, TORRENT_UPLOAD_CHUNK } from '@magnetar/protocol/limits'
import { MAX_RELAY_FRAME } from '@magnetar/protocol/relay'
import { describe, expect, test } from 'vitest'
import { RpcClient } from './rpcClient.ts'
import { sendTorrent } from './torrentUpload.ts'

const KB = 1000

function file(size: number, seed = 1): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1_103_515_245 + 12_345) >>> 0
    bytes[i] = x >>> 24
  }
  return bytes
}

type Call = { method: string; params: Record<string, unknown> }

/**
 * A device on the other end of the connection, answering a turn later as a socket would: it puts
 * uploads back together the way the app does and records what it started.
 */
class Device extends RpcClient {
  calls: Call[] = []
  largest = 0
  started: Uint8Array[] = []
  private uploads = new Map<string, { size: number; parts: Buffer[]; received: number }>()
  /** Answer a call with this instead, by method. */
  refuse: Record<string, { code: string; message: string }> = {}
  /** Drop the connection when this call arrives (0 = the first). */
  dropAt = -1

  constructor() {
    super()
    this.setState({ status: 'open' })
  }

  protected transmit(text: string): void {
    const message = JSON.parse(text) as ClientMessage
    const call = { method: message.method, params: message.params as Record<string, unknown> }
    this.largest = Math.max(this.largest, Buffer.byteLength(text))
    if (this.calls.push(call) - 1 === this.dropAt) {
      queueMicrotask(() => this.setState({ status: 'reconnecting' }))
      return
    }
    setTimeout(() => {
      const refusal = this.refuse[call.method]
      if (refusal) return this.receive({ id: message.id, error: refusal })
      this.receive({ id: message.id, result: this.answer(call) })
    })
  }

  private answer({ method, params }: Call): unknown {
    if (method === 'downloads.start') return this.start(Buffer.from(params.torrent as string, 'base64'))
    const id = params.uploadId as string
    if (method === 'downloads.upload') {
      const data = Buffer.from(params.data as string, 'base64')
      const upload = params.offset === 0 ? { size: params.size as number, parts: [], received: 0 } : this.uploads.get(id)!
      expect(params.offset).toBe(upload.received)
      upload.parts.push(data)
      upload.received += data.length
      this.uploads.set(id, upload)
      return { received: upload.received }
    }
    const upload = this.uploads.get(id)!
    this.uploads.delete(id)
    expect(upload.received).toBe(upload.size)
    return this.start(Buffer.concat(upload.parts))
  }

  private start(bytes: Uint8Array): DownloadDto {
    this.started.push(bytes)
    return { id: this.started.length, name: `Torrent ${this.started.length}` } as DownloadDto
  }

  close(): void {}
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))

describe('sending a .torrent file to the device', () => {
  test('190 KB goes in one call, as any version of the app takes it', async () => {
    const device = new Device()
    const bytes = file(190 * KB)
    const download = await sendTorrent(device, bytes, '/media')
    expect(download.id).toBe(1)
    expect(device.calls.map(c => c.method)).toEqual(['downloads.start'])
    expect(device.calls[0]!.params.folder).toBe('/media')
    expect(same(device.started[0]!, bytes)).toBe(true)
  })

  test('750 KB arrives whole, in pieces each small enough for the relay, and reports its progress', async () => {
    const device = new Device()
    const bytes = file(750 * KB)
    const progress: number[] = []
    await sendTorrent(device, bytes, undefined, sent => progress.push(sent))
    expect(device.calls.map(c => c.method)).toEqual(['downloads.upload', 'downloads.upload', 'downloads.startUpload'])
    expect(device.largest).toBeLessThanOrEqual(MAX_RELAY_FRAME)
    expect(same(device.started[0]!, bytes)).toBe(true)
    expect(progress).toEqual([TORRENT_UPLOAD_CHUNK, 750 * KB])
  })

  test('exactly 4 MiB arrives whole', async () => {
    const device = new Device()
    const bytes = file(MAX_TORRENT_FILE)
    await sendTorrent(device, bytes)
    expect(device.calls.filter(c => c.method === 'downloads.upload')).toHaveLength(MAX_TORRENT_FILE / TORRENT_UPLOAD_CHUNK)
    expect(device.largest).toBeLessThanOrEqual(MAX_RELAY_FRAME)
    expect(same(device.started[0]!, bytes)).toBe(true)
  })

  test('4 MiB and one byte is refused without calling the device', async () => {
    const device = new Device()
    await expect(sendTorrent(device, file(MAX_TORRENT_FILE + 1))).rejects.toMatchObject({ code: 'too_large' })
    expect(device.calls).toEqual([])
  })

  test('two files at once each arrive whole, under their own upload ids', async () => {
    const device = new Device()
    const one = file(900 * KB, 1)
    const two = file(1_300 * KB, 2)
    const [a, b] = await Promise.all([sendTorrent(device, one), sendTorrent(device, two)])
    expect(new Set([a.id, b.id]).size).toBe(2)
    const ids = new Set(device.calls.map(c => c.params.uploadId))
    expect(ids.size).toBe(2)
    // The pieces of the two really did interleave.
    expect(device.calls[0]!.params.uploadId).not.toBe(device.calls[1]!.params.uploadId)
    expect(device.started.some(s => same(s, one)) && device.started.some(s => same(s, two))).toBe(true)
  })

  test('a piece the device refuses ends the upload with its reason, and nothing more is sent', async () => {
    const device = new Device()
    device.refuse['downloads.upload'] = { code: 'bad_request', message: 'That .torrent file is larger than 4 MB.' }
    await expect(sendTorrent(device, file(2_000 * KB))).rejects.toMatchObject({ code: 'bad_request', message: 'That .torrent file is larger than 4 MB.' })
    expect(device.calls.map(c => c.method)).toEqual(['downloads.upload'])
  })

  test('a connection that drops mid-upload ends it at once, and nothing more is sent', async () => {
    const device = new Device()
    device.dropAt = 1
    await expect(sendTorrent(device, file(2_000 * KB))).rejects.toMatchObject({ code: 'offline' })
    expect(device.calls).toHaveLength(2)
    expect(device.started).toEqual([])
  })

  test('an app too old for uploads in pieces says it needs an update', async () => {
    const device = new Device()
    device.refuse['downloads.upload'] = { code: 'not_found', message: 'Unknown method downloads.upload' }
    await expect(sendTorrent(device, file(600 * KB))).rejects.toMatchObject({ code: 'update_needed' })
  })
})
