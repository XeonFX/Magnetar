import { useEffect, useRef } from 'react'
import { useT } from '../lib/i18n.tsx'

/** Rows rendered at first, and added each time the end of a long list comes into view. */
export const PAGE_SIZE = 50

/** Loads the next rows as the end of the list comes into view, with a button for keyboards. */
export function ShowMore({ remaining, onMore }: { remaining: number; onMore: () => void }) {
  const t = useT()
  const ref = useRef<HTMLButtonElement>(null)
  const more = useRef(onMore)
  more.current = onMore
  useEffect(() => {
    const button = ref.current
    if (!button || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) more.current() }, { rootMargin: '400px' })
    observer.observe(button)
    return () => observer.disconnect()
  }, [remaining])
  return <button ref={ref} type="button" className="btn btn-ghost btn-block mt-3" onClick={onMore}>{t('search.showMore', remaining)}</button>
}
