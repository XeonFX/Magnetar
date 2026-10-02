import type { LinkedBrowserDto } from '@magnetar/protocol'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { followLink, type LinkWatch } from './linkState.ts'

const browser = (keyId: string, lastSeenAt: string | null = null, label = keyId): LinkedBrowserDto =>
  ({ keyId, label, createdAt: '2026-10-02T10:00:00.000Z', lastSeenAt })

const NOW = 1_000_000
const watch = (listed: boolean): LinkWatch => ({ keyId: 'k1', listed, deadline: NOW + 600_000 })

describe('followLink', () => {
  it('waits while the list has not caught up with the new link yet', () => {
    expect(followLink(watch(false), [browser('old', '2026-10-01T10:00:00.000Z')], NOW)).toEqual({ ...watch(false), state: 'waiting' })
    expect(followLink(watch(false), [], NOW)).toEqual({ ...watch(false), state: 'waiting' })
    // Even past its time: a list from before the link was made says nothing about it.
    expect(followLink(watch(false), [], NOW + 700_000).state).toBe('waiting')
  })

  it('waits while its key is listed but no browser has used it', () => {
    expect(followLink(watch(false), [browser('k1')], NOW)).toEqual({ ...watch(true), state: 'waiting' })
    expect(followLink(watch(true), [browser('k1')], NOW)).toEqual({ ...watch(true), state: 'waiting' })
  })

  it('is linked once a browser has connected with its key, naming that browser', () => {
    const phone = browser('k1', '2026-10-02T10:01:00.000Z', 'My phone')
    expect(followLink(watch(true), [browser('old'), phone], NOW)).toEqual({ ...watch(true), state: 'linked', browser: phone })
    // The browser can connect before this dashboard ever saw the key unused, or just as the link expires.
    expect(followLink(watch(false), [phone], NOW)).toEqual({ ...watch(true), state: 'linked', browser: phone })
    expect(followLink(watch(true), [phone], NOW + 600_000).state).toBe('linked')
  })

  it('ignores other browsers being used, linked or revoked', () => {
    expect(followLink(watch(true), [browser('k1'), browser('k2', '2026-10-02T10:01:00.000Z')], NOW).state).toBe('waiting')
    expect(followLink(watch(true), [browser('k1')], NOW).state).toBe('waiting')
    expect(followLink(watch(true), [browser('k10', '2026-10-02T10:01:00.000Z'), browser('k1')], NOW).state).toBe('waiting')
  })

  it('has expired once its key leaves the list unused around its time', () => {
    expect(followLink(watch(true), [browser('k2')], NOW + 600_000)).toEqual({ ...watch(true), state: 'expired' })
    expect(followLink(watch(true), [], NOW + 900_000).state).toBe('expired')
    // The device's clock started the time a moment before this dashboard heard of the link.
    expect(followLink(watch(true), [], NOW + 596_000).state).toBe('expired')
  })

  it('was revoked when its key leaves the list well before its time, or never had one', () => {
    expect(followLink(watch(true), [browser('k2')], NOW)).toEqual({ ...watch(true), state: 'revoked' })
    expect(followLink(watch(true), [], NOW + 590_000).state).toBe('revoked')
    // An app from before links expired keeps them until they are revoked.
    expect(followLink({ keyId: 'k1', listed: true }, [], NOW + 10_000_000).state).toBe('revoked')
  })

  it('only reports linked for a list holding its key with a last use, whatever else the list holds', () => {
    const keyIds = fc.constantFrom('k1', 'k2', 'k3', 'K1', 'k1 ')
    const entry = fc.record({ keyId: keyIds, lastSeenAt: fc.option(fc.constant('2026-10-02T10:01:00.000Z')) })
      .map(({ keyId, lastSeenAt }) => browser(keyId, lastSeenAt))
    fc.assert(fc.property(fc.boolean(), fc.array(entry, { maxLength: 6 }), fc.integer({ min: 0, max: 2_000_000 }), (listed, browsers, now) => {
      const next = followLink(watch(listed), browsers, now)
      const mine = browsers.find(b => b.keyId === 'k1')
      expect(next.keyId).toBe('k1')
      expect(next.state === 'linked').toBe(mine?.lastSeenAt != null)
      expect(next.state === 'expired' || next.state === 'revoked').toBe(listed && !mine)
      // Once seen, a link stays seen.
      expect(next.listed).toBe(listed || mine !== undefined)
    }))
  })
})
