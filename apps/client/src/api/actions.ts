import type {
  DownloadDto, DownloadStatus, SearchResponse, SeriesTaskDto, SeriesTaskPatch, SourceDto, StartDownloadInput,
  TorrentDetailsDto,
} from '@md/protocol'
import { DOWNLOAD_STATUSES, SeriesTaskInput } from '@md/protocol'
import { z } from 'zod'
import type { DownloadManager } from '../downloads/downloadManager.ts'
import { logger } from '../log.ts'
import { mergeResults } from '../search/merge.ts'
import { toResultDto, type SearchResultCache } from '../search/resultCache.ts'
import type { SearchService } from '../search/searchService.ts'
import { needsResolution, type TorrentSearchResult } from '../search/types.ts'
import type { SeriesMonitor } from '../series/seriesMonitor.ts'
import { toSeriesDto, type SeriesStore } from '../series/seriesStore.ts'
import type { SettingsService } from '../settings.ts'
import { ApiError } from './errors.ts'
import type { RateLimiter } from './rateLimiter.ts'
import { resolveAgentFolder } from './saveFolderPolicy.ts'

const log = logger('actions')
const DEFAULT_SEARCH_LIMIT = 25
const MAX_SEARCH_LIMIT = 200

/**
 * Who is asking. Agents (REST/MCP) are rate limited and confined to the download folder because
 * they choose arguments after reading untrusted text; the dashboard is a person.
 */
export type Caller = 'agent' | 'user'

export interface ActionsForSeries {
  startFromResult(result: TorrentSearchResult, options: { seriesTaskId?: number | null; saveFolder?: string | null; signal?: AbortSignal }): Promise<DownloadDto>
}

/**
 * Everything that can be done to the app, in one place. The dashboard RPC, REST and MCP are thin
 * wrappers over this, so the surfaces cannot drift apart or enforce different rules.
 */
export class Actions implements ActionsForSeries {
  seriesMonitor: SeriesMonitor | null = null

  constructor(
    private readonly searchService: SearchService,
    private readonly downloads: DownloadManager,
    private readonly series: SeriesStore,
    private readonly settings: SettingsService,
    readonly cache: SearchResultCache,
    private readonly limiter: RateLimiter,
  ) {}

  sources(): SourceDto[] {
    return this.searchService.providers.map(p => ({ name: p.name, enabled: this.settings.isProviderEnabled(p.name) }))
  }

  /** One-shot search for agents: merged, de-duplicated, truncated to `limit`. */
  async search(query: string, source: string | null, limit: number | undefined, signal: AbortSignal): Promise<SearchResponse> {
    if (!query.trim()) throw new ApiError('A search query is required.')
    this.limiter.ensureAllowed('search')
    this.requireAvailableSource(source)
    const take = Math.min(Math.max(limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT)
    const collected: TorrentSearchResult[] = []
    const outcomes = await this.searchService.searchStream(query, source, batch => void collected.push(...batch), () => {}, signal)
    const merged = mergeResults(collected)
    return {
      results: merged.slice(0, take).map(r => toResultDto(r, this.cache.add(r))),
      sources: outcomes,
      totalMatched: merged.length,
      truncated: merged.length > take,
    }
  }

  async details(resultId: string, caller: Caller, signal: AbortSignal): Promise<TorrentDetailsDto> {
    if (caller === 'agent') this.limiter.ensureAllowed('detail')
    const result = this.cache.get(resultId)
    await this.searchService.ensureDetails(result, signal)
    return { result: toResultDto(result, resultId), description: result.description, magnetUri: result.magnetUri || null }
  }

  async startDownload(input: StartDownloadInput, caller: Caller, signal: AbortSignal): Promise<DownloadDto> {
    const folder = caller === 'agent'
      ? resolveAgentFolder(input.folder, this.settings.get().downloadFolder)
      : input.folder?.trim() || null
    if (input.resultId?.trim()) {
      const result = this.cache.get(input.resultId)
      return this.startFromResult(result, { saveFolder: folder, signal })
    }
    if (input.magnet?.trim()) {
      if (!input.magnet.toLowerCase().startsWith('magnet:')) throw new ApiError('`magnet` must be a magnet: URI.')
      const item = this.downloads.add({ name: '', magnetUri: input.magnet.trim(), source: caller === 'agent' ? 'Agent' : 'Magnet', saveFolder: folder })
      log.info(`Started download from a supplied magnet: ${item.name}`)
      return item
    }
    throw new ApiError('Provide either `resultId` (from a search) or `magnet`. For sources that resolve magnets lazily, only `resultId` works.')
  }

  async startFromResult(result: TorrentSearchResult, options: { seriesTaskId?: number | null; saveFolder?: string | null; signal?: AbortSignal }): Promise<DownloadDto> {
    if (needsResolution(result)) {
      const timeout = AbortSignal.timeout(30_000)
      await this.searchService.ensureDetails(result, options.signal ? AbortSignal.any([options.signal, timeout]) : timeout)
      options.signal?.throwIfAborted()
    }
    if (!result.magnetUri) throw new ApiError(`Could not resolve a magnet link for "${result.title}" from ${result.source}.`)
    return this.downloads.add({
      name: result.title,
      magnetUri: result.magnetUri,
      source: result.source,
      seriesTaskId: options.seriesTaskId ?? null,
      saveFolder: options.saveFolder ?? null,
    })
  }

  listDownloads(status?: string | null): DownloadDto[] {
    const all = this.downloads.list()
    if (!status) return all
    const wanted = DOWNLOAD_STATUSES.find(s => s.toLowerCase() === status.toLowerCase())
    if (!wanted) throw new ApiError(`Unknown status '${status}'. Valid values: ${DOWNLOAD_STATUSES.join(', ')}.`)
    return all.filter(d => d.status === (wanted as DownloadStatus))
  }

  getDownload(id: number): DownloadDto {
    return this.downloads.get(id)
  }

  pause(id: number): Promise<DownloadDto> {
    return this.downloads.pause(id)
  }

  resume(id: number): Promise<DownloadDto> {
    return this.downloads.resume(id)
  }

  /** `deleteFiles` erases what was downloaded — the one irreversible action, so it defaults to false everywhere. */
  async deleteDownload(id: number, deleteFiles: boolean): Promise<void> {
    const item = this.downloads.get(id)
    log.info(`Deleting download '${item.name}' (deleteFiles: ${deleteFiles})`)
    await this.downloads.delete(id, deleteFiles)
  }

  listSeries(): SeriesTaskDto[] {
    return this.series.dtos()
  }

  getSeries(id: number): SeriesTaskDto {
    return toSeriesDto(this.series.get(id))
  }

  createSeries(input: z.input<typeof SeriesTaskInput>, caller: Caller): SeriesTaskDto {
    const parsed = parseInput(input)
    this.requireAvailableSource(parsed.provider)
    const folder = caller === 'agent' ? resolveAgentFolder(parsed.downloadFolder, this.settings.get().downloadFolder) : parsed.downloadFolder
    return toSeriesDto(this.series.create({ ...parsed, downloadFolder: folder }))
  }

  /**
   * Changes only the fields supplied, then validates the merged result so a patch can't leave the
   * rule in a state a create would reject. A replace is just a patch that names every field.
   */
  updateSeries(id: number, patch: SeriesTaskPatch, caller: Caller): SeriesTaskDto {
    const task = this.series.get(id)
    const merged = parseInput({
      name: patch.name ?? task.name,
      query: patch.query ?? task.query,
      provider: patch.provider !== undefined ? patch.provider : task.provider,
      titleFilter: patch.titleFilter !== undefined ? patch.titleFilter : task.titleFilter,
      season: patch.season !== undefined ? patch.season : task.season,
      startEpisode: patch.startEpisode ?? task.startEpisode,
      endEpisode: patch.endEpisode !== undefined ? patch.endEpisode : task.endEpisode,
      checkIntervalMinutes: patch.checkIntervalMinutes ?? task.checkIntervalMinutes,
      enabled: patch.enabled ?? task.enabled,
      downloadFolder: patch.downloadFolder !== undefined ? patch.downloadFolder : task.downloadFolder,
    })
    if (patch.provider !== undefined) this.requireAvailableSource(merged.provider)
    // Only re-check the folder when the patch names one: an existing rule may point somewhere the
    // user chose in the dashboard, and renaming it must not fail.
    const folder = patch.downloadFolder === undefined
      ? task.downloadFolder
      : caller === 'agent' ? resolveAgentFolder(merged.downloadFolder, this.settings.get().downloadFolder) : merged.downloadFolder
    return toSeriesDto(this.series.save({ ...task, ...merged, downloadFolder: folder }))
  }

  deleteSeries(id: number): void {
    this.series.delete(id)
  }

  /** Can queue downloads, so it is a write even though it reads like a refresh. */
  async checkSeriesNow(id: number, caller: Caller): Promise<SeriesTaskDto> {
    if (caller === 'agent') this.limiter.ensureAllowed('series check')
    const task = this.series.get(id)
    this.requireAvailableSource(task.provider)
    if (!this.seriesMonitor) throw new ApiError('The series monitor is not running.', 'internal')
    return toSeriesDto(await this.seriesMonitor.checkNow(id))
  }

  /** Rejects a named source a search would silently skip, and an installation with no sources at all. */
  requireAvailableSource(requested: string | null | undefined): void {
    const sources = this.sources()
    if (!requested?.trim()) {
      if (sources.some(s => s.enabled)) return
      throw new ApiError('No torrent sources are available. Enable a source in Settings.')
    }
    const source = sources.find(s => s.name.toLowerCase() === requested.toLowerCase())
    if (!source) throw new ApiError(`Unknown source '${requested}'. Valid sources: ${sources.map(s => s.name).join(', ')}.`)
    if (!source.enabled) throw new ApiError(`Source '${source.name}' is disabled. Enable it in Settings before using it.`)
  }
}

function parseInput(input: z.input<typeof SeriesTaskInput>): SeriesTaskInput {
  const parsed = SeriesTaskInput.safeParse(input)
  if (!parsed.success) throw new ApiError(parsed.error.issues.map(i => i.message).join(' '))
  return parsed.data
}
