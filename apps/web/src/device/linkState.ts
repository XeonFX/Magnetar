import type { LinkedBrowserDto } from '@magnetar/protocol'

/** A link this dashboard made for another browser, followed through the device's list of browsers. */
export interface LinkWatch {
  keyId: string
  /** Whether a list held the key yet: the list can reach the dashboard before the link itself does. */
  listed: boolean
}

export type FollowedLink = LinkWatch & ({ state: 'waiting' | 'expired' } | { state: 'linked'; browser: LinkedBrowserDto })

/**
 * What became of a link, given the device's latest list of browsers: linked once a browser has connected with
 * its key, expired once the key has left the list unused (the device deletes a link nobody opened in time).
 * Changes to other browsers never count.
 */
export function followLink(watch: LinkWatch, browsers: readonly LinkedBrowserDto[]): FollowedLink {
  const browser = browsers.find(b => b.keyId === watch.keyId)
  if (browser?.lastSeenAt) return { keyId: watch.keyId, listed: true, state: 'linked', browser }
  if (browser) return { keyId: watch.keyId, listed: true, state: 'waiting' }
  return { ...watch, state: watch.listed ? 'expired' : 'waiting' }
}
