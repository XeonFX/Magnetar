/** A search hit as providers produce it. Mutable: lazy providers fill in magnet/description later. */
export interface TorrentSearchResult {
  title: string
  magnetUri: string
  /** Real info hash, or a provider placeholder ("1337x-123") until the detail page is resolved. */
  infoHash: string
  sizeBytes: number
  seeders: number
  leechers: number
  source: string
  publishedAt: Date | null
  detailsUrl: string | null
  /** Null until fetched; some providers only have it on a detail page. */
  description: string | null
}

export interface TorrentDetails {
  infoHash?: string | null
  magnetUri?: string | null
  description?: string | null
}

/**
 * A torrent site. Add one by implementing this and listing it in providers/index.ts; it then
 * appears in Search, the series-task source list and Settings automatically.
 */
export interface TorrentSearchProvider {
  readonly name: string
  search(query: string, signal: AbortSignal): Promise<TorrentSearchResult[]>
  /**
   * For sites whose listing lacks the magnet and/or description: fetched on demand for one result
   * (info dialog, starting a download), never during the search itself.
   */
  getDetails?(result: TorrentSearchResult, signal: AbortSignal): Promise<TorrentDetails>
}

export function needsResolution(result: TorrentSearchResult): boolean {
  return !result.magnetUri
}

export function isRealInfoHash(hash: string): boolean {
  return /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash)
}

export function newResult(fields: Partial<TorrentSearchResult> & Pick<TorrentSearchResult, 'title' | 'source'>): TorrentSearchResult {
  return {
    magnetUri: '',
    infoHash: '',
    sizeBytes: 0,
    seeders: 0,
    leechers: 0,
    publishedAt: null,
    detailsUrl: null,
    description: null,
    ...fields,
  }
}
