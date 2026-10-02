import { afterEach, describe, expect, test, vi } from 'vitest'
import { latestRelease, offeredVersion, releasesProblemText } from './releases.ts'

describe('offeredVersion', () => {
  test('offers what the app found, else a newer release the website knows of', () => {
    expect(offeredVersion('1.1.0', '1.2.0', '1.2.0')).toBe('1.2.0')
    // The app checks every 6 hours; the website may know first.
    expect(offeredVersion('1.1.0', null, '1.2.0')).toBe('1.2.0')
    // The app found one the website's cache doesn't have yet.
    expect(offeredVersion('1.1.0', '1.3.0', '1.2.0')).toBe('1.3.0')
    // An app from before 1.2 reports a version too, so it is caught by the website alone.
    expect(offeredVersion('1.0.0', undefined, '1.2.0')).toBe('1.2.0')
  })

  test('offers nothing to an app as new or newer, or without a version to compare', () => {
    expect(offeredVersion('1.2.0', null, '1.2.0')).toBeNull()
    expect(offeredVersion('1.3.0', null, '1.2.0')).toBeNull()
    expect(offeredVersion('1.3.0-rc.1', null, '1.2.0')).toBeNull()
    expect(offeredVersion('1.2.0+dev', null, '1.2.0')).toBeNull()
    // No app connected yet, or a report that isn't a version.
    expect(offeredVersion(undefined, null, '1.2.0')).toBeNull()
    expect(offeredVersion('', null, '1.2.0')).toBeNull()
    expect(offeredVersion('garbage', '1.2.0', '1.2.0')).toBeNull()
    // GitHub couldn't be read, and the app found nothing.
    expect(offeredVersion('1.1.0', null, null)).toBeNull()
    // A stale "available" for a version the app already runs.
    expect(offeredVersion('1.2.0', '1.2.0', null)).toBeNull()
  })
})

describe('latestRelease', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('asks once for every caller, again after ten minutes, and is null when the website cannot say', async () => {
    const fetch = vi.fn(async () => Response.json({ version: '1.2.0', publishedAt: '', pageUrl: '', assets: [] }))
    vi.stubGlobal('fetch', fetch)
    const start = Date.UTC(2026, 9, 2, 12)
    const [a, b] = await Promise.all([latestRelease(start), latestRelease(start + 1000)])
    expect(a?.version).toBe('1.2.0')
    expect(b).toBe(a)
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockImplementationOnce(async () => Response.json({ error: 'GitHub could not be read (rate-limited)' }, { status: 502 }))
    const failedAt = start + 10 * 60_000 + 1
    expect(await latestRelease(failedAt)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
    // Not knowing is kept only briefly: half a minute later the website asks again.
    expect(await latestRelease(failedAt + 1000)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect((await latestRelease(failedAt + 30_001))?.version).toBe('1.2.0')
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

describe('releasesProblemText', () => {
  const t = (key: string, ...args: (string | number)[]) => [key, ...args].join('|')
  const formatDate = (iso: string) => `at ${iso}`

  test('says each problem in words, with when the rate limit lifts if known', () => {
    expect(releasesProblemText(t, 'offline', null, formatDate)).toBe('releases.offline')
    expect(releasesProblemText(t, 'rate-limited', '2026-10-02T13:00:00.000Z', formatDate)).toBe('releases.rateLimitedUntil|at 2026-10-02T13:00:00.000Z')
    expect(releasesProblemText(t, 'rate-limited', null, formatDate)).toBe('releases.rateLimited')
    expect(releasesProblemText(t, 'unavailable', null, formatDate)).toBe('releases.unavailable')
    expect(releasesProblemText(t, 'install', null, formatDate, 'Update failed: Checksum mismatch')).toBe('settings.installFailed|Checksum mismatch')
  })
})
