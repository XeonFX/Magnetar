import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentFolder } from '../src/api/saveFolderPolicy.ts'
import { evaluateAgentRequest, isAllowedLoopbackOrigin, type AgentRequestFacts } from '../src/http/agentAuth.ts'
import { scrub } from '../src/telemetry.ts'

describe('agent API policy', () => {
  const base: AgentRequestFacts = {
    enabled: true, allowRemote: false, token: 'secret-token', clientIsLoopback: true, isHttps: false,
    origin: null, host: 'localhost:47820', authorization: null,
  }

  test('off means absent', () => expect(evaluateAgentRequest({ ...base, enabled: false })).toBe('disabled'))
  test('loopback needs no token', () => expect(evaluateAgentRequest(base)).toBe('allowed'))
  test('any web page origin is refused, token or not', () => {
    expect(evaluateAgentRequest({ ...base, origin: 'https://evil.example' })).toBe('forbiddenOrigin')
    expect(evaluateAgentRequest({ ...base, origin: 'https://evil.example', authorization: 'Bearer secret-token' })).toBe('forbiddenOrigin')
  })
  test('a DNS-rebound origin matching its own Host is still refused', () => {
    expect(evaluateAgentRequest({ ...base, origin: 'http://evil.example:47820', host: 'evil.example:47820' })).toBe('forbiddenOrigin')
  })
  test('the app’s own loopback origin is fine', () => {
    expect(evaluateAgentRequest({ ...base, origin: 'http://localhost:47820' })).toBe('allowed')
    expect(isAllowedLoopbackOrigin('http://127.0.0.1:47820', '127.0.0.1:47820')).toBe(true)
    expect(isAllowedLoopbackOrigin('http://localhost:5173', 'localhost:47820')).toBe(false)
  })
  test('remote callers', () => {
    const remote = { ...base, clientIsLoopback: false }
    expect(evaluateAgentRequest(remote)).toBe('remoteDisabled')
    expect(evaluateAgentRequest({ ...remote, allowRemote: true })).toBe('insecureTransport')
    expect(evaluateAgentRequest({ ...remote, allowRemote: true, isHttps: true })).toBe('unauthorized')
    expect(evaluateAgentRequest({ ...remote, allowRemote: true, isHttps: true, authorization: 'Bearer wrong' })).toBe('unauthorized')
    expect(evaluateAgentRequest({ ...remote, allowRemote: true, isHttps: true, authorization: 'Bearer secret-token' })).toBe('allowed')
  })
})

describe('agent save folders', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'md-root-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'md-outside-')))
  mkdirSync(join(root, 'shows'))
  symlinkSync(outside, join(root, 'escape'))
  writeFileSync(join(root, 'file.txt'), 'x')

  test('empty means the default', () => expect(resolveAgentFolder('  ', root)).toBeNull())
  test('inside the root is allowed, even when it does not exist yet', () => {
    expect(resolveAgentFolder(join(root, 'shows'), root)).toBe(join(root, 'shows'))
    expect(resolveAgentFolder(join(root, 'new', 'deeper'), root)).toBe(join(root, 'new', 'deeper'))
    expect(resolveAgentFolder(root, root)).toBe(root)
  })
  test('outside, via .., via a symlink, or a sibling with a shared prefix is refused', () => {
    expect(() => resolveAgentFolder(outside, root)).toThrow(/only be saved inside/)
    expect(() => resolveAgentFolder(join(root, '..'), root)).toThrow(/only be saved inside/)
    expect(() => resolveAgentFolder(join(root, 'escape', 'x'), root)).toThrow(/only be saved inside/)
    expect(() => resolveAgentFolder(`${root}-sibling`, root)).toThrow(/only be saved inside/)
  })
  test('a path through a file is refused', () => {
    expect(() => resolveAgentFolder(join(root, 'file.txt', 'x'), root)).toThrow(/not a usable folder/)
  })
})

describe('telemetry scrubbing', () => {
  test('removes titles, paths, urls, addresses, hashes and tokens', () => {
    const scrubbed = scrub('Could not resolve "Some.Show.S01E01.1080p" at /Users/alice/Downloads/x.mkv from https://nyaa.si/view/1 for bob@example.com 10.0.0.4 hash abcdef0123456789abcdef0123456789abcdef01 token AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-')
    expect(scrubbed).not.toMatch(/Some\.Show|alice|nyaa|bob@|10\.0\.0\.4|abcdef0123|AbCdEfGh/)
    expect(scrubbed).toContain('Could not resolve')
  })
})
