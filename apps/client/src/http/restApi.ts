import { SeriesTaskInput, SeriesTaskPatch, SeriesTaskReplacement, StartDownloadInput } from '@md/protocol'
import { z } from 'zod'
import type { Actions } from '../api/actions.ts'
import { ApiError } from '../api/errors.ts'
import type { SettingsService } from '../settings.ts'

const SearchRequest = z.strictObject({ query: z.string(), source: z.string().nullish(), limit: z.number().int().nullish() })

type Route = { method: string; pattern: RegExp; handle: (match: RegExpExecArray, request: Request, url: URL) => Promise<unknown> | unknown }

async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  let json: unknown
  try {
    json = await request.json()
  } catch {
    throw new ApiError('The request body must be JSON.')
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new ApiError(parsed.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  return parsed.data
}

/**
 * The agent REST surface under /api. Mirrors the MCP tools one-to-one; both go through Actions.
 * PATCH /api/series/{id} changes the fields sent; PUT replaces the whole rule and so requires
 * every field — a partial PUT is a 400, not a silent reset.
 */
export function createRestApi(actions: Actions, settings: SettingsService) {
  const id = (m: RegExpExecArray) => Number(m[1])
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/sources$/, handle: () => actions.sources() },
    { method: 'POST', pattern: /^\/api\/search$/, handle: async (_, request) => {
      const input = await body(request, SearchRequest)
      return actions.search(input.query, input.source ?? null, input.limit ?? undefined, request.signal)
    } },
    { method: 'GET', pattern: /^\/api\/search\/([\w-]+)$/, handle: (m, request) => actions.details(m[1]!, 'agent', request.signal) },
    { method: 'POST', pattern: /^\/api\/downloads$/, handle: async (_, request) => actions.startDownload(await body(request, StartDownloadInput), 'agent', request.signal) },
    { method: 'GET', pattern: /^\/api\/downloads$/, handle: (_, __, url) => actions.listDownloads(url.searchParams.get('status')) },
    { method: 'GET', pattern: /^\/api\/downloads\/(\d+)$/, handle: m => actions.getDownload(id(m)) },
    { method: 'POST', pattern: /^\/api\/downloads\/(\d+)\/pause$/, handle: m => actions.pause(id(m)) },
    { method: 'POST', pattern: /^\/api\/downloads\/(\d+)\/resume$/, handle: m => actions.resume(id(m)) },
    { method: 'DELETE', pattern: /^\/api\/downloads\/(\d+)$/, handle: async (m, _, url) => {
      const deleteFiles = url.searchParams.get('deleteFiles') === 'true'
      await actions.deleteDownload(id(m), deleteFiles)
      return { success: true, message: deleteFiles ? 'Download and its files deleted.' : 'Download removed; files kept.' }
    } },
    { method: 'GET', pattern: /^\/api\/series$/, handle: () => actions.listSeries() },
    { method: 'GET', pattern: /^\/api\/series\/(\d+)$/, handle: m => actions.getSeries(id(m)) },
    { method: 'POST', pattern: /^\/api\/series$/, handle: async (_, request) => actions.createSeries(await body(request, z.unknown()) as z.input<typeof SeriesTaskInput>, 'agent') },
    { method: 'PUT', pattern: /^\/api\/series\/(\d+)$/, handle: async (m, request) => actions.updateSeries(id(m), await body(request, SeriesTaskReplacement), 'agent') },
    { method: 'PATCH', pattern: /^\/api\/series\/(\d+)$/, handle: async (m, request) => actions.updateSeries(id(m), await body(request, SeriesTaskPatch), 'agent') },
    { method: 'DELETE', pattern: /^\/api\/series\/(\d+)$/, handle: m => {
      actions.deleteSeries(id(m))
      return { success: true, message: 'Series task deleted; its downloads were kept.' }
    } },
    { method: 'POST', pattern: /^\/api\/series\/(\d+)\/check$/, handle: m => actions.checkSeriesNow(id(m), 'agent') },
    { method: 'GET', pattern: /^\/api\/settings$/, handle: () => {
      const s = settings.get()
      return { downloadFolder: s.downloadFolder, postDownloadAction: s.postDownloadAction }
    } },
  ]

  return async (request: Request, url: URL): Promise<Response> => {
    const candidates = routes.filter(r => r.pattern.test(url.pathname))
    if (candidates.length === 0) return Response.json({ error: 'Not found.' }, { status: 404 })
    const route = candidates.find(r => r.method === request.method)
    if (!route) return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { allow: candidates.map(r => r.method).join(', ') } })
    try {
      const result = await route.handle(route.pattern.exec(url.pathname)!, request, url)
      return Response.json(result ?? { success: true })
    } catch (error) {
      if (error instanceof ApiError) return Response.json({ error: error.message }, { status: error.httpStatus })
      console.error(error)
      return Response.json({ error: 'Internal error.' }, { status: 500 })
    }
  }
}
