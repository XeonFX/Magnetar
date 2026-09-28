import { tokenMatches } from '../api/agentAccess.ts'

export type AgentAuthResult = 'allowed' | 'disabled' | 'forbiddenOrigin' | 'unauthorized' | 'remoteDisabled' | 'insecureTransport'

export function isAgentPath(pathname: string): boolean {
  return /^\/(api|mcp|openapi)(\/|$)/.test(pathname)
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false
  const ip = address.replace(/^::ffff:/i, '')
  return ip === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)
}

/** True for `localhost`, `127.x` or `[::1]` host names, i.e. never a DNS name that rebinding could point here. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * Only the app's own literal loopback origin counts as same-origin. Matching the Host header is
 * not enough: after a DNS rebind, `Origin: http://evil.example` and `Host: evil.example` also
 * match while the connection lands on 127.0.0.1.
 */
export function isAllowedLoopbackOrigin(origin: string, host: string | null): boolean {
  if (!host) return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  return isLoopbackHostname(url.hostname) && url.host.toLowerCase() === host.toLowerCase()
}

export function bearerToken(authorization: string | null): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '')
  return match?.[1]?.trim() || null
}

export interface AgentRequestFacts {
  enabled: boolean
  allowRemote: boolean
  token: string
  clientIsLoopback: boolean
  /** The request came through a reverse proxy on this machine (X-Forwarded-For from a loopback peer). */
  forwarded: boolean
  /** Host name the request was addressed to. */
  hostname: string
  isHttps: boolean
  origin: string | null
  host: string | null
  authorization: string | null
}

/**
 * Whether a request may use the agent API. In order:
 * 1. feature off → 404, as if the endpoints didn't exist;
 * 2. a direct request addressed to anything but a loopback host name → 403: a DNS-rebound page
 *    (evil.example → 127.0.0.1) sends no Origin on its same-origin GETs, so only the Host shows it;
 * 3. a cross-origin `Origin` header → 403, token or not: otherwise any web page could POST to
 *    localhost and queue downloads;
 * 4. loopback → allowed without a token;
 * 5. remote access off → 404; remote plaintext → 426; remote HTTPS → the bearer token must match.
 */
export function evaluateAgentRequest(f: AgentRequestFacts): AgentAuthResult {
  if (!f.enabled) return 'disabled'
  if (!f.forwarded && !isLoopbackHostname(f.hostname)) return 'forbiddenOrigin'
  if (f.origin && !isAllowedLoopbackOrigin(f.origin, f.host)) return 'forbiddenOrigin'
  if (f.clientIsLoopback) return 'allowed'
  if (!f.allowRemote) return 'remoteDisabled'
  if (!f.isHttps) return 'insecureTransport'
  return tokenMatches(bearerToken(f.authorization), f.token) ? 'allowed' : 'unauthorized'
}

export function refusal(result: Exclude<AgentAuthResult, 'allowed'>): Response {
  const [status, error] = {
    disabled: [404, 'The agent API is turned off. Enable it in MediaDownloader under Settings → Agent access.'],
    remoteDisabled: [404, 'Remote agent access is turned off.'],
    insecureTransport: [426, 'Remote agent requests require HTTPS. Put a TLS reverse proxy on this machine in front of the loopback URL.'],
    forbiddenOrigin: [403, 'Cross-origin requests are not accepted by the agent API.'],
    unauthorized: [401, 'Requests from other machines need a bearer token. Find it in Settings → Agent access.'],
  }[result] as [number, string]
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (result === 'insecureTransport') headers.upgrade = 'TLS/1.2, HTTP/1.1'
  return new Response(JSON.stringify({ error }), { status, headers })
}
