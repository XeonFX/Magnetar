import { MAX_RELAY_FRAME } from '@magnetar/protocol/relay'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LocalConnection } from './localConnection.ts'
import { RpcError } from './rpcClient.ts'

/** The browser's WebSocket, as far as the local connection uses it. */
class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static all: FakeSocket[] = []
  readyState = FakeSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }

  send(data: string): void {
    // A real socket that is closing drops what it is given without a word.
    if (this.readyState === FakeSocket.OPEN) this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED
  }

  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  answer(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  drop(): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code: 1006 })
  }
}

let socket: FakeSocket
let connection: LocalConnection

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:47820' })
  connection = new LocalConnection()
  socket = FakeSocket.all[0]!
  socket.open()
})

afterEach(() => {
  connection.close()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Settles within the current turn, without any timer running: "at once", not "after the 2-minute timeout". */
async function settledNow<T>(promise: Promise<T>): Promise<{ value?: T; error?: RpcError }> {
  let outcome: { value?: T; error?: RpcError } | null = null
  promise.then(value => { outcome = { value } }, (error: RpcError) => { outcome = { error } })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  if (!outcome) throw new Error('still waiting')
  return outcome
}

/** Params whose message, as sent, is exactly `bytes` long in UTF-8. */
function paramsOfSize(bytes: number, fill = 'a'): { magnet: string } {
  const envelope = Buffer.byteLength(JSON.stringify({ id: 1, method: 'downloads.start', params: { magnet: '' } }))
  const unit = Buffer.byteLength(fill)
  return { magnet: fill.repeat(Math.floor((bytes - envelope) / unit)) + 'a'.repeat((bytes - envelope) % unit) }
}

describe('a call to the device', () => {
  test('of exactly the largest message size is sent', async () => {
    connection.call('downloads.start', paramsOfSize(MAX_RELAY_FRAME)).catch(() => {})
    expect(socket.sent).toHaveLength(1)
    expect(Buffer.byteLength(socket.sent[0]!)).toBe(MAX_RELAY_FRAME)
  })

  test('one byte larger is refused at once and never sent, and the connection carries on', async () => {
    const { error } = await settledNow(connection.call('downloads.start', paramsOfSize(MAX_RELAY_FRAME + 1)))
    expect(error).toBeInstanceOf(RpcError)
    expect(error!.code).toBe('too_large')
    expect(socket.sent).toHaveLength(0)

    const next = connection.call('app.info')
    socket.answer({ id: JSON.parse(socket.sent[0]!).id, result: { version: '1.1.0' } })
    expect(await next).toEqual({ version: '1.1.0' })
  })

  test('is measured in bytes, not characters', async () => {
    // Under the limit in characters, over it in UTF-8.
    const params = paramsOfSize(MAX_RELAY_FRAME + 2, 'é')
    expect(JSON.stringify(params).length).toBeLessThan(MAX_RELAY_FRAME)
    expect((await settledNow(connection.call('downloads.start', params))).error!.code).toBe('too_large')
  })

  test('counts characters outside the BMP as their four UTF-8 bytes', async () => {
    connection.call('downloads.start', paramsOfSize(MAX_RELAY_FRAME, '😀')).catch(() => {})
    expect(Buffer.byteLength(socket.sent[0]!)).toBe(MAX_RELAY_FRAME)
    expect((await settledNow(connection.call('downloads.start', paramsOfSize(MAX_RELAY_FRAME + 1, '😀')))).error!.code).toBe('too_large')
  })

  test('fails at once when the socket closes before the answer', async () => {
    const pending = connection.call('downloads.upload', { uploadId: 'u', offset: 0, size: 10, data: 'AAAA' })
    socket.drop()
    const { error } = await settledNow(pending)
    expect(error!.code).toBe('offline')
    expect(connection.state.status).toBe('reconnecting')
  })

  test('fails at once when the socket is already closing and the send goes nowhere', async () => {
    socket.readyState = FakeSocket.CLOSING
    const { error } = await settledNow(connection.call('app.info'))
    expect(error!.code).toBe('offline')
  })

  test('nobody answers: fails after two minutes, not before', async () => {
    let error: RpcError | null = null
    connection.call('app.info').catch((e: RpcError) => { error = e })
    await vi.advanceTimersByTimeAsync(119_999)
    expect(error).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(error!.code).toBe('timeout')
  })

  test('while not connected is refused at once', async () => {
    socket.drop()
    expect((await settledNow(connection.call('app.info'))).error!.code).toBe('offline')
  })
})
