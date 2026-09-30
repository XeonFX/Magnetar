import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

/**
 * A button that opens a list of choices, as the ARIA menu button pattern has it: the arrow keys,
 * Home and End move between items, Escape closes and returns to the button, Tab or a click outside
 * closes. `items` gets a function that closes the menu, for items that act rather than navigate.
 */
export function MenuButton({ label, button, items, placement = 'down', onOpen, className = '' }: {
  label: string
  button: ReactNode
  items: (close: () => void) => ReactNode
  placement?: 'up' | 'down'
  onOpen?: () => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  /** Which item takes the focus once the menu is on screen. */
  const [focus, setFocus] = useState<'current' | 'first' | 'last'>('current')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const id = useId()

  const entries = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])]
  const close = (refocus = false) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }
  const show = (target: 'current' | 'first' | 'last') => {
    setFocus(target)
    setOpen(true)
    onOpen?.()
  }
  useLayoutEffect(() => {
    if (!open) return
    const all = entries()
    const target = focus === 'last' ? all.at(-1) : focus === 'first' ? all[0] : (all.find(e => e.getAttribute('aria-current') === 'page') ?? all[0])
    target?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  const onTriggerKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      show(event.key === 'ArrowDown' ? 'first' : 'last')
    }
  }
  const onListKey = (event: KeyboardEvent) => {
    const all = entries()
    const at = all.indexOf(document.activeElement as HTMLElement)
    const move = (index: number) => {
      event.preventDefault()
      all[(index + all.length) % all.length]?.focus()
    }
    if (event.key === 'ArrowDown') move(at + 1)
    else if (event.key === 'ArrowUp') move(at - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(all.length - 1)
    else if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'Tab') close()
  }

  return (
    <div ref={root} className={`relative ${className}`}>
      <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        className="w-full text-left" onClick={() => (open ? close() : show('current'))} onKeyDown={onTriggerKey}>
        {button}
        {/* Read after what the button shows, rather than instead of it. */}
        <span className="sr-only">{label}</span>
      </button>
      {open && (
        <ul id={id} ref={list} role="menu" aria-label={label} onKeyDown={onListKey}
          className={`menu absolute z-50 w-72 [&_[role=menuitem]]:min-h-11 max-w-[calc(100vw-2rem)] rounded-box border border-base-300 bg-base-100 p-2 shadow-lg ${
            placement === 'up' ? 'bottom-full left-0 mb-2' : 'left-0 top-full mt-2'}`}>
          {items(() => close())}
        </ul>
      )}
    </div>
  )
}
