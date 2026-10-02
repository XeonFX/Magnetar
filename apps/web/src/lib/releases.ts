import { isOutdated } from '@codefusion-cc/app-update'
import type { LatestReleaseDto, ReleasesProblem } from '@magnetar/protocol/cloud'
import { useEffect, useState } from 'react'
import { cloud } from './cloudApi.ts'
import type { Translate } from './i18n.tsx'

export { isOutdated }

/** How long the website trusts what it last heard of the newest release (the Worker caches GitHub as long). */
const LATEST_FOR_MS = 10 * 60_000
/** How long it trusts not knowing: one failed request must not hide every update notice for ten minutes. */
const UNKNOWN_FOR_MS = 30_000
let latest: { until: number; release: Promise<LatestReleaseDto | null> } | null = null

/** The newest release, shared by every caller on the page and asked again after ten minutes (30 s after a failure); null when unknown. */
export function latestRelease(now = Date.now()): Promise<LatestReleaseDto | null> {
  if (!latest || now > latest.until) {
    const entry = { until: now + LATEST_FOR_MS, release: cloud.latestRelease().catch(() => null) }
    void entry.release.then(release => { if (!release) entry.until = now + UNKNOWN_FOR_MS })
    latest = entry
  }
  return latest.release
}

/**
 * The newest release of the app, on the website (`undefined` while asked, null when GitHub couldn't say). On a
 * device's own dashboard the device knows it itself (`updates.status`), so `enabled` is false there.
 */
export function useLatestRelease(enabled = true): LatestReleaseDto | null | undefined {
  const [release, setRelease] = useState<LatestReleaseDto | null | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void latestRelease().then(r => !cancelled && setRelease(r))
    return () => { cancelled = true }
  }, [enabled])
  return enabled ? release : null
}

/**
 * The version to offer the app behind a dashboard, or null: the one the app found itself, else the newest release
 * the website knows of when the app runs an older one. Nothing without a running version (no app connected, an
 * unreadable report) or when the app is as new or newer (a pre-release, a development build).
 */
export function offeredVersion(running: string | null | undefined, appFound: string | null | undefined, latest: string | null | undefined): string | null {
  if (!running) return null
  if (appFound && isOutdated(running, appFound)) return appFound
  return latest && isOutdated(running, latest) ? latest : null
}

/** What went wrong reading the releases, in the person's language. */
export function releasesProblemText(t: Translate, problem: ReleasesProblem | 'install', retryAt: string | null, formatDate: (iso: string, withTime?: boolean) => string, detail?: string | null): string {
  switch (problem) {
    case 'offline': return t('releases.offline')
    case 'rate-limited': return retryAt ? t('releases.rateLimitedUntil', formatDate(retryAt, true)) : t('releases.rateLimited')
    case 'unavailable': return t('releases.unavailable')
    case 'install': return t('settings.installFailed', detail?.replace(/^Update failed: /, '') ?? '')
  }
}
