import { beforeEach, describe, expect, test } from 'vitest'
import { toBase64Url } from '@magnetar/protocol/base64'
import type { Env } from '../src/env.ts'
import { signInReturnUrl } from '../src/googleCallback.ts'
import { resetJwksCache, verifyGoogleIdToken } from '../src/oidc.ts'

const encoder = new TextEncoder()
const CLIENT_ID = 'client.apps.googleusercontent.com'
const NOW = Date.UTC(2026, 8, 28)

const pair = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
)) as CryptoKeyPair
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' }
const fetcher = (async () => Response.json({ keys: [publicJwk] })) as unknown as typeof fetch

async function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }): Promise<string> {
  const part = (value: unknown) => toBase64Url(encoder.encode(JSON.stringify(value)))
  const input = `${part(header)}.${part(claims)}`
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, encoder.encode(input)))
  return `${input}.${toBase64Url(signature)}`
}

const valid = {
  iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '123', email: 'a@example.com', email_verified: true,
  exp: NOW / 1000 + 600, iat: NOW / 1000, nonce: 'n1',
}

describe('Google ID tokens', () => {
  beforeEach(() => resetJwksCache())

  test('a valid token for this app, browser and nonce is accepted', async () => {
    expect((await verifyGoogleIdToken(await token(valid), CLIENT_ID, 'n1', fetcher, NOW)).email).toBe('a@example.com')
  })

  test.each([
    ['another app', { aud: 'other' }, /another app/],
    ['another issuer', { iss: 'https://evil.example' }, /issuer/],
    ['an expired token', { exp: NOW / 1000 - 1 }, /expired/],
    ['an unverified address', { email_verified: false }, /Unverified/],
    ['a different nonce', { nonce: 'stolen' }, /not started in this browser/],
  ])('refuses %s', async (_, change, message) => {
    await expect(verifyGoogleIdToken(await token({ ...valid, ...change }), CLIENT_ID, 'n1', fetcher, NOW)).rejects.toThrow(message)
  })

  test('refuses a token whose algorithm is not RS256', async () => {
    await expect(verifyGoogleIdToken(await token(valid, { alg: 'HS256', kid: 'k1' }), CLIENT_ID, 'n1', fetcher, NOW)).rejects.toThrow(/algorithm/)
  })

  test('refuses a tampered payload', async () => {
    const [header, , signature] = (await token(valid)).split('.')
    const forged = toBase64Url(encoder.encode(JSON.stringify({ ...valid, email: 'boss@example.com' })))
    await expect(verifyGoogleIdToken(`${header}.${forged}.${signature}`, CLIENT_ID, 'n1', fetcher, NOW)).rejects.toThrow(/signature/)
  })

  test('refuses when sign-in is not configured', async () => {
    await expect(verifyGoogleIdToken(await token(valid), '', 'n1', fetcher, NOW)).rejects.toThrow(/not configured/)
  })
})

describe('sign-in return URLs', () => {
  const env = { ORIGIN: 'https://magnetar.codefusion.cc', APP_ENV: 'production' } as Env
  const state = (origin: string, path: string) =>
    `${'a'.repeat(32)}.${toBase64Url(new TextEncoder().encode(JSON.stringify([origin, path])))}`

  test('only our own login page', () => {
    expect(signInReturnUrl(state(env.ORIGIN, '/login?next=%2Fd%2Fx'), env)?.href).toBe('https://magnetar.codefusion.cc/login?next=%2Fd%2Fx')
    expect(signInReturnUrl(state('https://evil.example', '/login'), env)).toBeNull()
    expect(signInReturnUrl(state(env.ORIGIN, '/pair/x'), env)).toBeNull()
    expect(signInReturnUrl(state(env.ORIGIN, '//evil.example/login'), env)).toBeNull()
    expect(signInReturnUrl('garbage', env)).toBeNull()
  })

  test('the Vite dev origin only in development with dev login', () => {
    expect(signInReturnUrl(state('http://localhost:5173', '/login'), env)).toBeNull()
    const dev = { ...env, APP_ENV: 'development', DEV_LOGIN: 'enabled' } as Env
    expect(signInReturnUrl(state('http://localhost:5173', '/login'), dev)).not.toBeNull()
  })
})
