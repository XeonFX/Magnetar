import type { Database } from 'bun:sqlite'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import type { DownloadDto, DownloadStatus } from '@md/protocol'
import { ApiError } from '../api/errors.ts'
import type { EventBus } from '../events.ts'
import { logger } from '../log.ts'
import type { NotificationDispatcher } from '../notifications/dispatcher.ts'
import { extractInfoHash, magnetName, normalizeInfoHash } from '../search/magnet.ts'
import type { SettingsService } from '../settings.ts'
import type { EngineTorrent, TorrentEngine } from './engine.ts'

const log = logger('downloads')

/** A dead torrent otherwise sits on "Fetching metadata" forever with no feedback. */
export const METADATA_TIMEOUT_MS = 3 * 60_000
const TICK_MS = 1000
const PERSIST_EVERY_TICKS = 20

interface DownloadRow {
  id: number
  name: string
  name_is_placeholder: number
  magnet_uri: string
  info_hash: string
  save_path: string
  source: string
  status: DownloadStatus
  progress: number
  total_bytes: number
  added_at: string
  completed_at: string | null
  error: string | null
  start_notification_sent: number
  complete_notification_sent: number
  series_task_id: number | null
}

interface Item {
  id: number
  name: string
  nameIsPlaceholder: boolean
  magnetUri: string
  infoHash: string
  savePath: string
  source: string
  status: DownloadStatus
  progress: number
  totalBytes: number
  addedAt: string
  completedAt: string | null
  error: string | null
  startNotificationSent: boolean
  completeNotificationSent: boolean
  seriesTaskId: number | null
  // Runtime only
  downloadSpeed: number
  uploadSpeed: number
  peers: number
  handle: EngineTorrent | null
  metadataSince: number | null
}

export interface AddDownloadInput {
  name: string
  magnetUri: string
  source: string
  seriesTaskId?: number | null
  saveFolder?: string | null
}

/**
 * Owns every download: persists them, drives the torrent engine, resumes unfinished ones on start,
 * and publishes live progress. The engine is optional so tests can run everything above it
 * without opening peer or DHT sockets.
 */
export class DownloadManager {
  private readonly items = new Map<number, Item>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticks = 0
  /** Runtime stats last sent to dashboards, so an idle tick sends nothing. */
  private lastStats = ''
  private shuttingDown = false
  private changedPending = false

  constructor(
    private readonly db: Database,
    private readonly engine: TorrentEngine | null,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationDispatcher,
    private readonly events: EventBus,
    private readonly torrentCache: string,
  ) {}

  start(): void {
    const rows = this.db.query('SELECT * FROM downloads').all() as DownloadRow[]
    for (const row of rows) {
      const item = fromRow(row)
      if (item.progress >= 100 && item.status !== 'Completed' && item.status !== 'Seeding') {
        item.status = 'Completed'
        item.completedAt ??= new Date().toISOString()
        this.persist(item)
      }
      this.items.set(item.id, item)
    }
    let resumed = 0
    for (const item of this.items.values()) {
      if (!this.engine || item.status === 'Completed' || item.status === 'Error' || item.status === 'Paused') continue
      try {
        this.attach(item)
        resumed++
      } catch (error) {
        this.fail(item, error instanceof Error ? error.message : String(error))
      }
    }
    if (this.engine) this.timer = setInterval(() => this.tick(), TICK_MS)
    log.info(`Download manager started, resumed ${resumed} downloads`)
  }

  /** Picks up rows written behind the manager's back (the legacy importer). */
  loadNew(): void {
    const rows = this.db.query('SELECT * FROM downloads').all() as DownloadRow[]
    for (const row of rows) if (!this.items.has(row.id)) this.items.set(row.id, fromRow(row))
    this.changed()
  }

  async stop(): Promise<void> {
    this.shuttingDown = true
    if (this.timer) clearInterval(this.timer)
    this.persistAll(this.items.values())
    // Closing every peer and DHT socket can take seconds; progress is already saved.
    if (this.engine) await Promise.race([this.engine.destroy(), Bun.sleep(3000)])
  }

  list(): DownloadDto[] {
    return [...this.items.values()].sort((a, b) => b.addedAt.localeCompare(a.addedAt)).map(toDto)
  }

  get(id: number): DownloadDto {
    return toDto(this.require(id))
  }

  /** Adds a magnet, or returns the download already tracking that torrent. */
  add(input: AddDownloadInput): DownloadDto {
    const rawHash = extractInfoHash(input.magnetUri)
    const hash = rawHash ? normalizeInfoHash(rawHash) : null
    if (!hash) throw new ApiError('That magnet link has no valid info hash.')
    const existing = [...this.items.values()].find(i => i.infoHash.toLowerCase() === hash)
    if (existing) return toDto(existing)

    const savePath = input.saveFolder?.trim() || this.settings.get().downloadFolder
    mkdirSync(savePath, { recursive: true })
    const displayName = input.name.trim() || magnetName(input.magnetUri) || hash
    const addedAt = new Date().toISOString()
    const result = this.db.query(`INSERT INTO downloads
      (name, name_is_placeholder, magnet_uri, info_hash, save_path, source, status, added_at, series_task_id)
      VALUES (?, ?, ?, ?, ?, ?, 'Queued', ?, ?) RETURNING *`)
      .get(displayName, displayName === hash ? 1 : 0, input.magnetUri, hash, savePath, input.source, addedAt, input.seriesTaskId ?? null) as DownloadRow
    const item = fromRow(result)
    this.items.set(item.id, item)
    if (this.engine) {
      try {
        this.attach(item)
        this.sendStartNotification(item)
      } catch (error) {
        this.fail(item, error instanceof Error ? error.message : String(error))
      }
    }
    this.changed()
    return toDto(item)
  }

  async pause(id: number): Promise<DownloadDto> {
    const item = this.require(id)
    await this.detach(item, false)
    item.status = 'Paused'
    this.clearStats(item)
    this.persist(item)
    this.changed()
    return toDto(item)
  }

  /** Resume a paused download, or retry a failed one. */
  async resume(id: number): Promise<DownloadDto> {
    const item = this.require(id)
    item.error = null
    item.metadataSince = null
    if (!this.engine) {
      item.status = 'Queued'
    } else if (!item.handle) {
      this.attach(item)
      this.sendStartNotification(item)
    }
    this.persist(item)
    this.changed()
    return toDto(item)
  }

  async delete(id: number, deleteFiles: boolean): Promise<void> {
    const item = this.require(id)
    // Drop it from the live list first so the tick and event handlers leave it alone.
    this.items.delete(id)
    this.changed()
    try {
      const contentDir = item.handle?.contentDirectory ?? null
      await this.detach(item, deleteFiles)
      if (deleteFiles && contentDir) removeEmptyTree(contentDir, item.savePath)
      this.db.query('DELETE FROM downloads WHERE id = ?').run(id)
      const cached = this.cachedTorrentPath(item.infoHash)
      if (existsSync(cached)) unlinkSync(cached)
    } catch (error) {
      log.error(`Failed to delete download ${id}`, error)
    }
  }

  /** Counts for the tray: active rows and total download rate. */
  active(): DownloadDto[] {
    return this.list().filter(d => d.status === 'Downloading' || d.status === 'Seeding' || d.status === 'FetchingMetadata')
  }

  private require(id: number): Item {
    const item = this.items.get(id)
    if (!item) throw ApiError.notFound(`No download with id ${id}.`)
    return item
  }

  private cachedTorrentPath(hash: string): string {
    return join(this.torrentCache, `${hash.toLowerCase()}.torrent`)
  }

  private attach(item: Item): void {
    if (!this.engine || item.handle) return
    mkdirSync(item.savePath, { recursive: true })
    const cached = this.cachedTorrentPath(item.infoHash)
    const source = existsSync(cached) ? new Uint8Array(readFileSync(cached)) : item.magnetUri
    const handle = this.engine.add(source, item.savePath)
    item.handle = handle
    item.status = handle.hasMetadata ? 'Downloading' : 'FetchingMetadata'
    item.metadataSince = handle.hasMetadata ? null : Date.now()

    handle.on('metadata', () => this.onMetadata(item, handle))
    handle.on('ready', () => {
      if (item.handle !== handle || this.shuttingDown) return
      this.onMetadata(item, handle)
      if (item.status === 'FetchingMetadata') item.status = 'Downloading'
      this.persist(item)
      this.changed()
    })
    handle.on('done', () => void this.onDone(item, handle))
    handle.on('error', (error: Error) => {
      if (item.handle !== handle || this.shuttingDown) return
      this.fail(item, error.message)
    })
  }

  private onMetadata(item: Item, handle: EngineTorrent): void {
    if (item.handle !== handle) return
    item.metadataSince = null
    item.totalBytes = handle.totalBytes
    if ((item.nameIsPlaceholder || !item.name) && handle.name) {
      item.name = handle.name
      item.nameIsPlaceholder = false
    }
    const file = handle.torrentFile
    const cached = this.cachedTorrentPath(item.infoHash)
    if (file && !existsSync(cached)) {
      try {
        mkdirSync(this.torrentCache, { recursive: true })
        writeFileSync(cached, file)
      } catch (error) {
        log.warn(`Could not cache metadata for ${item.name}`, error)
      }
    }
  }

  private async onDone(item: Item, handle: EngineTorrent): Promise<void> {
    if (item.handle !== handle || this.shuttingDown || !this.items.has(item.id)) return
    item.progress = 100
    item.totalBytes = handle.totalBytes || item.totalBytes
    if (!item.completeNotificationSent) {
      item.completeNotificationSent = true
      item.completedAt = new Date().toISOString()
      void this.notifications.dispatch({ kind: 'completed', title: 'Download finished', message: item.name })
    }
    if (this.settings.get().postDownloadAction === 'StopSeeding') {
      await this.detach(item, false)
      item.status = 'Completed'
      this.clearStats(item)
    } else {
      item.status = 'Seeding'
    }
    this.persist(item)
    this.changed()
  }

  private sendStartNotification(item: Item): void {
    if (item.startNotificationSent) return
    item.startNotificationSent = true
    this.persist(item)
    void this.notifications.dispatch({ kind: 'started', title: 'Download started', message: item.name })
  }

  private async detach(item: Item, deleteFiles: boolean): Promise<void> {
    const handle = item.handle
    item.handle = null
    if (handle && this.engine) await this.engine.remove(handle, deleteFiles)
  }

  private fail(item: Item, message: string): void {
    item.status = 'Error'
    item.error = message
    this.clearStats(item)
    void this.detach(item, false)
    this.persist(item)
    this.changed()
  }

  private clearStats(item: Item): void {
    item.downloadSpeed = 0
    item.uploadSpeed = 0
    item.peers = 0
  }

  private tick(): void {
    let anyActive = false
    const now = Date.now()
    for (const item of this.items.values()) {
      const handle = item.handle
      if (!handle) continue
      if (!handle.hasMetadata && item.metadataSince !== null && now - item.metadataSince > METADATA_TIMEOUT_MS) {
        log.info(`Gave up fetching metadata for ${item.name} after ${METADATA_TIMEOUT_MS / 60_000} min (no peers)`)
        this.fail(item, 'No peers found — the torrent may be dead or have no seeders.')
        continue
      }
      anyActive = true
      if (handle.hasMetadata) item.progress = Math.round(handle.progress * 10_000) / 100
      item.downloadSpeed = handle.downloadSpeed
      item.uploadSpeed = handle.uploadSpeed
      item.peers = handle.peers
      if (handle.totalBytes) item.totalBytes = handle.totalBytes
    }
    if (anyActive) {
      const stats = [...this.items.values()].filter(i => i.handle)
        .map(i => `${i.id}:${i.progress}:${i.downloadSpeed}:${i.uploadSpeed}:${i.peers}:${i.totalBytes}`).join(',')
      if (stats !== this.lastStats) {
        this.lastStats = stats
        this.changed()
      }
    }
    if (++this.ticks % PERSIST_EVERY_TICKS === 0) this.persistAll([...this.items.values()].filter(i => i.handle))
  }

  /** Coalesces change notifications to at most one per event-loop turn. */
  private changed(): void {
    if (this.changedPending) return
    this.changedPending = true
    queueMicrotask(() => {
      this.changedPending = false
      this.events.emit('downloads.changed', this.list())
    })
  }

  /** One transaction, so a periodic save is one commit rather than one per download. */
  private persistAll(items: Iterable<Item>): void {
    this.db.transaction(() => {
      for (const item of items) this.persist(item)
    })()
  }

  private persist(item: Item): void {
    if (!this.items.has(item.id)) return
    this.db.query(`UPDATE downloads SET name = ?, name_is_placeholder = ?, status = ?, progress = ?, total_bytes = ?,
      completed_at = ?, error = ?, start_notification_sent = ?, complete_notification_sent = ? WHERE id = ?`)
      .run(item.name, item.nameIsPlaceholder ? 1 : 0, item.status, item.progress, item.totalBytes,
        item.completedAt, item.error, item.startNotificationSent ? 1 : 0, item.completeNotificationSent ? 1 : 0, item.id)
  }
}

function fromRow(row: DownloadRow): Item {
  return {
    id: row.id,
    name: row.name,
    nameIsPlaceholder: row.name_is_placeholder === 1,
    magnetUri: row.magnet_uri,
    infoHash: row.info_hash,
    savePath: row.save_path,
    source: row.source,
    status: row.status,
    progress: row.progress,
    totalBytes: row.total_bytes,
    addedAt: row.added_at,
    completedAt: row.completed_at,
    error: row.error,
    startNotificationSent: row.start_notification_sent === 1,
    completeNotificationSent: row.complete_notification_sent === 1,
    seriesTaskId: row.series_task_id,
    downloadSpeed: 0,
    uploadSpeed: 0,
    peers: 0,
    handle: null,
    metadataSince: null,
  }
}

function toDto(item: Item): DownloadDto {
  return {
    id: item.id,
    name: item.name,
    status: item.status,
    progress: item.progress,
    totalBytes: item.totalBytes,
    downloadSpeed: item.downloadSpeed,
    uploadSpeed: item.uploadSpeed,
    peers: item.peers,
    source: item.source,
    savePath: item.savePath,
    addedAt: item.addedAt,
    completedAt: item.completedAt,
    error: item.error,
    seriesTaskId: item.seriesTaskId,
  }
}

/**
 * Removes a torrent's leftover folder once the engine has deleted its files — but only empty
 * directories, only strictly inside the save root, never the root itself. A user may have put
 * other files there, or another torrent may share it.
 */
export function removeEmptyTree(contentDir: string, saveRoot: string): void {
  const content = resolve(contentDir)
  const rel = relative(resolve(saveRoot), content)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return
  const prune = (dir: string): boolean => {
    let empty = true
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      // lstat: a symlink is content to keep, never a directory to walk into.
      if (lstatSync(path).isDirectory() && prune(path)) continue
      empty = false
    }
    if (empty) rmdirSync(dir)
    return empty
  }
  try {
    if (existsSync(content)) prune(content)
  } catch (error) {
    log.warn(`Could not remove leftover folder ${content}`, error)
  }
}
