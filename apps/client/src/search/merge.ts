import type { TorrentSearchResult } from './types.ts'

/**
 * De-duplicates overlapping providers (Torrents-CSV also indexes The Pirate Bay, aggregators
 * list Nyaa torrents, …): one row per info hash, the highest-seeded. Rows without a hash (still
 * awaiting detail resolution) pass through, since grouping blanks would merge unrelated torrents.
 */
export function mergeResults(results: TorrentSearchResult[]): TorrentSearchResult[] {
  const byHash = new Map<string, TorrentSearchResult>()
  const hashless: TorrentSearchResult[] = []
  for (const result of results) {
    if (!result.infoHash) {
      hashless.push(result)
      continue
    }
    const key = result.infoHash.toLowerCase()
    const existing = byHash.get(key)
    if (!existing || result.seeders > existing.seeders) byHash.set(key, result)
  }
  return [...hashless, ...byHash.values()].sort((a, b) => b.seeders - a.seeders)
}
