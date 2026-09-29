import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { useT } from '../lib/i18n.tsx'

/** A native <dialog>: focus trapping, Escape and the backdrop come from the browser. */
export function Modal({ open, title, icon, onClose, children, actions, wide = false }: {
  open: boolean
  title: ReactNode
  icon?: ReactNode
  onClose: () => void
  children: ReactNode
  actions?: ReactNode
  wide?: boolean
}) {
  const t = useT()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog ref={ref} className="modal modal-bottom sm:modal-middle" onClose={onClose} onCancel={onClose}>
      {open && (
        <div className={`modal-box ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'} p-0`}>
          <div className="flex items-center gap-2 border-b border-base-300 px-5 py-4">
            {icon}
            <h3 className="flex-1 text-lg font-semibold">{title}</h3>
            <button type="button" className="btn btn-ghost btn-sm btn-circle" aria-label={t('common.close')} onClick={onClose}><X size={18} /></button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
          {actions && <div className="modal-action mt-0 flex-wrap border-t border-base-300 px-5 py-3">{actions}</div>}
        </div>
      )}
      {/* A button rather than <form method="dialog">, so a dialog rendered inside a form never nests forms. */}
      <div className="modal-backdrop"><button type="button" onClick={onClose}>{t('common.close')}</button></div>
    </dialog>
  )
}

export interface ConfirmOption<T> {
  label: string
  value: T
  tone?: 'primary' | 'error' | 'ghost'
}

/** A question with a few answers; resolves with the chosen value, or null when dismissed. */
export function ConfirmDialog<T>({ open, title, message, options, onResult }: {
  open: boolean
  title: string
  message: ReactNode
  options: ConfirmOption<T>[]
  onResult: (value: T | null) => void
}) {
  return (
    <Modal open={open} title={title} onClose={() => onResult(null)}
      actions={options.map(option => (
        <button key={option.label} type="button"
          className={`btn btn-sm ${option.tone === 'error' ? 'btn-error' : option.tone === 'ghost' ? 'btn-ghost' : 'btn-primary'}`}
          onClick={() => onResult(option.value)}>
          {option.label}
        </button>
      ))}>
      <p className="break-release">{message}</p>
    </Modal>
  )
}
