import type { FailureReport } from '@md/protocol/cloud'
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
  CONSOLE_TELEMETRY?: ConsoleTelemetry
  APP_ID: string
  APP_ENV: string
  ORIGIN: string
  GOOGLE_CLIENT_ID: string
  /** "enabled" only in the dev environment: passwordless sign-in for local testing. */
  DEV_LOGIN?: string
}

export const devLoginEnabled = (env: Env) => env.DEV_LOGIN === 'enabled' && env.APP_ENV === 'development'

/** Origins allowed to make cookie-authenticated calls: the site itself, plus Vite in development. */
export function allowedOrigins(env: Env): string[] {
  return devLoginEnabled(env) ? [env.ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'] : [env.ORIGIN]
}
