import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as eztv from '../src/search/providers/eztv.ts'
import * as leetx from '../src/search/providers/leetx.ts'
import * as nyaa from '../src/search/providers/nyaa.ts'
import * as tpb from '../src/search/providers/piratebay.ts'
import * as rarbg from '../src/search/providers/rarbg.ts'
import * as csv from '../src/search/providers/torrentscsv.ts'
import { isRealInfoHash, needsResolution, type TorrentSearchResult } from '../src/search/types.ts'

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')
const utc = (y: number, m: number, d: number, h = 0, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min))

describe('The Pirate Bay', () => {
  test('api: keeps usable rows, skips the placeholder and hashless rows', () => {
    const results = tpb.parseApi(fixture('piratebay-api.json'))
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      title: 'ubuntu-26.04-desktop-amd64.iso', infoHash: 'DAFC8C076CA2F3ED376EEAE7C76A0D6BE2415C45',
      sizeBytes: 6517612871, seeders: 137, leechers: 18, source: 'The Pirate Bay',
    })
  })

  for (const layout of ['double', 'single']) {
    test(`mirror ${layout} layout`, () => {
      const results = tpb.parseMirrorHtml(fixture(`piratebay-mirror-${layout}.html`))
      expect(results).toHaveLength(2)
      expect(results[0]).toMatchObject({ title: 'ubuntu-26.04-desktop-amd64.iso', infoHash: 'DAFC8C076CA2F3ED376EEAE7C76A0D6BE2415C45', sizeBytes: 6517612871, seeders: 137, leechers: 18 })
      expect(results[0]!.publishedAt).toEqual(utc(new Date().getUTCFullYear(), 4, 25, 16, 35))
      expect(results[1]).toMatchObject({ sizeBytes: 6216965160, seeders: 42, leechers: 12 })
      expect(results[1]!.publishedAt).toEqual(utc(2024, 9, 8))
    })
  }

  test('upload dates', () => {
    const now = new Date(Date.UTC(2026, 5, 15, 12))
    expect(tpb.parseUploaded('Today 16:35', now)).toEqual(utc(2026, 6, 15))
    expect(tpb.parseUploaded('Y-day 16:35', now)).toEqual(utc(2026, 6, 14))
    expect(tpb.parseUploaded('09-08 2024', now)).toEqual(utc(2024, 9, 8))
    expect(tpb.parseUploaded('nonsense', now)).toBeNull()
  })
})

describe('1337x', () => {
  const rows = leetx.parseRows(fixture('leetx-search.html'), 'www.1377x.to')

  test('parses rows and picks the title anchor, not the icon', () => {
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      title: 'Ubuntu MATE 16.04.2 [MATE][armhf][img.xz][Uzerus]',
      detailsUrl: 'https://www.1377x.to/torrent/2099267/Ubuntu-MATE-16-04-2-MATE-armhf-img-xz-Uzerus/',
      sizeBytes: 1181116006, seeders: 260, leechers: 2,
    })
    expect(rows[0]!.publishedAt).toEqual(utc(2017, 6, 20))
  })

  test('uses a placeholder hash until the detail page is resolved', () => {
    expect(rows[0]!.infoHash).toBe('1337x-2099267')
    expect(needsResolution(rows[0]!)).toBe(true)
  })

  test('detail page yields a rebuilt magnet and plain-text description', () => {
    const details = leetx.parseDetailPage(
      '<a href="magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&tr=udp://evil">m</a><div id="description"><p>Line one</p><br>Line &amp; two</div>',
      'Title')
    expect(details.infoHash).toBe('abcdef0123456789abcdef0123456789abcdef01')
    expect(details.magnetUri).toStartWith('magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn=Title')
    expect(details.magnetUri).not.toContain('evil')
    expect(details.description).toBe('Line one\n\nLine & two')
  })

  test('dates', () => {
    expect(leetx.parseDate("Jan. 17th '26")).toEqual(utc(2026, 1, 17))
    expect(leetx.parseDate("5:42am Jan. 3rd '26")).toEqual(utc(2026, 1, 3))
    expect(leetx.parseDate('yesterday')).toBeNull()
  })
})

describe('Nyaa', () => {
  const results = nyaa.parseRows(fixture('nyaa-search.html'))

  test('parses rows with Nyaa trackers and timestamp dates', () => {
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      title: 'Koha Live CD Release 3 (3.0.4 Ubuntu 9.10 Desktop x86)', infoHash: '45008e48c8800b7d7643337b2e70a634e4c69f6a',
      sizeBytes: 654311424, seeders: 42, leechers: 3, source: 'Nyaa', detailsUrl: 'https://nyaa.si/view/96659',
    })
    expect(results[0]!.publishedAt).toEqual(utc(2009, 11, 3, 7, 3))
    expect(results[0]!.magnetUri).toContain(encodeURIComponent('http://nyaa.tracker.wf:7777/announce'))
  })

  test('ignores the comments link when reading the title', () => {
    expect(results[1]).toMatchObject({
      title: '[SubsPlease] Mushoku Tensei S3 - 06 (1080p) [FB09F4CC].mkv', detailsUrl: 'https://nyaa.si/view/2140895', seeders: 1234, leechers: 56,
    })
  })
})

describe('RARBG', () => {
  const page = rarbg.parsePage(fixture('rarbg-search.json'))

  test('parses every row and the total, with real hashes', () => {
    expect(page.results).toHaveLength(43)
    expect(page.total).toBe(43)
    expect(page.results[0]).toMatchObject({
      title: 'ubuntucinnamon-26.04-desktop-amd64.iso', infoHash: '8586FE65D6B589ACA262DBBC164570C335BD7D37',
      sizeBytes: 5659195392, seeders: 40, leechers: 11, source: 'RARBG', detailsUrl: 'https://therarbg.com/post-detail/8a715c/x/',
    })
    expect(page.results[0]!.publishedAt).toEqual(new Date(1777054855 * 1000))
    expect(page.results.every(r => isRealInfoHash(r.infoHash) && !needsResolution(r))).toBe(true)
  })

  test('skips hashless rows and tolerates a missing list', () => {
    const json = '{"total":2,"results":[{"pk":"a1","n":"Has hash","h":"8586FE65D6B589ACA262DBBC164570C335BD7D37","s":10,"se":1,"le":0,"a":1700000000},{"pk":"a2","n":"No hash","h":null}]}'
    expect(rarbg.parsePage(json).results.map(r => r.title)).toEqual(['Has hash'])
    expect(rarbg.parsePage('{"detail":"Not found"}').results).toEqual([])
  })

  test('detail description', () => {
    expect(rarbg.parseDetail(fixture('rarbg-detail.json')).description).toStartWith('Ubuntu 26.04 LTS')
    expect(rarbg.parseDetail('{"descr":"   "}').description).toBeNull()
  })
})

describe('EZTV', () => {
  const page = eztv.parsePage(fixture('eztv-api.json'))

  test('parses rows, skipping empty hashes', () => {
    expect(page.torrents).toHaveLength(2)
    expect(page.totalCount).toBe(219)
    expect(page.torrents[0]).toMatchObject({
      title: 'Law and Order S06E11 Corpus Delicti 720p HEVC x265-MeGusta EZTV', infoHash: '2fa9d6729a9cf935e4e53cc3c8cd16d619561c06',
      sizeBytes: 281349973, seeders: 41, leechers: 3, source: 'EZTV',
    })
    expect(page.torrents[1]!.infoHash).toBe('FE8F7271B12545E07DBFF0A265D2BC40DC5861EF')
    expect(eztv.parsePage('{"torrents_count": 0}').torrents).toEqual([])
  })
})

/**
 * Full, unedited pages captured from each live site. Assertions are structural so they survive a
 * site re-ranking results and fail when a selector stops matching.
 */
describe('live page sanity', () => {
  const parsers: Record<string, () => TorrentSearchResult[]> = {
    'Nyaa': () => nyaa.parseRows(fixture('live-nyaa-search.html')),
    'The Pirate Bay (api)': () => tpb.parseApi(fixture('live-piratebay-api.json')),
    'The Pirate Bay (mirror)': () => tpb.parseMirrorHtml(fixture('live-piratebay-mirror.html')),
    'EZTV': () => eztv.parsePage(fixture('live-eztv-api.json')).torrents,
    'RARBG': () => rarbg.parsePage(fixture('live-rarbg-search.json')).results,
    '1337x': () => leetx.parseRows(fixture('live-leetx-search.html'), 'www.1377x.to'),
    'Torrents-CSV': () => csv.parse(fixture('live-torrentscsv.json')),
  }

  for (const [name, parse] of Object.entries(parsers)) {
    test(name, () => {
      const results = parse()
      expect(results.length).toBeGreaterThan(10)
      for (const r of results) {
        expect(r.title.trim().length).toBeGreaterThan(3)
        expect(/^\d+$/.test(r.title)).toBe(false)
        expect(r.title).not.toMatch(/<|&nbsp/)
        expect(r.infoHash.length).toBeGreaterThan(0)
        expect(isRealInfoHash(r.infoHash) || r.infoHash.includes('-')).toBe(true)
        expect(r.source).toBe(name.split(' (')[0]!)
        expect(r.sizeBytes).toBeGreaterThanOrEqual(0)
        expect(r.seeders).toBeGreaterThanOrEqual(0)
      }
      expect(results.filter(r => r.sizeBytes > 0).length).toBeGreaterThan(results.length / 2)
      const dated = results.flatMap(r => (r.publishedAt ? [r.publishedAt] : []))
      expect(dated.length).toBeGreaterThan(0)
      for (const d of dated) {
        expect(d.getUTCFullYear()).toBeGreaterThanOrEqual(2000)
        expect(d.getTime()).toBeLessThanOrEqual(Date.now() + 2 * 86_400_000)
      }
    })
  }

  test('Nyaa keeps titles on the 31 rows that have comments', () => {
    const results = nyaa.parseRows(fixture('live-nyaa-search.html'))
    expect(results).toHaveLength(75)
    expect(results.every(r => r.title.includes('[') || r.title.includes('.'))).toBe(true)
    expect(results.every(r => r.detailsUrl!.startsWith('https://nyaa.si/view/') && !r.detailsUrl!.includes('#'))).toBe(true)
  })
})
