import { USER_AGENT } from '../config.ts'

/**
 * A backstop, not the usual limit: mirror fallback is staggered (see MirrorRotator), which caps
 * the wait on a slow host at ~1.5s. apibay.org takes ~16s on an uncached query, so shorter than
 * this would fail searches that were merely slow.
 */
export const SEARCH_TIMEOUT_MS = 15_000

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} from ${new URL(url).host}`)
    this.name = 'HttpError'
  }
}

/** GET a page as text, failing on non-2xx, a timeout, or the caller's abort. */
export async function fetchText(url: string, signal: AbortSignal, timeoutMs = SEARCH_TIMEOUT_MS): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    redirect: 'follow',
  })
  if (!response.ok) throw new HttpError(response.status, url)
  return response.text()
}

export async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  return JSON.parse(await fetchText(url, signal)) as T
}

/** A short, user-facing reason a provider failed. */
export function describeFailure(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status}`
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out'
    if (error instanceof SyntaxError) return 'unreadable response'
    if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|Unable to connect|certificate|socket/i.test(error.message)) return 'unreachable'
    return error.message
  }
  return String(error)
}

/** Parses an integer cell; 0 for anything else. */
export function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 2 ** 31 - 1) : 0
}

/** Sites return numbers as numbers or strings; accept both. */
export function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

export function fromUnixSeconds(value: unknown): Date | null {
  const seconds = toNumber(value)
  return seconds > 0 ? new Date(seconds * 1000) : null
}
