import { randomId, toBase64Url } from '@magnetar/protocol/base64'
import { GOOGLE_CALLBACK_PATH } from '@magnetar/protocol/cloud'

/**
 * "Sign in with Google" by full-page redirect (OpenID Connect, `id_token` in the fragment). The
 * page draws its own button, so no Google script or iframe runs on it. Google sends the browser to
 * the Worker's callback page, which bounces the token back to /login in the URL fragment; the
 * Worker then verifies it, including the nonce it bound to this browser with a cookie.
 */
const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const PENDING_KEY = 'magnetar-google-sign-in'
const MAX_AGE_MS = 10 * 60_000

export function startGoogleSignIn(clientId: string, nonce: string, returnPath: string, locale?: string): void {
  if (!returnPath.startsWith('/') || returnPath.startsWith('//')) throw new Error('Sign-in must return to a same-origin path')
  // A random value plus where to come back to; the callback reads the destination from it and
  // this page accepts only the exact state it stored.
  const state = `${randomId(24)}.${toBase64Url(new TextEncoder().encode(JSON.stringify([location.origin, `/login?next=${encodeURIComponent(returnPath)}`])))}`
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, createdAt: Date.now() }))
  const url = new URL(AUTHORIZATION_ENDPOINT)
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: new URL(GOOGLE_CALLBACK_PATH, location.origin).href,
    response_type: 'id_token',
    response_mode: 'fragment',
    scope: 'openid email profile',
    nonce,
    state,
    prompt: 'select_account',
    ...(locale ? { hl: locale } : {}),
  }).toString()
  location.assign(url.href)
}

export type SignInResult = { credential: string } | { error: string }

/** The result the callback left in this page's fragment, removed from the address bar at once. */
export function takeGoogleSignInResult(): SignInResult | null {
  const params = new URLSearchParams(location.hash.slice(1))
  const state = params.get('google_state')
  if (state === null) return null
  history.replaceState(history.state, '', location.pathname + location.search)
  const raw = sessionStorage.getItem(PENDING_KEY)
  sessionStorage.removeItem(PENDING_KEY)
  let pending: { state: string; createdAt: number } | null = null
  try {
    pending = JSON.parse(raw ?? 'null') as { state: string; createdAt: number } | null
  } catch {
    pending = null
  }
  if (!pending || pending.state !== state || Date.now() - pending.createdAt > MAX_AGE_MS) {
    return { error: 'Sign-in did not start in this tab or has expired. Try again.' }
  }
  const credential = params.get('google_id_token')
  return credential ? { credential } : { error: params.get('google_error') || 'Google did not return a credential.' }
}
