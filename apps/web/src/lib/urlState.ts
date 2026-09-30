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

/** A search as the address bar holds it: `/search?q=dragon&res=1080p&source=Nyaa&sort=newest`. */
export interface SearchView {
  query: string
  resolution: string
  source: string
  sort: string
}

export const SEARCH_PARAMS = { query: 'q', resolution: 'res', source: 'source', sort: 'sort' } as const

export function readSearch(params: URLSearchParams, resolutions: readonly string[], sorts: readonly string[]): SearchView {
  return {
    query: (params.get(SEARCH_PARAMS.query) ?? '').trim(),
    resolution: pickParam(params, SEARCH_PARAMS.resolution, resolutions, ''),
    source: (params.get(SEARCH_PARAMS.source) ?? '').trim(),
    sort: pickParam(params, SEARCH_PARAMS.sort, sorts, sorts[0] ?? ''),
  }
}

/** The query string for `view`, defaults left out; `sorts[0]` is the default sort. */
export function writeSearch(view: SearchView, sorts: readonly string[]): URLSearchParams {
  let params = new URLSearchParams()
  params = withParam(params, SEARCH_PARAMS.query, view.query.trim())
  params = withParam(params, SEARCH_PARAMS.resolution, view.resolution)
  params = withParam(params, SEARCH_PARAMS.source, view.source)
  params = withParam(params, SEARCH_PARAMS.sort, view.sort, sorts[0] ?? '')
  return params
}

/** What makes two searches the same search: sorting is done here, so it isn't part of it. Null without a query. */
export function searchKey(view: SearchView): string | null {
  return view.query ? JSON.stringify([view.query, view.resolution, view.source]) : null
}
