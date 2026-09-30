import type { LatestReleaseDto, ReleaseArch, ReleasePlatform } from '@magnetar/protocol/cloud'
import type { Env } from './env.ts'
import { error, json } from './http.ts'

/** `Magnetar-2.1.0-macos-arm64.zip`, `…-windows-x64.exe`, `…-linux-arm64`. */
const ASSET = /^Magnetar-([\w.-]+?)-(macos|windows|linux)-(arm64|x64)(\.zip|\.exe)?$/
const CACHE_SECONDS = 600

interface GitHubRelease {
  tag_name: string
  html_url: string
  published_at: string
  assets: { name: string; browser_download_url: string; size: number }[]
}

export function toLatestRelease(release: GitHubRelease): LatestReleaseDto {
  return {
    version: release.tag_name.replace(/^v/, ''),
    publishedAt: release.published_at,
    pageUrl: release.html_url,
    assets: release.assets.flatMap(asset => {
      const match = ASSET.exec(asset.name)
      if (!match) return []
      return [{ name: asset.name, url: asset.browser_download_url, size: asset.size, platform: match[2] as ReleasePlatform, arch: match[3] as ReleaseArch }]
    }),
  }
}

/**
 * The latest release's downloads, for visitors to the website. GitHub's API is asked at most once
 * every ten minutes per data centre; the page's own CSP keeps it from calling GitHub directly.
 */
export async function handleReleases(request: Request, env: Env, path: string, send: typeof fetch = fetch): Promise<Response | null> {
  if (path !== '/api/releases/latest' || request.method !== 'GET') return null
  const repo = env.RELEASES_REPO || 'XeonFX/Magnetar'
  const answer = await send(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'magnetar.codefusion.cc' },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  } as RequestInit)
  if (!answer.ok) return error(502, `GitHub answered HTTP ${answer.status}`)
  return json(toLatestRelease(await answer.json() as GitHubRelease), { headers: { 'cache-control': `public, max-age=${CACHE_SECONDS}` } })
}
