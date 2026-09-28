import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useT } from '../lib/i18n.tsx'

type Tone = 'success' | 'error' | 'info'
interface Toast {
  id: number
  tone: Tone
  message: string
}

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {})

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const [toasts, setToasts] = useState<Toast[]>([])
  const dismiss = useCallback((id: number) => setToasts(list => list.filter(item => item.id !== id)), [])
  const show = useCallback((message: string, tone: Tone = 'info') => {
    const id = nextId++
    setToasts(list => [...list.slice(-3), { id, tone, message }])
    setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000)
  }, [dismiss])
  const value = useMemo(() => show, [show])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast toast-end toast-bottom z-50 max-w-[calc(100vw-2rem)]" role="status" aria-live="polite">
        {toasts.map(toast => (
          <div key={toast.id} className={`alert shadow-lg ${toast.tone === 'success' ? 'alert-success' : toast.tone === 'error' ? 'alert-error' : 'alert-info'}`}>
            {toast.tone === 'success' ? <CircleCheck size={18} /> : toast.tone === 'error' ? <CircleAlert size={18} /> : <Info size={18} />}
            <span className="break-release text-sm">{toast.message}</span>
            <button type="button" className="btn btn-ghost btn-xs btn-circle" aria-label={t('common.close')} onClick={() => dismiss(toast.id)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}

/** Copies text and confirms with a toast; a blocked clipboard fails quietly, the text stays selectable. */
export function useCopy(message: string) {
  const toast = useToast()
  return useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast(message, 'success')
    } catch {
      // Clipboard access denied.
    }
  }, [toast, message])
}
