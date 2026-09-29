import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = import.meta.dir
const src = join(dir, '..')
const load = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as { name: string; strings: Record<string, string> }
const catalogs = Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.json')).map(f => [f.slice(0, 2), load(f)]))
const english = catalogs.en!.strings

function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [readFileSync(path, 'utf8')] : []
  })
}

describe('translation catalogs', () => {
  test('every language has exactly the English keys', () => {
    for (const [language, catalog] of Object.entries(catalogs)) {
      const keys = Object.keys(catalog.strings)
      expect({ language, missing: Object.keys(english).filter(k => !(k in catalog.strings)) }).toEqual({ language, missing: [] })
      expect({ language, extra: keys.filter(k => !(k in english)) }).toEqual({ language, extra: [] })
    }
  })

  test('every language keeps the {n} placeholders of the English text', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort().join(',')
    for (const [language, catalog] of Object.entries(catalogs)) {
      for (const [key, text] of Object.entries(catalog.strings)) {
        expect({ language, key, placeholders: placeholders(text) }).toEqual({ language, key, placeholders: placeholders(english[key] ?? '') })
      }
    }
  })

  test("every key the code asks for by name exists", () => {
    const used = new Set(sources(src).flatMap(code => [...code.matchAll(/\bt\(\s*'([\w.]+)'/g)].map(m => m[1]!)))
    expect([...used].filter(key => !(key in english))).toEqual([])
  })
})
