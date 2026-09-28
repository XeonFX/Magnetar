import { useMemo, useState } from 'react'

/**
 * Click-to-sort table columns. `accessors` maps each column key to the value it sorts by; clicking
 * the active column flips the direction.
 */
export function useSort<T, K extends string>(rows: T[], accessors: Record<K, (row: T) => string | number>, initial: { key: NoInfer<K>; desc: boolean } | null = null) {
  const [sort, setSort] = useState(initial)
  const sorted = useMemo(() => {
    if (!sort) return rows
    const value = accessors[sort.key]
    return [...rows].sort((a, b) => {
      const [x, y] = [value(a), value(b)]
      const order = x < y ? -1 : x > y ? 1 : 0
      return sort.desc ? -order : order
    })
    // Accessors are recreated each render but only read the row; the sort depends on rows and key.
  }, [rows, sort])

  const header = (key: K, label: string, className = '', firstDesc = false) => (
    <th className={className} aria-sort={sort?.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      <button type="button" className="inline-flex items-center gap-1 font-semibold"
        onClick={() => setSort(s => (s?.key === key ? { key, desc: !s.desc } : { key, desc: firstDesc }))}>
        {label}{sort?.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  )
  return { sorted, header }
}
