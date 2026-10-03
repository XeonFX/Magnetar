import type { DownloadFileDto } from '@magnetar/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RpcClient } from './rpcClient.ts'
import { loadSubtitles, srtToVtt } from './streaming.ts'

describe('subtitles', () => {
  test('SubRip becomes WebVTT with dotted milliseconds, whatever the line endings', () => {
    const srt = '﻿1\r\n00:00:01,500 --> 00:00:03,250\r\nHello, world\r\n\r\n2\r\n01:02:03,004 --> 01:02:04,000\r\nBye\r\n'
    expect(srtToVtt(srt)).toBe('WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.250\nHello, world\n\n2\n01:02:03.004 --> 01:02:04.000\nBye\n')
  })

  test('commas in the text itself are left alone', () => {
    expect(srtToVtt('1\n00:00:01,000 --> 00:00:02,000\nWait, 12:34:56,789 is a time')).toContain('Wait, 12:34:56,789 is a time')
  })
})

/** A promise settled from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const file = (index: number, path: string): DownloadFileDto => ({ index, path, size: 10, done: 10, selected: true, media: null } as unknown as DownloadFileDto)

describe('loading subtitles through the relay', () => {
  /** `stream.open` calls waiting for the device, by file index. */
  let opening: Map<number, ReturnType<typeof deferred<{ streamId: string; size: number; type: string }>>>
  /** Fetches of stream URLs waiting for their bytes, in order. */
  let fetching: { url: string; signal: AbortSignal | undefined; answer: ReturnType<typeof deferred<Response>> }[]
  let calls: { method: string; params: unknown }[]
  let made: string[]
  let revoked: string[]
  let connection: RpcClient

  beforeEach(() => {
    opening = new Map()
    fetching = []
    calls = []
    made = []
    revoked = []
    connection = {
      kind: 'remote',
      call: (method: string, params: { index?: number }) => {
        calls.push({ method, params })
        if (method === 'stream.open') {
          const open = deferred<{ streamId: string; size: number; type: string }>()
          opening.set(params.index!, open)
          return open.promise
        }
        return Promise.resolve(null)
      },
    } as unknown as RpcClient
    // The page's service worker is there and controls it.
    vi.stubGlobal('navigator', {
      serviceWorker: { register: async () => ({}), ready: Promise.resolve(), controller: {}, addEventListener: () => {} },
    })
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const answer = deferred<Response>()
      // Like a browser: aborting rejects the fetch... unless it already has its answer.
      init?.signal?.addEventListener('abort', () => answer.reject(new DOMException('Aborted', 'AbortError')))
      fetching.push({ url, signal: init?.signal ?? undefined, answer })
      return answer.promise
    })
    let n = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const url = `blob:test/${++n}`
      made.push(url)
      return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => { revoked.push(url) })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const closed = () => calls.filter(c => c.method === 'stream.close').map(c => (c.params as { streamId: string }).streamId)

  test('each subtitle becomes a WebVTT track, and its stream is closed once read', async () => {
    const loading = loadSubtitles(connection, 7, [file(1, 'Show/Movie.en.srt'), file(2, 'Show/Movie.de.vtt')], new AbortController().signal)
    await settle()
    opening.get(1)!.resolve({ streamId: 's1', size: 10, type: 'text/plain' })
    opening.get(2)!.resolve({ streamId: 's2', size: 10, type: 'text/vtt' })
    await settle()
    expect(fetching.map(f => f.url)).toEqual([expect.stringMatching(/^\/__stream\/.+\/Movie\.en\.srt$/), expect.stringMatching(/^\/__stream\/.+\/Movie\.de\.vtt$/)])
    fetching[0]!.answer.resolve(new Response('1\n00:00:01,000 --> 00:00:02,000\nHi'))
    fetching[1]!.answer.resolve(new Response('WEBVTT\n\nHallo'))
    const tracks = await loading
    expect(tracks).toEqual([{ file: file(1, 'Show/Movie.en.srt'), url: 'blob:test/1' }, { file: file(2, 'Show/Movie.de.vtt'), url: 'blob:test/2' }])
    expect(closed().sort()).toEqual(['s1', 's2'])
    expect(revoked).toEqual([])
  })

  test('a subtitle that cannot be read is left out, the others still load', async () => {
    const loading = loadSubtitles(connection, 7, [file(1, 'a.srt'), file(2, 'b.srt')], new AbortController().signal)
    await settle()
    opening.get(1)!.reject(new Error('The device did not answer'))
    opening.get(2)!.resolve({ streamId: 's2', size: 10, type: '' })
    await settle()
    fetching[0]!.answer.resolve(new Response('text'))
    expect((await loading).map(t => t.file.index)).toEqual([2])
    expect(closed()).toEqual(['s2'])
  })

  test('closed while a stream is still opening: the stream is closed as soon as it opens, and nothing is fetched', async () => {
    const abort = new AbortController()
    const loading = loadSubtitles(connection, 7, [file(1, 'a.srt')], abort.signal)
    await settle()
    abort.abort()
    opening.get(1)!.resolve({ streamId: 's1', size: 10, type: '' })
    expect(await loading).toEqual([])
    expect(fetching).toEqual([])
    expect(closed()).toEqual(['s1'])
    expect(made).toEqual([])
  })

  test('closed while a subtitle is being read: the read is aborted, its stream closed and no URL kept', async () => {
    const abort = new AbortController()
    const loading = loadSubtitles(connection, 7, [file(1, 'a.srt')], abort.signal)
    await settle()
    opening.get(1)!.resolve({ streamId: 's1', size: 10, type: '' })
    await settle()
    expect(fetching[0]!.signal).toBe(abort.signal)
    abort.abort()
    expect(await loading).toEqual([])
    expect(closed()).toEqual(['s1'])
    expect(made.filter(url => !revoked.includes(url))).toEqual([])
  })

  test('closed between two subtitles: the one already made is let go of too', async () => {
    const abort = new AbortController()
    const loading = loadSubtitles(connection, 7, [file(1, 'a.srt'), file(2, 'b.srt')], abort.signal)
    await settle()
    opening.get(1)!.resolve({ streamId: 's1', size: 10, type: '' })
    await settle()
    fetching[0]!.answer.resolve(new Response('one'))
    await settle()
    expect(made).toEqual(['blob:test/1'])
    abort.abort()
    opening.get(2)!.resolve({ streamId: 's2', size: 10, type: '' })
    expect(await loading).toEqual([])
    expect(revoked).toEqual(['blob:test/1'])
    expect(closed().sort()).toEqual(['s1', 's2'])
  })
})
