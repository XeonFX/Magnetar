import type { LinkedBrowserDto } from '@magnetar/protocol'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { followLink } from './linkState.ts'

const browser = (keyId: string, lastSeenAt: string | null = null, label = keyId): LinkedBrowserDto =>
  ({ keyId, label, createdAt: '2026-10-02T10:00:00.000Z', lastSeenAt })

describe('followLink', () => {
  it('waits while the list has not caught up with the new link yet', () => {
    expect(followLink({ keyId: 'k1', listed: false }, [browser('old', '2026-10-01T10:00:00.000Z')]))
      .toEqual({ keyId: 'k1', listed: false, state: 'waiting' })
    expect(followLink({ keyId: 'k1', listed: false }, [])).toEqual({ keyId: 'k1', listed: false, state: 'waiting' })
  })

  it('waits while its key is listed but no browser has used it', () => {
    expect(followLink({ keyId: 'k1', listed: false }, [browser('k1')])).toEqual({ keyId: 'k1', listed: true, state: 'waiting' })
    expect(followLink({ keyId: 'k1', listed: true }, [browser('k1')])).toEqual({ keyId: 'k1', listed: true, state: 'waiting' })
  })

  it('is linked once a browser has connected with its key, naming that browser', () => {
    const phone = browser('k1', '2026-10-02T10:01:00.000Z', 'My phone')
    expect(followLink({ keyId: 'k1', listed: true }, [browser('old'), phone]))
      .toEqual({ keyId: 'k1', listed: true, state: 'linked', browser: phone })
    // The browser can connect before this dashboard ever saw the key unused.
    expect(followLink({ keyId: 'k1', listed: false }, [phone]))
      .toEqual({ keyId: 'k1', listed: true, state: 'linked', browser: phone })
  })

  it('ignores other browsers being used, linked or revoked', () => {
    const watch = { keyId: 'k1', listed: true }
    expect(followLink(watch, [browser('k1'), browser('k2', '2026-10-02T10:01:00.000Z')]).state).toBe('waiting')
    expect(followLink(watch, [browser('k1')]).state).toBe('waiting')
    expect(followLink(watch, [browser('k10', '2026-10-02T10:01:00.000Z'), browser('k1')]).state).toBe('waiting')
  })

  it('has expired once its key leaves the list unused', () => {
    expect(followLink({ keyId: 'k1', listed: true }, [browser('k2')])).toEqual({ keyId: 'k1', listed: true, state: 'expired' })
    expect(followLink({ keyId: 'k1', listed: true }, [])).toEqual({ keyId: 'k1', listed: true, state: 'expired' })
  })

  it('only reports linked for a list holding its key with a last use, whatever else the list holds', () => {
    const keyIds = fc.constantFrom('k1', 'k2', 'k3', 'K1', 'k1 ')
    const entry = fc.record({ keyId: keyIds, lastSeenAt: fc.option(fc.constant('2026-10-02T10:01:00.000Z')) })
      .map(({ keyId, lastSeenAt }) => browser(keyId, lastSeenAt))
    fc.assert(fc.property(fc.boolean(), fc.array(entry, { maxLength: 6 }), (listed, browsers) => {
      const next = followLink({ keyId: 'k1', listed }, browsers)
      const mine = browsers.find(b => b.keyId === 'k1')
      expect(next.keyId).toBe('k1')
      expect(next.state === 'linked').toBe(mine?.lastSeenAt != null)
      expect(next.state === 'expired').toBe(listed && !mine)
      // Once seen, a link stays seen.
      expect(next.listed).toBe(listed || mine !== undefined)
    }))
  })
})
