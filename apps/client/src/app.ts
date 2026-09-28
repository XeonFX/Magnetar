import type { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import type { SearchResultDto } from '@md/protocol'
import { Actions } from './api/actions.ts'
import { AgentAccess } from './api/agentAccess.ts'
import { ApiError } from './api/errors.ts'
import { RateLimiter } from './api/rateLimiter.ts'
import { ARCH, PLATFORM, VERSION } from './config.ts'
import { KeyValue, openDatabase } from './db/database.ts'
import { SecretBox, SecretStore } from './db/secrets.ts'
import { DownloadManager } from './downloads/downloadManager.ts'
import { WebTorrentEngine, type TorrentEngine } from './downloads/engine.ts'
import { EventBus } from './events.ts'
import { LegacyImporter } from './legacy/legacyImport.ts'
import { logger } from './log.ts'
import { NotificationDispatcher } from './notifications/dispatcher.ts'
import { DATA_DIR, legacyDatabasePath, paths } from './paths.ts'
import { BrowserKeyStore } from './remote/browserKeys.ts'
import { RemoteService } from './remote/remoteService.ts'
import { RpcServer, type RpcHandlers } from './rpc/rpcServer.ts'
import { createProviders } from './search/providers/index.ts'
import { SearchResultCache, toResultDto } from './search/resultCache.ts'
import { SearchService } from './search/searchService.ts'
import type { TorrentSearchProvider } from './search/types.ts'
import { SeriesMonitor } from './series/seriesMonitor.ts'
import { SeriesStore } from './series/seriesStore.ts'
import { SettingsService } from './settings.ts'
import { listFolder, makeFolder, pickFolderNatively } from './system/folders.ts'
import { LoginStartup } from './system/loginStartup.ts'
import { UpdateService } from './updates/updateService.ts'

const log = logger('app')


export interface AppOptions {
  databasePath?: string
  /** Null runs everything without opening peer or DHT sockets (tests). */
  engine?: TorrentEngine | null
  providers?: TorrentSearchProvider[]
  legacyDatabase?: string | null
}

/** Every service, wired together. `main.ts` adds the HTTP server, tray and lifecycle around it. */
export class App {
  readonly db: Database
  readonly kv: KeyValue
  readonly secrets: SecretStore
  readonly events = new EventBus()
  readonly settings: SettingsService
  readonly notifications: NotificationDispatcher
  readonly search: SearchService
  readonly cache = new SearchResultCache()
  readonly downloads: DownloadManager
  readonly series: SeriesStore
  readonly monitor: SeriesMonitor
  readonly actions: Actions
  readonly updates: UpdateService
  readonly startup = new LoginStartup()
  readonly agent: AgentAccess
  readonly remote: RemoteService
  readonly legacy: LegacyImporter
  readonly rpc: RpcServer
  private readonly engine: TorrentEngine | null

  constructor(options: AppOptions = {}) {
    this.db = openDatabase(options.databasePath ?? paths.database)
    this.kv = new KeyValue(this.db)
    const box = new SecretBox(paths.secretKey)
    this.secrets = new SecretStore(this.db, box)
    this.settings = new SettingsService(this.db, this.secrets, this.events)
    this.notifications = new NotificationDispatcher(this.settings, this.events)
    this.search = new SearchService(options.providers ?? createProviders(), this.settings)
    this.engine = options.engine === undefined ? new WebTorrentEngine(this.savedDhtNodes()) : options.engine
    this.downloads = new DownloadManager(this.db, this.engine, this.settings, this.notifications, this.events, paths.torrentFiles)
    this.series = new SeriesStore(this.db, this.events)
    this.actions = new Actions(this.search, this.downloads, this.series, this.settings, this.cache, new RateLimiter())
    this.monitor = new SeriesMonitor(this.series, this.search, this.actions)
    this.actions.seriesMonitor = this.monitor
    this.updates = new UpdateService(this.events, this.notifications)
    this.agent = new AgentAccess(this.settings, this.secrets)
    this.remote = new RemoteService(this.kv, this.secrets, new BrowserKeyStore(this.db, box), this.events)
    this.legacy = new LegacyImporter(this.db, this.kv, this.settings, options.legacyDatabase === undefined ? legacyDatabasePath() : options.legacyDatabase)
    this.rpc = new RpcServer(this.handlers(), this.events)
    this.remote.rpc = this.rpc
  }

  start(): void {
    this.downloads.start()
    this.monitor.start()
    this.updates.start()
    this.remote.start()
  }

  async stop(): Promise<void> {
    this.monitor.stop()
    this.updates.stop()
    this.remote.stop()
    if (this.engine) this.kv.set('dht.nodes', JSON.stringify(this.engine.knownNodes()))
    await this.downloads.stop()
    this.db.close()
  }

  private savedDhtNodes(): { host: string; port: number }[] {
    try {
      return JSON.parse(this.kv.get('dht.nodes') ?? '[]') as { host: string; port: number }[]
    } catch {
      return []
    }
  }

  private handlers(): RpcHandlers {
    const a = this.actions
    return {
      'app.info': (_, ctx) => ({
        version: VERSION,
        platform: PLATFORM,
        arch: ARCH,
        dataDirectory: DATA_DIR,
        local: ctx.local,
        nativeFolderPicker: ctx.local && process.platform === 'darwin',
      }),
      'sources.list': () => a.sources(),

      'search.start': ({ query, source }, ctx) => {
        a.requireAvailableSource(source)
        const searchId = randomBytes(6).toString('hex')
        const controller = new AbortController()
        ctx.searches.set(searchId, controller)
        const signal = AbortSignal.any([controller.signal, ctx.signal])
        void this.search.searchStream(
          query, source,
          batch => ctx.emit('search.results', { searchId, results: batch.map(r => toResultDto(r, this.cache.add(r))) as SearchResultDto[] }),
          outcome => ctx.emit('search.source', { searchId, outcome }),
          signal,
        ).then(
          () => ctx.emit('search.done', { searchId, error: null }),
          error => { if (!signal.aborted) ctx.emit('search.done', { searchId, error: error instanceof Error ? error.message : String(error) }) },
        ).finally(() => ctx.searches.delete(searchId))
        return { searchId }
      },
      'search.cancel': ({ searchId }, ctx) => {
        ctx.searches.get(searchId)?.abort()
        return null
      },
      'search.details': ({ resultId }, ctx) => a.details(resultId, 'user', ctx.signal),

      'downloads.list': () => a.listDownloads(),
      'downloads.start': (input, ctx) => a.startDownload(input, 'user', ctx.signal),
      'downloads.pause': ({ id }) => a.pause(id),
      'downloads.resume': ({ id }) => a.resume(id),
      'downloads.delete': async ({ id, deleteFiles }) => {
        await a.deleteDownload(id, deleteFiles)
        return null
      },

      'series.list': () => a.listSeries(),
      'series.create': input => a.createSeries(input, 'user'),
      'series.update': ({ id, patch }) => a.updateSeries(id, patch, 'user'),
      'series.delete': ({ id }) => {
        a.deleteSeries(id)
        return null
      },
      'series.checkNow': ({ id }) => a.checkSeriesNow(id, 'user'),

      'settings.get': () => this.settings.toDto(),
      'settings.update': patch => this.settings.applyPatch(patch),
      'notifications.test': async () => {
        await this.notifications.dispatch({ kind: 'test', title: 'Test notification', message: 'If you can read this, notifications are working.' }, true)
        return null
      },

      'fs.list': ({ path }) => listFolder(path),
      'fs.mkdir': ({ path }) => makeFolder(path),
      'fs.pickNative': async ({ start, prompt }) => ({ path: await pickFolderNatively(start, prompt ?? 'Choose a folder') }),

      'updates.status': () => this.updates.status(),
      'updates.check': () => this.updates.check(),
      'updates.install': async () => {
        const releasePage = await this.updates.install()
        if (releasePage) openInBrowser(releasePage)
        return this.updates.status()
      },

      'startup.status': () => ({ status: this.startup.status() }),
      'startup.set': ({ enabled }) => {
        try {
          return { status: this.startup.set(enabled) }
        } catch (error) {
          throw new ApiError(error instanceof Error ? error.message : String(error))
        }
      },

      'agent.status': () => this.agent.status(),
      'agent.set': change => this.agent.set(change),
      'agent.regenerateToken': () => this.agent.regenerate(),

      'remote.status': () => this.remote.status(),
      'remote.pair': ({ deviceName }) => wrap(() => this.remote.pair(deviceName)),
      'remote.cancelPairing': () => this.remote.cancelPairing(),
      'remote.unpair': () => this.remote.unpair(),
      'remote.rename': ({ deviceName }) => wrap(() => this.remote.rename(deviceName)),
      'remote.linkBrowser': ({ label }) => wrap(async () => this.remote.linkBrowser(label)),
      'remote.revokeBrowser': ({ keyId }) => this.remote.revokeBrowser(keyId),

      'legacy.status': () => this.legacy.status(),
      'legacy.import': () => {
        const result = wrapSync(() => this.legacy.run())
        this.downloads.loadNew()
        this.series.changed()
        return result
      },
    }
  }
}

async function wrap<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(error instanceof Error ? error.message : String(error))
  }
}

function wrapSync<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    log.warn('Legacy import failed', error)
    throw new ApiError(error instanceof Error ? error.message : String(error))
  }
}

export function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? ['/usr/bin/open', url]
    : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url]
    : ['xdg-open', url]
  try {
    Bun.spawn(command, { stdio: ['ignore', 'ignore', 'ignore'] }).unref()
  } catch (error) {
    log.warn(`Could not open ${url}`, error)
  }
}
