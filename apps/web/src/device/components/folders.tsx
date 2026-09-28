import type { FolderListing } from '@md/protocol'
import { ArrowUp, Folder, FolderOpen, FolderPlus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../lib/i18n.tsx'
import { blurOnEnter } from '../../ui/fields.tsx'
import { Modal } from '../../ui/Modal.tsx'
import { useDevice } from '../DeviceContext.tsx'

/** Browses folders on the device (not this computer, when used through the relay). */
export function FolderBrowser({ open, start, onClose, onSelect }: {
  open: boolean
  start: string
  onClose: () => void
  onSelect: (path: string) => void
}) {
  const t = useT()
  const { connection } = useDevice()
  const [path, setPath] = useState(start)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (target: string) => {
    setError(null)
    try {
      const result = await connection.call('fs.list', { path: target || undefined })
      setListing(result)
      setPath(result.path)
      if (result.error) setError(t('folderBrowser.readError', result.error))
      else if (!result.exists) setError(t('folderBrowser.notExistYet'))
    } catch (e) {
      setError(t('folderBrowser.readError', e instanceof Error ? e.message : String(e)))
    }
  }, [connection, t])

  useEffect(() => {
    if (open) void load(start)
  }, [open, start, load])

  const makeFolder = async () => {
    try {
      setListing(await connection.call('fs.mkdir', { path }))
      setError(null)
    } catch (e) {
      setError(t('folderBrowser.createError', e instanceof Error ? e.message : String(e)))
    }
  }

  return (
    <Modal open={open} title={t('dialog.chooseFolder')} icon={<FolderOpen size={20} />} onClose={onClose}
      actions={<>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!path.trim()} onClick={() => onSelect(path.trim())}>{t('folderBrowser.selectFolder')}</button>
      </>}>
      <label className="floating-label mb-3 block">
        <span>{t('folderBrowser.currentFolder')}</span>
        <input className="input w-full font-mono text-sm" value={path} onChange={e => setPath(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void load(path) }} />
      </label>
      <div className="mb-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn-outline btn-sm" disabled={!listing?.parent} onClick={() => listing?.parent && void load(listing.parent)}>
          <ArrowUp size={14} />{t('folderBrowser.up')}
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => void load(path)}><RefreshCw size={14} />{t('folderBrowser.refresh')}</button>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => void makeFolder()}><FolderPlus size={14} />{t('folderBrowser.newFolder')}</button>
      </div>
      {error && <div role="alert" className="alert alert-warning alert-soft mb-3 py-2 text-sm">{error}</div>}
      <ul className="menu max-h-72 w-full flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100">
        {listing && listing.folders.length === 0 && <li className="menu-disabled"><span>{t('folderBrowser.noSubfolders')}</span></li>}
        {listing?.folders.map(name => (
          <li key={name}>
            <button type="button" onClick={() => void load(`${listing.path.replace(/[\\/]$/, '')}${listing.path.includes('\\') ? '\\' : '/'}${name}`)}>
              <Folder size={16} className="text-primary" /><span className="truncate">{name}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/**
 * A folder path input with a Browse button: the macOS folder chooser on the device's own
 * dashboard, the in-page browser everywhere else.
 */
export function FolderField({ label, value, placeholder, help, onChange }: {
  label: string
  value: string
  placeholder?: string
  help?: string
  onChange: (path: string) => void
}) {
  const t = useT()
  const { connection, info } = useDevice()
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
    <div>
      <div className="join w-full">
        <label className="floating-label join-item w-full">
          <span>{label}</span>
          <input className="input w-full font-mono text-sm" value={draft} placeholder={placeholder ?? label}
            onChange={e => setDraft(e.target.value)} onBlur={() => draft !== value && onChange(draft)}
            onKeyDown={blurOnEnter} />
        </label>
        <button type="button" className="btn join-item" aria-label={t('common.browse')} onClick={() => void browse()}><FolderOpen size={16} /><span className="hidden sm:inline">{t('common.browse')}</span></button>
      </div>
      {help && <p className="mt-1 text-xs text-base-content/60">{help}</p>}
      <FolderBrowser open={browsing} start={draft || placeholder || ''} onClose={() => setBrowsing(false)}
        onSelect={path => { setBrowsing(false); onChange(path) }} />
    </div>
  )
}
