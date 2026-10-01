/** A device's pages live under `/<device name>`; everything after it is the page on that device. */
export const devicePath = (deviceName: string) => `/${encodeURIComponent(deviceName)}`

/**
 * The address that names a device by id, which a rename doesn't change: the app's notifications use it, and
 * it opens the same page under the device's name.
 */
export const deviceIdPath = (deviceId: string) => `/d/${encodeURIComponent(deviceId)}`

/**
 * The same page on another device: `/A/settings/agents?x=1` becomes `/B/settings/agents?x=1`, so switching
 * devices keeps you where you were. A path outside `from`'s pages opens `to`'s first page. `from` and `to` are
 * base paths (`devicePath` or `deviceIdPath`).
 */
export function samePageOn(pathname: string, search: string, from: string, to: string): string {
  const rest = pathname === from || pathname.startsWith(`${from}/`) ? pathname.slice(from.length) : ''
  return `${to}${rest === '/' ? '' : rest}${rest ? search : ''}`
}
