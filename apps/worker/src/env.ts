import type { FailureReport } from '@magnetar/protocol/cloud'
import type { DeviceRelay } from './relay.ts'

export interface ConsoleTelemetry {
  reportBrowserFailure(report: FailureReport & { appId: string; env: string }): Promise<void>
}

export interface Env {
  DB: D1Database
  RELAY: DurableObjectNamespace<DeviceRelay>
  ASSETS: Fetcher
  PAIR_LIMITER: RateLimit
  AUTH_LIMITER: RateLimit
  TELEMETRY_LIMITER: RateLimit
  /** Website failure reports, per connection (createConsoleRoutes). */
  BROWSER_FAILURE_RATE_LIMITER?: RateLimit
  /** CodeFusion Console's shared visits dataset (createConsoleRoutes). */
  VISITS?: AnalyticsEngineDataset
  PUSH_LIMITER: RateLimit
  CONSOLE_TELEMETRY?: ConsoleTelemetry
  APP_ID: string
  APP_ENV: string
  ORIGIN: string
  GOOGLE_CLIENT_ID: string
  /** GitHub owner/name whose releases the website offers for download. */
  RELEASES_REPO?: string
  /** Optional secret: a GitHub token (no scopes) for 5,000 release lookups an hour instead of 60 per shared address. */
  GITHUB_TOKEN?: string
  /** Web Push (VAPID) key, a secret made by `codefusion-vapid` (@codefusion-cc/web-push). Unset: no browser push. */
  VAPID_PRIVATE_KEY?: string
  /** Contact for push services; the site's origin by default. */
  VAPID_SUBJECT?: string
  /** "enabled" only in the dev environment: passwordless sign-in for local testing. */
  DEV_LOGIN?: string
}

export const devLoginEnabled = (env: Env) => env.DEV_LOGIN === 'enabled' && env.APP_ENV === 'development'

/** Origins allowed to make cookie-authenticated calls: the site itself, plus Vite in development. */
export function allowedOrigins(env: Env): string[] {
  return devLoginEnabled(env) ? [env.ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'] : [env.ORIGIN]
}

/** The largest JSON body an API call takes; the biggest, a failure report, stays well under it. */
export const MAX_BODY = 16 * 1024
