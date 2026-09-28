import type { TorrentSearchProvider } from '../types.ts'
import { EztvProvider } from './eztv.ts'
import { LeetxProvider } from './leetx.ts'
import { NyaaProvider } from './nyaa.ts'
import { PirateBayProvider } from './piratebay.ts'
import { RarbgProvider } from './rarbg.ts'
import { TorrentsCsvProvider } from './torrentscsv.ts'

/** Every search source. Add a provider here and it shows up in Search, Series and Settings. */
export function createProviders(): TorrentSearchProvider[] {
  return [
    new EztvProvider(),
    new LeetxProvider(),
    new NyaaProvider(),
    new PirateBayProvider(),
    new RarbgProvider(),
    new TorrentsCsvProvider(),
  ]
}
