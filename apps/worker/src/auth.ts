import { verifyGoogleIdToken } from '@codefusion-cc/google-sign-in'
import { clientNetwork, getCookie, HttpError, json, jsonError, rateLimit, readJson, requireSameOrigin, serializeCookie, sha256 } from '@codefusion-cc/workers-http'
import type { AccountDto } from '@magnetar/protocol/cloud'
import { randomId } from '@magnetar/protocol/base64'
import { allowedOrigins, devLoginEnabled, MAX_BODY, type Env } from './env.ts'

export const SESSION_COOKIE = '__Host-md_session'
export const NONCE_COOKIE = '__Host-md_nonce'
const SESSION_DAYS = 30
const NONCE_SECONDS = 10 * 60

interface UserRow {
  id: string
  email: string
  name: string | null
  picture: string | null
}

const toAccount = (u: UserRow): AccountDto => ({ id: u.id, email: u.email, name: u.name, picture: u.picture })

/** The signed-in user, or null. Sessions slide: each use within the last half extends them. */
export async function currentUser(request: Request, env: Env): Promise<UserRow | null> {
  const token = getCookie(request, SESSION_COOKIE)
  if (!token || token.length > 100) return null
  const hash = await sha256(token, 'base64url')
  const row = await env.DB.prepare(`SELECT u.id, u.email, u.name, u.picture, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(hash, Date.now()).first<UserRow & { expires_at: number }>()
  if (!row) return null
  if (row.expires_at - Date.now() < (SESSION_DAYS / 2) * 86_400_000) {
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(Date.now() + SESSION_DAYS * 86_400_000, hash).run()
  }
  return row
}

export async function requireUser(request: Request, env: Env): Promise<UserRow> {
  const user = await currentUser(request, env)
  if (!user) throw new HttpError(401, 'Sign in first')
  return user
}

async function signIn(env: Env, subject: string, email: string, name: string | null, picture: string | null): Promise<{ user: UserRow; cookie: string }> {
  const now = Date.now()
  const user = await env.DB.prepare(`INSERT INTO users (id, subject, email, name, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subject) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture, last_login_at = excluded.last_login_at
    RETURNING id, email, name, picture`).bind(`u_${randomId(12)}`, subject, email, name, picture, now, now).first<UserRow>()
  const token = randomId(32)
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token, 'base64url'), user!.id, now, now + SESSION_DAYS * 86_400_000).run()
  // Opportunistic cleanup, bounded so a sign-in never does much work.
  await env.DB.prepare('DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at < ? LIMIT 50)').bind(now).run()
  return { user: user!, cookie: serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86_400 }) }
}

/** The app's Google client id; 503 while sign-in is not set up. */
function googleClientId(env: Env): string {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(503, 'Google sign-in is not configured yet')
  return env.GOOGLE_CLIENT_ID
}

export async function handleAuth(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/api/me' && request.method === 'GET') {
    const user = await currentUser(request, env)
    return user ? json(toAccount(user)) : jsonError(401, 'Not signed in')
  }

  if (path === '/api/auth/start' && request.method === 'POST') {
    requireSameOrigin(request, allowedOrigins(env))
    const clientId = googleClientId(env)
    // The nonce binds the ID token Google returns to this browser: a token obtained anywhere
    // else carries a different nonce and is refused.
    const nonce = randomId(24)
    return json({ nonce, clientId }, { headers: { 'set-cookie': serializeCookie(NONCE_COOKIE, nonce, { maxAge: NONCE_SECONDS }) } })
  }

  if (path === '/api/auth/google' && request.method === 'POST') {
    requireSameOrigin(request, allowedOrigins(env))
    const clientId = googleClientId(env)
    await rateLimit(env.AUTH_LIMITER, clientNetwork(request))
    const { credential } = await readJson<{ credential?: string }>(request, { maxBytes: MAX_BODY })
    const check = await verifyGoogleIdToken(String(credential ?? ''), { clientId, nonce: getCookie(request, NONCE_COOKIE) ?? '' })
    // A nonce serves one attempt, whatever its outcome: the next sign-in starts with a new one.
    const headers = new Headers({ 'set-cookie': serializeCookie(NONCE_COOKIE, '', { maxAge: 0 }) })
    // The page words the outcome from the status: 503 when Google's keys could not be read, else 401.
    if (!check.ok) return jsonError(check.problem === 'keys-unavailable' ? 503 : 401, check.problem, { headers })
    const { claims } = check
    const { user, cookie: session } = await signIn(env, `google:${claims.sub}`, claims.email, claims.name ?? null, claims.picture ?? null)
    headers.append('set-cookie', session)
    return json(toAccount(user), { headers })
  }

  if (path === '/api/auth/dev' && request.method === 'POST') {
    if (!devLoginEnabled(env)) return jsonError(404, 'Not found')
    requireSameOrigin(request, allowedOrigins(env))
    const { email } = await readJson<{ email?: string }>(request, { maxBytes: MAX_BODY })
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) return jsonError(400, 'Enter an e-mail address')
    const { user, cookie: session } = await signIn(env, `dev:${email.toLowerCase()}`, email, 'Dev user', null)
    return json(toAccount(user), { headers: { 'set-cookie': session } })
  }

  if (path === '/api/auth/logout' && request.method === 'POST') {
    requireSameOrigin(request, allowedOrigins(env))
    const token = getCookie(request, SESSION_COOKIE)
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token, 'base64url')).run()
    return json({ ok: true }, { headers: { 'set-cookie': serializeCookie(SESSION_COOKIE, '', { maxAge: 0 }) } })
  }

  return null
}
