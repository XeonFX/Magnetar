/**
 * The website's screens as CodeFusion Console counts their visits and files their failures. The Worker
 * accepts only these names (createConsoleRoutes); anything else arrives as "other".
 */
export const CONSOLE_PAGES = [
  'login',
  'pair',
  'link',
  'add',
  'devices',
  'device-downloads',
  'device-search',
  'device-series',
  'device-settings',
] as const

export type ConsolePage = (typeof CONSOLE_PAGES)[number]

const DEVICE_TABS = new Set(['search', 'series', 'settings'])

/** The screen a website path shows, never an id from it. */
export function consolePage(pathname: string): ConsolePage {
  const [, first = '', , tab = ''] = pathname.split('/')
  if (first === 'd') return DEVICE_TABS.has(tab) ? (`device-${tab}` as ConsolePage) : 'device-downloads'
  if (first === 'login' || first === 'pair' || first === 'link' || first === 'add') return first
  return 'devices'
}
