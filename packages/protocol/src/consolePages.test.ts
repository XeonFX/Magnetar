import { expect, test } from 'vitest'
import { consolePage } from './consolePages.ts'

test('names the screen a path shows, never the device in it', () => {
  expect(consolePage('/')).toBe('devices')
  expect(consolePage('')).toBe('devices')
  for (const page of ['about', 'login', 'pair', 'link', 'add', 'features'] as const) expect(consolePage(`/${page}`)).toBe(page)
  expect(consolePage('/pair/abc')).toBe('pair')
  expect(consolePage('/features/pl')).toBe('features')
  expect(consolePage('/MacBook-Pro')).toBe('device-downloads')
  expect(consolePage('/MacBook-Pro/')).toBe('device-downloads')
  expect(consolePage('/MacBook-Pro/search/dragon')).toBe('device-search')
  expect(consolePage('/MacBook-Pro/series/releases')).toBe('device-series')
  expect(consolePage('/MacBook-Pro/settings/agents')).toBe('device-settings')
  expect(consolePage('/MacBook-Pro/nope')).toBe('device-downloads')
  // Addresses by id, before they move to the name.
  expect(consolePage('/d/d_123/search')).toBe('device-search')
  expect(consolePage('/d/d_123')).toBe('device-downloads')
  // A device named like a tab is still a device.
  expect(consolePage('/search-box/settings')).toBe('device-settings')
})
