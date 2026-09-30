import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

/** public/sw.js is a plain script; run it against a stand-in `self` and take what it defines. */
function loadServiceWorker(origin: string): { sameSitePath: (url: unknown) => string } {
  const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')
  const self = { location: { origin }, addEventListener: () => {} }
  return new Function('self', `${source}\nreturn { sameSitePath }`)(self)
}

describe('service worker', () => {
  const { sameSitePath } = loadServiceWorker('https://magnetar.codefusion.cc')

  test('a notification opens the page on this site it names', () => {
    expect(sameSitePath('/d/abc/downloads?id=3#files')).toBe('/d/abc/downloads?id=3#files')
    expect(sameSitePath('https://magnetar.codefusion.cc/d/abc')).toBe('/d/abc')
  })

  test('anything leading to another site opens the start page instead', () => {
    for (const elsewhere of ['//evil.example/x', '/\\evil.example/x', 'https://evil.example/', 'javascript:alert(1)']) {
      expect(sameSitePath(elsewhere)).toBe('/')
    }
    expect(sameSitePath(undefined)).toBe('/')
    expect(sameSitePath(42)).toBe('/')
  })
})
