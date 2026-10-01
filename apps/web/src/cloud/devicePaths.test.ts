import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { deviceIdPath, devicePath, samePageOn } from './devicePaths.ts'

const on = (pathname: string, search: string, from: string, to: string) => samePageOn(pathname, search, devicePath(from), devicePath(to))

describe('device addresses', () => {
  test('name a device by its name, or by its id under /d/', () => {
    expect(devicePath('MacBook-Pro')).toBe('/MacBook-Pro')
    expect(deviceIdPath('d_5qCHTcgbQwpvYZQ9c')).toBe('/d/d_5qCHTcgbQwpvYZQ9c')
  })
})

describe('the same page on another device', () => {
  test('keeps the page and its query', () => {
    expect(on('/a/settings/agents', '?x=1', 'a', 'b')).toBe('/b/settings/agents?x=1')
    expect(on('/a/search/dragon', '?res=1080p', 'a', 'b')).toBe('/b/search/dragon?res=1080p')
  })

  test("the device's first page stays the first page", () => {
    expect(on('/a', '', 'a', 'b')).toBe('/b')
    expect(on('/a/', '', 'a', 'b')).toBe('/b')
    expect(on('/a', '?filter=paused', 'a', 'b')).toBe('/b')
  })

  test('names that need encoding, or share a prefix, are matched whole', () => {
    expect(on('/a%2Fb/search', '', 'a/b', 'c d')).toBe('/c%20d/search')
    expect(on('/ab/search', '?q=x', 'a', 'b')).toBe('/b')
  })

  test('a page of some other device opens the first page', () => {
    expect(on('/z/search', '?q=x', 'a', 'b')).toBe('/b')
    expect(on('/', '', 'a', 'b')).toBe('/b')
  })

  test('moves an address by id to the same page by name', () => {
    expect(samePageOn('/d/d_1/search/dragon', '?res=720p', deviceIdPath('d_1'), devicePath('Studio-Mac'))).toBe('/Studio-Mac/search/dragon?res=720p')
    expect(samePageOn('/d/d_1', '', deviceIdPath('d_1'), devicePath('Studio-Mac'))).toBe('/Studio-Mac')
  })

  test('always lands on the chosen device, for any names and page', () => {
    const name = fc.string({ minLength: 1, maxLength: 30 })
    const segment = fc.stringMatching(/^[a-z0-9-]{1,12}$/)
    fc.assert(fc.property(name, name, fc.array(segment, { maxLength: 3 }), (from, to, page) => {
      const path = `${devicePath(from)}${page.map(p => `/${p}`).join('')}`
      const moved = on(path, '?q=1', from, to)
      expect(moved.startsWith(devicePath(to))).toBe(true)
      expect(moved).toBe(page.length ? `${devicePath(to)}/${page.join('/')}?q=1` : devicePath(to))
    }))
  })
})
