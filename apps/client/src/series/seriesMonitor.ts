import type { Actions } from '../api/actions.ts'
import { logger } from '../log.ts'
import type { SearchService } from '../search/searchService.ts'
import type { TorrentSearchResult } from '../search/types.ts'
import { episodeQueries, matchesEpisode } from './episodeParser.ts'
import { isFinished, nextEpisode, type SeriesStore, type SeriesTask } from './seriesStore.ts'

const log = logger('series')
const POLL_MS = 60_000
const STARTUP_DELAY_MS = 10_000
/** Bounds the work of one check if a loose rule matches many episodes at once. */
const MAX_EPISODES_PER_CHECK = 25

/** Periodically checks due series tasks and queues their new episodes. */
export class SeriesMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly controller = new AbortController()
  private readonly running = new Set<number>()

  constructor(
    private readonly store: SeriesStore,
    private readonly search: SearchService,
    private readonly actions: Pick<Actions, 'startFromResult'>,
  ) {}

  start(): void {
    const loop = async () => {
      try {
        await this.checkDue()
      } catch (error) {
        log.error('Series check pass failed', error)
      }
      if (!this.controller.signal.aborted) this.timer = setTimeout(loop, POLL_MS)
    }
    this.timer = setTimeout(loop, STARTUP_DELAY_MS)
  }

  stop(): void {
    this.controller.abort()
    if (this.timer) clearTimeout(this.timer)
  }

  private async checkDue(): Promise<void> {
    const now = Date.now()
    for (const task of this.store.all()) {
      if (!task.enabled) continue
      const due = !task.lastCheckedAt || Date.parse(task.lastCheckedAt) + task.checkIntervalMinutes * 60_000 <= now
      if (!due) continue
      // One task failing (a provider bug) must not stop the others from being checked.
      try {
        await this.check(task)
      } catch (error) {
        if (this.controller.signal.aborted) return
        log.error(`Series check failed for '${task.name}'`, error)
      }
    }
  }

  /** Runs one check immediately (the "Check now" button and the agent tool). */
  async checkNow(id: number): Promise<SeriesTask> {
    await this.check(this.store.get(id))
    return this.store.get(id)
  }

  private async check(task: SeriesTask): Promise<void> {
    if (this.running.has(task.id)) return
    this.running.add(task.id)
    try {
      // A blank query would match arbitrary torrents: never auto-download for one.
      if (!task.query.trim()) return
      log.info(`Checking series '${task.name}' for episode ${nextEpisode(task)}`)
      // Catching up asks the same broad query for every episode; ask each site once per check.
      const searches = new Map<string, Promise<TorrentSearchResult[]>>()
      for (let guard = 0; guard < MAX_EPISODES_PER_CHECK; guard++) {
        if (isFinished(task)) break
        const episode = nextEpisode(task)
        const result = await this.findEpisode(task, episode, searches)
        if (!result) break
        await this.actions.startFromResult(result, { seriesTaskId: task.id, saveFolder: task.downloadFolder })
        task.lastDownloadedEpisode = episode
        // Saved per episode: a failure hunting the next one must not lose the record that this
        // one was queued, or the next pass could add a second download of it.
        this.store.save(this.fresh(task))
        log.info(`Series '${task.name}': queued episode ${episode} (${result.title})`)
      }
    } finally {
      const latest = this.fresh(task)
      if (isFinished(latest)) latest.enabled = false
      latest.lastCheckedAt = new Date().toISOString()
      this.store.save(latest)
      this.running.delete(task.id)
    }
  }

  /**
   * Re-reads the task and applies what this check changed. The user may edit the rule from the
   * dashboard while a slow check runs; those edits must not be overwritten by the check's copy.
   */
  private fresh(task: SeriesTask): SeriesTask {
    try {
      const current = this.store.get(task.id)
      current.lastDownloadedEpisode = Math.max(current.lastDownloadedEpisode, task.lastDownloadedEpisode)
      return current
    } catch {
      return task
    }
  }

  private async findEpisode(task: SeriesTask, episode: number, searches: Map<string, Promise<TorrentSearchResult[]>>): Promise<TorrentSearchResult | null> {
    for (const query of episodeQueries(task, episode)) {
      let results = searches.get(query)
      if (!results) {
        // No relevance filter: episode matching below is stricter. Results come seeder-sorted.
        results = this.search.collect(query, task.provider, this.controller.signal, false).then(r => r.results)
        searches.set(query, results)
      }
      const match = (await results).find(r => matchesEpisode(r.title, task, episode))
      if (match) return match
    }
    return null
  }
}
