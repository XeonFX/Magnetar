import { describe, expect, test } from 'bun:test'
import { formatBytes, parseBytes } from '@md/protocol/bytes'
import { RateLimiter } from '../src/api/rateLimiter.ts'
import { htmlToPlainText } from '../src/search/description.ts'
import { buildMagnet, extractInfoHash, magnetName, normalizeInfoHash } from '../src/search/magnet.ts'
import { mergeResults } from '../src/search/merge.ts'
import { MirrorRotator } from '../src/search/mirrors.ts'
import { matchesQuery } from '../src/search/relevance.ts'
import { SearchResultCache } from '../src/search/resultCache.ts'
import { newResult } from '../src/search/types.ts'
import { episodeQueries, matchesEpisode, parseEpisode } from '../src/series/episodeParser.ts'

describe('episode parsing', () => {
  test.each([
    ['Show.Name.S01E05.1080p.WEB-DL', 1, 5], ['Show Name S02E12', 2, 12], ['show.name.s1e5.720p', 1, 5],
    ['Show Name 1x05', 1, 5], ['Show.Name.2x12.HDTV', 2, 12],
  ])('%s has a season', (title, season, episode) => expect(parseEpisode(title)).toEqual({ season, episode }))

  test.each([
    ['Show Name Episode 5', 5], ['Show Name Ep05', 5], ['Show Name E05', 5],
    ['Some Anime Show - 05 [1080p]', 5], ['Some Anime Show - 123 [720p]', 123],
  ])('%s has no season', (title, episode) => expect(parseEpisode(title)).toEqual({ season: null, episode }))

  test('nothing to parse', () => {
    expect(parseEpisode('')).toBeNull()
    expect(parseEpisode('   ')).toBeNull()
    expect(parseEpisode('Documentary 2024 1080p')).toBeNull()
  })

  test('prefers SxxEyy over an anime dash', () => {
    expect(parseEpisode('Show - 07 S02E03')).toEqual({ season: 2, episode: 3 })
  })
})

describe('episode matching', () => {
  const rule = { query: 'Mushoku Tensei', titleFilter: null, season: null }
  test('query, episode and season must all agree', () => {
    expect(matchesEpisode('[Sub] Mushoku Tensei - 06 (1080p)', rule, 6)).toBe(true)
    expect(matchesEpisode('[Sub] Mushoku Tensei - 07 (1080p)', rule, 6)).toBe(false)
    expect(matchesEpisode('[Sub] Mushoku Tensei S02E06', { ...rule, season: 3 }, 6)).toBe(false)
    expect(matchesEpisode('[Sub] Mushoku Tensei - 06', { ...rule, season: 3 }, 6)).toBe(false)
    expect(matchesEpisode('[Sub] Mushoku - 06', rule, 6)).toBe(false)
    expect(matchesEpisode('[Sub] Mushoku Tensei - 06 (720p)', { ...rule, titleFilter: '1080p' }, 6)).toBe(false)
    expect(matchesEpisode('[SUB] MUSHOKU TENSEI - 06 (1080P)', { ...rule, titleFilter: '1080p' }, 6)).toBe(true)
    expect(matchesEpisode('Mushoku Tensei Movie', rule, 6)).toBe(false)
  })

  test('targeted queries come first', () => {
    expect(episodeQueries({ query: 'Show', titleFilter: null, season: 2 }, 5)).toEqual(['Show S02E05', 'Show 05', 'Show'])
    expect(episodeQueries({ query: 'Show', titleFilter: null, season: null }, 12)).toEqual(['Show 12', 'Show'])
  })
})

describe('relevance', () => {
  test('every token of the query must be in the title', () => {
    expect(matchesQuery('ubuntu 24.04', 'ubuntu-24.04-desktop-amd64.iso')).toBe(true)
    expect(matchesQuery('The Matrix 1999', 'The.Matrix.1999.1080p.BluRay.x264')).toBe(true)
    expect(matchesQuery('matrix reloaded', 'The.Matrix.1999')).toBe(false)
    expect(matchesQuery('UBUNTU', 'ubuntu')).toBe(true)
    expect(matchesQuery('a', 'anything')).toBe(true)
    expect(matchesQuery('', 'anything')).toBe(true)
  })
})

describe('merge', () => {
  test('one row per hash (highest seeded), hashless rows kept, sorted by seeders', () => {
    const merged = mergeResults([
      newResult({ title: 'a', source: 'X', infoHash: 'AAAA', seeders: 5 }),
      newResult({ title: 'a2', source: 'Y', infoHash: 'aaaa', seeders: 9 }),
      newResult({ title: 'lazy', source: 'Z', infoHash: '', seeders: 1 }),
      newResult({ title: 'lazy2', source: 'Z', infoHash: '', seeders: 3 }),
    ])
    expect(merged.map(r => r.title)).toEqual(['a2', 'lazy2', 'lazy'])
  })
})

describe('magnets', () => {
  test('build, extract and normalise', () => {
    const magnet = buildMagnet('ABCDEF0123456789ABCDEF0123456789ABCDEF01', 'Some Name')
    expect(extractInfoHash(magnet)).toBe('ABCDEF0123456789ABCDEF0123456789ABCDEF01')
    expect(magnetName(magnet)).toBe('Some Name')
    expect(normalizeInfoHash('ABCDEF0123456789ABCDEF0123456789ABCDEF01')).toBe('abcdef0123456789abcdef0123456789abcdef01')
    // base32 form of the same 20 bytes
    expect(normalizeInfoHash('VPG66AJDIVTYTK6N54ASGRLHRGV433YB')).toBe('abcdef0123456789abcdef0123456789abcdef01')
    expect(normalizeInfoHash('nope')).toBeNull()
  })
})

describe('bytes', () => {
  test('format and parse binary units', () => {
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(0)).toBe('0 B')
    expect(parseBytes('6.07 GiB')).toBe(6517612871)
    expect(parseBytes('1.1 GB')).toBe(1181116006)
    expect(parseBytes('junk')).toBe(0)
  })
})

describe('descriptions', () => {
  test('HTML to plain text', () => {
    expect(htmlToPlainText('<p>One</p><p>Two &amp; three</p>\n\n\n\n<b>x</b>')).toBe('One\nTwo & three\n\nx')
    expect(htmlToPlainText('   ')).toBeNull()
  })
})

describe('mirror rotation', () => {
  test('staggers, takes the first success and remembers it', async () => {
    const rotator = new MirrorRotator(['slow', 'fast'], 20)
    const calls: string[] = []
    const attempt = async (host: string, signal: AbortSignal) => {
      calls.push(host)
      if (host === 'slow') await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 500)
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
      })
      return host
    }
    expect(await rotator.fetch(attempt, () => true, new AbortController().signal)).toBe('fast')
    calls.length = 0
    expect(await rotator.fetch(attempt, () => true, new AbortController().signal)).toBe('fast')
    expect(calls[0]).toBe('fast')
  })

  test('rethrows the last error when every host fails', async () => {
    const rotator = new MirrorRotator(['a', 'b'], 1)
    await expect(rotator.fetch(async host => { throw new Error(`down ${host}`) }, () => true, new AbortController().signal)).rejects.toThrow(/down/)
  })
})

describe('result cache', () => {
  test('ids expire after 30 idle minutes', () => {
    let now = 0
    const cache = new SearchResultCache(() => now)
    const id = cache.add(newResult({ title: 't', source: 's' }))
    now = 29 * 60_000
    expect(cache.get(id).title).toBe('t')
    now += 31 * 60_000
    expect(() => cache.get(id)).toThrow(/expired/)
  })
})

describe('rate limiter', () => {
  test('allows a burst of 10 then refills one per 3s', () => {
    let now = 0
    const limiter = new RateLimiter(() => now)
    for (let i = 0; i < 10; i++) limiter.ensureAllowed('search')
    expect(() => limiter.ensureAllowed('search')).toThrow(/Wait about 3s/)
    now += 3000
    limiter.ensureAllowed('search')
  })
})
