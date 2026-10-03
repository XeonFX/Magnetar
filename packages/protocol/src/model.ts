import { z } from 'zod'
import { MAX_TORRENT_FILE, MIN_SPEED_LIMIT } from './limits.ts'

export { MAX_TORRENT_FILE, MIN_SPEED_LIMIT }

export const DOWNLOAD_STATUSES = [
  'Queued', 'FetchingMetadata', 'Downloading', 'Seeding', 'Paused', 'Completed', 'Error',
] as const
export type DownloadStatus = (typeof DOWNLOAD_STATUSES)[number]

export type PostDownloadAction = 'StopSeeding' | 'KeepSeeding' | 'SeedToRatio'

/** When the alternative speed limits apply instead of the usual ones. */
export type AltSpeedMode = 'off' | 'on' | 'scheduled'


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
  /** Set while a disk Magnetar writes to is full. */
  diskFull: DiskFullDto | null
}

/** A disk with no room left for what Magnetar writes. */
export interface DiskFullDto {
  /** What to free space on, when it has a name: "C:", "/Volumes/Media". */
  drive: string | null
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
  /** A file the dashboard can play, and how; null for anything else. */
  media: 'video' | 'audio' | null
}

/** A search source and whether the user has it switched on. */
export interface SourceDto {
  /** Short and lowercase, for addresses: `tpb` for The Pirate Bay. */
  id: string
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
  /** Only releases of this resolution; null takes any. */
  resolution: SeriesResolution | null
  minSeeders: number
  maxSizeMb: number | null
  /** Comma-separated words that make a release preferred / rule it out. */
  preferWords: string | null
  excludeWords: string | null
  /** From TVmaze, once the show has been found there. */
  show: ShowInfoDto | null
}

export type SeriesResolution = '720p' | '1080p' | '2160p'

/** A release a watch found. */
export interface FoundReleaseDto {
  title: string
  magnetUri: string
  sizeBytes: number
  seeders: number
  source: string
  foundAt: string
}

/**
 * Waiting for a release of something (a film in 4K, an album): checked on a schedule, it reports
 * the first release its rules allow, or downloads it, then rests until armed again.
 */
export interface WatchDto {
  id: number
  query: string
  resolution: SeriesResolution | null
  minSeeders: number
  maxSizeMb: number | null
  preferWords: string | null
  excludeWords: string | null
  autoDownload: boolean
  checkIntervalMinutes: number
  enabled: boolean
  createdAt: string
  lastCheckedAt: string | null
  found: FoundReleaseDto | null
  downloadId: number | null
}

/** An episode's place and air time, as TVmaze reports it. */
export interface AiringDto {
  season: number | null
  number: number | null
  name: string | null
  airstamp: string | null
}

export interface ShowInfoDto {
  tvmazeId: number
  name: string
  url: string | null
  /** "Running", "Ended", "To Be Determined"… */
  status: string | null
  premiered: string | null
  network: string | null
  /** Whether `series.poster` has an image for it. */
  hasPoster: boolean
  nextEpisode: AiringDto | null
  previousEpisode: AiringDto | null
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

/** The longest a series rule or a watch waits between checks: a week. Also in `apps/client/src/protocol/model.rs`. */
export const MAX_CHECK_INTERVAL_MINUTES = 10_080
/** The shortest a watch waits between checks; a series rule may check every minute. */
export const MIN_WATCH_INTERVAL_MINUTES = 15
const seriesInterval = z.number().int().min(1).max(MAX_CHECK_INTERVAL_MINUTES)

const episode = z.number().int().min(1)
const optionalText = z.string().trim().transform(v => (v === '' ? null : v)).nullable()
const resolution = z.enum(['720p', '1080p', '2160p'])
const words = z.string().trim().max(200).transform(v => (v === '' ? null : v)).nullable()

/** A complete series rule. Creating one fills omitted fields with these defaults. */
export const SeriesTaskInput = z.strictObject({
  name: z.string().trim().min(1, 'A series task needs a name.'),
  query: z.string().trim().min(1, 'A series task needs a search query, otherwise it can never match an episode.'),
  provider: optionalText.default(null),
  titleFilter: optionalText.default(null),
  season: z.number().int().min(0).nullable().default(null),
  startEpisode: episode.default(1),
  endEpisode: episode.nullable().default(null),
  checkIntervalMinutes: seriesInterval.default(60),
  enabled: z.boolean().default(true),
  downloadFolder: optionalText.default(null),
  resolution: resolution.nullable().default(null),
  minSeeders: z.number().int().min(1).default(1),
  maxSizeMb: z.number().int().min(1).nullable().default(null),
  preferWords: words.default(null),
  excludeWords: words.default(null),
  /** Where a new task starts: `startEpisode`, the newest episode out, or only new ones. Creating only. */
  startFrom: z.enum(['episode', 'latest', 'new']).default('episode'),
}).refine(t => t.endEpisode == null || t.endEpisode >= t.startEpisode, {
  message: 'endEpisode cannot be before startEpisode.',
})
export type SeriesTaskInput = z.infer<typeof SeriesTaskInput>

/** A partial change: anything omitted keeps its current value. Null clears a nullable field. */
export const SeriesTaskPatch = z.strictObject({
  name: z.string().optional(),
  query: z.string().optional(),
  provider: z.string().nullable().optional(),
  titleFilter: z.string().nullable().optional(),
  season: z.number().int().nullable().optional(),
  startEpisode: z.number().int().optional(),
  endEpisode: z.number().int().nullable().optional(),
  checkIntervalMinutes: seriesInterval.optional(),
  enabled: z.boolean().optional(),
  downloadFolder: z.string().nullable().optional(),
  resolution: resolution.nullable().optional(),
  minSeeders: z.number().int().min(1).optional(),
  maxSizeMb: z.number().int().min(1).nullable().optional(),
  preferWords: z.string().nullable().optional(),
  excludeWords: z.string().nullable().optional(),
})
export type SeriesTaskPatch = z.infer<typeof SeriesTaskPatch>


export const WatchInput = z.strictObject({
  query: z.string().trim().min(2).max(200),
  resolution: resolution.nullable().default(null),
  minSeeders: z.number().int().min(1).default(1),
  maxSizeMb: z.number().int().min(1).nullable().default(null),
  preferWords: words.default(null),
  excludeWords: words.default(null),
  autoDownload: z.boolean().default(false),
  checkIntervalMinutes: z.number().int().min(MIN_WATCH_INTERVAL_MINUTES).max(MAX_CHECK_INTERVAL_MINUTES).default(360),
  enabled: z.boolean().default(true),
})
export type WatchInput = z.input<typeof WatchInput>

export const StartDownloadInput = z.strictObject({
  resultId: z.string().optional(),
  magnet: z.string().optional(),
  /** A .torrent file, base64. */
  torrent: z.string().max(Math.ceil(MAX_TORRENT_FILE / 3) * 4).optional(),
  folder: z.string().optional(),
})
export type StartDownloadInput = z.infer<typeof StartDownloadInput>

/**
 * A folder the dashboard may browse, with everything below it: the download folder, or one the owner added on the
 * device itself (never through the relay).
 */
export interface FolderRootDto {
  path: string
  kind: 'downloads' | 'added'
  /** False while it can't be read: a disk that isn't connected, a folder that was removed or isn't made yet. */
  available: boolean
  freeBytes: number | null
}

export interface FolderRootsDto {
  roots: FolderRootDto[]
  /** Whether this dashboard may add folders: only the one on the device itself. */
  canAdd: boolean
}

export interface FolderEntryDto {
  name: string
  kind: 'folder' | 'file'
  /** Bytes, for files. */
  size: number | null
  /** Last change, ISO 8601. */
  modified: string | null
  /** Files a browser can play. */
  media: 'video' | 'audio' | null
  /** The download it belongs to: its folder (no `index`), or one of its files. */
  download: { id: number; index?: number } | null
}

/** One page of a folder: folders first, then files, each by name as people sort them ("2" before "10"). */
export interface FolderPageDto {
  path: string
  /** The root the folder is in; the breadcrumb starts there. */
  root: string
  /** What joins a folder and a name on the device. */
  separator: '/' | '\\'
  entries: FolderEntryDto[]
  offset: number
  /** Entries in the folder, on every page. */
  total: number
  /** The folder holds more entries than the device reads from one folder: only the first of them are shown. */
  truncated: boolean
}

/** `unavailable` outside the installed app. */
export type HandlerStatus = 'unavailable' | 'default' | 'notDefault'

export type LoginStartupStatus = 'unavailable' | 'disabled' | 'enabled' | 'requiresApproval'

/** Why reading GitHub's releases failed: no answer, its rate limit, or a refusal or unreadable answer. */
export type ReleasesProblem = 'offline' | 'rate-limited' | 'unavailable'

export interface UpdateStatusDto {
  currentVersion: string
  /** The commit the app was built from, short; `dev` outside a packaged build. */
  currentCommit: string
  available: { version: string; tag: string; name: string; releaseUrl: string; publishedAt: string | null } | null
  canSelfInstall: boolean
  checking: boolean
  installing: boolean
  lastCheckedAt: string | null
  lastCheckError: string | null
  /** Why the last check, or an install, failed. */
  lastCheckProblem: ReleasesProblem | 'install' | null
  /** When GitHub's rate limit lifts, after a rate-limited check. */
  retryAt: string | null
}

/** A published release, with its notes (Markdown) for the changelog. */
export interface ReleaseDto {
  version: string
  tag: string
  name: string
  notes: string
  publishedAt: string | null
  prerelease: boolean
  url: string
}

/** The releases, newest version first (`updates.releases`, `/api/releases`), or why there are none. */
export interface ReleasesDto {
  releases: ReleaseDto[]
  problem: ReleasesProblem | null
}

export interface AgentStatusDto {
  enabled: boolean
  allowRemote: boolean
  token: string
  mcpUrl: string
  endpointFile: string
}

/** The AI agents Magnetar can connect to its MCP server on this computer. */
export const AGENT_CLIENTS = ['claudeCode', 'codex', 'geminiCli', 'cursor', 'vscode', 'windsurf', 'opencode', 'claudeDesktop'] as const
export type AgentClientId = (typeof AGENT_CLIENTS)[number]

export interface AgentClientDto {
  id: AgentClientId
  name: string
  /** Found on this computer: its command, or its settings folder. */
  installed: boolean
  /** Already set up to reach this device at its current address. */
  connected: boolean
  /** How to connect it by hand: a command to run, or JSON to add to a settings file. */
  manual: { kind: 'command'; text: string } | { kind: 'json'; file: string; text: string }
}

/** After connecting an agent: agent access (now on) and every agent's state. */
export interface AgentConnectResultDto {
  agent: AgentStatusDto
  clients: AgentClientDto[]
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
  /** The commit the app was built from, short; `dev` outside a packaged build. */
  commit: string
  platform: 'macos' | 'windows' | 'linux'
  arch: string
  dataDirectory: string
  nativeFolderPicker: boolean
  /** Answers `fs.roots`, `fs.browse` and `fs.createFolder` (absent from older apps). */
  fileBrowser?: boolean
}
