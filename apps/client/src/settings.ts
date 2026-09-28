import type { Database } from 'bun:sqlite'
import type { PostDownloadAction, SettingsDto, SettingsPatch } from '@md/protocol'
import type { SecretStore } from './db/secrets.ts'
import type { EventBus } from './events.ts'
import { DEFAULT_DOWNLOAD_FOLDER } from './paths.ts'

/** Everything persisted in the settings row. Secrets live in the SecretStore instead. */
export interface AppSettings {
  downloadFolder: string
  postDownloadAction: PostDownloadAction
  disabledProviders: string[]
  language: string
  notifyOnStart: boolean
  notifyOnComplete: boolean
  emailEnabled: boolean
  smtpHost: string
  smtpPort: number
  smtpUseSsl: boolean
  smtpUsername: string
  emailFrom: string
  emailTo: string
  desktopEnabled: boolean
  pushEnabled: boolean
  ntfyServer: string
  ntfyTopic: string
  telegramEnabled: boolean
  telegramChatId: string
  /** Off by default: enabling it lets any program on this machine search and start downloads. */
  agentApiEnabled: boolean
  /** Remote agent requests still need HTTPS and the bearer token. */
  agentApiAllowRemote: boolean
  /** Scrubbed error reports to CodeFusion Console (see telemetry.ts). */
  errorReportsEnabled: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  downloadFolder: DEFAULT_DOWNLOAD_FOLDER,
  postDownloadAction: 'StopSeeding',
  disabledProviders: [],
  language: 'en',
  notifyOnStart: true,
  notifyOnComplete: true,
  emailEnabled: false,
  smtpHost: '',
  smtpPort: 587,
  smtpUseSsl: true,
  smtpUsername: '',
  emailFrom: '',
  emailTo: '',
  desktopEnabled: true,
  pushEnabled: false,
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: '',
  telegramEnabled: false,
  telegramChatId: '',
  agentApiEnabled: false,
  agentApiAllowRemote: false,
  errorReportsEnabled: true,
}

export class SettingsService {
  private cached: AppSettings | null = null

  constructor(private readonly db: Database, readonly secrets: SecretStore, private readonly events: EventBus) {}

  get(): AppSettings {
    if (this.cached) return this.cached
    const row = this.db.query('SELECT json FROM settings WHERE id = 1').get() as { json: string } | null
    let stored: Partial<AppSettings> = {}
    try {
      stored = row ? (JSON.parse(row.json) as Partial<AppSettings>) : {}
    } catch {
      stored = {}
    }
    this.cached = { ...DEFAULT_SETTINGS, ...stored }
    return this.cached
  }

  /** Writes a change to the non-secret settings and tells every dashboard. */
  save(change: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...change }
    this.db.query('INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(JSON.stringify(next))
    this.cached = next
    this.events.emit('settings.changed', this.toDto())
    return next
  }

  /** Applies a validated patch from the dashboard, secrets included. */
  applyPatch(patch: SettingsPatch): SettingsDto {
    const { smtpPassword, telegramBotToken, ...plain } = patch
    if (smtpPassword !== undefined) this.secrets.set('smtpPassword', smtpPassword)
    if (telegramBotToken !== undefined) this.secrets.set('telegramBotToken', telegramBotToken)
    const change: Partial<AppSettings> = {}
    for (const [key, value] of Object.entries(plain)) {
      if (value !== undefined) (change as Record<string, unknown>)[key] = value
    }
    this.save(change)
    return this.toDto()
  }

  isProviderEnabled(name: string): boolean {
    return !this.get().disabledProviders.some(p => p.toLowerCase() === name.toLowerCase())
  }

  toDto(): SettingsDto {
    const s = this.get()
    return {
      downloadFolder: s.downloadFolder,
      postDownloadAction: s.postDownloadAction,
      disabledProviders: s.disabledProviders,
      language: s.language,
      notifyOnStart: s.notifyOnStart,
      notifyOnComplete: s.notifyOnComplete,
      emailEnabled: s.emailEnabled,
      smtpHost: s.smtpHost,
      smtpPort: s.smtpPort,
      smtpUseSsl: s.smtpUseSsl,
      smtpUsername: s.smtpUsername,
      smtpPasswordSet: this.secrets.has('smtpPassword'),
      emailFrom: s.emailFrom,
      emailTo: s.emailTo,
      desktopEnabled: s.desktopEnabled,
      pushEnabled: s.pushEnabled,
      ntfyServer: s.ntfyServer,
      ntfyTopic: s.ntfyTopic,
      telegramEnabled: s.telegramEnabled,
      telegramBotTokenSet: this.secrets.has('telegramBotToken'),
      telegramChatId: s.telegramChatId,
      errorReportsEnabled: s.errorReportsEnabled,
    }
  }
}
