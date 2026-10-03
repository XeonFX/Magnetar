import type { FolderEntryDto } from '@magnetar/protocol'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { appendPage, baseName, crumbs, isWithin, joinPath, samePath, type Separator } from './folderPaths.ts'

/** Names a folder can have on either system: anything but the separators. */
const name = fc.string({ minLength: 1, maxLength: 12, unit: 'grapheme' }).filter(n => !/[\\/]/.test(n))
const roots: [string, Separator][] = [['/', '/'], ['/Users/me/Downloads', '/'], ['C:\\', '\\'], ['D:\\Media', '\\'], ['\\\\nas\\share', '\\']]
const root = fc.constantFrom(...roots)

describe('paths on the device', () => {
  test('a folder joined to a name has one separator between, also after a root', () => {
    expect(joinPath('/', 'Users', '/')).toBe('/Users')
    expect(joinPath('/Users', 'me', '/')).toBe('/Users/me')
    expect(joinPath('C:\\', 'Media', '\\')).toBe('C:\\Media')
    expect(joinPath('\\\\nas\\share', 'TV', '\\')).toBe('\\\\nas\\share\\TV')
  })

  test('the breadcrumb leads from the root to the folder, one name at a time', () => {
    expect(crumbs('/Users/me/Downloads', '/Users/me/Downloads/Show S01/Extras', '/')).toEqual([
      { name: 'Downloads', path: '/Users/me/Downloads' },
      { name: 'Show S01', path: '/Users/me/Downloads/Show S01' },
      { name: 'Extras', path: '/Users/me/Downloads/Show S01/Extras' },
    ])
    expect(crumbs('C:\\', 'C:\\Media\\TV', '\\')).toEqual([
      { name: 'C:\\', path: 'C:\\' },
      { name: 'Media', path: 'C:\\Media' },
      { name: 'TV', path: 'C:\\Media\\TV' },
    ])
    expect(crumbs('/', '/', '/')).toEqual([{ name: '/', path: '/' }])
    // Never a crumb outside the root, whatever is asked: a sibling that starts with its name is outside.
    expect(crumbs('/Users/me/Downloads', '/Users/me/Downloads-old/x', '/')).toEqual([{ name: 'Downloads', path: '/Users/me/Downloads' }])
    expect(crumbs('/Users/me/Downloads', '/etc', '/')).toHaveLength(1)
  })

  test('a folder is within itself and below, never beside', () => {
    expect(isWithin('/a/dl', '/a/dl', '/')).toBe(true)
    expect(isWithin('/a/dl/', '/a/dl', '/')).toBe(true)
    expect(isWithin('/a/dl/x', '/a/dl/', '/')).toBe(true)
    expect(isWithin('/a/dl-old', '/a/dl', '/')).toBe(false)
    expect(isWithin('/a', '/a/dl', '/')).toBe(false)
    expect(isWithin('/anything', '/', '/')).toBe(true)
    expect(isWithin('C:\\Media\\TV', 'C:\\', '\\')).toBe(true)
    expect(samePath('/a/dl/', '/a/dl', '/')).toBe(true)
    expect(samePath('/a/dl', '/a/dl/x', '/')).toBe(false)
    expect(samePath('/', '/', '/')).toBe(true)
  })

  test('every path below a root splits back into its names, each crumb inside the one before', () => {
    fc.assert(fc.property(root, fc.array(name, { maxLength: 6 }), ([top, separator], names) => {
      const path = names.reduce((folder, n) => joinPath(folder, n, separator), top)
      const trail = crumbs(top, path, separator)
      expect(trail.map(c => c.name)).toEqual([baseName(top, separator), ...names])
      expect(trail.at(-1)!.path).toBe(path)
      trail.slice(1).forEach((crumb, i) => {
        expect(isWithin(crumb.path, trail[i]!.path, separator)).toBe(true)
        expect(baseName(crumb.path, separator)).toBe(crumb.name)
      })
      expect(crumbs(top, top, separator)).toHaveLength(1)
    }))
  })

  test('the next page adds only what is not shown yet, in its order', () => {
    const entry = (n: string): FolderEntryDto => ({ name: n, kind: 'file', size: 1, modified: null, media: null, download: null })
    const shown = [entry('a'), entry('b')]
    expect(appendPage(shown, [entry('b'), entry('c'), entry('d')]).map(e => e.name)).toEqual(['a', 'b', 'c', 'd'])
    expect(appendPage(shown, [entry('a')])).toBe(shown)
    expect(appendPage([], [])).toEqual([])
    fc.assert(fc.property(fc.uniqueArray(name), fc.array(name), (first, next) => {
      const merged = appendPage(first.map(entry), next.map(entry)).map(e => e.name)
      expect(new Set(merged).size).toBe(merged.length)
      expect(merged.slice(0, first.length)).toEqual(first)
      expect(new Set(merged)).toEqual(new Set([...first, ...next]))
    }))
  })
})
