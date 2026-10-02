import { isOutdated } from '@codefusion-cc/app-update'
import { createLatestRelease } from '@codefusion-cc/app-update/react'
import type { LatestReleaseDto, ReleasesProblem } from '@magnetar/protocol/cloud'
import { cloud } from './cloudApi.ts'
import type { Translate } from './i18n.tsx'

/**
 * The newest release of the app, as the website's Worker says, read once for every component on the page (again
 * after ten minutes, 30 s after a failure). On a device's own dashboard the device knows it itself
 * (`updates.status`), so its components pass `enabled` false to `useLatest`.
 */
export const latestRelease = createLatestRelease<LatestReleaseDto>(cloud.latestRelease)

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
