import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { devicePath, samePageOn } from './devicePaths.ts'

describe('the same page on another device', () => {
  test('keeps the page and its query', () => {
    expect(samePageOn('/d/a/settings/agents', '?x=1', 'a', 'b')).toBe('/d/b/settings/agents?x=1')
    expect(samePageOn('/d/a/search', '?q=dragon&res=1080p', 'a', 'b')).toBe('/d/b/search?q=dragon&res=1080p')
  })

  test("the device's first page stays the first page", () => {
    expect(samePageOn('/d/a', '', 'a', 'b')).toBe('/d/b')
    expect(samePageOn('/d/a/', '', 'a', 'b')).toBe('/d/b')
    expect(samePageOn('/d/a', '?filter=paused', 'a', 'b')).toBe('/d/b')
  })

  test('ids that need encoding, or share a prefix, are matched whole', () => {
    expect(samePageOn('/d/a%2Fb/search', '', 'a/b', 'c d')).toBe('/d/c%20d/search')
    expect(samePageOn('/d/ab/search', '?q=x', 'a', 'b')).toBe('/d/b')
  })

  test('a page of some other device opens the first page', () => {
    expect(samePageOn('/d/z/search', '?q=x', 'a', 'b')).toBe('/d/b')
    expect(samePageOn('/', '', 'a', 'b')).toBe('/d/b')
  })

  test('always lands on the chosen device, for any ids and page', () => {
    const id = fc.string({ minLength: 1, maxLength: 30 })
    const segment = fc.stringMatching(/^[a-z0-9-]{1,12}$/)
    fc.assert(fc.property(id, id, fc.array(segment, { maxLength: 3 }), (from, to, page) => {
      const path = `${devicePath(from)}${page.map(p => `/${p}`).join('')}`
      const moved = samePageOn(path, '?q=1', from, to)
      expect(moved.startsWith(devicePath(to))).toBe(true)
      expect(moved).toBe(page.length ? `${devicePath(to)}/${page.join('/')}?q=1` : devicePath(to))
    }))
  })
})
