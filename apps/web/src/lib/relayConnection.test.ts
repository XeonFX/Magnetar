import { RELAY_CLOSE } from '@magnetar/protocol/relay'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { StoredDeviceKey } from './keyStore.ts'
import { RelayConnection } from './relayConnection.ts'

/** The browser's WebSocket, as far as the relay connection uses it before a handshake. */
class FakeSocket {
  static readonly OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }

  send(): void {}
  close(): void {}

  /** The relay closes the connection with `code`. */
  closedBy(code: number): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const key = { deviceId: 'dev1', keyId: 'key1', key: {} as CryptoKey, linkedAt: '' } satisfies StoredDeviceKey
let connection: RelayConnection

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('location', { protocol: 'https:', host: 'magnetar.codefusion.cc' })
  connection = new RelayConnection('dev1', key)
})

afterEach(() => {
  connection.close()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a dashboard on the relay when the relay closes it', () => {
  test.each([
    [RELAY_CLOSE.signedOut, 'remote.signedOut'],
    [RELAY_CLOSE.notOnAccount, 'remote.removed'],
  ])('code %i: says why and stops retrying', (code, reason) => {
    FakeSocket.all[0]!.closedBy(code)
    expect(connection.state).toEqual({ status: 'rejected', reason })
    vi.advanceTimersByTime(10 * 60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  test.each([1006, 1012, RELAY_CLOSE.closedByDevice])('code %i: reconnects', code => {
    FakeSocket.all[0]!.closedBy(code)
    expect(connection.state).toEqual({ status: 'reconnecting' })
    vi.advanceTimersByTime(10 * 60_000)
    expect(FakeSocket.all.length).toBeGreaterThan(1)
    expect(FakeSocket.all[1]!.url).toBe('wss://magnetar.codefusion.cc/api/devices/dev1/connect')
  })
})
