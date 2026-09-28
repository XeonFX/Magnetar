import { toBase64Url } from '@md/protocol/base64'
import { allowedOrigins, type Env } from './env.ts'

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export const json = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, { ...init, headers: { 'cache-control': 'no-store', ...(init.headers as Record<string, string>) } })

export const error = (status: number, message: string) => json({ error: message }, { status })

const MAX_BODY = 16 * 1024

export async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Expected JSON')
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) throw new HttpError(413, 'Request too large')
  const text = await request.text()
  if (text.length > MAX_BODY) throw new HttpError(413, 'Request too large')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

/**
 * Cookie-authenticated calls must come from our own pages. SameSite=Lax already stops most
 * cross-site requests; this also covers WebSocket upgrades, which cookies ride along on.
 */
export function requireSameOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('origin')
  if (!origin || !allowedOrigins(env).includes(origin)) throw new HttpError(403, 'Cross-origin request refused')
}

export async function sha256(text: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown'
}

export async function limit(limiter: RateLimit, key: string): Promise<void> {
  const { success } = await limiter.limit({ key })
  if (!success) throw new HttpError(429, 'Too many requests. Try again in a minute.')
}

export function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=') || null
  }
  return null
}

export function setCookie(name: string, value: string, maxAge: number, path = '/'): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}
