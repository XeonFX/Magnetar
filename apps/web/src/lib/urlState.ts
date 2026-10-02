import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

/**
 * Page state kept in the address bar, so a reload, a bookmark, a shared link or Back brings it
 * back. A value equal to its default is left out, keeping links short.
 */

/** `params` with `name` set to `value`, or without it when `value` is the default. */
export function withParam(params: URLSearchParams, name: string, value: string, fallback = ''): URLSearchParams {
  const next = new URLSearchParams(params)
  if (value === fallback) next.delete(name)
  else next.set(name, value)
  return next
}

/** The parameter when it is one of `allowed`, else `fallback`. */
export function pickParam<T extends string>(params: URLSearchParams, name: string, allowed: readonly T[], fallback: T): T {
  const value = params.get(name)
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** One choice kept in the query string: `[value, setValue]`, like useState. Changes replace the history entry. */
export function useQueryChoice<T extends string>(name: string, allowed: readonly T[], fallback: T): [T, (value: T) => void] {
  const [params, setParams] = useSearchParams()
  const value = pickParam(params, name, allowed, fallback)
  const set = useCallback((next: T) => setParams(current => withParam(current, name, next, fallback), { replace: true }), [name, fallback, setParams])
  return [value, set]
}

/**
 * A choice kept as the last part of the path (/settings/agents), the first of `allowed` being the
 * bare path. Returns the choice, and where to send the browser instead when the address isn't the
 * proper one: an older link naming it in the query (?section=agents), an unknown choice, or the
 * first one spelled out.
 */
export function pathChoice<T extends string>(segment: string | undefined, params: URLSearchParams, allowed: readonly [T, ...T[]], legacyParam: string): { value: T; redirect: T | null } {
  const first = allowed[0]
  if (segment === undefined) {
    const legacy = params.get(legacyParam)
    return { value: first, redirect: legacy === null ? null : (allowed.find(v => v === legacy) ?? first) }
  }
  const known = allowed.find(v => v === segment)
  return known && known !== first ? { value: known, redirect: null } : { value: first, redirect: first }
}

export function usePathChoice<T extends string>(segment: string | undefined, allowed: readonly [T, ...T[]], legacyParam: string): { value: T; redirect: T | null } {
  const [params] = useSearchParams()
  return pathChoice(segment, params, allowed, legacyParam)
}

/** A search as the address holds it: `/search/house+of+the+dragon?res=720p&source=tpb&sort=new`. */
export interface SearchView<R extends string = string, S extends string = string> {
  query: string
  resolution: R
  /** A source's id, or '' for all of them. */
  source: string
  sort: S
}

/** What a search address may name, each list's first entry being the default that addresses leave out. */
export interface SearchChoices<R extends string, S extends string> {
  resolutions: readonly [R, ...R[]]
  /** Each sort and the word an address spells it with (`newest` → `new`). */
  sorts: readonly [readonly [S, string], ...(readonly [S, string])[]]
  /** The device's sources, still empty while they load: an address names one by id, older ones by name. */
  sources: readonly { id: string; name: string }[]
}

/** Characters a path segment may hold as they are, which encodeURIComponent escapes anyway. */
const READABLE = /%(3A|40|2C|24|26|3B|3D)/g

/** Search text as a path segment: words joined by `+`, a real plus as `%2B`, anything else percent-encoded. */
export function searchTextSegment(text: string): string {
  // A lone surrogate (half an emoji) has no UTF-8 spelling and would make encodeURIComponent throw.
  return encodeURIComponent(text.replace(/\p{Cs}/gu, '\uFFFD')).replace(/%20/g, '+').replace(READABLE, escaped => decodeURIComponent(escaped))
}

/** The text a path segment spells; a malformed escape is read as it is. */
export function searchTextFrom(segment: string): string {
  return segment.split('+').map(part => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  }).join(' ')
}

/**
 * Reads a search from what follows `/search/` in the path (as the address bar has it, still encoded) and the
 * query string, whose `q` holds the text when the path has none: text of only dots, and older addresses
 * (`?q=dragon&source=The+Pirate+Bay&sort=newest`). Unknown choices fall back to the defaults. A source stays as
 * written until the device's sources are known.
 */
export function readSearch<R extends string, S extends string>(segment: string, params: URLSearchParams, choices: SearchChoices<R, S>): SearchView<R, S> {
  const sortWord = params.get('sort')
  const sort = choices.sorts.find(([value, word]) => sortWord === word || sortWord === value) ?? choices.sorts[0]
  const source = (params.get('source') ?? '').trim()
  const known = choices.sources.find(s => s.id.toLowerCase() === source.toLowerCase() || s.name.toLowerCase() === source.toLowerCase())
  return {
    query: (segment ? searchTextFrom(segment) : params.get('q') ?? '').trim(),
    resolution: pickParam(params, 'res', choices.resolutions, choices.resolutions[0]),
    source: known ? known.id : choices.sources.length ? '' : source,
    sort: sort[0],
  }
}

/**
 * Text a path segment can't hold: browsers and URL parsers drop a `.` segment and climb out of the page at `..`,
 * spelled `%2E` or not.
 */
const DOT_SEGMENT = /^\.\.?$/

/**
 * The address of a search, from `/search` on: the text in the path, choices other than the defaults after it.
 * Text that is a dot segment (`.` or `..`) goes in the query instead (`/search?q=..`).
 */
export function searchAddress<R extends string, S extends string>(view: SearchView<R, S>, choices: SearchChoices<R, S>): string {
  const query = view.query.trim()
  const inPath = query !== '' && !DOT_SEGMENT.test(query)
  const params = new URLSearchParams()
  if (query && !inPath) params.set('q', query)
  if (view.resolution !== choices.resolutions[0]) params.set('res', view.resolution)
  if (view.source) params.set('source', view.source)
  const sort = choices.sorts.find(([value]) => value === view.sort)
  if (sort && sort !== choices.sorts[0]) params.set('sort', sort[1])
  const search = params.toString()
  return `/search${inPath ? `/${searchTextSegment(query)}` : ''}${search ? `?${search}` : ''}`
}

/** What makes two searches the same search: sorting is done here, so it isn't part of it. Null without a query. */
export function searchKey(view: SearchView): string | null {
  return view.query ? JSON.stringify([view.query, view.resolution, view.source]) : null
}
