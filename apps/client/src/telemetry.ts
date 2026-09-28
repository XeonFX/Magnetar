import type { FailureReport } from '@md/protocol/cloud'
import { scrub } from '@md/protocol/scrub'
import type { App } from './app.ts'
import { ARCH, CLOUD_URL, IS_DEV, PLATFORM, USER_AGENT, VERSION } from './config.ts'
import { setErrorSink } from './log.ts'

const MAX_PER_HOUR = 10
const sent: number[] = []

/** Error reports go to the Worker, which forwards them to CodeFusion Console. Off in development. */
export function startTelemetry(app: App): void {
  if (IS_DEV) return
  setErrorSink((error, scope) => {
    if (!app.settings.get().errorReportsEnabled) return
    const now = Date.now()
    while (sent.length && now - sent[0]! > 3600_000) sent.shift()
    if (sent.length >= MAX_PER_HOUR) return
    sent.push(now)
    const err = error instanceof Error ? error : new Error(String(error))
    const report: FailureReport = {
      source: 'error',
      name: err.name.slice(0, 100),
      message: scrub(err.message).slice(0, 1000),
      stack: err.stack ? scrub(err.stack).slice(0, 8000) : null,
      page: `client-${scope}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
      version: VERSION,
      client: `MediaDownloader ${VERSION} · ${PLATFORM} ${ARCH} · desktop`,
    }
    void fetch(`${CLOUD_URL}/api/telemetry/failure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {})
  })
}
