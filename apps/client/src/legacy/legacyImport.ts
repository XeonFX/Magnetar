import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import type { DownloadStatus, LegacyImportResultDto, LegacyImportStatusDto } from '@md/protocol'
import { ApiError } from '../api/errors.ts'
import type { KeyValue } from '../db/database.ts'
import { logger } from '../log.ts'
import type { AppSettings, SettingsService } from '../settings.ts'

const log = logger('legacy')
const IMPORTED_KEY = 'legacy.importedAt'

/** The legacy app stored DownloadStatus as its enum index. */
const LEGACY_STATUSES: DownloadStatus[] = ['Queued', 'FetchingMetadata', 'Downloading', 'Seeding', 'Paused', 'Completed', 'Error']

/** EF Core wrote "2026-07-09 14:40:00.1234567" (UTC, no zone). */
export function legacyDate(value: string | null): string | null {
  if (!value) return null
  const iso = value.includes('T') ? value : value.replace(' ', 'T')
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso.slice(0, 23)}Z`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

interface LegacySettingsRow {
  DownloadFolder: string
  NotifyOnStart: number
  NotifyOnComplete: number
  EmailEnabled: number
  SmtpHost: string
  SmtpPort: number
  SmtpUseSsl: number
  SmtpUsername: string
  SmtpPassword: string
  EmailFrom: string
  EmailTo: string
  DesktopEnabled: number
  PushEnabled: number
  NtfyServer: string
  NtfyTopic: string
  TelegramEnabled: number
  TelegramBotToken: string
  TelegramChatId: string
  PostDownloadAction?: number
  DisabledProviders?: string
  Language?: string
  AgentApiEnabled?: number
  AgentApiAllowRemote?: number
}

/**
 * Imports downloads, series tasks and settings from the legacy .NET MediaDownloader. The legacy
 * database is opened read-only and never changed, so the old app keeps working. Its secrets were
 * encrypted with ASP.NET Data Protection keys this app can't use; they are reported for re-entry.
 */
export class LegacyImporter {
  constructor(
    private readonly db: Database,
    private readonly kv: KeyValue,
    private readonly settings: SettingsService,
    private readonly legacyPath: string | null,
  ) {}

  status(): LegacyImportStatusDto {
    const path = this.legacyPath
    if (!path || !existsSync(path)) return { available: false, path, imported: false, downloads: 0, seriesTasks: 0 }
    try {
      const legacy = new Database(path, { readonly: true })
      try {
        const count = (table: string) => (legacy.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n
        return { available: true, path, imported: this.kv.get(IMPORTED_KEY) !== null, downloads: count('Downloads'), seriesTasks: count('SeriesTasks') }
      } finally {
        legacy.close()
      }
    } catch (error) {
      log.warn('Could not read the legacy database', error)
      return { available: false, path, imported: false, downloads: 0, seriesTasks: 0 }
    }
  }

  run(): LegacyImportResultDto {
    const path = this.legacyPath
    if (!path || !existsSync(path)) throw new ApiError('No legacy MediaDownloader database was found.')
    const legacy = new Database(path, { readonly: true })
    try {
      return this.db.transaction(() => this.copy(legacy))()
    } finally {
      legacy.close()
    }
  }

  private copy(legacy: Database): LegacyImportResultDto {
    const secretsToReenter: string[] = []
    const settingsRow = legacy.query('SELECT * FROM "Settings" WHERE "Id" = 1').get() as LegacySettingsRow | null
    if (settingsRow) {
      const change: Partial<AppSettings> = {
        downloadFolder: settingsRow.DownloadFolder,
        notifyOnStart: settingsRow.NotifyOnStart === 1,
        notifyOnComplete: settingsRow.NotifyOnComplete === 1,
        emailEnabled: settingsRow.EmailEnabled === 1,
        smtpHost: settingsRow.SmtpHost,
        smtpPort: settingsRow.SmtpPort,
        smtpUseSsl: settingsRow.SmtpUseSsl === 1,
        smtpUsername: settingsRow.SmtpUsername,
        emailFrom: settingsRow.EmailFrom,
        emailTo: settingsRow.EmailTo,
        desktopEnabled: settingsRow.DesktopEnabled === 1,
        pushEnabled: settingsRow.PushEnabled === 1,
        ntfyServer: settingsRow.NtfyServer,
        ntfyTopic: settingsRow.NtfyTopic,
        telegramEnabled: settingsRow.TelegramEnabled === 1,
        telegramChatId: settingsRow.TelegramChatId,
        postDownloadAction: settingsRow.PostDownloadAction === 1 ? 'KeepSeeding' : 'StopSeeding',
        disabledProviders: (settingsRow.DisabledProviders ?? '').split(',').map(s => s.trim()).filter(p => p && p !== 'PTE'),
        language: settingsRow.Language || 'en',
        agentApiEnabled: settingsRow.AgentApiEnabled === 1,
        agentApiAllowRemote: settingsRow.AgentApiAllowRemote === 1,
      }
      this.settings.save(change)
      if (settingsRow.SmtpPassword) secretsToReenter.push('SMTP password')
      if (settingsRow.TelegramBotToken) secretsToReenter.push('Telegram bot token')
    }

    const seriesMap = new Map<number, number>()
    const series = legacy.query('SELECT * FROM "SeriesTasks" ORDER BY "Id"').all() as Record<string, unknown>[]
    let seriesTasks = 0
    for (const row of series) {
      // A re-import maps to the task it created last time instead of adding it again.
      const existing = this.db.query('SELECT id FROM series_tasks WHERE name = ? AND query = ?').get(row.Name as string, row.Query as string) as { id: number } | null
      if (existing) {
        seriesMap.set(row.Id as number, existing.id)
        continue
      }
      const inserted = this.db.query(`INSERT INTO series_tasks (name, query, provider, title_filter, season, start_episode, end_episode,
        download_folder, last_downloaded_episode, check_interval_minutes, enabled, last_checked_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
        row.Name as string, row.Query as string, row.Provider === 'PTE' ? null : (row.Provider as string | null),
        row.TitleFilter as string | null, row.Season as number | null, row.StartEpisode as number, row.EndEpisode as number | null,
        row.DownloadFolder as string | null, row.LastDownloadedEpisode as number, row.CheckIntervalMinutes as number,
        row.Enabled as number, legacyDate(row.LastCheckedAt as string | null), legacyDate(row.CreatedAt as string) ?? new Date().toISOString(),
      ) as { id: number }
      seriesMap.set(row.Id as number, inserted.id)
      seriesTasks++
    }

    let downloads = 0
    const rows = legacy.query('SELECT * FROM "Downloads" ORDER BY "Id"').all() as Record<string, unknown>[]
    for (const row of rows) {
      // Private-tracker (.torrent file) downloads can't be resumed without that tracker.
      if (!(row.MagnetUri as string)) continue
      const status = LEGACY_STATUSES[row.Status as number] ?? 'Paused'
      const result = this.db.query(`INSERT OR IGNORE INTO downloads (name, name_is_placeholder, magnet_uri, info_hash, save_path, source,
        status, progress, total_bytes, added_at, completed_at, error, start_notification_sent, complete_notification_sent, series_task_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        row.Name as string, (row.NameIsPlaceholder as number | undefined) ?? 0, row.MagnetUri as string,
        (row.InfoHash as string).toLowerCase(), row.SavePath as string, row.Source as string,
        // Imported downloads start paused so both apps never write the same files at once.
        status === 'Completed' || status === 'Error' ? status : 'Paused',
        row.Progress as number, row.TotalBytes as number, legacyDate(row.AddedAt as string) ?? new Date().toISOString(),
        legacyDate(row.CompletedAt as string | null), row.Error as string | null, row.CompleteNotificationSent as number,
        row.SeriesTaskId == null ? null : seriesMap.get(row.SeriesTaskId as number) ?? null,
      )
      downloads += result.changes
    }

    this.kv.set(IMPORTED_KEY, new Date().toISOString())
    log.info(`Imported ${downloads} downloads and ${seriesTasks} series tasks from the legacy app`)
    return { downloads, seriesTasks, settings: settingsRow !== null, secretsToReenter }
  }
}
