import type { ReactNode } from 'react'

export interface SegmentOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  count?: number
}

/** A small set of mutually exclusive choices, all visible at once (filters, modes). */
export function Segmented<T extends string>({ label, value, options, onChange, size = 'sm' }: {
  label: string
  value: T
  options: SegmentOption<T>[]
  onChange: (value: T) => void
  size?: 'xs' | 'sm'
}) {
  return (
    <div role="radiogroup" aria-label={label} className="scroll-strip -mx-1 flex max-w-full gap-1 overflow-x-auto px-1">
      {options.map(option => {
        const selected = option.value === value
        return (
          <button key={option.value} type="button" role="radio" aria-checked={selected} onClick={() => onChange(option.value)}
            className={`btn btn-${size} shrink-0 gap-1.5 rounded-full font-medium ${selected ? 'btn-neutral' : 'btn-ghost muted border-base-300 bg-base-100'}`}>
            {option.icon}
            {option.label}
            {option.count !== undefined && <span className={`tabular-nums ${selected ? 'opacity-70' : 'opacity-60'}`}>{option.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/**
 * One setting: what it is and what it does on the left, its control on the right. `wide` controls
 * (menus, choices, buttons) move under the text on phones; `stack` puts the control under the text
 * at every width (a folder field). Switches stay on the right everywhere.
 */
export function SettingRow({ title, description, children, htmlFor, layout = 'inline' }: {
  title: string
  description?: ReactNode
  children?: ReactNode
  htmlFor?: string
  layout?: 'inline' | 'wide' | 'stack'
}) {
  const row = layout === 'inline' ? 'flex-row items-center' : layout === 'wide' ? 'flex-col sm:flex-row sm:items-center' : 'flex-col'
  return (
    <div className={`flex gap-x-6 gap-y-3 py-4 first:pt-0 last:pb-0 ${row}`}>
      <div className="min-w-0 flex-1">
        {htmlFor ? <label htmlFor={htmlFor} className="font-medium">{title}</label> : <div className="font-medium">{title}</div>}
        {description && <div className="muted mt-0.5 text-sm">{description}</div>}
      </div>
      {children && <div className={layout === 'stack' ? 'w-full' : 'shrink-0'}>{children}</div>}
    </div>
  )
}

/** A titled card holding setting rows separated by hairlines. */
export function SettingGroup({ title, description, action, children }: {
  title?: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="surface p-5 sm:p-6">
      {(title || description || action) && (
        <div className="mb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="muted mt-0.5 text-sm">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="divide-y divide-base-300">{children}</div>
    </section>
  )
}

export function Switch({ label, checked, onChange, disabled = false, id }: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  id?: string
}) {
  return (
    <input id={id} type="checkbox" role="switch" className="toggle toggle-primary" aria-label={label} checked={checked}
      disabled={disabled} onChange={e => onChange(e.target.checked)} />
  )
}

/** Page title, an optional one-line summary under it, and the page's main action on the right. */
export function PageHeader({ title, summary, action }: { title: string; summary?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-x-4 gap-y-3 sm:mb-6">
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {summary && <div className="muted mt-1 text-sm">{summary}</div>}
      </div>
      {action}
    </div>
  )
}
