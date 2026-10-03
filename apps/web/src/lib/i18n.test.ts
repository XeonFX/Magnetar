import { describe, expect, test, vi } from 'vitest'
import { claimDocumentLanguage, loadCatalog } from './i18n.tsx'

/** The parts of a document `<html lang>` lives in. */
const page = () => ({ documentElement: { lang: 'en', dir: 'ltr' } }) as unknown as Document

describe('the document language', () => {
  test('is the language of the innermost translated part on screen, and goes back as parts leave', () => {
    const doc = page()
    const site = claimDocumentLanguage(0, 'fr', doc)
    expect(doc.documentElement.lang).toBe('fr')
    // A device's pages in its own language, inside the website's.
    const device = claimDocumentLanguage(1, 'pl', doc)
    expect(doc.documentElement.lang).toBe('pl')
    device()
    expect(doc.documentElement.lang).toBe('fr')
    site()
    expect(doc.documentElement.lang).toBe('en')
  })

  test('an inner part that mounts first still wins over the outer one mounting after it', () => {
    // React runs a child's effects before its parent's.
    const doc = page()
    const device = claimDocumentLanguage(1, 'de', doc)
    const site = claimDocumentLanguage(0, 'en', doc)
    expect(doc.documentElement.lang).toBe('de')
    device()
    site()
  })

  test('of two parts at the same depth, the newer one wins until it leaves', () => {
    const doc = page()
    const old = claimDocumentLanguage(1, 'es', doc)
    const fresh = claimDocumentLanguage(1, 'it', doc)
    expect(doc.documentElement.lang).toBe('it')
    fresh()
    expect(doc.documentElement.lang).toBe('es')
    old()
  })

  test('releasing twice releases once', () => {
    const doc = page()
    const outer = claimDocumentLanguage(0, 'ru', doc)
    const inner = claimDocumentLanguage(1, 'pt', doc)
    const again = claimDocumentLanguage(1, 'pt', doc)
    inner()
    inner()
    expect(doc.documentElement.lang).toBe('pt')
    again()
    expect(doc.documentElement.lang).toBe('ru')
    outer()
  })
})

describe('loading a catalog', () => {
  test('a catalog that loads is shown in its language', async () => {
    const shown = await loadCatalog('de', async () => ({ name: 'Deutsch', strings: { 'common.close': 'Schließen' } }))
    expect(shown).toEqual({ language: 'de', strings: { 'common.close': 'Schließen' } })
  })

  test('a catalog that fails to load shows English, says so in its language, and is tried again next time', async () => {
    const load = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce({ name: 'Polski', strings: { 'common.close': 'Zamknij' } })
    const first = await loadCatalog('pl', load)
    expect(first.language).toBe('en')
    expect(first.strings['common.close']).toBe('Close')
    expect((await loadCatalog('pl', load)).language).toBe('pl')
    expect(load).toHaveBeenCalledTimes(2)
  })

  test('English needs no loading, and a language without a catalog is English', async () => {
    expect((await loadCatalog('en')).language).toBe('en')
    expect((await loadCatalog('xx')).language).toBe('en')
  })
})
