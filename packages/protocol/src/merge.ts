/**
 * One row per info hash, keeping the best-seeded, sorted by seeders. Rows without a hash (lazy
 * sources not resolved yet) pass through: grouping blanks would merge unrelated torrents.
 * Shared by the app (whole result sets) and the dashboard (streamed batches).
 */
export function mergeByInfoHash<T extends { infoHash?: string | null; seeders: number }>(rows: Iterable<T>): T[] {
  const byHash = new Map<string, T>()
  const hashless: T[] = []
  for (const row of rows) {
    const key = row.infoHash?.toLowerCase()
    if (!key) {
      hashless.push(row)
      continue
    }
    const existing = byHash.get(key)
    if (!existing || row.seeders > existing.seeders) byHash.set(key, row)
  }
  return [...hashless, ...byHash.values()].sort((a, b) => b.seeders - a.seeders)
}
