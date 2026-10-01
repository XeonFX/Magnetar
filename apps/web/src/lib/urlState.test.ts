import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { pathChoice, pickParam, readSearch, searchKey, withParam, writeSearch, type SearchView } from './urlState.ts'

const RESOLUTIONS = ['', '720p', '1080p', '2160p'] as const
const SORTS = ['seeders', 'newest', 'largest', 'smallest'] as const

describe('query parameters', () => {
  test('a default value is left out, anything else is set, and other parameters are kept', () => {
    const params = new URLSearchParams('q=dragon&filter=active')
    expect(withParam(params, 'filter', 'all', 'all').toString()).toBe('q=dragon')
    expect(withParam(params, 'filter', 'failed', 'all').toString()).toBe('q=dragon&filter=failed')
    expect(withParam(params, 'sort', '', '').toString()).toBe('q=dragon&filter=active')
    // The original is not changed.
    expect(params.toString()).toBe('q=dragon&filter=active')
  })

  test('only an allowed value is taken', () => {
    const allowed = ['all', 'active', 'failed'] as const
    expect(pickParam(new URLSearchParams('filter=failed'), 'filter', allowed, 'all')).toBe('failed')
    expect(pickParam(new URLSearchParams('filter=FAILED'), 'filter', allowed, 'all')).toBe('all')
    expect(pickParam(new URLSearchParams('filter=constructor'), 'filter', allowed, 'all')).toBe('all')
    expect(pickParam(new URLSearchParams(''), 'filter', allowed, 'all')).toBe('all')
    expect(pickParam(new URLSearchParams('filter='), 'filter', allowed, 'all')).toBe('all')
  })
})

describe('a search in the address bar', () => {
  test('reads every choice, and falls back on ones it does not know', () => {
    expect(readSearch(new URLSearchParams('q=%20dragon%20&res=1080p&source=Nyaa&sort=newest'), RESOLUTIONS, SORTS))
      .toEqual({ query: 'dragon', resolution: '1080p', source: 'Nyaa', sort: 'newest' })
    expect(readSearch(new URLSearchParams('q=x&res=8K&sort=random'), RESOLUTIONS, SORTS))
      .toEqual({ query: 'x', resolution: '', source: '', sort: 'seeders' })
    expect(readSearch(new URLSearchParams(''), RESOLUTIONS, SORTS)).toEqual({ query: '', resolution: '', source: '', sort: 'seeders' })
  })

  test('writes a short link: the defaults stay out', () => {
    expect(writeSearch({ query: 'dragon', resolution: '', source: '', sort: 'seeders' }, RESOLUTIONS, SORTS).toString()).toBe('q=dragon')
    expect(writeSearch({ query: 'Łódź & co?', resolution: '2160p', source: 'The Pirate Bay', sort: 'smallest' }, RESOLUTIONS, SORTS).toString())
      .toBe('q=%C5%81%C3%B3d%C5%BA+%26+co%3F&res=2160p&source=The+Pirate+Bay&sort=smallest')
  })

  test('sorting does not make it another search; a query, resolution or source does', () => {
    const base: SearchView = { query: 'dragon', resolution: '', source: '', sort: 'seeders' }
    expect(searchKey({ ...base, sort: 'newest' })).toBe(searchKey(base))
    expect(searchKey({ ...base, resolution: '1080p' })).not.toBe(searchKey(base))
    expect(searchKey({ ...base, source: 'Nyaa' })).not.toBe(searchKey(base))
    expect(searchKey({ ...base, query: 'dragons' })).not.toBe(searchKey(base))
    expect(searchKey({ ...base, query: '' })).toBeNull()
    // Fields can't run into each other.
    expect(searchKey({ ...base, query: 'a 1080p', resolution: '' })).not.toBe(searchKey({ ...base, query: 'a', resolution: '1080p' }))
  })

  test('what is written reads back the same, for any text', () => {
    const view = fc.record({
      query: fc.string({ maxLength: 200 }).map(s => s.trim()),
      resolution: fc.constantFrom(...RESOLUTIONS),
      source: fc.string({ maxLength: 40 }).map(s => s.trim()),
      sort: fc.constantFrom(...SORTS),
    })
    fc.assert(fc.property(view, v => {
      const again = readSearch(new URLSearchParams(writeSearch(v, RESOLUTIONS, SORTS).toString()), RESOLUTIONS, SORTS)
      expect(again).toEqual(v)
      expect(searchKey(again)).toBe(searchKey(v))
    }))
  })
})

describe('a choice in the path', () => {
  const SECTIONS = ['general', 'downloads', 'agents'] as const
  const at = (segment: string | undefined, query = '') => pathChoice(segment, new URLSearchParams(query), SECTIONS, 'section')

  test('the bare path is the first choice, and a known segment is itself', () => {
    expect(at(undefined)).toEqual({ value: 'general', redirect: null })
    expect(at('agents')).toEqual({ value: 'agents', redirect: null })
  })

  test('older query links move to their path', () => {
    expect(at(undefined, 'section=agents')).toEqual({ value: 'general', redirect: 'agents' })
    expect(at(undefined, 'section=general')).toEqual({ value: 'general', redirect: 'general' })
    expect(at(undefined, 'section=nope')).toEqual({ value: 'general', redirect: 'general' })
    // Only the bare path reads the old parameter.
    expect(at('downloads', 'section=agents')).toEqual({ value: 'downloads', redirect: null })
  })

  test('an unknown segment, or the first one spelled out, goes to the bare path', () => {
    expect(at('nope')).toEqual({ value: 'general', redirect: 'general' })
    expect(at('general')).toEqual({ value: 'general', redirect: 'general' })
    expect(at('Agents')).toEqual({ value: 'general', redirect: 'general' })
    expect(at('')).toEqual({ value: 'general', redirect: 'general' })
  })
})
