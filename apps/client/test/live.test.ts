import { describe, expect, test } from 'bun:test'
import { createProviders } from '../src/search/providers/index.ts'
import { isRealInfoHash } from '../src/search/types.ts'

/**
 * Hits the real sites: fails when a provider returns nothing or unparseable rows. Skipped unless
 * MD_LIVE_TESTS=1 (the weekly Provider health workflow sets it).
 */
const live = process.env.MD_LIVE_TESTS === '1'

describe.skipIf(!live)('live providers', () => {
  for (const provider of createProviders()) {
    // EZTV only pages through recent TV releases, so it needs a query that is always airing.
    const query = provider.name === 'EZTV' ? 'S01' : provider.name === 'Nyaa' ? '1080p' : 'ubuntu'
    test(provider.name, async () => {
      const results = await provider.search(query, AbortSignal.timeout(30_000))
      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.title.trim().length).toBeGreaterThan(3)
        expect(isRealInfoHash(r.infoHash) || r.infoHash.includes('-')).toBe(true)
      }
    }, 45_000)
  }
})
