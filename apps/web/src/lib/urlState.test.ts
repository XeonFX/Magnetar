import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { pathChoice, pickParam, readSearch, searchAddress, searchKey, searchTextFrom, searchTextSegment, withParam, type SearchChoices, type SearchView } from './urlState.ts'

type Resolution = '' | '720p' | '1080p' | '2160p'
type Sort = 'seeders' | 'newest' | 'largest' | 'smallest'
const SOURCES = [{ id: 'tpb', name: 'The Pirate Bay' }, { id: 'nyaa', name: 'Nyaa' }, { id: '1337x', name: '1337x' }]
const CHOICES: SearchChoices<Resolution, Sort> = {
  resolutions: ['', '720p', '1080p', '2160p'],
  sorts: [['seeders', 'seeders'], ['newest', 'new'], ['largest', 'large'], ['smallest', 'small']],
  sources: SOURCES,
}
/** Reads an address the way the search page does: the path after /search/ and the query string. */
const read = (address: string, choices = CHOICES) => {
  const url = new URL(address, 'https://x.example')
  return readSearch(url.pathname.replace(/^\/search\/?/, ''), url.searchParams, choices)
}

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
  test('reads the text from the path and every choice from the query', () => {
    expect(read('/search/house+of+the+dragon?res=720p&source=tpb&sort=new'))
      .toEqual({ query: 'house of the dragon', resolution: '720p', source: 'tpb', sort: 'newest' })
    expect(read('/search/dragon')).toEqual({ query: 'dragon', resolution: '', source: '', sort: 'seeders' })
    expect(read('/search')).toEqual({ query: '', resolution: '', source: '', sort: 'seeders' })
  })

  test('reads older addresses the same', () => {
    expect(read('/search?q=dragon&res=720p&source=The+Pirate+Bay&sort=newest'))
      .toEqual({ query: 'dragon', resolution: '720p', source: 'tpb', sort: 'newest' })
    expect(read('/search?q=%20dragon%20&source=nyaa&sort=largest')).toEqual({ query: 'dragon', resolution: '', source: 'nyaa', sort: 'largest' })
    // The path wins over a stray q.
    expect(read('/search/dragon?q=other').query).toBe('dragon')
  })

  test('falls back on choices it does not know', () => {
    expect(read('/search/x?res=8K&sort=random&source=nope')).toEqual({ query: 'x', resolution: '', source: '', sort: 'seeders' })
    expect(read('/search/x?source=TPB&sort=NEW')).toMatchObject({ source: 'tpb', sort: 'seeders' })
  })

  test('keeps a source as written until the device has said which it has', () => {
    const loading = { ...CHOICES, sources: [] }
    expect(read('/search/x?source=The+Pirate+Bay', loading).source).toBe('The Pirate Bay')
    expect(read('/search/x?source=tpb', loading).source).toBe('tpb')
  })

  test('writes a short address: the defaults stay out', () => {
    expect(searchAddress({ query: 'dragon', resolution: '', source: '', sort: 'seeders' }, CHOICES)).toBe('/search/dragon')
    expect(searchAddress({ query: '', resolution: '', source: '', sort: 'seeders' }, CHOICES)).toBe('/search')
    expect(searchAddress({ query: '', resolution: '1080p', source: '', sort: 'seeders' }, CHOICES)).toBe('/search?res=1080p')
    expect(searchAddress({ query: 'dragon', resolution: '720p', source: 'tpb', sort: 'newest' }, CHOICES)).toBe('/search/dragon?res=720p&source=tpb&sort=new')
  })

  test('spells text readably in the path, and anything else safely', () => {
    expect(searchTextSegment('house of the dragon')).toBe('house+of+the+dragon')
    expect(searchTextSegment('C++ & Rust: 2024, vol=1')).toBe('C%2B%2B+&+Rust:+2024,+vol=1')
    expect(searchTextSegment('AC/DC? #1 100%')).toBe('AC%2FDC%3F+%231+100%25')
    expect(searchTextSegment('Łódź')).toBe('%C5%81%C3%B3d%C5%BA')
    expect(searchTextSegment('half \uD83D')).toBe('half+%EF%BF%BD')
    expect(searchTextFrom('C%2B%2B+&+Rust:+2024,+vol=1')).toBe('C++ & Rust: 2024, vol=1')
    // A broken escape is read as it is rather than failing the page.
    expect(searchTextFrom('100%+off')).toBe('100% off')
    expect(searchTextFrom('%E0%A4%A')).toBe('%E0%A4%A')
  })

  test('text of only dots survives the address bar, which drops a . or .. path segment however it is spelled', () => {
    // What a browser makes of these paths: %2E is a dot to the URL standard too, and .. even leaves the search page.
    expect(['/search/.', '/search/%2E', '/search/..', '/search/.%2e'].map(path => new URL(path, 'https://x.example').pathname)).toEqual(['/search/', '/search/', '/', '/'])
    for (const query of ['.', '..']) {
      const address = searchAddress({ query, resolution: '', source: '', sort: 'seeders' }, CHOICES)
      expect(address).toBe(`/search?q=${query}`)
      expect(read(address).query).toBe(query)
    }
    expect(searchAddress({ query: '..', resolution: '720p', source: 'tpb', sort: 'newest' }, CHOICES)).toBe('/search?q=..&res=720p&source=tpb&sort=new')
    expect(read('/search?q=..&res=720p&source=tpb&sort=new')).toEqual({ query: '..', resolution: '720p', source: 'tpb', sort: 'newest' })
    // Three dots or more, or dots among other text, are an ordinary segment.
    expect(searchAddress({ query: '...', resolution: '', source: '', sort: 'seeders' }, CHOICES)).toBe('/search/...')
    expect(read('/search/...').query).toBe('...')
    expect(searchAddress({ query: '. .', resolution: '', source: '', sort: 'seeders' }, CHOICES)).toBe('/search/.+.')
    expect(read('/search/.+.').query).toBe('. .')
  })

  test('an address whose text trims down to dots, or to nothing, settles after one move', () => {
    // Found by the property below (seed 1489426516): the trimmed ". " was written as /search/., which reads as no search.
    const settles = (address: string, to: string) => {
      const once = searchAddress(read(address), CHOICES)
      expect([once, searchAddress(read(once), CHOICES)], address).toEqual([to, to])
    }
    settles('/search/.%20?', '/search?q=.')
    settles('/search/+..+?res=720p', '/search?q=..&res=720p')
    settles('/search/%20.%20.%20', '/search/.+.')
    // Text that trims to nothing is no search, and the path still wins over a q.
    settles('/search/+%20+', '/search')
    settles('/search/%20?q=dragon&sort=new', '/search?sort=new')
  })

  test('sorting does not make it another search; a query, resolution or source does', () => {
    const base: SearchView = { query: 'dragon', resolution: '', source: '', sort: 'seeders' }
    expect(searchKey({ ...base, sort: 'newest' })).toBe(searchKey(base))
    expect(searchKey({ ...base, resolution: '1080p' })).not.toBe(searchKey(base))
    expect(searchKey({ ...base, source: 'nyaa' })).not.toBe(searchKey(base))
    expect(searchKey({ ...base, query: 'dragons' })).not.toBe(searchKey(base))
    expect(searchKey({ ...base, query: '' })).toBeNull()
    // Fields can't run into each other.
    expect(searchKey({ ...base, query: 'a 1080p', resolution: '' })).not.toBe(searchKey({ ...base, query: 'a', resolution: '1080p' }))
  })

  /** Text of dots and spaces, which a path segment can lose to the URL standard's . and .. segments. */
  const dotty = fc.string({ unit: fc.constantFrom('.', ' '), maxLength: 5 })
  const view = fc.record({
    query: fc.oneof(fc.string({ unit: 'binary', maxLength: 120 }), dotty).map(s => s.trim()),
    resolution: fc.constantFrom(...CHOICES.resolutions),
    source: fc.constantFrom('', ...SOURCES.map(s => s.id)),
    sort: fc.constantFrom(...CHOICES.sorts.map(([value]) => value)),
  })

  test('what is written reads back the same, for any text', () => {
    fc.assert(fc.property(view, v => {
      expect(read(searchAddress(v, CHOICES))).toEqual(v)
    }))
  })

  test('an address written from what was read is written the same again, so it is never moved twice', () => {
    const address = fc.oneof(
      view.map(v => searchAddress(v, CHOICES)),
      fc.tuple(fc.string({ maxLength: 30 }), fc.string({ maxLength: 20 })).map(([path, query]) => `/search/${encodeURIComponent(path)}?${query}`),
      // Paths as typed, with every spelling of a dot and a space.
      fc.tuple(fc.string({ unit: fc.constantFrom('.', '%2E', '%2e', '+', '%20', 'a', '/'), maxLength: 6 }), fc.constantFrom('', 'q=..', 'q=dragon', 'res=720p'))
        .map(([path, query]) => `/search/${path}?${query}`),
    )
    fc.assert(fc.property(address, a => {
      const once = searchAddress(read(a), CHOICES)
      expect(searchAddress(read(once), CHOICES)).toBe(once)
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
