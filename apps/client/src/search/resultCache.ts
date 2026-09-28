import type { SearchResultDto } from '@md/protocol'
import { randomId } from '@md/protocol/base64'
import { ApiError } from '../api/errors.ts'
import { isRealInfoHash, type TorrentSearchResult } from './types.ts'

const LIFETIME_MS = 30 * 60_000
const MAX_ENTRIES = 2000

/**
 * Short-lived handles for search results. Starting a download needs the live result object — a
 * 1337x row only has a placeholder hash until its detail page is fetched — and a dashboard or an
 * agent over HTTP has no other way to point back at it. Entries expire on a sliding window and the
 * cache is bounded, so a long-running app doesn't accumulate them.
 */
export class SearchResultCache {
  private readonly entries = new Map<string, { result: TorrentSearchResult; lastUsed: number }>()
  private lastPrune = 0

  constructor(private readonly now: () => number = Date.now) {}

  add(result: TorrentSearchResult): string {
    this.prune()
    const id = `r_${randomId(8)}`
    this.entries.set(id, { result, lastUsed: this.now() })
    return id
  }

  get(resultId: string): TorrentSearchResult {
    const entry = this.entries.get(resultId)
    if (entry && this.now() - entry.lastUsed <= LIFETIME_MS) {
      entry.lastUsed = this.now()
      return entry.result
    }
    this.entries.delete(resultId)
    throw ApiError.notFound(
      `Search result '${resultId}' is unknown or has expired (results are kept for 30 minutes). Run the search again to get fresh result ids.`)
  }

  /** Scans for expired entries at most once a minute; the size cap is enforced on every add. */
  private prune(): void {
    const now = this.now()
    if (now - this.lastPrune >= 60_000) {
      this.lastPrune = now
      for (const [id, entry] of this.entries) {
        if (now - entry.lastUsed > LIFETIME_MS) this.entries.delete(id)
      }
    }
    // Map iteration is insertion order, which is also the order entries would have expired in.
    for (const id of this.entries.keys()) {
      if (this.entries.size < MAX_ENTRIES) break
      this.entries.delete(id)
    }
  }
}

export function toResultDto(result: TorrentSearchResult, resultId: string): SearchResultDto {
  return {
    resultId,
    title: result.title,
    source: result.source,
    sizeBytes: result.sizeBytes,
    seeders: result.seeders,
    leechers: result.leechers,
    publishedAt: result.publishedAt?.toISOString() ?? null,
    detailsUrl: result.detailsUrl,
    infoHash: isRealInfoHash(result.infoHash) ? result.infoHash : null,
  }
}
