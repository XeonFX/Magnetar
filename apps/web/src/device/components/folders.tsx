import { FolderOpen } from 'lucide-react'
import { lazy, Suspense, useEffect, useId, useState } from 'react'
import { useT } from '../../lib/i18n.tsx'
import { updates } from '../../lib/updates.ts'
import { blurOnEnter } from '../../ui/fields.tsx'
import { Loading } from '../../ui/Loading.tsx'
import { Modal } from '../../ui/Modal.tsx'
import { useDevice } from '../DeviceContext.tsx'

// The browser loads when first opened: most pages with a folder field never open it.
const Chooser = lazy(() => updates.importOrReload(() => import('./folderChooser.tsx')).then(m => ({ default: m.Chooser })))

/**
 * Chooses a folder on the device (not this computer, when used through the relay), inside the folders Files may
 * browse. It opens at `start` when that is inside one of them, else at the list of them.
 */
export function FolderBrowser({ open, start, onClose, onSelect }: {
  open: boolean
  start: string
  onClose: () => void
  onSelect: (path: string) => void
}) {
  const t = useT()
  const [chosen, setChosen] = useState<string | null>(null)
  useEffect(() => {
    if (!open) setChosen(null)
  }, [open])
  return (
    <Modal open={open} title={t('dialog.chooseFolder')} icon={<FolderOpen size={20} />} onClose={onClose} wide
      actions={<>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={chosen === null} onClick={() => chosen && onSelect(chosen)}>
          {t('folderBrowser.selectFolder')}
        </button>
      </>}>
      {open && <Suspense fallback={<Loading />}><Chooser start={start} onPath={setChosen} /></Suspense>}
    </Modal>
  )
}

/**
 * A folder path input with a Browse button: the macOS folder chooser on the device's own
 * dashboard, the in-page browser everywhere else.
 */
export function FolderField({ label, value, placeholder, help, onChange, hideLabel = false }: {
  label: string
  /** When a surrounding setting row already names it. */
  hideLabel?: boolean
  value: string
  placeholder?: string
  help?: string
  onChange: (path: string) => void
}) {
  const t = useT()
  const { connection, info } = useDevice()
  const id = useId()
  const [browsing, setBrowsing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const browse = async () => {
    if (info?.nativeFolderPicker) {
      try {
        const { path } = await connection.call('fs.pickNative', { start: draft || placeholder, prompt: t('dialog.chooseDownloadFolder') })
        if (path) onChange(path)
        return
      } catch {
        // Fall back to the in-page browser.
      }
    }
    setBrowsing(true)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-sm font-medium'}>{label}</label>
      <div className="join w-full">
        <input id={id} className="input join-item w-full min-w-0 font-mono text-sm" value={draft} placeholder={placeholder ?? label}
          onChange={e => setDraft(e.target.value)} onBlur={() => draft !== value && onChange(draft)}
          onKeyDown={blurOnEnter} />
        <button type="button" className="btn join-item" aria-label={t('common.browse')} onClick={() => void browse()}><FolderOpen size={16} /><span className="hidden sm:inline">{t('common.browse')}</span></button>
      </div>
      {help && <p className="muted text-xs">{help}</p>}
      <FolderBrowser open={browsing} start={draft || placeholder || ''} onClose={() => setBrowsing(false)}
        onSelect={path => { setBrowsing(false); setDraft(path); onChange(path) }} />
    </div>
  )
}
