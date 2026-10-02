import { watchAppUpdates } from '@codefusion-cc/app-update/browser'
import { MAGNETAR_REPO } from '@magnetar/protocol/cloud'
import { useEffect } from 'react'
import { useLocation } from 'react-router'

/** The commit this page was built from (vite.config.ts), compared with the deploy's /version.json. */
declare const __APP_COMMIT__: string

/** The newest release's page, where the app can always be downloaded. */
export const RELEASES_PAGE = `https://github.com/${MAGNETAR_REPO}/releases/latest`

/** This page's build: the version it was released as and the commit it was built from. */
export const BUILD = { version: import.meta.env.VITE_APP_VERSION ?? 'dev', commit: __APP_COMMIT__ }

/** "v1.0.0 · abc1234": the build as CodeFusion Console's Failures page shows it. */
export const BUILD_LABEL = `v${BUILD.version} · ${BUILD.commit}`


/**
 * Keeps an open page on the build that is deployed (@codefusion-cc/app-update): on the website after a Worker
 * deploy, on a device's own dashboard after the app updates. A link or coming back to the tab loads the new
 * build; a page a deploy removed reloads instead of failing. Nothing typed or being saved is cut short.
 */
export const updates = watchAppUpdates({ current: __APP_COMMIT__, storageKey: 'magnetar-update' })

/** Tells the updater each route change, so a field changed on a page no longer holds the reload once it is left. */
export function UpdatesOnNavigation() {
  const { pathname } = useLocation()
  useEffect(() => updates.navigated(), [pathname])
  return null
}
