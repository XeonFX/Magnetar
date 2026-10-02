import type { LinkedBrowserDto } from '@magnetar/protocol'

/** A link this dashboard made for another browser, followed through the device's list of browsers. */
export interface LinkWatch {
  keyId: string
  /** Whether a list held the key yet: the list can reach the dashboard before the link itself does. */
  listed: boolean
  /** When the device lets the link expire, on this browser's clock; absent from apps whose links never expire. */
  deadline?: number
}

export type FollowedLink = LinkWatch & ({ state: 'waiting' | 'expired' | 'revoked' } | { state: 'linked'; browser: LinkedBrowserDto })

/** How much sooner than its deadline the device may expire a link: its clock started before the answer got here. */
const EARLY_MS = 5_000

/**
 * What became of a link, given the device's latest list of browsers at `now`: linked once a browser has connected
 * with its key; once the key has left the list unused, expired when that happened around its deadline (the device
 * deletes a link nobody opened in time) and revoked otherwise. Changes to other browsers never count.
 */
export function followLink(watch: LinkWatch, browsers: readonly LinkedBrowserDto[], now: number): FollowedLink {
  const browser = browsers.find(b => b.keyId === watch.keyId)
  if (browser?.lastSeenAt) return { ...watch, listed: true, state: 'linked', browser }
  if (browser) return { ...watch, listed: true, state: 'waiting' }
  if (!watch.listed) return { ...watch, state: 'waiting' }
  return { ...watch, state: watch.deadline !== undefined && now >= watch.deadline - EARLY_MS ? 'expired' : 'revoked' }
}
