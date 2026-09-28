import type { Database } from 'bun:sqlite'
import type { SeriesTaskDto, SeriesTaskInput } from '@md/protocol'
import { ApiError } from '../api/errors.ts'
import type { EventBus } from '../events.ts'

export interface SeriesTask {
  id: number
  name: string
  query: string
  provider: string | null
  titleFilter: string | null
  season: number | null
  startEpisode: number
  endEpisode: number | null
  downloadFolder: string | null
  lastDownloadedEpisode: number
  checkIntervalMinutes: number
  enabled: boolean
  lastCheckedAt: string | null
  createdAt: string
}

interface SeriesRow {
  id: number
  name: string
  query: string
  provider: string | null
  title_filter: string | null
  season: number | null
  start_episode: number
  end_episode: number | null
  download_folder: string | null
  last_downloaded_episode: number
  check_interval_minutes: number
  enabled: number
  last_checked_at: string | null
  created_at: string
}

export function nextEpisode(task: SeriesTask): number {
  return Math.max(task.startEpisode, task.lastDownloadedEpisode + 1)
}

export function isFinished(task: SeriesTask): boolean {
  return task.endEpisode !== null && task.lastDownloadedEpisode >= task.endEpisode
}

export class SeriesStore {
  constructor(private readonly db: Database, private readonly events: EventBus) {}

  all(): SeriesTask[] {
    return (this.db.query('SELECT * FROM series_tasks ORDER BY id').all() as SeriesRow[]).map(fromRow)
  }

  get(id: number): SeriesTask {
    const row = this.db.query('SELECT * FROM series_tasks WHERE id = ?').get(id) as SeriesRow | null
    if (!row) throw ApiError.notFound(`No series task with id ${id}.`)
    return fromRow(row)
  }

  create(input: SeriesTaskInput): SeriesTask {
    const row = this.db.query(`INSERT INTO series_tasks
      (name, query, provider, title_filter, season, start_episode, end_episode, download_folder, check_interval_minutes, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(input.name, input.query, input.provider, input.titleFilter, input.season, input.startEpisode, input.endEpisode,
        input.downloadFolder, input.checkIntervalMinutes, input.enabled ? 1 : 0, new Date().toISOString()) as SeriesRow
    this.changed()
    return fromRow(row)
  }

  save(task: SeriesTask): SeriesTask {
    this.db.query(`UPDATE series_tasks SET name = ?, query = ?, provider = ?, title_filter = ?, season = ?, start_episode = ?,
      end_episode = ?, download_folder = ?, last_downloaded_episode = ?, check_interval_minutes = ?, enabled = ?, last_checked_at = ?
      WHERE id = ?`)
      .run(task.name, task.query, task.provider, task.titleFilter, task.season, task.startEpisode, task.endEpisode,
        task.downloadFolder, task.lastDownloadedEpisode, task.checkIntervalMinutes, task.enabled ? 1 : 0, task.lastCheckedAt, task.id)
    this.changed()
    return task
  }

  /** Its downloads are kept and become manual downloads (the foreign key sets them to null). */
  delete(id: number): void {
    this.get(id)
    this.db.query('DELETE FROM series_tasks WHERE id = ?').run(id)
    this.changed()
  }

  dtos(): SeriesTaskDto[] {
    return this.all().map(toSeriesDto)
  }

  changed(): void {
    this.events.emit('series.changed', this.dtos())
  }
}

function fromRow(row: SeriesRow): SeriesTask {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    provider: row.provider,
    titleFilter: row.title_filter,
    season: row.season,
    startEpisode: row.start_episode,
    endEpisode: row.end_episode,
    downloadFolder: row.download_folder,
    lastDownloadedEpisode: row.last_downloaded_episode,
    checkIntervalMinutes: row.check_interval_minutes,
    enabled: row.enabled === 1,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
  }
}

export function toSeriesDto(t: SeriesTask): SeriesTaskDto {
  return {
    id: t.id,
    name: t.name,
    query: t.query,
    provider: t.provider,
    titleFilter: t.titleFilter,
    season: t.season,
    startEpisode: t.startEpisode,
    endEpisode: t.endEpisode,
    lastDownloadedEpisode: t.lastDownloadedEpisode,
    nextEpisode: nextEpisode(t),
    checkIntervalMinutes: t.checkIntervalMinutes,
    enabled: t.enabled,
    downloadFolder: t.downloadFolder,
    lastCheckedAt: t.lastCheckedAt,
    finished: isFinished(t),
  }
}
