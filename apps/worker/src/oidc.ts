import { fromBase64Url } from '@md/protocol/base64'

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])
const MAX_TOKEN_BYTES = 16_000
const JWKS_FRESH_MS = 5 * 60_000
/** A Google outage must not sign everyone out, but never trust a key set older than a day. */
const JWKS_STALE_MS = 24 * 60 * 60_000

interface Jwk extends JsonWebKey {
  kid?: string
}

let cache: { keys: Jwk[]; fetchedAt: number } | null = null

async function loadJwks(fetcher: typeof fetch, now: number, force = false): Promise<Jwk[]> {
  if (!force && cache && now - cache.fetchedAt <= JWKS_FRESH_MS) return cache.keys
  try {
    const response = await fetcher(GOOGLE_JWKS_URL, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error('Google public keys unavailable')
    const body = (await response.json()) as { keys?: Jwk[] }
    if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('Empty Google key set')
    cache = { keys: body.keys, fetchedAt: now }
    return body.keys
  } catch (error) {
    if (cache && now - cache.fetchedAt <= JWKS_STALE_MS) return cache.keys
    throw error
  }
}

export interface GoogleClaims {
  sub: string
  email: string
  name?: string
  picture?: string
  nonce?: string
}

const decodeJson = <T>(part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as T

/**
 * Verifies a Google ID token: RS256 signature against Google's published keys (the algorithm is
 * fixed here, never taken from the token), exact issuer, our client id as audience, expiry, a
 * verified e-mail, and the nonce this browser was given for this sign-in.
 */
export async function verifyGoogleIdToken(
  token: string, clientId: string, expectedNonce: string, fetcher: typeof fetch = fetch, now = Date.now(),
): Promise<GoogleClaims> {
  if (!clientId) throw new Error('Google sign-in is not configured')
  if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) throw new Error('Malformed token')
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed token')
  const header = decodeJson<{ alg?: string; kid?: string }>(parts[0]!)
  const claims = decodeJson<Record<string, unknown>>(parts[1]!)
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unexpected token algorithm')

  let keys = await loadJwks(fetcher, now)
  let jwk = keys.find(k => k.kid === header.kid)
  // Google rotates keys: an unknown kid refreshes once so a new key works immediately.
  if (!jwk) {
    keys = await loadJwks(fetcher, now, true)
    jwk = keys.find(k => k.kid === header.kid)
  }
  if (!jwk) throw new Error('Signing key not found')
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64Url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  if (!valid) throw new Error('Invalid signature')

  const seconds = Math.floor(now / 1000)
  const audience = claims.aud
  if (!GOOGLE_ISSUERS.has(String(claims.iss))) throw new Error('Unexpected issuer')
  if (!(audience === clientId || (Array.isArray(audience) && audience.includes(clientId)))) throw new Error('Token is for another app')
  if (typeof claims.exp !== 'number' || claims.exp <= seconds) throw new Error('Token expired')
  if (typeof claims.iat === 'number' && claims.iat > seconds + 60) throw new Error('Token from the future')
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('Unverified e-mail address')
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string') throw new Error('Token without an identity')
  if (!expectedNonce || claims.nonce !== expectedNonce) throw new Error('Sign-in was not started in this browser')
  return {
    sub: claims.sub,
    email: claims.email,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    picture: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : undefined,
    nonce: claims.nonce as string,
  }
}

/** For tests: forget the cached key set. */
export function resetJwksCache(): void {
  cache = null
}
