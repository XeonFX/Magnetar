import * as cheerio from 'cheerio'
import { parseBytes } from '@md/protocol/bytes'
import { htmlToPlainText } from '../description.ts'
import { fetchText, toInt } from '../http.ts'
import { buildMagnet, extractInfoHash } from '../magnet.ts'
import { MirrorRotator } from '../mirrors.ts'
import { newResult, type TorrentDetails, type TorrentSearchProvider, type TorrentSearchResult } from '../types.ts'

const NAME = '1337x'

/** The main domains sit behind a Cloudflare challenge; these mirrors serve plain HTML. */
const mirrors = new MirrorRotator(['www.1377x.to', 'www.1337xx.to'])

/**
 * The listing has every column except the magnet and description, which live on each torrent's
 * detail page — fetched lazily, once, for the torrent the user actually opens.
 */
export class LeetxProvider implements TorrentSearchProvider {
  readonly name = NAME

  search(query: string, signal: AbortSignal): Promise<TorrentSearchResult[]> {
    return mirrors.fetch(async (host, attemptSignal) => {
      const html = await fetchText(`https://${host}/sort-search/${encodeURIComponent(query)}/seeders/desc/1/`, attemptSignal)
      return parseRows(html, host)
    }, () => true, signal)
  }

  getDetails(result: TorrentSearchResult, signal: AbortSignal): Promise<TorrentDetails> {
    return resolveDetailPage(result, signal)
  }
}

export function parseRows(html: string, host: string): TorrentSearchResult[] {
  const $ = cheerio.load(html)
  const results: TorrentSearchResult[] = []
  $('tbody tr').each((_, row) => {
    const $row = $(row)
    // The name cell has an icon-only category link and the real title link; pick the one with text.
    const titleLink = $row.find("td.coll-1 a[href^='/torrent/']").toArray().map(a => $(a)).find(a => a.text().trim())
    if (!titleLink) return
    const path = titleLink.attr('href') ?? ''
    const id = path.replace(/^\/+|\/+$/g, '').split('/')[1] ?? path
    results.push(newResult({
      title: titleLink.text().trim(),
      source: NAME,
      // Stands in for the real hash until the detail page is resolved, keeping dedup stable.
      infoHash: `1337x-${id}`,
      sizeBytes: parseBytes($row.find('td.coll-4').text().trim()),
      seeders: toInt($row.find('td.coll-2').text()),
      leechers: toInt($row.find('td.coll-3').text()),
      publishedAt: parseDate($row.find('td.coll-date').text().trim()),
      detailsUrl: `https://${host}${path}`,
    }))
  })
  return results
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "Jan. 17th '26", "Apr. 3rd '25" or "5:42am Jan. 3rd '26" → UTC midnight of that day. */
export function parseDate(text: string): Date | null {
  const m = /([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+'?(\d{2})/.exec(text)
  if (!m) return null
  const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase())
  if (month < 0) return null
  return new Date(Date.UTC(2000 + Number(m[3]), month, Number(m[2])))
}

/** Magnet (rebuilt from its hash with our own trackers) and description from a detail page. */
export async function resolveDetailPage(result: TorrentSearchResult, signal: AbortSignal): Promise<TorrentDetails> {
  if (!result.detailsUrl) return {}
  return parseDetailPage(await fetchText(result.detailsUrl, signal), result.title)
}

export function parseDetailPage(html: string, title: string): TorrentDetails {
  const $ = cheerio.load(html)
  const href = $("a[href^='magnet:']").first().attr('href')
  const hash = href ? extractInfoHash(href) : null
  const description = $('#description')
  return {
    infoHash: hash,
    magnetUri: hash ? buildMagnet(hash, title) : null,
    description: description.length ? htmlToPlainText(description.html()) : null,
  }
}
