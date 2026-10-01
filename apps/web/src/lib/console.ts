import { connectBrowser } from '@codefusion-cc/console/browser'
import { scrub } from '@magnetar/protocol/scrub'

/**
 * CodeFusion Console on the website (never on a device's own dashboard): uncaught errors and rejections, and
 * page views by screen name, through the Worker (createConsoleRoutes). Reports go through the same `scrub` as
 * the desktop app's (torrent titles, magnets, paths, addresses), then the package's own masking. Nobody is
 * asked for statistics consent, so views are counted without a visitor id and nothing is stored in the browser.
 */
export const reporting = connectBrowser({ appId: 'magnetar', version: import.meta.env.VITE_APP_VERSION ?? 'dev', mask: scrub })
