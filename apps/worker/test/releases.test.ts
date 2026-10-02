import { describe, expect, test } from 'vitest'
import type { LatestReleaseDto, ReleasesDto } from '@magnetar/protocol/cloud'
import type { Env } from '../src/env.ts'
import { handleReleases } from '../src/releases.ts'

const asset = (tag: string, name: string, size = 10) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}`, size })

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag, name: `Magnetar ${tag.slice(1)}`, body: `## New\n\n- Something in ${tag} (#1)`, html_url: `https://github.com/o/r/releases/tag/${tag}`,
    published_at: '2026-09-29T10:00:00Z', draft: false, prerelease: false, assets: [], ...extra,
  }
}

/** GitHub answering `answer`, and the requests it was sent. */
function github(answer: () => Response) {
  const requests: Request[] = []
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init))
    return answer()
  }) as typeof fetch
  return { send, requests }
}

const ask = (path: string, send: typeof fetch, env: Partial<Env> = {}, method = 'GET') =>
  handleReleases(new Request(`https://x${path}`, { method }), env as Env, path, send)

describe('the changelog (/api/releases)', () => {
  test('lists what each release brings, newest version first, for ten minutes', async () => {
    const { send, requests } = github(() => Response.json([
      release('v1.0.0'), release('v1.2.0-rc.1', { prerelease: true }), release('v1.1.0'), release('v2.0.0', { draft: true }), release('nightly'),
    ]))
    const response = (await ask('/api/releases', send))!
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=600')
    const body = await response.json() as ReleasesDto
    expect(body.problem).toBeNull()
    expect(body.releases.map(r => [r.version, r.prerelease])).toEqual([['1.2.0-rc.1', true], ['1.1.0', false], ['1.0.0', false]])
    expect(body.releases[1]).toEqual({
      version: '1.1.0', tag: 'v1.1.0', name: 'Magnetar 1.1.0', notes: '## New\n\n- Something in v1.1.0 (#1)',
      publishedAt: '2026-09-29T10:00:00Z', prerelease: false, url: 'https://github.com/o/r/releases/tag/v1.1.0',
    })
    expect(requests[0]!.url).toBe('https://api.github.com/repos/XeonFX/Magnetar/releases?per_page=20')
    expect(requests[0]!.headers.get('user-agent')).toBe('magnetar.codefusion.cc')
    expect(requests[0]!.headers.has('authorization')).toBe(false)
  })

  test('says why when GitHub cannot be read, and is asked again next time', async () => {
    const cases: [() => Response, ReleasesDto['problem']][] = [
      [() => { throw new TypeError('network down') }, 'offline'],
      [() => Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' } }), 'rate-limited'],
      [() => new Response('', { status: 429, headers: { 'retry-after': '60' } }), 'rate-limited'],
      [() => new Response('<html>', { status: 502 }), 'unavailable'],
      [() => new Response('<html>'), 'unavailable'],
    ]
    for (const [answer, problem] of cases) {
      const response = (await ask('/api/releases', github(answer).send))!
      expect(response.status, String(problem)).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({ releases: [], problem })
    }
  })

  test('a repository without releases has an empty changelog, which is no problem', async () => {
    const response = (await ask('/api/releases', github(() => Response.json({ message: 'Not Found' }, { status: 404 })).send))!
    expect(await response.json()).toEqual({ releases: [], problem: null })
  })

  test('asks GitHub with the token when the Worker has one, and for the repository it is set to', async () => {
    const { send, requests } = github(() => Response.json([]))
    await ask('/api/releases', send, { GITHUB_TOKEN: 'github_pat_x', RELEASES_REPO: 'Someone/Fork' })
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer github_pat_x')
    expect(requests[0]!.url).toBe('https://api.github.com/repos/Someone/Fork/releases?per_page=20')
  })

  test('answers only GET on its own paths', async () => {
    const { send, requests } = github(() => Response.json([]))
    expect(await ask('/api/releases', send, {}, 'POST')).toBeNull()
    expect(await ask('/api/releases/2', send)).toBeNull()
    expect(await ask('/api/other', send)).toBeNull()
    expect(requests).toHaveLength(0)
  })
})

describe('the downloads (/api/releases/latest)', () => {
  test("are the newest release's, never a pre-release's, with each file's platform and architecture", async () => {
    const tag = 'v2.1.0'
    const { send } = github(() => Response.json([
      release('v3.0.0-rc.1', { prerelease: true, assets: [asset('v3.0.0-rc.1', 'Magnetar-3.0.0-rc.1-linux-x64')] }),
      release('v2.0.0'),
      release(tag, { assets: [
        asset(tag, 'Magnetar-2.1.0-macos-arm64.zip'), asset(tag, 'Magnetar-2.1.0-windows-x64.exe'), asset(tag, 'Magnetar-2.1.0-linux-arm64'),
        asset(tag, 'SHA256SUMS.txt'), asset(tag, 'SHA256SUMS.txt.sig'), asset(tag, 'Other-2.1.0-linux-x64'),
      ] }),
    ]))
    const response = (await ask('/api/releases/latest', send))!
    expect(response.headers.get('cache-control')).toBe('public, max-age=600')
    const latest = await response.json() as LatestReleaseDto
    expect(latest.version).toBe('2.1.0')
    expect(latest.pageUrl).toBe('https://github.com/o/r/releases/tag/v2.1.0')
    expect(latest.assets.map(a => [a.name, a.platform, a.arch])).toEqual([
      ['Magnetar-2.1.0-macos-arm64.zip', 'macos', 'arm64'],
      ['Magnetar-2.1.0-windows-x64.exe', 'windows', 'x64'],
      ['Magnetar-2.1.0-linux-arm64', 'linux', 'arm64'],
    ])
  })

  test('are a 404 before the first release, and a 502 the page falls back from when GitHub fails', async () => {
    expect((await ask('/api/releases/latest', github(() => Response.json([release('v1.0.0-beta', { prerelease: true })])).send))!.status).toBe(404)
    expect((await ask('/api/releases/latest', github(() => Response.json({}, { status: 404 })).send))!.status).toBe(404)
    expect((await ask('/api/releases/latest', github(() => new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })).send))!.status).toBe(502)
  })
})
