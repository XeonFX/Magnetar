import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react'

/** A labelled field with optional help text below it. */
export function Field({ label, help, className = '', children }: { label: string; help?: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <label className="floating-label block"><span>{label}</span>{children}</label>
      {help && <p className="mt-1 text-xs text-base-content/60">{help}</p>}
    </div>
  )
}

/** Enter commits a field the same way leaving it does. */
export const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') e.currentTarget.blur()
}

/**
 * An input that edits a local draft and saves when it loses focus (or on Enter), only when the
 * value actually changed. The draft follows the value when it changes elsewhere.
 */
export function SaveOnBlurInput({ value, onSave, className = 'input w-full', ...rest }: {
  value: string
  onSave: (value: string) => void
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'onKeyDown'>) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input {...rest} className={className} value={draft} onChange={e => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)} onKeyDown={blurOnEnter} />
  )
}
