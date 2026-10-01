import { handleGoogleSignIn } from '@codefusion-cc/google-sign-in'
import { consoleAdmin, createConsoleRoutes } from '@codefusion-cc/console/worker'
import type { AppConfig, FailureReport } from '@magnetar/protocol/cloud'
import { CONSOLE_PAGES } from '@magnetar/protocol/console-pages'
import { handleAuth } from './auth.ts'
import { consoleResources } from './console/admin.ts'
import { manifest } from './console/manifest.ts'
import { handleDevices } from './devices.ts'
import { allowedOrigins, devLoginEnabled, type Env } from './env.ts'
import { clientIp, error, HttpError, json, limit, readJson } from './http.ts'
import { handlePush } from './push.ts'
import { handleReleases } from './releases.ts'

export { DeviceRelay } from './relay.ts'

/** CodeFusion Console reads accounts and devices through this, over its service binding only (console/admin.ts). */
export const ConsoleAdmin = consoleAdmin<Env>({ manifest, resources: consoleResources })

/** The website's failures (POST /api/browser-failures) and page views (POST /api/visits), from its own pages only. */
const consoleRoutes = createConsoleRoutes({ appId: 'magnetar', pages: CONSOLE_PAGES })

const SOURCES = new Set(['error', 'rejection', 'render'])
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')

/**
 * Error reports from desktop clients, forwarded to CodeFusion Console. Clients scrub them first; this only
 * bounds their size and rate. The website reports through createConsoleRoutes instead.
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

const GOOGLE_CALLBACK_PAGE = { background: { light: '#f6f7fb', dark: '#0f1117' } }

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname
  const consoleAnswer = await consoleRoutes.fetch(request, env, ctx, origin => allowedOrigins(env).includes(origin))
  if (consoleAnswer) return consoleAnswer
  if (path === '/app-config.json') {
    return json({ mode: 'cloud', googleClientId: env.GOOGLE_CLIENT_ID || undefined, devLogin: devLoginEnabled(env) || undefined } satisfies AppConfig)
  }
  if (path === '/api/telemetry/failure' && request.method === 'POST') return reportFailure(request, env)
  // Google's redirect back: the page it lands on, in the dashboard's background so it never flashes white, and
  // the hand-off that sends the token to /login on one of our origins.
  return (await handleGoogleSignIn(request, { allowedOrigin: origin => allowedOrigins(env).includes(origin), page: GOOGLE_CALLBACK_PAGE }))
    ?? (await handleAuth(request, env, path))
    ?? (await handleDevices(request, env, path))
    ?? (await handlePush(request, env, path))
    ?? (await handleReleases(request, env, path))
    ?? error(404, 'Not found')
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const response = await route(request, env, ctx)
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
