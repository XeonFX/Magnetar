import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { DOWNLOAD_STATUSES } from '@md/protocol'
import { z } from 'zod'
import type { Actions } from '../api/actions.ts'
import { ApiError } from '../api/errors.ts'
import { VERSION } from '../config.ts'
import type { SettingsService } from '../settings.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }

/** Wraps a result for MCP; caller mistakes come back as tool errors the model can read, not stack traces. */
async function run(action: () => unknown): Promise<ToolResult> {
  try {
    const value = await action()
    const structured = Array.isArray(value) ? { items: value } : (value ?? { success: true }) as Record<string, unknown>
    return { content: [{ type: 'text', text: JSON.stringify(value ?? { success: true }) }], structuredContent: structured }
  } catch (error) {
    const message = error instanceof ApiError ? error.message : 'The operation failed. See the MediaDownloader log for details.'
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

function createServer(actions: Actions, settings: SettingsService, signal: AbortSignal): McpServer {
  const server = new McpServer({ name: 'mediadownloader', version: VERSION })
  const read = { readOnlyHint: true, destructiveHint: false }

  server.registerTool('list_sources', {
    description: 'List torrent sources and whether each is enabled.',
    annotations: read,
  }, () => run(() => actions.sources()))

  server.registerTool('search_torrents', {
    description: 'Search one or all enabled torrent sources. Inspect the per-source outcomes before treating an empty result list as no matches. Result ids remain valid for about 30 minutes.',
    inputSchema: {
      query: z.string().describe('Words that every returned title should contain.'),
      source: z.string().optional().describe('Exact source name from list_sources, or omit to search all enabled sources.'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum results to return, from 1 to 200. Defaults to 25.'),
    },
    annotations: { ...read, openWorldHint: true },
  }, ({ query, source, limit }) => run(() => actions.search(query, source ?? null, limit, signal)))

  server.registerTool('get_torrent_details', {
    description: 'Resolve the description and magnet for a result returned by search_torrents. Some sources fetch a detail page lazily.',
    inputSchema: { resultId: z.string().describe('Opaque result id returned by search_torrents.') },
    annotations: { ...read, openWorldHint: true },
  }, ({ resultId }) => run(() => actions.details(resultId, 'agent', signal)))

  server.registerTool('get_settings', {
    description: 'Read the default download folder and post-download behavior. Secret and notification settings are never exposed.',
    annotations: read,
  }, () => run(() => {
    const s = settings.get()
    return { downloadFolder: s.downloadFolder, postDownloadAction: s.postDownloadAction }
  }))

  server.registerTool('start_download', {
    description: 'Queue a torrent download. Prefer a resultId from search_torrents because lazy sources cannot always be started from a magnet alone.',
    inputSchema: {
      resultId: z.string().optional().describe('Opaque id returned by search_torrents.'),
      magnet: z.string().optional().describe('Raw magnet URI when no search result id is available.'),
      folder: z.string().optional().describe('Optional save folder override; must be inside the configured download folder.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, input => run(() => actions.startDownload(input, 'agent', signal)))

  server.registerTool('list_downloads', {
    description: 'List downloads with current progress, speeds, peers, and status.',
    inputSchema: { status: z.string().optional().describe(`Optional status filter: ${DOWNLOAD_STATUSES.join(', ')}.`) },
    annotations: read,
  }, ({ status }) => run(() => actions.listDownloads(status)))

  const downloadId = { id: z.number().int().describe('Download id from list_downloads.') }
  server.registerTool('pause_download', {
    description: 'Pause an active download.', inputSchema: downloadId,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, ({ id }) => run(() => actions.pause(id)))
  server.registerTool('resume_download', {
    description: 'Resume a paused download.', inputSchema: downloadId,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, ({ id }) => run(() => actions.resume(id)))
  server.registerTool('delete_download', {
    description: 'Remove a download from MediaDownloader. deleteFiles defaults to false. Setting it true permanently erases downloaded data from disk.',
    inputSchema: { ...downloadId, deleteFiles: z.boolean().optional().describe('False keeps downloaded files. True permanently erases them.') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, ({ id, deleteFiles }) => run(async () => {
    await actions.deleteDownload(id, deleteFiles ?? false)
    return { success: true, message: deleteFiles ? 'Download and its files deleted.' : 'Download removed; files kept.' }
  }))

  const seriesFields = {
    titleFilter: z.string().optional().describe('Extra text that must appear in a result title.'),
    provider: z.string().optional().describe('Restrict to one source, or omit for all.'),
    season: z.number().int().optional().describe('Season number; when set only SxxEyy-style titles match.'),
    startEpisode: z.number().int().optional().describe('First episode to look for.'),
    endEpisode: z.number().int().optional().describe('Last episode; the rule disables itself once it is downloaded.'),
    checkIntervalMinutes: z.number().int().optional().describe('How often to check, in minutes.'),
    enabled: z.boolean().optional().describe('False pauses the rule without deleting it.'),
    downloadFolder: z.string().optional().describe('Must be inside the configured download folder.'),
  }
  server.registerTool('list_series_tasks', {
    description: 'List automatic series download rules and their next episode/check state.', annotations: read,
  }, () => run(() => actions.listSeries()))
  server.registerTool('create_series_task', {
    description: 'Create an automatic rule that searches for and downloads new episodes.',
    inputSchema: { name: z.string(), query: z.string().describe('Search query, e.g. "One Piece 1080p".'), ...seriesFields },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, input => run(() => actions.createSeries(input, 'agent')))
  server.registerTool('update_series_task', {
    description: 'Change one or more fields of an automatic series rule. Anything you leave out keeps its current value, so pass only what should change.',
    inputSchema: { id: z.number().int().describe('Series task id from list_series_tasks.'), name: z.string().optional(), query: z.string().optional(), ...seriesFields },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, ({ id, ...patch }) => run(() => actions.updateSeries(id, patch, 'agent')))
  server.registerTool('delete_series_task', {
    description: 'Delete an automatic series rule. Existing downloads and their files are kept.',
    inputSchema: { id: z.number().int() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, ({ id }) => run(() => {
    actions.deleteSeries(id)
    return { success: true, message: 'Series task deleted; its downloads were kept.' }
  }))
  server.registerTool('check_series_task_now', {
    description: 'Run one series rule immediately. This can queue one or more matching episode downloads.',
    inputSchema: { id: z.number().int() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, ({ id }) => run(() => actions.checkSeriesNow(id, 'agent')))

  return server
}

/** Stateless Streamable HTTP: a fresh server and transport per request, as the SDK recommends. */
export async function handleMcp(request: Request, actions: Actions, settings: SettingsService): Promise<Response> {
  const server = createServer(actions, settings, request.signal)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    void server.close()
  }
}
