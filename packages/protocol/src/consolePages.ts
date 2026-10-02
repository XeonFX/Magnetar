/**
 * The website's screens as CodeFusion Console counts their visits and files their failures. The Worker
 * accepts only these names (createConsoleRoutes); anything else arrives as "other".
 */
export const CONSOLE_PAGES = [
  'login',
  'pair',
  'link',
  'add',
  'features',
  'devices',
  'device-downloads',
  'device-search',
  'device-series',
  'device-settings',
] as const

export type ConsolePage = (typeof CONSOLE_PAGES)[number]

const DEVICE_TABS = new Set(['search', 'series', 'settings'])
/** The website's own top-level pages, which no device may be named after (device-names.json). */
export const SITE_PAGES = new Set(['login', 'pair', 'link', 'add', 'features'])

/** The screen a website path shows (`/MacBook-Pro/search/dragon` is device-search), never a name or id from it. */
export function consolePage(pathname: string): ConsolePage {
  const [, first = '', ...rest] = pathname.split('/')
  if (SITE_PAGES.has(first)) return first as ConsolePage
  if (!first) return 'devices'
  // A device by name, or by id under /d/ on its way to its name.
  const tab = (first === 'd' ? rest[1] : rest[0]) ?? ''
  return DEVICE_TABS.has(tab) ? (`device-${tab}` as ConsolePage) : 'device-downloads'
}
