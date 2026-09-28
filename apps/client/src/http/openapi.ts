import { SeriesTaskInput, SeriesTaskPatch, SeriesTaskReplacement, StartDownloadInput } from '@md/protocol'
import { z } from 'zod'
import { VERSION } from '../config.ts'

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' })
const json = (s: z.ZodType) => ({ required: true, content: { 'application/json': { schema: schema(s) } } })
const ok = { 200: { description: 'OK' }, 400: { description: 'Invalid request' }, 404: { description: 'Not found' } }
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } }

/** The agent REST API described for OpenAPI tooling, built from the schemas the routes validate with. */
export function openApiDocument() {
  return {
    openapi: '3.1.0',
    info: { title: 'MediaDownloader agent API', version: VERSION },
    paths: {
      '/api/sources': { get: { summary: 'List sources', responses: ok } },
      '/api/search': { post: { summary: 'Search torrents', requestBody: json(z.object({ query: z.string(), source: z.string().optional(), limit: z.number().int().min(1).max(200).optional() })), responses: { ...ok, 429: { description: 'Rate limited' } } } },
      '/api/search/{resultId}': { get: { summary: 'Details of a search result', parameters: [{ name: 'resultId', in: 'path', required: true, schema: { type: 'string' } }], responses: ok } },
      '/api/downloads': {
        get: { summary: 'List downloads', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }], responses: ok },
        post: { summary: 'Start a download', requestBody: json(StartDownloadInput), responses: ok },
      },
      '/api/downloads/{id}': {
        get: { summary: 'Get a download', parameters: [idParam], responses: ok },
        delete: { summary: 'Remove a download', parameters: [idParam, { name: 'deleteFiles', in: 'query', schema: { type: 'boolean', default: false } }], responses: ok },
      },
      '/api/downloads/{id}/pause': { post: { summary: 'Pause', parameters: [idParam], responses: ok } },
      '/api/downloads/{id}/resume': { post: { summary: 'Resume or retry', parameters: [idParam], responses: ok } },
      '/api/series': {
        get: { summary: 'List series tasks', responses: ok },
        post: { summary: 'Create a series task', requestBody: json(SeriesTaskInput), responses: ok },
      },
      '/api/series/{id}': {
        get: { summary: 'Get a series task', parameters: [idParam], responses: ok },
        put: { summary: 'Replace every field', parameters: [idParam], requestBody: json(SeriesTaskReplacement), responses: ok },
        patch: { summary: 'Change the fields sent', parameters: [idParam], requestBody: json(SeriesTaskPatch), responses: ok },
        delete: { summary: 'Delete (downloads are kept)', parameters: [idParam], responses: ok },
      },
      '/api/series/{id}/check': { post: { summary: 'Check now', parameters: [idParam], responses: { ...ok, 429: { description: 'Rate limited' } } } },
      '/api/settings': { get: { summary: 'Download folder and post-download action', responses: ok } },
    },
  }
}
