import { fetchGitHubReleases, latestRelease, type Release, type ReleasesFailure } from '@codefusion-cc/app-update'
import { json, jsonError } from '@codefusion-cc/workers-http'
import type { LatestReleaseDto, ReleaseArch, ReleasePlatform, ReleasesDto, ReleasesProblem } from '@magnetar/protocol/cloud'
import type { Env } from './env.ts'

/** `Magnetar-2.1.0-macos-arm64.zip`, `…-windows-x64.exe`, `…-linux-arm64`. */
const ASSET = /^Magnetar-([\w.-]+?)-(macos|windows|linux)-(arm64|x64)(\.zip|\.exe)?$/
const CACHE_SECONDS = 600
/** The newest releases the changelog shows; the same list answers the download buttons. */
const PER_PAGE = 20

export function toLatestRelease(release: Release): LatestReleaseDto {
  return {
    version: release.version,
    publishedAt: release.publishedAt ?? '',
    pageUrl: release.url,
    assets: release.assets.flatMap(asset => {
      const match = ASSET.exec(asset.name)
      if (!match) return []
      return [{ name: asset.name, url: asset.url, size: asset.size, platform: match[2] as ReleasePlatform, arch: match[3] as ReleaseArch }]
    }),
  }
}

const PROBLEMS: Record<Exclude<ReleasesFailure, 'not-found'>, ReleasesProblem> = {
  offline: 'offline',
  'rate-limited': 'rate-limited',
  unavailable: 'unavailable',
  invalid: 'unavailable',
}

const cached = { 'cache-control': `public, max-age=${CACHE_SECONDS}` }

/**
 * The app's releases for visitors to the website: the newest one's downloads (`/api/releases/latest`) and what each
 * brings (`/api/releases`, the changelog and the "your app is outdated" notice). One GitHub list answers both, asked
 * at most every ten minutes per data centre; the page's own CSP keeps it from calling GitHub directly. A
 * `GITHUB_TOKEN` secret, when set, raises GitHub's rate limit for the Worker's shared addresses.
 */
export async function handleReleases(request: Request, env: Env, path: string, send: typeof fetch = fetch): Promise<Response | null> {
  if ((path !== '/api/releases' && path !== '/api/releases/latest') || request.method !== 'GET') return null
  const result = await fetchGitHubReleases(env.RELEASES_REPO || 'XeonFX/Magnetar', {
    userAgent: 'magnetar.codefusion.cc',
    token: env.GITHUB_TOKEN || undefined,
    perPage: PER_PAGE,
    fetch: send,
    init: { cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } } as RequestInit,
  })
  const releases = result.ok ? result.releases : []
  if (path === '/api/releases/latest') {
    const latest = latestRelease(releases)
    if (latest) return json(toLatestRelease(latest), { headers: cached })
    return result.ok || result.reason === 'not-found' ? jsonError(404, 'No release yet') : jsonError(502, `GitHub could not be read (${result.reason})`)
  }
  const problem = result.ok || result.reason === 'not-found' ? null : PROBLEMS[result.reason]
  const body: ReleasesDto = {
    releases: releases.map(({ version, tag, name, notes, publishedAt, prerelease, url }) => ({ version, tag, name, notes, publishedAt, prerelease, url })),
    problem,
  }
  // A failure is asked about again at the next visit rather than kept for ten minutes.
  return json(body, { headers: problem ? { 'cache-control': 'no-store' } : cached })
}
