import * as cheerio from 'cheerio'
import { parseBytes } from '@md/protocol/bytes'
import { fetchText, fromUnixSeconds, toInt } from '../http.ts'
import { buildMagnet, extractInfoHash } from '../magnet.ts'
import { MirrorRotator } from '../mirrors.ts'
import { newResult, type TorrentSearchProvider, type TorrentSearchResult } from '../types.ts'

const NAME = 'The Pirate Bay'

/**
 * Prefers the apibay.org JSON API and falls back to HTML mirrors: some ISPs block the official
 * domains (the maintainer's blackholes apibay after the TLS handshake).
 */
const sources = new MirrorRotator<{ host: string; html: boolean }>([
  { host: 'apibay.org', html: false },
  { host: 'tpb.party', html: true },
  { host: 'piratebay.live', html: true },
])

export class PirateBayProvider implements TorrentSearchProvider {
  readonly name = NAME

  search(query: string, signal: AbortSignal): Promise<TorrentSearchResult[]> {
    return sources.fetch(async ({ host, html }, attemptSignal) => {
      const url = html
        ? `https://${host}/search/${encodeURIComponent(query)}/1/99/0`
        : `https://${host}/q.php?q=${encodeURIComponent(query)}`
      const body = await fetchText(url, attemptSignal)
      return html ? parseMirrorHtml(body) : parseApi(body)
    }, () => true, signal)
  }
}

interface ApibayRow { id?: unknown; name?: unknown; info_hash?: unknown; size?: unknown; seeders?: unknown; leechers?: unknown; added?: unknown }

export function parseApi(json: string): TorrentSearchResult[] {
  const rows = JSON.parse(json) as ApibayRow[]
  if (!Array.isArray(rows)) throw new SyntaxError('apibay did not return a list')
  const results: TorrentSearchResult[] = []
  for (const row of rows) {
    const name = String(row.name ?? '')
    // apibay answers "nothing found" with a single placeholder row.
    if (String(row.id) === '0' || name === 'No results returned') continue
    const hash = String(row.info_hash ?? '').trim()
    if (!hash) continue
    results.push(newResult({
      title: name,
      source: NAME,
      infoHash: hash,
      magnetUri: buildMagnet(hash, name),
      sizeBytes: Number(row.size) || 0,
      seeders: toInt(row.seeders),
      leechers: toInt(row.leechers),
      publishedAt: fromUnixSeconds(row.added),
    }))
  }
  return results
}

const DET_DESC = /Uploaded\s+([^,]+),\s*Size\s+([^,]+),/
const UPLOAD_DATE_CELL = /^(Today|Y-day|\d{2}-\d{2})/i

/**
 * The mirrors serve one of two classic layouts (piratebay.live a compact "Single" view, tpb.party
 * a "Double" one). Double: title, a date cell, magnet, then size/seeders/leechers right-aligned.
 * Single: title + magnet + a "Uploaded X, Size Y, ULed by Z" blob, then only seeders/leechers.
 * Seeders and leechers are always the last two right-aligned cells.
 */
export function parseMirrorHtml(html: string, now = new Date()): TorrentSearchResult[] {
  const $ = cheerio.load(html)
  const results: TorrentSearchResult[] = []
  $('tr').each((_, row) => {
    const $row = $(row)
    const titleLink = $row.find("a[title^='Details for ']").first()
    const magnetHref = $row.find("a[href^='magnet:']").first().attr('href')
    if (!titleLink.length || !magnetHref) return
    const hash = extractInfoHash(magnetHref)
    if (!hash) return

    const title = titleLink.text().trim()
    const right = $row.find("td[align='right']").toArray().map(td => $(td).text().trim())
    const seeders = right.length >= 2 ? toInt(right.at(-2)) : 0
    const leechers = right.length >= 1 ? toInt(right.at(-1)) : 0

    let sizeBytes = 0
    let publishedAt: Date | null = null
    if (right.length >= 3) {
      sizeBytes = parseBytes(right.at(-3))
      const dateCell = $row.find('td').toArray().map(td => $(td).text().trim()).find(text => UPLOAD_DATE_CELL.test(text))
      publishedAt = dateCell ? parseUploaded(dateCell, now) : null
    } else {
      const match = DET_DESC.exec($row.find('font.detDesc').text())
      if (match) {
        sizeBytes = parseBytes(match[2]!.trim())
        publishedAt = parseUploaded(match[1]!.trim(), now)
      }
    }

    results.push(newResult({
      title, source: NAME, infoHash: hash, magnetUri: buildMagnet(hash, title),
      sizeBytes, seeders, leechers, publishedAt,
    }))
  })
  return results
}

/** "04-25 16:35" (this year), "09-08 2024", "Today 16:35", "Y-day 16:35" — all UTC. */
export function parseUploaded(text: string, now = new Date()): Date | null {
  const value = text.replaceAll(' ', ' ').trim()
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  if (/^today/i.test(value)) return new Date(today)
  if (/^y-day/i.test(value)) return new Date(today - 86_400_000)
  let m = /^(\d{2})-(\d{2}) (\d{4})$/.exec(value)
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])))
  m = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value)
  if (m) return new Date(Date.UTC(now.getUTCFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4])))
  return null
}
