import { z } from 'zod'

export const DOWNLOAD_STATUSES = [
  'Queued', 'FetchingMetadata', 'Downloading', 'Seeding', 'Paused', 'Completed', 'Error',
] as const
export type DownloadStatus = (typeof DOWNLOAD_STATUSES)[number]

export type PostDownloadAction = 'StopSeeding' | 'KeepSeeding' | 'SeedToRatio'

/** When the alternative speed limits apply instead of the usual ones. */
export type AltSpeedMode = 'off' | 'on' | 'scheduled'

/** The engine refuses caps below this (bytes per second); 0 is no cap. */
export const MIN_SPEED_LIMIT = 32 * 1024

export type EngineState = 'running' | 'starting' | 'waitingForNetwork' | 'failed' | 'off'

/** The torrent engine and its limits, as the Downloads page shows them. */
export interface TransferStatusDto {
  engine: EngineState
  message: string | null
  networkInterface: string | null
  altSpeedActive: boolean
  /** The caps in force now, bytes per second; 0 is none. */
  downloadLimit: number
  uploadLimit: number
  /** Free space where new downloads go. */
  freeBytes: number | null
}

export interface NetworkInterfaceDto {
  name: string
  addresses: string[]
  /** Named like a VPN tunnel (utun, tun, wg, ppp, ipsec…). */
  vpn: boolean
}

/** One file of a download's torrent. */
export interface DownloadFileDto {
  index: number
  /** Relative to the download's folder, with / separators. */
  path: string
  size: number
  /** Verified bytes so far. */
  done: number
  selected: boolean
  /** A video or audio file the dashboard can play. */
  playable: boolean
}

/** A search source and whether the user has it switched on. */
export interface SourceDto {
  name: string
  enabled: boolean
}

/** One row of a search. `resultId` is a handle valid for about 30 minutes. */
export interface SearchResultDto {
  resultId: string
  title: string
  source: string
  sizeBytes: number
  seeders: number
  leechers: number
  /** ISO timestamp, or null when the source doesn't say. */
  publishedAt: string | null
  detailsUrl: string | null
  /** Real v1/v2 info hash, or null while a lazy source hasn't resolved it. */
  infoHash: string | null
}

/** How one source fared during a search. */
export interface SourceOutcomeDto {
  source: string
  status: 'ok' | 'failed'
  /** Rows before relevance filtering. */
  returned: number
  /** Rows dropped because the title didn't contain every word of the query. */
  filtered: number
  error: string | null
}

export interface SearchResponse {
  results: SearchResultDto[]
  sources: SourceOutcomeDto[]
  totalMatched: number
  truncated: boolean
}

export interface TorrentDetailsDto {
  result: SearchResultDto
  description: string | null
  magnetUri: string | null
}

export interface DownloadDto {
  id: number
  name: string
  status: DownloadStatus
  /** 0–100 */
  progress: number
  totalBytes: number
  downloadSpeed: number
  uploadSpeed: number
  peers: number
  source: string
  savePath: string
  addedAt: string
  completedAt: string | null
  error: string | null
  seriesTaskId: number | null
  uploadedBytes: number
  /** Set when only some of the torrent's files are downloaded. */
  partialFiles: { selected: number; total: number } | null
}

export interface SeriesTaskDto {
  id: number
  name: string
  query: string
  provider: string | null
  titleFilter: string | null
  season: number | null
  startEpisode: number
  endEpisode: number | null
  lastDownloadedEpisode: number
  nextEpisode: number
  checkIntervalMinutes: number
  enabled: boolean
  downloadFolder: string | null
  lastCheckedAt: string | null
  finished: boolean
}

/** Secret fields are write-only: reads say whether one is set, never what it is. */
export interface SettingsDto {
  downloadFolder: string
  postDownloadAction: PostDownloadAction
  seedRatio: number
  /** Bytes per second; 0 is no limit. */
  downloadLimit: number
  uploadLimit: number
  altDownloadLimit: number
  altUploadLimit: number
  altSpeedMode: AltSpeedMode
  /** Local time, minutes after midnight; an end before the start runs overnight. */
  altScheduleFrom: number
  altScheduleTo: number
  /** Days (0 = Monday) a scheduled window starts on. */
  altScheduleDays: number[]
  /** Empty: any. Otherwise torrent traffic only uses this interface, and stops without it. */
  networkInterface: string
  disabledProviders: string[]
  language: string
  notifyOnStart: boolean
  notifyOnComplete: boolean
  emailEnabled: boolean
  smtpHost: string
  smtpPort: number
  smtpUseSsl: boolean
  smtpUsername: string
  smtpPasswordSet: boolean
  emailFrom: string
  emailTo: string
  desktopEnabled: boolean
  pushEnabled: boolean
  ntfyServer: string
  ntfyTopic: string
  telegramEnabled: boolean
  telegramBotTokenSet: boolean
  telegramChatId: string
  errorReportsEnabled: boolean
}

const emailOrEmpty = z.union([z.literal(''), z.email()])
const speedLimit = z.number().int().refine(v => v === 0 || (v >= MIN_SPEED_LIMIT && v <= 0xffffffff), { message: 'Use 0 (no limit) or at least 32 KiB/s' })
const minuteOfDay = z.number().int().min(0).max(24 * 60 - 1)

/** A partial settings change. Secrets are set by value and cleared with an empty string. */
export const SettingsPatch = z.strictObject({
  downloadFolder: z.string().trim().min(1, 'Download folder is required').optional(),
  postDownloadAction: z.enum(['StopSeeding', 'KeepSeeding', 'SeedToRatio']).optional(),
  seedRatio: z.number().min(0.1).max(100).optional(),
  downloadLimit: speedLimit.optional(),
  uploadLimit: speedLimit.optional(),
  altDownloadLimit: speedLimit.optional(),
  altUploadLimit: speedLimit.optional(),
  altSpeedMode: z.enum(['off', 'on', 'scheduled']).optional(),
  altScheduleFrom: minuteOfDay.optional(),
  altScheduleTo: minuteOfDay.optional(),
  altScheduleDays: z.array(z.number().int().min(0).max(6)).optional(),
  networkInterface: z.string().trim().max(64).optional(),
  disabledProviders: z.array(z.string()).optional(),
  language: z.string().regex(/^[a-z]{2}$/).optional(),
  notifyOnStart: z.boolean().optional(),
  notifyOnComplete: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  smtpHost: z.string().trim().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpUseSsl: z.boolean().optional(),
  smtpUsername: z.string().trim().optional(),
  smtpPassword: z.string().optional(),
  emailFrom: emailOrEmpty.optional(),
  emailTo: emailOrEmpty.optional(),
  desktopEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  ntfyServer: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).optional(),
  ntfyTopic: z.string().trim().optional(),
  telegramEnabled: z.boolean().optional(),
  telegramBotToken: z.string().trim().optional(),
  telegramChatId: z.string().trim().optional(),
  errorReportsEnabled: z.boolean().optional(),
})
export type SettingsPatch = z.infer<typeof SettingsPatch>

const episode = z.number().int().min(1)
const optionalText = z.string().trim().transform(v => (v === '' ? null : v)).nullable()

/**
 * A complete series rule. Creating one fills omitted fields with these defaults; replacing one
 * (`SeriesTaskReplacement`) requires every field so an omission can't silently reset it.
 */
export const SeriesTaskInput = z.strictObject({
  name: z.string().trim().min(1, 'A series task needs a name.'),
  query: z.string().trim().min(1, 'A series task needs a search query, otherwise it can never match an episode.'),
  provider: optionalText.default(null),
  titleFilter: optionalText.default(null),
  season: z.number().int().min(0).nullable().default(null),
  startEpisode: episode.default(1),
  endEpisode: episode.nullable().default(null),
  checkIntervalMinutes: z.number().int().min(1).default(60),
  enabled: z.boolean().default(true),
  downloadFolder: optionalText.default(null),
}).refine(t => t.endEpisode == null || t.endEpisode >= t.startEpisode, {
  message: 'endEpisode cannot be before startEpisode.',
})
export type SeriesTaskInput = z.infer<typeof SeriesTaskInput>

export const SeriesTaskReplacement = z.strictObject({
  name: z.string(),
  query: z.string(),
  provider: z.string().nullable(),
  titleFilter: z.string().nullable(),
  season: z.number().int().nullable(),
  startEpisode: z.number().int(),
  endEpisode: z.number().int().nullable(),
  checkIntervalMinutes: z.number().int(),
  enabled: z.boolean(),
  downloadFolder: z.string().nullable(),
})

/** A partial change: anything omitted keeps its current value. Null clears a nullable field. */
export const SeriesTaskPatch = z.strictObject({
  name: z.string().optional(),
  query: z.string().optional(),
  provider: z.string().nullable().optional(),
  titleFilter: z.string().nullable().optional(),
  season: z.number().int().nullable().optional(),
  startEpisode: z.number().int().optional(),
  endEpisode: z.number().int().nullable().optional(),
  checkIntervalMinutes: z.number().int().optional(),
  enabled: z.boolean().optional(),
  downloadFolder: z.string().nullable().optional(),
})
export type SeriesTaskPatch = z.infer<typeof SeriesTaskPatch>

/** Largest .torrent file accepted, before base64. */
export const MAX_TORRENT_FILE = 4 * 1024 * 1024

export const StartDownloadInput = z.strictObject({
  resultId: z.string().optional(),
  magnet: z.string().optional(),
  /** A .torrent file, base64. */
  torrent: z.string().max(Math.ceil(MAX_TORRENT_FILE / 3) * 4).optional(),
  folder: z.string().optional(),
})
export type StartDownloadInput = z.infer<typeof StartDownloadInput>

export interface FolderListing {
  path: string
  parent: string | null
  folders: string[]
  exists: boolean
  error: string | null
}

/** `unavailable` outside the installed app. */
export type HandlerStatus = 'unavailable' | 'default' | 'notDefault'

export type LoginStartupStatus = 'unavailable' | 'disabled' | 'enabled' | 'requiresApproval'

export interface UpdateStatusDto {
  currentVersion: string
  available: { version: string; tag: string; releaseUrl: string } | null
  canSelfInstall: boolean
  checking: boolean
  installing: boolean
  lastCheckedAt: string | null
  lastCheckError: string | null
}

export interface AgentStatusDto {
  enabled: boolean
  allowRemote: boolean
  token: string
  baseUrl: string
  mcpUrl: string
  endpointFile: string
}

/** Outcome of registering this device's MCP server with Claude Code on the device. */
export interface ClaudeConnectResultDto {
  /** `cliNotFound`: Claude Code isn't installed where the app can find it; run `command` instead. */
  status: 'connected' | 'cliNotFound'
  command: string
  agent: AgentStatusDto
}

export interface LinkedBrowserDto {
  keyId: string
  label: string
  createdAt: string
  lastSeenAt: string | null
}

export interface RemoteStatusDto {
  cloudUrl: string
  paired: boolean
  deviceId: string | null
  deviceName: string
  accountEmail: string | null
  connected: boolean
  /** Set while a pairing link is open and waiting for approval on the website. */
  pendingPairing: { url: string; expiresAt: string } | null
  browsers: LinkedBrowserDto[]
  lastError: string | null
}

export interface LegacyImportStatusDto {
  available: boolean
  path: string | null
  imported: boolean
  downloads: number
  seriesTasks: number
}

export interface LegacyImportResultDto {
  downloads: number
  seriesTasks: number
  settings: boolean
  /** Secrets the legacy app encrypted with a key this app can't read; re-enter them in Settings. */
  secretsToReenter: string[]
}

export interface AppInfoDto {
  version: string
  platform: 'macos' | 'windows' | 'linux'
  arch: string
  dataDirectory: string
  nativeFolderPicker: boolean
}
