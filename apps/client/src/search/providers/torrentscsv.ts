import { fetchText, fromUnixSeconds, toInt, toNumber } from '../http.ts'
import { buildMagnet } from '../magnet.ts'
import { newResult, type TorrentSearchProvider, type TorrentSearchResult } from '../types.ts'

const NAME = 'Torrents-CSV'

/** The torrents-csv.com open index, which aggregates The Pirate Bay and others. */
export class TorrentsCsvProvider implements TorrentSearchProvider {
  readonly name = NAME

  async search(query: string, signal: AbortSignal): Promise<TorrentSearchResult[]> {
    return parse(await fetchText(`https://torrents-csv.com/service/search?q=${encodeURIComponent(query)}&size=100`, signal))
  }
}

interface CsvRow { name?: unknown; infohash?: unknown; size_bytes?: unknown; seeders?: unknown; leechers?: unknown; created_unix?: unknown }

export function parse(json: string): TorrentSearchResult[] {
  const root = JSON.parse(json) as { torrents?: CsvRow[] }
  if (!Array.isArray(root.torrents)) return []
  return root.torrents.flatMap(row => {
    const hash = typeof row.infohash === 'string' ? row.infohash.trim() : ''
    if (!hash) return []
    const name = String(row.name ?? '')
    return [newResult({
      title: name,
      source: NAME,
      infoHash: hash,
      magnetUri: buildMagnet(hash, name),
      sizeBytes: toNumber(row.size_bytes),
      seeders: toInt(row.seeders),
      leechers: toInt(row.leechers),
      publishedAt: fromUnixSeconds(row.created_unix),
    })]
  })
}
