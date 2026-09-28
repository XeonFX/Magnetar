import type { FailureReport } from '@md/protocol/cloud'
import type { App } from './app.ts'
import { ARCH, CLOUD_URL, IS_DEV, PLATFORM, USER_AGENT, VERSION } from './config.ts'
import { setErrorSink } from './log.ts'

const MAX_PER_HOUR = 10
const sent: number[] = []

/**
 * Strips anything that could identify the user or what they download before an error leaves the
 * machine: quoted text (torrent titles), paths, URLs, e-mail addresses, IPs and long hex/base64
 * runs (hashes, tokens). What remains is the shape of the failure.
 */
export function scrub(text: string): string {
  return text
    .replace(/https?:\/\/[^\s'")]+/gi, '<url>')
    .replace(/magnet:\?[^\s'")]+/gi, '<magnet>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”/g, '"…"')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\\/\s:'"()]+)+/g, match => `…/${match.split(/[\\/]/).pop()}`)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>')
}

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
