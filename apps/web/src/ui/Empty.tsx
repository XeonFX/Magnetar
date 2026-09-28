import type { ReactNode } from 'react'

/** The centred "nothing here" card used by list pages. */
export function Empty({ icon, title, text, children }: { icon: ReactNode; title?: string; text: string; children?: ReactNode }) {
  return (
    <div className="surface flex flex-col items-center gap-4 px-6 py-16 text-center">
      {icon}
      <div>
        {title && <h2 className="text-lg font-semibold">{title}</h2>}
        <p className="mt-1 max-w-md text-sm text-base-content/60">{text}</p>
      </div>
      {children}
    </div>
  )
}
