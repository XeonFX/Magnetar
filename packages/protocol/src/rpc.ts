import { z } from 'zod'
import {
  SeriesTaskInput, SeriesTaskPatch, SettingsPatch, StartDownloadInput, WatchInput,
  type AgentStatusDto, type AppInfoDto, type ClaudeConnectResultDto, type DownloadDto, type DownloadFileDto, type FolderListing, type LegacyImportResultDto,
  type LegacyImportStatusDto, type LoginStartupStatus, type RemoteStatusDto, type SearchResultDto,
  type HandlerStatus, type NetworkInterfaceDto, type SeriesTaskDto, type SettingsDto, type SourceDto, type SourceOutcomeDto, type TorrentDetailsDto,
  type TransferStatusDto, type UpdateStatusDto, type WatchDto,
} from './model.ts'

const none = z.strictObject({})
const id = z.strictObject({ id: z.number().int() })

/**
 * Every call the dashboard can make to a device, with its parameter schema. The same table serves
 * the local WebSocket and the end-to-end encrypted relay, so the two surfaces cannot drift apart.
 */
export const RPC_PARAMS = {
  'app.info': none,
  'sources.list': none,

  /** Starts a streaming search; results arrive as `search.*` events tagged with the returned id. */
  'search.start': z.strictObject({ query: z.string().trim().min(1), source: z.string().optional() }),
  'search.cancel': z.strictObject({ searchId: z.string() }),
  'search.details': z.strictObject({ resultId: z.string() }),

  'downloads.list': none,
  'downloads.start': StartDownloadInput,
  'downloads.pause': id,
  'downloads.resume': id,
  'downloads.delete': z.strictObject({ id: z.number().int(), deleteFiles: z.boolean().default(false) }),
  'downloads.files': id,
  'downloads.selectFiles': z.strictObject({ id: z.number().int(), files: z.array(z.number().int().min(0)).min(1) }),
  /** Shows the download in Finder or Explorer. Only offered on the local dashboard. */
  'downloads.reveal': id,
  /** Opens a finished video or audio file in its usual player. Only offered on the local dashboard. */
  'downloads.openFile': z.strictObject({ id: z.number().int(), index: z.number().int().min(0) }),

  /** A link to play a file straight from this computer (`/stream/<token>`). Local dashboard only. */
  'downloads.streamUrl': z.strictObject({ id: z.number().int(), index: z.number().int().min(0) }),
  /** Playback through the relay: open a file, read it in pieces, close it. */
  'stream.open': z.strictObject({ id: z.number().int(), index: z.number().int().min(0) }),
  'stream.read': z.strictObject({ streamId: z.string(), offset: z.number().int().min(0), length: z.number().int().min(1) }),
  'stream.close': z.strictObject({ streamId: z.string() }),

  /** Web Push for a linked browser: whether its subscription is known, and adding or removing it. */
  'push.status': z.strictObject({ endpoint: z.string() }),
  'push.subscribe': z.strictObject({ endpoint: z.url({ protocol: /^https$/ }).max(1000), p256dh: z.string().max(200), auth: z.string().max(100) }),
  'push.unsubscribe': z.strictObject({ endpoint: z.string() }),

  /** Adds a .torrent file from this computer's disk. Local dashboard only. */
  'downloads.addTorrentPath': z.strictObject({ path: z.string().min(1) }),
  /** Whether MediaDownloader opens magnet links and .torrent files, and making it do so. */
  'handlers.status': none,
  'handlers.register': none,

  'transfer.status': none,
  'network.interfaces': none,

  'series.list': none,
  'series.create': SeriesTaskInput,
  'series.update': z.strictObject({ id: z.number().int(), patch: SeriesTaskPatch }),
  'series.delete': id,
  'series.checkNow': id,
  'watches.list': none,
  /** Creates a watch and looks once straight away. */
  'watches.create': WatchInput,
  /** Replaces a watch's rules; enabling one that found something arms it again. */
  'watches.update': z.strictObject({ id: z.number().int(), watch: WatchInput }),
  'watches.delete': id,
  'watches.checkNow': id,
  /** Downloads what a watch found. */
  'watches.download': id,
  /** The show's poster from TVmaze, base64 JPEG, or null. */
  'series.poster': id,

  'settings.get': none,
  'settings.update': SettingsPatch,
  'notifications.test': none,

  'fs.list': z.strictObject({ path: z.string().optional() }),
  'fs.mkdir': z.strictObject({ path: z.string().min(1) }),
  /** Shows the OS folder chooser on the device's own screen. Only offered on the local dashboard. */
  'fs.pickNative': z.strictObject({ start: z.string().optional(), prompt: z.string().optional() }),

  'updates.status': none,
  'updates.check': none,
  'updates.install': none,

  'startup.status': none,
  'startup.set': z.strictObject({ enabled: z.boolean() }),

  'agent.status': none,
  'agent.set': z.strictObject({ enabled: z.boolean().optional(), allowRemote: z.boolean().optional() }),
  'agent.regenerateToken': none,
  /** Turns agent access on and registers the MCP server with the Claude Code CLI on the device. */
  'agent.connectClaude': none,

  'remote.status': none,
  'remote.pair': z.strictObject({ deviceName: z.string().trim().min(1).max(60).optional() }),
  'remote.cancelPairing': none,
  'remote.unpair': none,
  'remote.rename': z.strictObject({ deviceName: z.string().trim().min(1).max(60) }),
  /** Mints a key for one more browser and returns the link that carries it. */
  'remote.linkBrowser': z.strictObject({ label: z.string().trim().max(60).optional() }),
  'remote.revokeBrowser': z.strictObject({ keyId: z.string() }),

  'legacy.status': none,
  'legacy.import': none,
} satisfies Record<string, z.ZodType>

export type RpcMethod = keyof typeof RPC_PARAMS
export type RpcParams<M extends RpcMethod> = z.input<(typeof RPC_PARAMS)[M]>
export type RpcParsedParams<M extends RpcMethod> = z.output<(typeof RPC_PARAMS)[M]>

export interface RpcResults {
  'app.info': AppInfoDto
  'sources.list': SourceDto[]
  'search.start': { searchId: string }
  'search.cancel': null
  'search.details': TorrentDetailsDto
  'downloads.list': DownloadDto[]
  'downloads.start': DownloadDto
  'downloads.pause': DownloadDto
  'downloads.resume': DownloadDto
  'downloads.delete': null
  'downloads.files': DownloadFileDto[]
  'downloads.selectFiles': DownloadDto
  'downloads.reveal': null
  'downloads.openFile': null
  'downloads.streamUrl': { url: string }
  'stream.open': { streamId: string; size: number; name: string; type: string }
  /** base64; shorter than asked at the end of the file, and at most 448 KiB. */
  'stream.read': { data: string }
  'stream.close': null
  'push.status': { subscribed: boolean }
  'push.subscribe': null
  'push.unsubscribe': null
  'downloads.addTorrentPath': DownloadDto
  'handlers.status': { status: HandlerStatus }
  'handlers.register': { status: HandlerStatus }
  'transfer.status': TransferStatusDto
  'network.interfaces': { supported: boolean; interfaces: NetworkInterfaceDto[] }
  'series.list': SeriesTaskDto[]
  'series.create': SeriesTaskDto
  'series.update': SeriesTaskDto
  'series.delete': null
  'series.checkNow': SeriesTaskDto
  'series.poster': { data: string | null }
  'watches.list': WatchDto[]
  'watches.create': WatchDto
  'watches.update': WatchDto
  'watches.delete': null
  'watches.checkNow': WatchDto
  'watches.download': DownloadDto
  'settings.get': SettingsDto
  'settings.update': SettingsDto
  'notifications.test': null
  'fs.list': FolderListing
  'fs.mkdir': FolderListing
  'fs.pickNative': { path: string | null }
  'updates.status': UpdateStatusDto
  'updates.check': UpdateStatusDto
  'updates.install': UpdateStatusDto
  'startup.status': { status: LoginStartupStatus }
  'startup.set': { status: LoginStartupStatus }
  'agent.status': AgentStatusDto
  'agent.set': AgentStatusDto
  'agent.regenerateToken': AgentStatusDto
  'agent.connectClaude': ClaudeConnectResultDto
  'remote.status': RemoteStatusDto
  'remote.pair': RemoteStatusDto
  'remote.cancelPairing': RemoteStatusDto
  'remote.unpair': RemoteStatusDto
  'remote.rename': RemoteStatusDto
  'remote.linkBrowser': { url: string; keyId: string }
  'remote.revokeBrowser': RemoteStatusDto
  'legacy.status': LegacyImportStatusDto
  'legacy.import': LegacyImportResultDto
}

/** Pushed from the device without a request. */
export interface RpcEvents {
  'downloads.changed': DownloadDto[]
  /** Once a second: the rows whose numbers changed. */
  'downloads.updated': DownloadDto[]
  'transfer.changed': TransferStatusDto
  'series.changed': SeriesTaskDto[]
  'watches.changed': WatchDto[]
  'search.results': { searchId: string; results: SearchResultDto[] }
  'search.source': { searchId: string; outcome: SourceOutcomeDto }
  'search.done': { searchId: string; error: string | null }
  'notification': { kind: 'started' | 'completed' | 'found' | 'update' | 'test'; title: string; message: string }
  'updates.changed': UpdateStatusDto
  'remote.changed': RemoteStatusDto
  'settings.changed': SettingsDto
}
export type RpcEventName = keyof RpcEvents

export type RpcErrorCode = 'bad_request' | 'not_found' | 'rate_limited' | 'forbidden' | 'internal'

export type ClientMessage = { id: number; method: string; params?: unknown }
export type ServerMessage =
  | { id: number; result: unknown }
  | { id: number; error: { code: RpcErrorCode; message: string } }
  | { event: string; data: unknown }

/** Methods that act on the device's own screen or programs, not offered through the relay. */
export const LOCAL_ONLY_METHODS: ReadonlySet<RpcMethod> = new Set([
  'fs.pickNative', 'agent.connectClaude', 'downloads.reveal', 'downloads.openFile', 'downloads.streamUrl',
  'downloads.addTorrentPath', 'handlers.register',
])
