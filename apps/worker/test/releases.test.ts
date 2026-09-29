import { describe, expect, test } from 'bun:test'
import type { Env } from '../src/env.ts'
import { handleReleases, toLatestRelease } from '../src/releases.ts'

const asset = (name: string, size = 10) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/v2.1.0/${name}`, size })

describe('latest release', () => {
  test('keeps the app downloads and reads their platform and architecture', () => {
    const release = toLatestRelease({
      tag_name: 'v2.1.0', html_url: 'https://github.com/o/r/releases/tag/v2.1.0', published_at: '2026-09-29T10:00:00Z',
      assets: [
        asset('MediaDownloader-2.1.0-macos-arm64.zip'), asset('MediaDownloader-2.1.0-windows-x64.exe'),
        asset('MediaDownloader-2.1.0-linux-arm64'), asset('MediaDownloader-2.1.0-rc.1-linux-x64'),
        asset('SHA256SUMS.txt'), asset('SHA256SUMS.txt.sig'), asset('MediaDownloader-2.1.0-macos-arm64'), asset('Other-2.1.0-linux-x64'),
      ],
    })
    expect(release.version).toBe('2.1.0')
    expect(release.assets.map(a => [a.name, a.platform, a.arch])).toEqual([
      ['MediaDownloader-2.1.0-macos-arm64.zip', 'macos', 'arm64'],
      ['MediaDownloader-2.1.0-windows-x64.exe', 'windows', 'x64'],
      ['MediaDownloader-2.1.0-linux-arm64', 'linux', 'arm64'],
      ['MediaDownloader-2.1.0-rc.1-linux-x64', 'linux', 'x64'],
      ['MediaDownloader-2.1.0-macos-arm64', 'macos', 'arm64'],
    ])
  })

  test('GitHub failing is a 502 the page can fall back from', async () => {
    const down = (async () => new Response('rate limited', { status: 403 })) as unknown as typeof fetch
    const response = await handleReleases(new Request('https://x/api/releases/latest'), {} as Env, '/api/releases/latest', down)
    expect(response!.status).toBe(502)
    expect(await handleReleases(new Request('https://x/api/other'), {} as Env, '/api/other', down)).toBeNull()
  })
})
