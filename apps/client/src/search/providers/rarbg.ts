import { fetchExtraPages, fetchText, fromUnixSeconds, toInt, toNumber } from '../http.ts'
import { buildMagnet } from '../magnet.ts'
import { newResult, type TorrentDetails, type TorrentSearchProvider, type TorrentSearchResult } from '../types.ts'

// "RARBG", not "TheRARBG": the name keys the per-source toggle, so renaming it would reset it.
const NAME = 'RARBG'
const BASE_URL = 'https://therarbg.com'
const PAGE_SIZE = 50
/** The endpoint ignores sort order, so fetch a second page rather than strand a popular release. */
const MAX_PAGES = 2

/**
 * The RARBG catalogue through TheRARBG's JSON endpoint, which hands back real info hashes so
 * magnets are built during the search. Only the description needs a lazy detail fetch.
 */
export class RarbgProvider implements TorrentSearchProvider {
  readonly name = NAME

  async search(query: string, signal: AbortSignal): Promise<TorrentSearchResult[]> {
    const first = parsePage(await fetchText(searchUrl(query, 1), signal))
    if (first.results.length < PAGE_SIZE || first.total <= PAGE_SIZE) return first.results
    return [...first.results, ...await fetchExtraPages(MAX_PAGES - 1, async page => parsePage(await fetchText(searchUrl(query, page), signal)).results, signal)]
  }

  async getDetails(result: TorrentSearchResult, signal: AbortSignal): Promise<TorrentDetails> {
    if (!result.detailsUrl) return {}
    try {
      return parseDetail(await fetchText(`${result.detailsUrl}?format=json`, signal))
    } catch {
      return {}
    }
  }
}

function searchUrl(query: string, page: number): string {
  const url = `${BASE_URL}/get-posts/keywords:${encodeURIComponent(query)}/?format=json`
  return page > 1 ? `${url}&page=${page}` : url
}

interface RarbgRow { n?: unknown; h?: unknown; s?: unknown; se?: unknown; le?: unknown; a?: unknown; pk?: unknown }

export function parsePage(json: string): { results: TorrentSearchResult[]; total: number } {
  const root = JSON.parse(json) as { total?: unknown; results?: RarbgRow[] }
  const total = toNumber(root.total)
  const results: TorrentSearchResult[] = []
  if (!Array.isArray(root.results)) return { results, total }
  for (const row of root.results) {
    // n=name, h=info hash, s=size, se=seeders, le=leechers, a=added (unix), pk=detail id
    const hash = typeof row.h === 'string' ? row.h.trim() : ''
    const name = typeof row.n === 'string' ? row.n : ''
    if (!hash || !name.trim()) continue
    results.push(newResult({
      title: name,
      source: NAME,
      infoHash: hash,
      magnetUri: buildMagnet(hash, name),
      sizeBytes: toNumber(row.s),
      seeders: toInt(row.se),
      leechers: toInt(row.le),
      publishedAt: fromUnixSeconds(row.a),
      // The slug is required by the route but not validated.
      detailsUrl: typeof row.pk === 'string' || typeof row.pk === 'number' ? `${BASE_URL}/post-detail/${row.pk}/x/` : null,
    }))
  }
  return { results, total }
}

export function parseDetail(json: string): TorrentDetails {
  const root = JSON.parse(json) as { descr?: unknown }
  const description = typeof root.descr === 'string' ? root.descr.trim() : ''
  return { description: description || null }
}
