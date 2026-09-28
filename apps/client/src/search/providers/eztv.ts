import { fetchText, fromUnixSeconds, toInt, toNumber } from '../http.ts'
import { matchesQuery } from '../relevance.ts'
import { newResult, type TorrentSearchProvider, type TorrentSearchResult } from '../types.ts'

const NAME = 'EZTV'
const BASE_URL = 'https://eztvx.to'
const PAGE_SIZE = 100
const MAX_PAGES = 5
const MAX_RESULTS = 50

/**
 * EZTV's search page is behind a Cloudflare challenge and its API has no keyword filter, so this
 * pages through the newest-first feed and keeps matching titles. It only finds recent releases.
 */
export class EztvProvider implements TorrentSearchProvider {
  readonly name = NAME

  async search(query: string, signal: AbortSignal): Promise<TorrentSearchResult[]> {
    const first = parsePage(await fetchText(pageUrl(1), signal))
    const matches = first.torrents.filter(t => matchesQuery(query, t.title))
    const morePages = Math.min(MAX_PAGES, Math.ceil(first.totalCount / PAGE_SIZE)) - 1
    if (matches.length < MAX_RESULTS && first.torrents.length > 0 && morePages > 0) {
      const rest = await Promise.all(Array.from({ length: morePages }, async (_, i) => {
        try {
          return parsePage(await fetchText(pageUrl(i + 2), signal)).torrents
        } catch (error) {
          if (signal.aborted) throw error
          return []
        }
      }))
      matches.push(...rest.flat().filter(t => matchesQuery(query, t.title)))
    }
    return matches.slice(0, MAX_RESULTS)
  }
}

function pageUrl(page: number): string {
  return `${BASE_URL}/api/get-torrents?page=${page}&limit=${PAGE_SIZE}`
}

interface EztvRow { hash?: unknown; title?: unknown; magnet_url?: unknown; size_bytes?: unknown; seeds?: unknown; peers?: unknown; date_released_unix?: unknown }

export function parsePage(json: string): { torrents: TorrentSearchResult[]; totalCount: number } {
  const root = JSON.parse(json) as { torrents_count?: unknown; torrents?: EztvRow[] }
  const totalCount = toNumber(root.torrents_count)
  if (!Array.isArray(root.torrents)) return { torrents: [], totalCount }
  const torrents = root.torrents.flatMap(row => {
    const hash = typeof row.hash === 'string' ? row.hash.trim() : ''
    if (!hash) return []
    return [newResult({
      title: typeof row.title === 'string' ? row.title : '',
      source: NAME,
      infoHash: hash,
      magnetUri: typeof row.magnet_url === 'string' ? row.magnet_url : '',
      sizeBytes: toNumber(row.size_bytes),
      seeders: toInt(row.seeds),
      leechers: toInt(row.peers),
      publishedAt: fromUnixSeconds(row.date_released_unix),
    })]
  })
  return { torrents, totalCount }
}
