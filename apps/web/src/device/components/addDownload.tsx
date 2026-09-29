import { MAX_TORRENT_FILE } from '@md/protocol'
import { FilePlus2, Link2, Upload } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { useT } from '../../lib/i18n.tsx'
import { Modal } from '../../ui/Modal.tsx'
import { useToast } from '../../ui/toast.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { FolderField } from './folders.tsx'

/** Every magnet link in a block of text, one per line or run together. */
export function magnetsIn(text: string): string[] {
  return [...new Set(text.match(/magnet:\?[^\s"'<>]+/gi) ?? [])]
}

const isTorrentFile = (file: File) => file.name.toLowerCase().endsWith('.torrent') || file.type === 'application/x-bittorrent'

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    reader.readAsDataURL(file)
  })
}

export interface PendingAdd {
  magnets: string[]
  files: File[]
}

/**
 * Adds magnet links and .torrent files, pasted, dropped or picked. Each is started on its own, so
 * one bad link doesn't stop the rest; the result says how many started.
 */
export function AddDownloadDialog({ open, initial, onClose }: { open: boolean; initial: PendingAdd | null; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const { connection, settings } = useDevice()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [folder, setFolder] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setText(initial?.magnets.join('\n') ?? '')
    setFiles(initial?.files ?? [])
    setFolder(null)
    setError(null)
  }, [open, initial])

  const magnets = magnetsIn(text)
  const tooBig = files.filter(f => f.size > MAX_TORRENT_FILE)
  const count = magnets.length + files.length
  const addFiles = (list: FileList | File[]) => setFiles(current => [...current, ...[...list].filter(isTorrentFile).filter(f => !current.some(c => c.name === f.name && c.size === f.size))])

  const submit = async () => {
    if (count === 0) return setError(t('add.nothing'))
    if (tooBig.length) return setError(t('add.tooBig', tooBig.map(f => f.name).join(', ')))
    setBusy(true)
    setError(null)
    const target = folder?.trim() || undefined
    const failures: string[] = []
    let started = 0
    for (const magnet of magnets) {
      try {
        await connection.call('downloads.start', { magnet, folder: target })
        started++
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e))
      }
    }
    for (const file of files) {
      try {
        await connection.call('downloads.start', { torrent: await toBase64(file), folder: target })
        started++
      } catch (e) {
        failures.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setBusy(false)
    if (started > 0) toast(t('add.started', started), 'success')
    if (failures.length) setError(failures.join('\n'))
    else onClose()
  }

  return (
    <Modal open={open} title={t('add.title')} icon={<FilePlus2 size={20} />} onClose={onClose}
      actions={<>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || count === 0} onClick={() => void submit()}>
          {busy && <span className="loading loading-spinner loading-xs" />}{count > 1 ? t('add.startMany', count) : t('common.download')}
        </button>
      </>}>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t('add.magnets')}</span>
        <textarea className="textarea h-28 w-full font-mono text-xs" placeholder="magnet:?xt=urn:btih:…" value={text}
          onChange={e => setText(e.target.value)} data-autofocus spellCheck={false} />
        <span className="muted text-xs">{magnets.length > 0 ? t('add.magnetCount', magnets.length) : t('add.magnetsHint')}</span>
      </label>
      <div className="my-4 flex items-center gap-3 text-xs"><span className="h-px flex-1 bg-base-300" /><span className="muted">{t('add.or')}</span><span className="h-px flex-1 bg-base-300" /></div>
      <input ref={picker} type="file" accept=".torrent,application/x-bittorrent" multiple hidden onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
      <button type="button" className="flex w-full flex-col items-center gap-1 rounded-box border border-dashed border-base-content/25 px-4 py-5 text-sm transition-colors hover:border-primary hover:bg-primary/5"
        onClick={() => picker.current?.click()} onDragOver={e => e.preventDefault()} onDrop={(e: DragEvent) => { e.preventDefault(); addFiles(e.dataTransfer.files) }}>
        <Upload size={20} className="text-primary" />
        <span className="font-medium">{t('add.chooseFiles')}</span>
        <span className="muted text-xs">{t('add.dropHint')}</span>
      </button>
      {files.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {files.map(f => (
            <li key={`${f.name}:${f.size}`} className="flex items-center gap-2 rounded-field bg-base-200 px-3 py-1.5 text-sm">
              <Link2 size={14} className="muted shrink-0" />
              <span className="break-release min-w-0 flex-1">{f.name}</span>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setFiles(list => list.filter(x => x !== f))}>{t('common.remove')}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        {folder === null
          ? <button type="button" className="link link-hover text-sm" onClick={() => setFolder(settings?.downloadFolder ?? '')}>{t('add.otherFolder')}</button>
          : <FolderField label={t('dialog.folder')} value={folder} help={t('dialog.folderHelp')} onChange={setFolder} />}
      </div>
      {error && <p role="alert" className="mt-3 whitespace-pre-line text-sm text-error">{error}</p>}
    </Modal>
  )
}

/**
 * .torrent files dropped anywhere on the page, and magnet links pasted outside a text field, open
 * the add dialog with them already in.
 */
export function useAddShortcuts(onAdd: (pending: PendingAdd) => void) {
  const [dragging, setDragging] = useState(false)
  const handler = useRef(onAdd)
  handler.current = onAdd
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: globalThis.DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
    const enter = (e: globalThis.DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true) } }
    const leave = (e: globalThis.DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false) } }
    const over = (e: globalThis.DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const drop = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const files = [...(e.dataTransfer?.files ?? [])].filter(isTorrentFile)
      if (files.length) handler.current({ magnets: [], files })
    }
    const paste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"], dialog[open]')) return
      const magnets = magnetsIn(e.clipboardData?.getData('text') ?? '')
      if (magnets.length) {
        e.preventDefault()
        handler.current({ magnets, files: [] })
      }
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [])
  return dragging
}

export function DropOverlay() {
  const t = useT()
  return (
    <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-base-100/80 p-6 backdrop-blur-sm" aria-hidden>
      <div className="flex flex-col items-center gap-2 rounded-box border-2 border-dashed border-primary px-10 py-8 text-center">
        <Upload size={32} className="text-primary" />
        <span className="text-lg font-semibold">{t('add.dropTitle')}</span>
      </div>
    </div>
  )
}
