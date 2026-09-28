import { useCallback, useEffect, useState } from 'react'

function current(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'mddark' ? 'dark' : 'light'
}

/** Light/dark switch, remembered per browser; public/theme.js applies it before first paint. */
export function useTheme(): ['dark' | 'light', () => void] {
  const [theme, setTheme] = useState(current)
  useEffect(() => {
    // Follow the system while the user hasn't chosen.
    const media = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      let saved: string | null = null
      try {
        saved = localStorage.getItem('md-theme')
      } catch {
        // storage unavailable
      }
      if (saved) return
      document.documentElement.setAttribute('data-theme', media.matches ? 'mddark' : 'mdlight')
      setTheme(current())
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  const toggle = useCallback(() => {
    const next = current() === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next === 'dark' ? 'mddark' : 'mdlight')
    try {
      localStorage.setItem('md-theme', next)
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
    setTheme(next)
  }, [])
  return [theme, toggle]
}
