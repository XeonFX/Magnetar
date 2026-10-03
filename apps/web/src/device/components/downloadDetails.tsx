import type { DownloadDto, DownloadFileDto } from '@magnetar/protocol'
import { formatBytes } from '@magnetar/protocol/bytes'
import { FileAudio, FileText, FileVideo, FolderOpen, FolderSearch, Info, Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { errorMessage } from '../../lib/errors.ts'
import { isWithin, separatorOf } from '../../lib/folderPaths.ts'
import type { FilesLocation } from '../pages/FilesPage.tsx'
import { useFormatDate, useT } from '../../lib/i18n.tsx'
import { Modal } from '../../ui/Modal.tsx'
import { useDevice, useDownloads } from '../DeviceContext.tsx'
import { useRun } from '../useRun.ts'
import { isFinished, ProgressBar, ratioOf } from './downloads.tsx'
import { PlayerDialog, subtitlesFor, type PlayTarget } from './player.tsx'

/** While the download is running, the file list's progress is read again this often. */
const REFRESH_MS = 2000

/** A download's facts and files: choose which files to fetch, show it on disk. */
export function DownloadDetailsDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const t = useT()
  const download = useDownloads().find(d => d.id === id) ?? null
  return (
    <Modal open={download !== null} title={t('details.title')} icon={<Info size={20} />} onClose={onClose} wide>
      {download && <Details download={download} onClose={onClose} />}
    </Modal>
  )
}

function Details({ download: d, onClose }: { download: DownloadDto; onClose: () => void }) {
  const t = useT()
  const formatDate = useFormatDate()
  const run = useRun()
  const navigate = useNavigate()
  const { connection, info, settings, basePath } = useDevice()
  const local = connection.kind === 'local'
  // Files shows the download folder; a download saved elsewhere may be in a folder it can't browse.
  const browsable = info?.fileBrowser === true && !!settings && isWithin(d.savePath, settings.downloadFolder, separatorOf(settings.downloadFolder))
  const facts: [string, string][] = [
    [t('info.size'), d.totalBytes > 0 ? formatBytes(d.totalBytes) : '—'],
    [t('details.uploaded'), formatBytes(d.uploadedBytes)],
    [t('details.ratio'), ratioOf(d).toFixed(2)],
    [t('details.added'), formatDate(d.addedAt, true)],
    [t('details.finished'), formatDate(d.completedAt, true)],
    [t('info.source'), d.source],
  ]
  return (
    <>
      <p className="break-release mb-3 text-lg font-semibold leading-snug">{d.name}</p>
      {d.status !== 'Completed' && d.status !== 'Error' && <div className="mb-4"><ProgressBar download={d} /></div>}
      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label} className="rounded-field bg-base-200 px-3 py-2">
            <dt className="muted text-xs">{label}</dt>
            <dd className="mt-0.5 truncate text-sm font-medium tabular-nums" title={value}>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="muted min-w-0 flex-1 break-all font-mono text-xs">{d.savePath}</span>
        {browsable && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { onClose(); navigate(`${basePath}/files`, { state: { path: d.savePath } satisfies FilesLocation }) }}>
            <FolderSearch size={14} />{t('files.showInFiles')}
          </button>
        )}
        {local && (
          <button type="button" className="btn btn-sm" onClick={() => void run(() => connection.call('downloads.reveal', { id: d.id }))}>
            <FolderOpen size={14} />{t('details.reveal')}
          </button>
        )}
      </div>
      <FileList download={d} />
    </>
  )
}

function fileIcon(file: DownloadFileDto) {
  if (file.media === 'audio') return <FileAudio size={16} className="shrink-0 text-accent" />
  if (file.media === 'video') return <FileVideo size={16} className="shrink-0 text-info" />
  return <FileText size={16} className="muted shrink-0" />
}

/** The torrent's files with a checkbox each; the choice is saved with one button, not per click. */
function FileList({ download: d }: { download: DownloadDto }) {
  const t = useT()
  const run = useRun()
  const { connection } = useDevice()
  const [files, setFiles] = useState<DownloadFileDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<number> | null>(null)
  const [saving, setSaving] = useState(false)
  const [playing, setPlaying] = useState<PlayTarget | null>(null)
  const running = d.status === 'Downloading' || d.status === 'Seeding'
  const hasMetadata = d.totalBytes > 0

  useEffect(() => {
    if (!hasMetadata) return
    let cancelled = false
    const load = () => connection.call('downloads.files', { id: d.id })
      .then(list => { if (!cancelled) { setFiles(list); setError(null) } })
      .catch((e: unknown) => { if (!cancelled) setError(errorMessage(e)) })
    void load()
    const timer = running ? setInterval(() => void load(), REFRESH_MS) : undefined
    return () => { cancelled = true; clearInterval(timer) }
  }, [connection, d.id, running, hasMetadata])

  const selected = useMemo(() => chosen ?? new Set(files?.filter(f => f.selected).map(f => f.index)), [chosen, files])
  const dirty = chosen !== null && files !== null && files.some(f => f.selected !== chosen.has(f.index))
  const chosenBytes = files?.filter(f => selected.has(f.index)).reduce((sum, f) => sum + f.size, 0) ?? 0

  if (!hasMetadata) return <p className="muted text-sm">{t('details.filesPending')}</p>
  if (error && !files) return <p className="text-sm text-error">{error}</p>
  if (!files) return <div className="flex justify-center py-6"><span className="loading loading-spinner text-primary" /></div>

  const toggle = (index: number) => setChosen(() => {
    const next = new Set(selected)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    return next
  })
  const save = async () => {
    setSaving(true)
    const updated = await run(() => connection.call('downloads.selectFiles', { id: d.id, files: [...selected] }), 'details.selectFailed')
    setSaving(false)
    if (updated) {
      setChosen(null)
      setFiles(list => list?.map(f => ({ ...f, selected: selected.has(f.index) })) ?? null)
    }
  }

  return (
    <section aria-labelledby="magnetar-files">
      <div className="mb-2 flex items-center gap-2">
        <h4 id="magnetar-files" className="flex-1 text-sm font-semibold">{t('details.files', files.length)}</h4>
        {files.length > 1 && (
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setChosen(selected.size === files.length ? new Set() : new Set(files.map(f => f.index)))}>
            {selected.size === files.length ? t('details.selectNone') : t('details.selectAll')}
          </button>
        )}
      </div>
      <ul className="max-h-80 divide-y divide-base-300 overflow-y-auto rounded-field border border-base-300">
        {files.map(file => {
          const percent = file.size > 0 ? Math.round((file.done / file.size) * 100) : 100
          return (
            <li key={file.index} className="flex items-center gap-3 px-3 py-2">
              {files.length > 1 && (
                <input type="checkbox" className="checkbox checkbox-sm checkbox-primary" checked={selected.has(file.index)}
                  aria-label={t('details.fileChoose', file.path)} onChange={() => toggle(file.index)} />
              )}
              {fileIcon(file)}
              <div className="min-w-0 flex-1">
                <div className="break-release text-sm leading-snug">{file.path}</div>
                <div className="muted mt-0.5 text-xs tabular-nums">
                  {formatBytes(file.size)}{selected.has(file.index) && percent < 100 ? ` · ${percent}%` : ''}
                  {!selected.has(file.index) && ` · ${t('details.skipped')}`}
                </div>
              </div>
              {file.media && file.selected && (file.done > 0 || running) && (
                <button type="button" className="btn btn-ghost btn-sm btn-square text-primary" aria-label={t('player.play', file.path)} title={t('player.play', file.path)}
                  onClick={() => setPlaying({ downloadId: d.id, file, subtitles: subtitlesFor(file, files) })}>
                  <Play size={16} />
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {dirty && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="muted flex-1 text-sm">{selected.size === 0 ? t('details.chooseOne') : t('details.chosenSize', selected.size, formatBytes(chosenBytes))}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setChosen(null)}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={saving || selected.size === 0} onClick={() => void save()}>
            {saving && <span className="loading loading-spinner loading-xs" />}{t('details.saveFiles')}
          </button>
        </div>
      )}
      <PlayerDialog target={playing} finished={isFinished(d)} onClose={() => setPlaying(null)} />
    </section>
  )
}
