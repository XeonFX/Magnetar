import * as cheerio from 'cheerio'
import { parseBytes } from '@md/protocol/bytes'
import { fetchExtraPages, fetchText, fromUnixSeconds, toInt } from '../http.ts'
import { buildMagnet, extractInfoHash } from '../magnet.ts'
import { newResult, type TorrentSearchProvider, type TorrentSearchResult } from '../types.ts'

const NAME = 'Nyaa'
/** Nyaa's own tracker plus the generic public ones. */
const TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce',
]
const PAGE_SIZE = 75
/** Enough for a series check hunting an older, low-seed episode past row 75. */
const MAX_PAGES = 2

/**
 * nyaa.si's HTML search, not its RSS feed: RSS ignores the sort-by-seeders parameters and returns
 * a fixed 75-item window in another order, so popular torrents can be missing from it entirely.
 */
export class NyaaProvider implements TorrentSearchProvider {
  readonly name = NAME

  async search(query: string, signal: AbortSignal): Promise<TorrentSearchResult[]> {
    const first = parseRows(await fetchText(pageUrl(query, 1), signal))
    if (first.length < PAGE_SIZE) return first
    return [...first, ...await fetchExtraPages(MAX_PAGES - 1, async page => parseRows(await fetchText(pageUrl(query, page), signal)), signal)]
  }
}

function pageUrl(query: string, page: number): string {
  const url = `https://nyaa.si/?f=0&c=0_0&q=${encodeURIComponent(query)}&s=seeders&o=desc`
  return page > 1 ? `${url}&p=${page}` : url
}

export function parseRows(html: string): TorrentSearchResult[] {
  const $ = cheerio.load(html)
  const results: TorrentSearchResult[] = []
  $('tr').each((_, row) => {
    const $row = $(row)
    // A commented torrent has a "/view/<id>#comments" link before the title, whose text is the
    // comment count — skip it or the torrent gets named "12".
    const titleLink = $row.find("a[href^='/view/']:not(.comments)").first()
    const magnetHref = $row.find("a[href^='magnet:']").first().attr('href')
    if (!titleLink.length || !magnetHref) return
    const hash = extractInfoHash(magnetHref)
    if (!hash) return
    const cells = $row.find('td.text-center').toArray().map(td => $(td).text().trim())
    if (cells.length < 5) return // links, size, date, seeders, leechers
    const name = titleLink.text().trim()
    results.push(newResult({
      title: name,
      source: NAME,
      infoHash: hash,
      magnetUri: buildMagnet(hash, name, TRACKERS),
      sizeBytes: parseBytes(cells[1]),
      seeders: toInt(cells[3]),
      leechers: toInt(cells[4]),
      publishedAt: fromUnixSeconds($row.find('td[data-timestamp]').attr('data-timestamp')),
      detailsUrl: `https://nyaa.si${titleLink.attr('href') ?? ''}`,
    }))
  })
  return results
}
