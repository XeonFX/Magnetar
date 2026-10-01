import { json, readBody } from '@codefusion-cc/workers-http'
import { fromBase64Url } from '@magnetar/protocol/base64'
import { GOOGLE_CALLBACK_PATH } from '@magnetar/protocol/cloud'
import { allowedOrigins, MAX_BODY, type Env } from './env.ts'

/**
 * Where a sign-in started, read from its state: `<random>.<base64url JSON [origin, path]>`. The
 * origin must be ours and the path our login page. The login page only accepts the exact state
 * it stored, so this decides where a token may go, never whether it is accepted.
 */
export function signInReturnUrl(state: string | null, env: Env): URL | null {
  if (!state || state.length > 2048) return null
  const [random, encoded, ...rest] = state.split('.')
  if (rest.length || !random || !/^[A-Za-z0-9_-]{32}$/.test(random) || !/^[A-Za-z0-9_-]+$/.test(encoded ?? '')) return null
  try {
    const [origin, path, ...extra] = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded!))) as unknown[]
    if (extra.length || typeof origin !== 'string' || typeof path !== 'string') return null
    if (!allowedOrigins(env).includes(origin)) return null
    if (path !== '/login' && !path.startsWith('/login?')) return null
    const url = new URL(path, origin)
    return url.origin === origin && url.pathname === '/login' ? url : null
  } catch {
    return null
  }
}

// Reads Google's fragment response, drops it from history, and posts it here to be bounced to /login.
const PAGE_SCRIPT = `(async () => {
  const found = new URLSearchParams(location.hash.slice(1))
  history.replaceState(null, '', location.pathname)
  const form = new URLSearchParams()
  for (const name of ['state', 'id_token', 'error']) if (found.has(name)) form.set(name, found.get(name))
  try {
    const response = await fetch(location.pathname, { method: 'POST', body: form, headers: { accept: 'application/json' } })
    if (response.ok) return location.replace((await response.json()).location)
    document.body.textContent = await response.text()
  } catch {
    document.body.textContent = 'Sign-in failed'
  }
})()`

async function hashSource(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`
}

/** Google redirects here (`response_mode=fragment`); drawn in the app's background, so no white flash. */
async function callbackPage(): Promise<Response> {
  const style = 'html{color-scheme:light dark;background:#f6f7fb}@media (prefers-color-scheme:dark){html{background:#0f1117}}'
  const csp = [`default-src 'none'`, `script-src ${await hashSource(PAGE_SCRIPT)}`, `style-src ${await hashSource(style)}`,
    `connect-src 'self'`, `base-uri 'none'`, `frame-ancestors 'none'`].join('; ')
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title><style>${style}</style></head><body><script>${PAGE_SCRIPT}</script></body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  })
}

/** Sends the browser back to the login page with the token in the fragment, which no server sees. */
async function bounce(request: Request, env: Env): Promise<Response> {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return new Response('Invalid sign-in response', { status: 400 })
  const form = new URLSearchParams(new TextDecoder().decode(await readBody(request, { maxBytes: MAX_BODY })))
  const state = form.get('state')
  const target = signInReturnUrl(state, env)
  if (!target) return new Response('Invalid sign-in response', { status: 400 })
  const fragment = new URLSearchParams({ google_state: state! })
  const credential = form.get('id_token')
  const failure = form.get('error')
  if (credential) fragment.set('google_id_token', credential)
  else fragment.set('google_error', failure && /^[a-z_]{1,64}$/.test(failure) ? failure : 'no_credential')
  target.hash = fragment.toString()
  return json({ location: target.href })
}

export async function handleGoogleCallback(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== GOOGLE_CALLBACK_PATH) return null
  if (request.method === 'GET') return callbackPage()
  if (request.method === 'POST') return bounce(request, env)
  return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
}
