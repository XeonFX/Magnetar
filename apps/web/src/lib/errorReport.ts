import type { FailureReport } from '@md/protocol/cloud'

const MAX_PER_PAGE_LOAD = 5
let sent = 0
let installed = false

/**
 * Masks anything identifying before an error leaves the browser: quoted text (torrent titles),
 * URLs and query strings, e-mail addresses and long ids.
 */
export function scrub(text: string): string {
  return text
    .replace(/https?:\/\/[^\s'")]+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/"[^"\n]*"|'[^'\n]*'/g, '"…"')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<id>')
}

function client(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other'
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other'
  return `${browser} · ${os} · ${matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop'}`
}

/** The page's name for the screen, never an id. */
function page(): string {
  const first = location.pathname.split('/')[1] ?? ''
  if (first === 'd') return `device-${location.pathname.split('/')[3] || 'downloads'}`
  return first || 'home'
}

export function reportError(source: FailureReport['source'], error: unknown): void {
  if (sent >= MAX_PER_PAGE_LOAD) return
  const err = error instanceof Error ? error : new Error(String(error))
  // Browser extensions throw into every page; their errors aren't ours.
  if (/extension:\/\//.test(err.stack ?? '')) return
  sent++
  const report: FailureReport = {
    source,
    name: err.name,
    message: scrub(err.message),
    stack: err.stack ? scrub(err.stack) : null,
    page: page(),
    version: import.meta.env.VITE_APP_VERSION ?? 'dev',
    client: client(),
  }
  void fetch('/api/telemetry/failure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report), keepalive: true }).catch(() => {})
}

/** Reports uncaught errors and rejections on the website to CodeFusion Console, via the Worker. */
export function installErrorReporting(): void {
  if (installed) return
  installed = true
  addEventListener('error', event => reportError('error', event.error ?? event.message))
  addEventListener('unhandledrejection', event => reportError('rejection', event.reason))
}
