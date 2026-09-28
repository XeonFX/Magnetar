import type { SourceOutcomeDto } from '@md/protocol'
import { logger } from '../log.ts'
import type { SettingsService } from '../settings.ts'
import { describeFailure } from './http.ts'
import { mergeResults } from './merge.ts'
import { matchesQuery } from './relevance.ts'
import { needsResolution, type TorrentSearchProvider, type TorrentSearchResult } from './types.ts'

const log = logger('search')

/** Aggregates every provider: parallel fan-out, per-source outcomes, lazy detail resolution. */
export class SearchService {
  constructor(readonly providers: readonly TorrentSearchProvider[], private readonly settings: SettingsService) {}

  findProvider(name: string | null | undefined): TorrentSearchProvider | undefined {
    if (!name) return undefined
    return this.providers.find(p => p.name.toLowerCase() === name.toLowerCase())
  }

  /** A whole search, merged, with every source's outcome. */
  async collect(query: string, provider: string | null, signal: AbortSignal, filterRelevance = true): Promise<{ results: TorrentSearchResult[]; outcomes: SourceOutcomeDto[] }> {
    const all: TorrentSearchResult[] = []
    const outcomes = await this.searchStream(query, provider, batch => void all.push(...batch), () => {}, signal, filterRelevance)
    return { results: mergeResults(all), outcomes }
  }

  /**
   * Searches enabled providers in parallel, handing each provider's rows to `onResults` as soon as
   * it answers. Every provider reports an outcome, so "this site failed" and "everything was
   * filtered out" stay distinguishable from "there is nothing to find".
   */
  async searchStream(
    query: string,
    provider: string | null | undefined,
    onResults: (results: TorrentSearchResult[]) => void,
    onOutcome: (outcome: SourceOutcomeDto) => void,
    signal: AbortSignal,
    filterRelevance = true,
  ): Promise<SourceOutcomeDto[]> {
    const targets = this.providers.filter(p =>
      (!provider || p.name.toLowerCase() === provider.toLowerCase()) && this.settings.isProviderEnabled(p.name))

    return Promise.all(targets.map(async (p): Promise<SourceOutcomeDto> => {
      let outcome: SourceOutcomeDto
      try {
        const results = await p.search(query, signal)
        const kept = filterRelevance ? results.filter(r => matchesQuery(query, r.title)) : results
        if (kept.length > 0) onResults(kept)
        outcome = { source: p.name, status: 'ok', returned: results.length, filtered: results.length - kept.length, error: null }
      } catch (error) {
        // The caller moving on is not a provider fault.
        if (signal.aborted) throw error
        log.warn(`Search on ${p.name} failed: ${describeFailure(error)}`)
        outcome = { source: p.name, status: 'failed', returned: 0, filtered: 0, error: describeFailure(error) }
      }
      onOutcome(outcome)
      return outcome
    }))
  }

  /** Fills in a lazy result's magnet and description; a no-op once there is nothing left to fetch. */
  async ensureDetails(result: TorrentSearchResult, signal: AbortSignal): Promise<void> {
    if (!needsResolution(result) && result.description !== null) return
    const provider = this.findProvider(result.source)
    if (!provider?.getDetails) return
    try {
      const details = await provider.getDetails(result, signal)
      if (details.infoHash) result.infoHash = details.infoHash
      if (details.magnetUri) result.magnetUri = details.magnetUri
      if (details.description != null) result.description = details.description
    } catch (error) {
      log.warn(`Could not fetch details from ${result.source}: ${describeFailure(error)}`)
    }
  }
}
