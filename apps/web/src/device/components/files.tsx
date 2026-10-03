import type { FolderEntryDto, FolderPageDto, FolderRootDto, FolderRootsDto } from '@magnetar/protocol'
import { formatBytes } from '@magnetar/protocol/bytes'
import {
  CircleAlert, Download, FileAudio, FileText, FileVideo, Folder, FolderDown, FolderPlus, HardDrive, House, Info, Play, Plus,
  RefreshCw, X,
} from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { errorMessage } from '../../lib/errors.ts'
import { appendPage, baseName, crumbs, isWithin, joinPath, parentOf, separatorOf, type Separator } from '../../lib/folderPaths.ts'
import { useFormatDate, useT } from '../../lib/i18n.tsx'
import { RpcError } from '../../lib/rpcClient.ts'
import { ConfirmDialog } from '../../ui/Modal.tsx'
import { ShowMore } from '../../ui/ShowMore.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { useRun } from '../useRun.ts'

/** Entries asked for at a time: a page the relay carries easily, and a list a phone scrolls quickly. */
const PAGE = 100

/** The folders the dashboard may browse, read again whenever the settings change (the download folder moved). */
export function useRoots() {
  const { connection, settings, info } = useDevice()
  const supported = info?.fileBrowser === true
  const [roots, setRoots] = useState<FolderRootsDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)
  const reload = useCallback(() => {
    if (!supported) return
    const id = ++latest.current
    setError(null)
    connection.call('fs.roots').then(
      next => { if (id === latest.current) setRoots(next) },
      (e: unknown) => { if (id === latest.current) setError(errorMessage(e)) },
    )
  }, [connection, supported])
  // `settings` changes when the download folder or the added folders do.
  useEffect(reload, [reload, settings])
  return { supported, roots, error, reload, setRoots }
}

/** The name a root goes by: "Download folder", or its own name. */
export function rootLabel(root: Pick<FolderRootDto, 'kind' | 'path'>, separator: Separator, t: ReturnType<typeof useT>): string {
  return root.kind === 'downloads' ? t('files.downloadFolder') : baseName(root.path, separator)
}

type FolderState =
  | { status: 'loading'; path: string }
  | { status: 'error'; path: string; message: string; code: string }
  | { status: 'ready'; page: FolderPageDto; entries: FolderEntryDto[]; next: number; more: 'idle' | 'loading' }

/**
 * A folder's entries as its pages arrive: the first on opening, the next on asking. Answers for a folder left in the
 * meantime are dropped, and a folder that failed for want of a connection is read again once it is back.
 */
export function useFolder(path: string | null, foldersOnly: boolean) {
  const { connection, connectionState } = useDevice()
  const [state, setState] = useState<FolderState | null>(null)
  const current = useRef(state)
  current.current = state
  const latest = useRef(0)

  const reload = useCallback(() => {
    const id = ++latest.current
    if (path === null) return setState(null)
    setState({ status: 'loading', path })
    connection.call('fs.browse', { path, limit: PAGE, foldersOnly }).then(
      page => { if (id === latest.current) setState({ status: 'ready', page, entries: page.entries, next: page.entries.length, more: 'idle' }) },
      (e: unknown) => {
        if (id === latest.current) setState({ status: 'error', path, message: errorMessage(e), code: e instanceof RpcError ? e.code : 'internal' })
      },
    )
  }, [connection, path, foldersOnly])
  useEffect(reload, [reload])

  const offline = state?.status === 'error' && state.code === 'offline'
  useEffect(() => {
    if (offline && connectionState.status === 'open') reload()
  }, [offline, connectionState.status, reload])

  const run = useRun()
  const loadMore = useCallback(() => {
    const shown = current.current
    if (shown?.status !== 'ready' || shown.more === 'loading' || shown.next >= shown.page.total) return
    const id = latest.current
    setState({ ...shown, more: 'loading' })
    void run(() => connection.call('fs.browse', { path: shown.page.path, offset: shown.next, limit: PAGE, foldersOnly }), 'files.moreFailed')
      .then(page => {
        if (id !== latest.current) return
        const now = current.current
        if (now?.status !== 'ready') return
        setState(page
          ? { ...now, page, entries: appendPage(now.entries, page.entries), next: now.next + page.entries.length, more: 'idle' }
          : { ...now, more: 'idle' })
      })
  }, [connection, foldersOnly, run])

  return { state, reload, loadMore }
}

function entryIcon(entry: FolderEntryDto) {
  if (entry.kind === 'folder') {
    return entry.download ? <FolderDown size={18} className="shrink-0 text-primary" aria-hidden /> : <Folder size={18} className="shrink-0 text-primary" aria-hidden />
  }
  if (entry.media === 'video') return <FileVideo size={18} className="shrink-0 text-info" aria-hidden />
  if (entry.media === 'audio') return <FileAudio size={18} className="shrink-0 text-accent" aria-hidden />
  return <FileText size={18} className="muted shrink-0" aria-hidden />
}

/** The way back from a folder to the folders that can be browsed, each step a link. */
export function Breadcrumbs({ page, roots, onOpen, onHome }: {
  page: Pick<FolderPageDto, 'root' | 'path' | 'separator'>
  roots: FolderRootDto[]
  onOpen: (path: string) => void
  onHome: () => void
}) {
  const t = useT()
  const trail = crumbs(page.root, page.path, page.separator)
  const root = roots.find(r => r.path === page.root)
  return (
    <nav aria-label={t('files.breadcrumb')} className="breadcrumbs scroll-strip -mx-1 max-w-full px-1 py-0 text-sm">
      <ul>
        <li>
          <button type="button" className="link link-hover inline-flex items-center gap-1.5" onClick={onHome}>
            <House size={14} aria-hidden />{t('files.title')}
          </button>
        </li>
        {trail.map((crumb, i) => {
          const name = i === 0 && root ? rootLabel(root, page.separator, t) : crumb.name
          return (
            <li key={crumb.path}>
              {i === trail.length - 1
                ? <span aria-current="page" className="max-w-[16rem] truncate font-medium" title={crumb.path}>{name}</span>
                : <button type="button" className="link link-hover max-w-[12rem] truncate" title={crumb.path} onClick={() => onOpen(crumb.path)}>{name}</button>}
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** A form for a new folder's name, inside `parent`. Resolves with the folder made. */
export function NewFolderForm({ parent, onMade, onCancel }: { parent: string; onMade: (path: string) => void; onCancel: () => void }) {
  const t = useT()
  const { connection } = useDevice()
  const id = useId()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      onMade((await connection.call('fs.createFolder', { parent, name: name.trim() })).path)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <form className="mb-3 flex flex-col gap-1.5" onSubmit={e => { e.preventDefault(); void submit() }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onCancel() } }}>
      <label htmlFor={id} className="text-sm font-medium">{t('files.newFolderName')}</label>
      <div className="flex gap-2">
        <input id={id} data-autofocus autoFocus className="input input-sm w-full min-w-0" value={name} maxLength={255} autoComplete="off"
          aria-invalid={error !== null} aria-describedby={error ? `${id}-error` : undefined} onChange={e => setName(e.target.value)} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>
          {busy && <span className="loading loading-spinner loading-xs" />}{t('files.create')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-error">{error}</p>}
    </form>
  )
}

/**
 * One folder: its breadcrumb, a few actions, and its entries, folders first. `onOpen` goes into a folder; files of a
 * download offer what the dashboard already does with them (`fileActions`).
 */
export function FolderPanel({ path, roots, foldersOnly = false, onOpen, onHome, toolbar, fileActions, compact = false }: {
  path: string
  roots: FolderRootDto[]
  foldersOnly?: boolean
  onOpen: (path: string) => void
  onHome: () => void
  /** Actions for the folder shown, beside Refresh and New folder. */
  toolbar?: (page: FolderPageDto) => ReactNode
  fileActions?: (entry: FolderEntryDto) => ReactNode
  /** Inside a dialog: no heading of its own, a list that scrolls. */
  compact?: boolean
}) {
  const t = useT()
  const formatDate = useFormatDate()
  const { state, reload, loadMore } = useFolder(path, foldersOnly)
  const [making, setMaking] = useState(false)
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  // Arriving in another folder, keyboard and screen reader users land on its name once it is read; not on opening.
  const announced = useRef(path)
  const settled = state?.status === 'ready' || state?.status === 'error'
  useEffect(() => {
    if (settled && announced.current !== path) {
      announced.current = path
      heading.current?.focus({ preventScroll: compact })
    }
  }, [settled, path, compact])
  useEffect(() => setMaking(false), [path])

  const page = state?.status === 'ready' ? state.page : null
  const separator = page?.separator ?? separatorOf(path)
  const root = page?.root ?? roots.find(r => isWithin(path, r.path, separator))?.path ?? path
  const up = parentOf(root, path, separator)
  const name = crumbs(root, path, separator).length === 1 ? rootLabel(roots.find(r => r.path === root) ?? { kind: 'added', path }, separator, t) : baseName(path, separator)

  // Backspace or Alt+↑ goes up a folder, unless typing.
  const onKeyDown = (event: KeyboardEvent) => {
    const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, select')
    if (typing || event.defaultPrevented) return
    if (event.key === 'Backspace' || (event.altKey && event.key === 'ArrowUp')) {
      event.preventDefault()
      if (up) onOpen(up)
      else onHome()
    }
  }

  const count = page && (foldersOnly
    ? t(page.total === 1 ? 'files.folderCountOne' : 'files.folderCount', page.total)
    : t(page.total === 1 ? 'files.itemCountOne' : 'files.itemCount', page.total))

  return (
    <section aria-labelledby={headingId} onKeyDown={onKeyDown} className="flex min-w-0 flex-col gap-3">
      <Breadcrumbs page={{ root, path, separator }} roots={roots} onOpen={onOpen} onHome={onHome} />
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} ref={heading} tabIndex={-1}
          className={`break-release min-w-0 flex-1 font-semibold outline-none ${compact ? 'text-base' : 'text-xl'}`}>
          {name}
        </h2>
        {count && <span className="muted text-sm tabular-nums">{count}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-ghost btn-sm" onClick={reload} disabled={state?.status === 'loading'}>
          <RefreshCw size={14} className={state?.status === 'loading' ? 'animate-spin' : ''} aria-hidden />{t('files.refresh')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={making} disabled={state?.status !== 'ready'} onClick={() => setMaking(m => !m)}>
          <FolderPlus size={14} aria-hidden />{t('files.newFolder')}
        </button>
        {page && toolbar?.(page)}
      </div>
      {making && page && <NewFolderForm parent={page.path} onCancel={() => setMaking(false)} onMade={made => { setMaking(false); onOpen(made) }} />}

      {state?.status === 'loading' && (
        <div className="flex justify-center py-12" role="status" aria-live="polite">
          <span className="loading loading-spinner loading-md text-primary" aria-hidden /><span className="sr-only">{t('files.loading')}</span>
        </div>
      )}
      {state?.status === 'error' && (
        <div role="alert" className="alert alert-soft alert-warning flex-wrap">
          <CircleAlert size={18} aria-hidden />
          <span className="break-release min-w-0 flex-1">{state.message}</span>
          <div className="flex gap-2">
            {state.code !== 'forbidden' && <button type="button" className="btn btn-sm" onClick={reload}>{t('common.retry')}</button>}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => (up ? onOpen(up) : onHome())}>{up ? t('files.up') : t('files.backToFiles')}</button>
          </div>
        </div>
      )}
      {state?.status === 'ready' && (
        <>
          {state.page.truncated && <p className="muted text-xs">{t('files.truncated', state.page.total)}</p>}
          {state.entries.length === 0
            ? <p className="muted rounded-box border border-dashed border-base-300 px-4 py-10 text-center text-sm">{t(foldersOnly ? 'files.noFolders' : 'files.empty')}</p>
            : (
              <ul aria-label={t('files.contents', name)} aria-busy={state.more === 'loading'}
                className={`divide-y divide-base-300 rounded-box border border-base-300 bg-base-100 ${compact ? 'max-h-80 overflow-y-auto' : ''}`}>
                {state.entries.map(entry => (
                  <EntryRow key={entry.name} entry={entry} formatDate={formatDate}
                    onOpen={entry.kind === 'folder' ? () => onOpen(joinPath(state.page.path, entry.name, separator)) : undefined}
                    actions={entry.kind === 'file' ? fileActions?.(entry) : undefined} />
                ))}
              </ul>
            )}
          {state.next < state.page.total && (
            state.more === 'loading'
              ? <div className="flex justify-center py-3"><span className="loading loading-spinner loading-sm text-primary" /></div>
              : <ShowMore remaining={state.page.total - state.next} onMore={loadMore} />
          )}
        </>
      )}
    </section>
  )
}

function EntryRow({ entry, formatDate, onOpen, actions }: {
  entry: FolderEntryDto
  formatDate: ReturnType<typeof useFormatDate>
  onOpen?: () => void
  actions?: ReactNode
}) {
  const t = useT()
  const modified = entry.modified === null ? null : new Date(entry.modified).toISOString()
  const facts = [entry.size !== null ? formatBytes(entry.size) : null, modified && formatDate(modified)].filter(Boolean).join(' · ')
  const body = (
    <>
      {entryIcon(entry)}
      <span className="min-w-0 flex-1">
        <span className="break-release block text-sm leading-snug">{entry.name}</span>
        {(facts || entry.download) && (
          <span className="muted mt-0.5 flex flex-wrap items-center gap-x-2 text-xs tabular-nums" title={modified ? formatDate(modified, true) : undefined}>
            {facts && <span>{facts}</span>}
            {entry.download && <span className="badge badge-soft badge-primary badge-xs">{t('files.fromDownload')}</span>}
          </span>
        )}
      </span>
    </>
  )
  return (
    <li className="flex min-h-12 items-center gap-1 pr-2">
      {onOpen
        ? <button type="button" className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left hover:bg-base-200 focus-visible:bg-base-200" onClick={onOpen}>{body}</button>
        : <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5">{body}</div>}
      {actions}
    </li>
  )
}

/** The folders that can be browsed, as cards; on the device itself, a way to add more. */
export function RootList({ roots, canAdd, onOpen, onChanged, compact = false }: {
  roots: FolderRootDto[]
  canAdd: boolean
  onOpen: (path: string) => void
  onChanged: (roots: FolderRootsDto) => void
  compact?: boolean
}) {
  const t = useT()
  const run = useRun()
  const { connection, info, deviceName } = useDevice()
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<FolderRootDto | null>(null)
  const separator = separatorOf(roots[0]?.path ?? '/')

  const add = async () => {
    if (info?.nativeFolderPicker) {
      const picked = await run(() => connection.call('fs.pickNative', { prompt: t('files.addPrompt') }))
      if (picked === undefined) return
      if (picked.path) {
        const next = await run(() => connection.call('fs.addRoot', { path: picked.path! }), 'files.addFailed')
        if (next) onChanged(next)
      }
      return
    }
    setAdding(true)
  }
  const remove = async (root: FolderRootDto | null) => {
    setRemoving(null)
    if (!root) return
    const next = await run(() => connection.call('fs.removeRoot', { path: root.path }), 'files.removeFailed')
    if (next) onChanged(next)
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className={`grid gap-3 ${compact ? '' : 'sm:grid-cols-2'}`} aria-label={t('files.roots')}>
        {roots.map(root => (
          <li key={root.path} className="surface flex items-stretch">
            <button type="button" className="flex min-w-0 flex-1 items-start gap-3 rounded-box p-4 text-left hover:bg-base-200/60" onClick={() => onOpen(root.path)}>
              {root.kind === 'downloads'
                ? <Download size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                : <HardDrive size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{rootLabel(root, separator, t)}</span>
                <span className="muted break-release mt-0.5 block font-mono text-xs">{root.path}</span>
                <span className="mt-1.5 flex flex-wrap gap-2 text-xs">
                  {root.available
                    ? root.freeBytes !== null && <span className="muted tabular-nums">{t('transfer.free', formatBytes(root.freeBytes))}</span>
                    : <span className="badge badge-soft badge-warning badge-sm">{t('files.unavailable')}</span>}
                </span>
              </span>
            </button>
            {root.kind === 'added' && (
              <button type="button" className="btn btn-ghost btn-sm btn-square m-2" aria-label={t('files.remove', root.path)} title={t('files.remove', root.path)}
                onClick={() => setRemoving(root)}>
                <X size={16} aria-hidden />
              </button>
            )}
          </li>
        ))}
      </ul>
      {canAdd
        ? (adding
            ? <AddRootForm onCancel={() => setAdding(false)} onAdded={next => { setAdding(false); onChanged(next) }} />
            : (
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className="btn btn-sm" onClick={() => void add()}><Plus size={14} aria-hidden />{t('files.add')}</button>
                <span className="muted text-xs">{t('files.addHint')}</span>
              </div>
            ))
        : <p className="muted flex items-start gap-2 text-xs"><Info size={14} className="mt-0.5 shrink-0" aria-hidden />{t('files.addOnDevice', deviceName)}</p>}
      <ConfirmDialog open={removing !== null} title={t('files.removeTitle')} message={t('files.removeMessage', removing ? rootLabel(removing, separator, t) : '')}
        options={[{ label: t('common.cancel'), value: null, tone: 'ghost' }, { label: t('common.remove'), value: removing, tone: 'error' }]}
        onResult={root => void remove(root)} />
    </div>
  )
}

/** Adding a folder by its path, where the system's folder chooser can't be shown from here. */
function AddRootForm({ onAdded, onCancel }: { onAdded: (roots: FolderRootsDto) => void; onCancel: () => void }) {
  const t = useT()
  const { connection } = useDevice()
  const id = useId()
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!path.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      onAdded(await connection.call('fs.addRoot', { path: path.trim() }))
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <form className="flex flex-col gap-1.5" onSubmit={e => { e.preventDefault(); void submit() }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onCancel() } }}>
      <label htmlFor={id} className="text-sm font-medium">{t('files.addPath')}</label>
      <div className="flex flex-wrap gap-2">
        <input id={id} autoFocus className="input input-sm min-w-0 flex-1 font-mono" value={path} placeholder={t('files.addPlaceholder')}
          aria-invalid={error !== null} aria-describedby={`${id}-help`} onChange={e => setPath(e.target.value)} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !path.trim()}>
          {busy && <span className="loading loading-spinner loading-xs" />}{t('files.addButton')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
      {error ? <p id={`${id}-help`} role="alert" className="text-xs text-error">{error}</p> : <p id={`${id}-help`} className="muted text-xs">{t('files.addHint')}</p>}
    </form>
  )
}

/** Play and Details for a file of a download, as the download's own details offer them. */
export function DownloadFileActions({ entry, onPlay, onDetails, playing }: {
  entry: FolderEntryDto
  onPlay: (entry: FolderEntryDto) => void
  onDetails: (id: number) => void
  playing: boolean
}) {
  const t = useT()
  if (!entry.download) return null
  return (
    <>
      {entry.media && entry.download.index !== undefined && (
        <button type="button" className="btn btn-ghost btn-sm btn-square text-primary" disabled={playing}
          aria-label={t('player.play', entry.name)} title={t('player.play', entry.name)} onClick={() => onPlay(entry)}>
          {playing ? <span className="loading loading-spinner loading-xs" /> : <Play size={16} aria-hidden />}
        </button>
      )}
      <button type="button" className="btn btn-ghost btn-sm btn-square" aria-label={t('files.details', entry.name)} title={t('files.details', entry.name)}
        onClick={() => onDetails(entry.download!.id)}>
        <Info size={16} aria-hidden />
      </button>
    </>
  )
}
