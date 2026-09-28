import type { AppConfig, FailureReport } from '@md/protocol/cloud'
import { handleAuth } from './auth.ts'
import { handleDevices } from './devices.ts'
import { devLoginEnabled, type Env } from './env.ts'
import { handleGoogleCallback } from './googleCallback.ts'
import { clientIp, error, HttpError, json, limit, readJson } from './http.ts'

export { DeviceRelay } from './relay.ts'

const SOURCES = new Set(['error', 'rejection', 'render'])
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')

/**
 * Error reports from the website and from desktop clients, forwarded to CodeFusion Console.
 * Senders scrub them first; this only bounds their size and rate.
 */
async function reportFailure(request: Request, env: Env): Promise<Response> {
  await limit(env.TELEMETRY_LIMITER, clientIp(request))
  const report = await readJson<Partial<FailureReport>>(request)
  if (!SOURCES.has(String(report.source)) || !report.message) return error(400, 'Invalid report')
  await env.CONSOLE_TELEMETRY?.reportBrowserFailure({
    appId: env.APP_ID,
    env: env.APP_ENV,
    source: report.source as FailureReport['source'],
    name: text(report.name, 100) || 'Error',
    message: text(report.message, 1000),
    stack: text(report.stack, 8000) || null,
    page: /^[a-z][a-z0-9-]{0,39}$/.test(String(report.page)) ? String(report.page) : 'other',
    version: text(report.version, 40),
    client: text(report.client, 80),
  })
  return new Response(null, { status: 204 })
}

async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/app-config.json') {
    return json({ mode: 'cloud', googleClientId: env.GOOGLE_CLIENT_ID || undefined, devLogin: devLoginEnabled(env) || undefined } satisfies AppConfig)
  }
  if (path === '/api/telemetry/failure' && request.method === 'POST') return reportFailure(request, env)
  return (await handleGoogleCallback(request, env, path))
    ?? (await handleAuth(request, env, path))
    ?? (await handleDevices(request, env, path))
    ?? error(404, 'Not found')
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const response = await route(request, env)
      if (response.status === 101) return response
      const headers = new Headers(response.headers)
      headers.set('x-content-type-options', 'nosniff')
      headers.set('referrer-policy', 'no-referrer')
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.message)
      console.error('Unhandled error', e)
      return error(500, 'Something went wrong')
    }
  },
} satisfies ExportedHandler<Env>
