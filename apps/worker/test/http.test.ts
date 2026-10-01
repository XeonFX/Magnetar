import { env } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import { SESSION_COOKIE } from '../src/auth.ts'
import { call, freshIp, signIn } from './client.ts'

// How every API call reads requests and refuses them (@codefusion-cc/workers-http), through the real Worker.

/** SHA-256 in base64url without padding: how sessions and device tokens have always been stored. */
async function storedHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('requests the API refuses', () => {
  test('a session stored before keeps working: tokens are kept by their base64url SHA-256', async () => {
    const user = await signIn()
    const token = user.headers.cookie!.slice(`${SESSION_COOKIE}=`.length)
    const row = await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').bind(await storedHash(token)).first<{ user_id: string }>()
    expect(row).not.toBeNull()

    const older = 'o'.repeat(43)
    await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await storedHash(older), row!.user_id, Date.now(), Date.now() + 86_400_000).run()
    const me = await call('/api/me', { headers: { cookie: `${SESSION_COOKIE}=${older}` } })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ email: user.email })
  })

  test('refusals thrown on the way carry the same headers as any answer, and say why', async () => {
    const user = await signIn()
    const refused = await call('/api/auth/logout', { method: 'POST', headers: { ...user.headers, origin: 'https://evil.example' } })
    expect(refused.status).toBe(403)
    expect(refused.headers.get('x-content-type-options')).toBe('nosniff')
    expect(refused.headers.get('referrer-policy')).toBe('no-referrer')
    expect(refused.headers.get('cache-control')).toBe('no-store')
    expect(await refused.json()).toEqual({ error: 'Cross-origin request refused.', code: 'cross_origin' })
  })

  test('a page of ours without Origin passes only with Sec-Fetch-Site: same-origin', async () => {
    const user = await signIn()
    const logout = (headers: Record<string, string>) => call('/api/auth/logout', { method: 'POST', headers: { cookie: user.headers.cookie!, ...headers } })
    expect((await logout({ 'sec-fetch-site': 'same-site' })).status).toBe(403)
    expect((await logout({ 'sec-fetch-site': 'same-origin' })).status).toBe(200)
  })

  test('JSON that is not an object is a 400, not a server error', async () => {
    for (const json of [null, [], 'name', 7]) {
      const response = await call('/api/pair/start', { method: 'POST', headers: { 'cf-connecting-ip': freshIp() }, json })
      expect(response.status, JSON.stringify(json)).toBe(400)
      expect(await response.json()).toEqual({ error: 'The request is not valid JSON.', code: 'invalid_json' })
    }
  })

  test('a body sent in pieces is cut off at the limit too', async () => {
    const piece = new TextEncoder().encode('x'.repeat(4096))
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) controller.enqueue(new TextEncoder().encode('{"name":"'))
        else if (sent > 8) return controller.close()
        controller.enqueue(piece)
        sent++
      },
    })
    const response = await call('/api/pair/start', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp() }, body, duplex: 'half' } as RequestInit)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'The request is too large.', code: 'body_too_large' })
  })

  test('limits count a whole IPv6 /64, so new addresses on one line do not get around them', async () => {
    const network = freshIp().slice(0, -'::1'.length)
    const report = (ip: string) => call('/api/telemetry/failure', { method: 'POST', headers: { 'cf-connecting-ip': ip }, json: { source: 'nope' } })
    // Local rate limits count in one-minute windows on the wall clock; don't straddle two.
    const leftInWindow = 60_000 - (Date.now() % 60_000)
    if (leftInWindow < 5000) await new Promise(resolve => setTimeout(resolve, leftInWindow + 100))
    // The dev environment allows 100 a minute: each from another address in the /64.
    const statuses = await Promise.all(Array.from({ length: 100 }, async (_, i) => (await report(`${network}::${(i + 1).toString(16)}`)).status))
    expect(statuses.filter(s => s === 400)).toHaveLength(100)
    const refused = await report(`${network}:ffff:ffff:ffff:ffff`)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('60')
    expect((await report(freshIp())).status).toBe(400)
  })
})
