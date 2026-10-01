/** A device's pages live under `/d/<device id>`; everything after it is the page on that device. */
export const devicePath = (deviceId: string) => `/d/${encodeURIComponent(deviceId)}`

/**
 * The same page on another device: `/d/A/settings/agents?x=1` becomes `/d/B/settings/agents?x=1`,
 * so switching devices keeps you where you were. A path outside `from`'s pages opens `to`'s first page.
 */
export function samePageOn(pathname: string, search: string, from: string, to: string): string {
  const base = devicePath(from)
  const rest = pathname === base || pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : ''
  return `${devicePath(to)}${rest === '/' ? '' : rest}${rest ? search : ''}`
}
