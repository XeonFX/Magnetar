import { MAX_TORRENT_FILE } from '@magnetar/protocol/limits'
import { FilePlus2, Link2, Upload } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { errorMessage } from '../../lib/errors.ts'
import { useT, type Translate } from '../../lib/i18n.tsx'
import { magnetsIn } from '../../lib/magnets.ts'
import { RpcError } from '../../lib/rpcClient.ts'
import { sendTorrent } from '../../lib/torrentUpload.ts'
import { Modal } from '../../ui/Modal.tsx'
import { useToast } from '../../ui/toast.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { FolderField } from './folders.tsx'

const isTorrentFile = (file: File) => file.name.toLowerCase().endsWith('.torrent') || file.type === 'application/x-bittorrent'
const fileKey = (file: File) => `${file.name}:${file.size}`

/** `current` and the .torrent files among `list` it doesn't have yet, and those too large to take. */
function withFiles(current: File[], list: Iterable<File>): { files: File[]; tooBig: File[] } {
  const files = [...current]
  const tooBig: File[] = []
  for (const file of list) {
    if (!isTorrentFile(file) || files.some(f => fileKey(f) === fileKey(file))) continue
    if (file.size > MAX_TORRENT_FILE) tooBig.push(file)
    else files.push(file)
  }
  return { files, tooBig }
}

/** What went wrong with one item, in the reader's language where the dashboard knows the case. */
function describe(t: Translate, error: unknown): string {
  if (error instanceof RpcError) {
    if (error.code === 'offline') return t('add.offline')
    if (error.code === 'timeout') return t('add.timeout')
    if (error.code === 'update_needed') return t('add.updateDevice')
  }
  return errorMessage(error)
}

export interface PendingAdd {
  magnets: string[]
  files: File[]
  /** .torrent files on the computer running the app (it was opened with one). */
  paths?: string[]
}

/**
 * Adds magnet links and .torrent files, pasted, dropped or picked. Each is started on its own, so
 * one bad link doesn't stop the rest; the result says how many started, and what failed stays in
 * the dialog to try again. Files over MAX_TORRENT_FILE never join the list.
 */
export function AddDownloadDialog({ open, initial, onClose }: { open: boolean; initial: PendingAdd | null; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const { connection, settings } = useDevice()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [paths, setPaths] = useState<string[]>([])
  const [folder, setFolder] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Share sent so far (0–1) of each file going in pieces, by fileKey. */
  const [progress, setProgress] = useState<Record<string, number>>({})
  const picker = useRef<HTMLInputElement>(null)
  /** Counts the times the dialog opened, so a run started before it closed leaves the new one alone. */
  const opened = useRef(0)

  const refuse = (tooBig: File[]) => setError(tooBig.length ? t('add.tooBig', tooBig.map(f => f.name).join(', ')) : null)

  useEffect(() => {
    if (!open) return
    opened.current++
    const { files, tooBig } = withFiles([], initial?.files ?? [])
    setText(initial?.magnets.join('\n') ?? '')
    setFiles(files)
    setPaths(initial?.paths ?? [])
    setFolder(null)
    setProgress({})
    setBusy(false)
    refuse(tooBig)
  }, [open, initial])

  const magnets = magnetsIn(text)
  const count = magnets.length + files.length + paths.length
  const addFiles = (list: FileList | File[]) => {
    const more = [...list]
    setFiles(current => withFiles(current, more).files)
    refuse(withFiles(files, more).tooBig)
  }

  const submit = async () => {
    if (count === 0) return setError(t('add.nothing'))
    const run = opened.current
    const stillOpen = () => opened.current === run
    setBusy(true)
    setError(null)
    const target = folder?.trim() || undefined
    const failures: string[] = []
    const left = { magnets: [] as string[], paths: [] as string[], files: [] as File[] }
    let started = 0
    for (const magnet of magnets) {
      try {
        await connection.call('downloads.start', { magnet, folder: target })
        started++
      } catch (e) {
        failures.push(describe(t, e))
        left.magnets.push(magnet)
      }
    }
    for (const path of paths) {
      try {
        await connection.call('downloads.addTorrentPath', { path })
        started++
      } catch (e) {
        failures.push(`${path.split(/[\\/]/).pop()}: ${describe(t, e)}`)
        left.paths.push(path)
      }
    }
    for (const file of files) {
      const key = fileKey(file)
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        await sendTorrent(connection, bytes, target, sent => { if (stillOpen()) setProgress(p => ({ ...p, [key]: sent / bytes.length })) })
        started++
      } catch (e) {
        failures.push(`${file.name}: ${describe(t, e)}`)
        left.files.push(file)
      } finally {
        if (stillOpen()) setProgress(p => {
          const next = { ...p }
          delete next[key]
          return next
        })
      }
    }
    if (started > 0) toast(started === 1 ? t('add.startedOne') : t('add.started', started), 'success')
    // Closed while this ran, and maybe opened again for something else: that is no longer this run's.
    if (!stillOpen()) return
    setBusy(false)
    if (!failures.length) return onClose()
    // What started is done with: a second try is only for what failed.
    if (started > 0) {
      setText(left.magnets.join('\n'))
      setPaths(left.paths)
      setFiles(left.files)
    }
    setError(failures.join('\n'))
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
        <textarea className="textarea h-28 w-full font-mono text-xs" placeholder="magnet:?xt=urn:btih:…" value={text} readOnly={busy}
          onChange={e => setText(e.target.value)} data-autofocus spellCheck={false} />
        <span className="muted text-xs">{magnets.length === 1 ? t('add.magnetOne') : magnets.length > 1 ? t('add.magnetCount', magnets.length) : t('add.magnetsHint')}</span>
      </label>
      <div className="my-4 flex items-center gap-3 text-xs"><span className="h-px flex-1 bg-base-300" /><span className="muted">{t('add.or')}</span><span className="h-px flex-1 bg-base-300" /></div>
      <input ref={picker} type="file" accept=".torrent,application/x-bittorrent" multiple hidden onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
      <button type="button" disabled={busy} className="flex w-full flex-col items-center gap-1 rounded-box border border-dashed border-base-content/25 px-4 py-5 text-sm transition-colors enabled:hover:border-primary enabled:hover:bg-primary/5 disabled:opacity-60"
        onClick={() => picker.current?.click()} onDragOver={e => e.preventDefault()} onDrop={(e: DragEvent) => { e.preventDefault(); if (!busy) addFiles(e.dataTransfer.files) }}>
        <Upload size={20} className="text-primary" />
        <span className="font-medium">{t('add.chooseFiles')}</span>
        <span className="muted text-xs">{t('add.dropHint')}</span>
      </button>
      {paths.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {paths.map(path => (
            <li key={path} className="flex items-center gap-2 rounded-field bg-base-200 px-3 py-1.5 text-sm">
              <Link2 size={14} className="muted shrink-0" />
              <span className="break-release min-w-0 flex-1" title={path}>{path.split(/[\\/]/).pop()}</span>
              <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => setPaths(list => list.filter(x => x !== path))}>{t('common.remove')}</button>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {files.map(f => {
            const sent = progress[fileKey(f)]
            return (
              <li key={fileKey(f)} className="flex flex-col gap-1 rounded-field bg-base-200 px-3 py-1.5 text-sm">
                <div className="flex items-center gap-2">
                  <Link2 size={14} className="muted shrink-0" />
                  <span className="break-release min-w-0 flex-1">{f.name}</span>
                  <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => setFiles(list => list.filter(x => x !== f))}>{t('common.remove')}</button>
                </div>
                {sent !== undefined && (
                  <div className="h-1 overflow-hidden rounded-full bg-base-300" role="progressbar" aria-label={t('add.sending', f.name)}
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(sent * 100)}>
                    <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${sent * 100}%` }} />
                  </div>
                )}
              </li>
            )
          })}
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
      // Pasting into a field, or while a dialog is open, is left to the page.
      if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"], dialog[open]')) return
      // A dialog showing its content (one closing has already dropped it).
      if (document.querySelector('dialog[open] .modal-box')) return
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
