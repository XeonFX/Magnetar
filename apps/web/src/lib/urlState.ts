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

/** A search as the address bar holds it: `/search?q=dragon&res=1080p&source=Nyaa&sort=newest`. */
export interface SearchView<R extends string = string, S extends string = string> {
  query: string
  resolution: R
  source: string
  sort: S
}

const SEARCH_PARAMS = { query: 'q', resolution: 'res', source: 'source', sort: 'sort' } as const

/** Reads a search; `resolutions[0]` and `sorts[0]` are the defaults. */
export function readSearch<R extends string, S extends string>(params: URLSearchParams, resolutions: readonly [R, ...R[]], sorts: readonly [S, ...S[]]): SearchView<R, S> {
  return {
    query: (params.get(SEARCH_PARAMS.query) ?? '').trim(),
    resolution: pickParam(params, SEARCH_PARAMS.resolution, resolutions, resolutions[0]),
    source: (params.get(SEARCH_PARAMS.source) ?? '').trim(),
    sort: pickParam(params, SEARCH_PARAMS.sort, sorts, sorts[0]),
  }
}

/** The query string for `view`, defaults left out. */
export function writeSearch<R extends string, S extends string>(view: SearchView<R, S>, resolutions: readonly [R, ...R[]], sorts: readonly [S, ...S[]]): URLSearchParams {
  const defaults = { query: '', resolution: resolutions[0], source: '', sort: sorts[0] }
  const params = new URLSearchParams()
  for (const field of ['query', 'resolution', 'source', 'sort'] as const) {
    const value = view[field].trim()
    if (value !== defaults[field]) params.set(SEARCH_PARAMS[field], value)
  }
  return params
}

/** What makes two searches the same search: sorting is done here, so it isn't part of it. Null without a query. */
export function searchKey(view: SearchView): string | null {
  return view.query ? JSON.stringify([view.query, view.resolution, view.source]) : null
}
