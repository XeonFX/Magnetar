import { useCallback, useEffect, useState } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

const KEY = 'magnetar-theme'
const CHANGED = 'magnetar-theme-changed'

function savedMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  } catch {
    return 'system'
  }
}

function apply(mode: ThemeMode): 'light' | 'dark' {
  const dark = mode === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : mode === 'dark'
  document.documentElement.setAttribute('data-theme', dark ? 'magnetar-dark' : 'magnetar-light')
  return dark ? 'dark' : 'light'
}

/**
 * Light, dark, or following the system; remembered per browser. public/theme.js applies it before
 * first paint. Returns the chosen mode, the theme in effect, and a setter.
 */
export function useTheme(): { mode: ThemeMode; theme: 'light' | 'dark'; setMode: (mode: ThemeMode) => void } {
  const [mode, setModeState] = useState(savedMode)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => apply(savedMode()))
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const sync = () => {
      setModeState(savedMode())
      setTheme(apply(savedMode()))
    }
    media.addEventListener('change', sync)
    // Another component on the page changed it.
    window.addEventListener(CHANGED, sync)
    return () => {
      media.removeEventListener('change', sync)
      window.removeEventListener(CHANGED, sync)
    }
  }, [])
  const setMode = useCallback((next: ThemeMode) => {
    try {
      if (next === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
    apply(next)
    window.dispatchEvent(new Event(CHANGED))
  }, [])
  return { mode, theme, setMode }
}
