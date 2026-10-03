import { testServiceWorker } from '@codefusion-cc/web-push/testing'
import fc from 'fast-check'
import { describe, expect, test, vi } from 'vitest'
import { CHUNK, handleStreams, MAX_RANGE, parseRange, type StreamFetchEvent, type StreamWorkerScope } from './streamWorker.ts'

const SITE = 'https://magnetar.codefusion.cc'

/** The website's worker (src/sw.ts) as a browser runs it, with the pages that are open. */
async function worker() {
  const sw = testServiceWorker(SITE)
  vi.resetModules()
  await sw.load(() => import('../sw.ts'))
  return sw
}

describe('notifications from linked devices', () => {
  test('a push shows what the device sent, with the app icon', async () => {
    const sw = await worker()
    await sw.push({ title: 'Download complete', body: 'Movie.2024.1080p', kind: 'completed', url: '/office', tag: 'magnetar-Movie.2024.1080p' })
    expect(sw.shown).toEqual([{ title: 'Download complete', options: expect.objectContaining({ body: 'Movie.2024.1080p', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'magnetar-Movie.2024.1080p' }) }])
  })

  test('the same download finishing again replaces its notification; another one shows beside it', async () => {
    const sw = await worker()
    await sw.push({ title: 'Download complete', body: 'A', url: '/office', tag: 'magnetar-A' })
    await sw.push({ title: 'Download complete', body: 'A', url: '/office', tag: 'magnetar-A' })
    await sw.push({ title: 'Download started', body: 'B', url: '/office' })
    expect(sw.showing.map(n => n.options.body)).toEqual(['A', 'B'])
  })

  test('a push that is empty or not JSON still shows, under the app name', async () => {
    const sw = await worker()
    await sw.push()
    await sw.push('not json')
    expect(sw.shown.map(n => [n.title, n.options.body])).toEqual([['Magnetar', ''], ['Magnetar', 'not json']])
  })

  test('a click with no page open opens the device the push is about', async () => {
    const sw = await worker()
    await sw.push({ title: 'Download complete', body: 'A', url: '/My%20Mac' })
    await sw.click()
    expect(sw.opened).toEqual([`${SITE}/My%20Mac`])
    expect(sw.showing).toEqual([])
  })

  test('a click takes an open dashboard page to the device; one already showing it is only brought forward', async () => {
    const sw = await worker()
    const devices = sw.page('/', { focused: true })
    await sw.push({ title: 'Download complete', body: 'A', url: '/office' })
    await sw.click()
    expect(devices.events).toEqual(['focus', `navigate ${SITE}/office`])

    const office = sw.page('/office')
    await sw.push({ title: 'Download complete', body: 'B', url: '/office' })
    await sw.click()
    expect(office.events).toEqual([])
    expect(devices.events.slice(2)).toEqual(['focus'])
    expect(sw.opened).toEqual([])
  })

  test('a link to anywhere else opens the website itself', async () => {
    for (const elsewhere of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', 42]) {
      const sw = await worker()
      await sw.push({ title: 'x', url: elsewhere })
      await sw.click()
      expect(sw.opened, String(elsewhere)).toEqual([`${SITE}/`])
    }
  })

  test('a new version of the worker takes over the open pages at once', async () => {
    const sw = await worker()
    expect(await sw.install()).toEqual({ skippedWaiting: true, claimed: true })
  })
})

describe('byte ranges', () => {
  test('a range inside the file is that range; an open end runs to the end', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99, partial: true })
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999, partial: true })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999, partial: true })
  })

  test('a suffix range is the last bytes, at most the whole file', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999, partial: true })
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999, partial: true })
  })

  test('no range, or one this does not read, is the whole file', () => {
    for (const header of [null, '', 'items=0-5', 'bytes=-', 'bytes=abc']) expect(parseRange(header, 1000), String(header)).toEqual({ start: 0, end: 999, partial: false })
  })

  test('a range outside the file, or backwards, cannot be satisfied', () => {
    for (const header of ['bytes=1000-', 'bytes=1000-2000', 'bytes=500-100', 'bytes=-0']) expect(parseRange(header, 1000), header).toBeNull()
    expect(parseRange('bytes=0-', 0)).toBeNull()
  })

  test('any part of a file it answers with lies inside the file and is not empty; anything else is the whole file', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 2 ** 40 }), fc.option(fc.nat({ max: 2 ** 41 })), fc.option(fc.nat({ max: 2 ** 41 })), (size, a, b) => {
      const range = parseRange(`bytes=${a ?? ''}-${b ?? ''}`, size)
      if (range === null) return true
      if (!range.partial) return range.start === 0 && range.end === size - 1
      return range.start >= 0 && range.start <= range.end && range.end <= size - 1
    }))
  })
})

/** A dashboard page that opened streams through the relay, answering the worker as streaming.ts does. */
function page(files: Record<string, { bytes: Uint8Array; type: string; failAt?: number }>) {
  const reads: { offset: number; length: number }[] = []
  return {
    reads,
    postMessage(message: { type: string; key: string; offset: number; length: number }, [port]: MessagePort[]) {
      const file = files[message.key]
      setTimeout(() => {
        if (message.type === 'magnetar-stream-meta') return port!.postMessage(file ? { size: file.bytes.length, type: file.type } : null)
        reads.push({ offset: message.offset, length: message.length })
        if (!file) return port!.postMessage({ error: 'This stream is closed.' })
        if (file.failAt !== undefined && message.offset >= file.failAt) return port!.postMessage({ error: 'The device did not answer in time' })
        const data = file.bytes.slice(message.offset, message.offset + message.length).buffer
        port!.postMessage({ data }, [data])
      }, 0)
    },
  }
}

/** The worker's fetch handler with one open page, and a way to make requests through it. */
function streams(client: ReturnType<typeof page>) {
  let listener: ((event: StreamFetchEvent) => void) | null = null
  const scope: StreamWorkerScope = {
    location: { origin: SITE },
    addEventListener: (_type, fetchListener) => { listener = fetchListener },
    clients: { get: async id => (id === 'tab' ? client : undefined), matchAll: async () => [client] },
  }
  handleStreams(scope)
  return (url: string, headers: Record<string, string> = {}, clientId = 'tab'): Promise<Response> | null => {
    let answer: Promise<Response> | null = null
    listener!({ request: new Request(url, { headers }), clientId, respondWith: response => { answer = response } })
    return answer
  }
}

describe('playing a file through the relay', () => {
  const movie = new Uint8Array(5 * CHUNK + 123)
  for (let i = 0; i < movie.length; i++) movie[i] = i % 251
  /** Compared as bytes: toEqual walks megabytes element by element. */
  const same = (body: ArrayBuffer, bytes: Uint8Array) => expect(Buffer.from(body).equals(Buffer.from(bytes))).toBe(true)

  test('a range from the start answers at most MAX_RANGE bytes, read from the page a chunk at a time', async () => {
    const tab = page({ k1: { bytes: movie, type: 'video/mp4' } })
    const response = await streams(tab)(`${SITE}/__stream/k1/Movie.mp4`, { range: 'bytes=0-' })!
    expect(response.status).toBe(206)
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'video/mp4',
      'content-range': `bytes 0-${MAX_RANGE - 1}/${movie.length}`,
      'content-length': String(MAX_RANGE),
      'accept-ranges': 'bytes',
    })
    same(await response.arrayBuffer(), movie.subarray(0, MAX_RANGE))
    expect(tab.reads.every(read => read.length <= CHUNK)).toBe(true)
  })

  test('the end of the file, asked for after a seek, is exactly what is left', async () => {
    const response = await streams(page({ k1: { bytes: movie, type: 'video/mp4' } }))(`${SITE}/__stream/k1/x`, { range: `bytes=${movie.length - 200}-` })!
    expect(response.headers.get('content-range')).toBe(`bytes ${movie.length - 200}-${movie.length - 1}/${movie.length}`)
    same(await response.arrayBuffer(), movie.subarray(-200))
  })

  test('without a range the whole file comes, as 200', async () => {
    const small = movie.slice(0, 1000)
    const response = await streams(page({ k1: { bytes: small, type: 'text/vtt' } }))(`${SITE}/__stream/k1/a.srt`)!
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBeNull()
    same(await response.arrayBuffer(), small)
  })

  test('a range past the end is refused with the size', async () => {
    const response = await streams(page({ k1: { bytes: movie, type: 'video/mp4' } }))(`${SITE}/__stream/k1/x`, { range: `bytes=${movie.length}-` })!
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${movie.length}`)
  })

  test('a stream the page no longer knows (the player was closed) is 404', async () => {
    const response = await streams(page({}))(`${SITE}/__stream/gone/x`)!
    expect(response.status).toBe(404)
  })

  test('a request from a page the worker cannot name is answered by an open page that knows the stream', async () => {
    const response = await streams(page({ k1: { bytes: movie.slice(0, 10), type: '' } }))(`${SITE}/__stream/k1/x`, {}, '')!
    expect(response.status).toBe(200)
  })

  test('the device failing mid-file ends the response with an error rather than short bytes', async () => {
    const response = await streams(page({ k1: { bytes: movie, type: 'video/mp4', failAt: CHUNK } }))(`${SITE}/__stream/k1/x`, { range: 'bytes=0-' })!
    await expect(response.arrayBuffer()).rejects.toThrow('The device did not answer in time')
  })

  test('other requests are left to the browser', () => {
    const fetchThrough = streams(page({}))
    expect(fetchThrough(`${SITE}/assets/index.js`)).toBeNull()
    expect(fetchThrough('https://evil.example/__stream/k1/x')).toBeNull()
  })
})
