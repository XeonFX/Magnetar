import { useEffect, useReducer } from 'react'

/** Chrome's and Edge's install offer, kept until the page offers it itself. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

let offer: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(listener => listener())

/** Call once at start-up: the offer arrives early and only once per page load. */
export function captureInstallOffer(): void {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    offer = event as InstallPromptEvent
    changed()
  })
  window.addEventListener('appinstalled', () => {
    offer = null
    changed()
  })
}

/** "Install app", while the browser offers it: a function that shows the browser's own prompt. */
export function useInstallOffer(): (() => void) | null {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    listeners.add(rerender)
    return () => void listeners.delete(rerender)
  }, [])
  if (!offer) return null
  return () => {
    const current = offer
    offer = null
    changed()
    void current?.prompt()
  }
}
