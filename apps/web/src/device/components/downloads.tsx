import type { DownloadDto, DownloadStatus } from '@magnetar/protocol'
import { formatBytes, formatRate } from '@magnetar/protocol/bytes'
import { ArrowDown, ArrowUp, Clock, Files, Pause, Play, RotateCw, Trash2, Tv, Users } from 'lucide-react'
import { memo, useState } from 'react'
import { useFormatEta, useT } from '../../lib/i18n.tsx'
import { ConfirmDialog } from '../../ui/Modal.tsx'
import { useConnection } from '../DeviceContext.tsx'
import { useRun } from '../useRun.ts'

const STATUS: Record<DownloadStatus, { key: string; text: string; bar: string }> = {
  Queued: { key: 'status.queued', text: 'muted', bar: 'bg-base-content/30' },
  FetchingMetadata: { key: 'status.fetchingMetadata', text: 'text-info', bar: 'bg-info' },
  Downloading: { key: 'status.downloading', text: 'text-info', bar: 'bg-info' },
  Seeding: { key: 'status.seeding', text: 'text-accent', bar: 'bg-accent' },
  Paused: { key: 'status.paused', text: 'text-warning', bar: 'bg-warning' },
  Completed: { key: 'status.completed', text: 'text-success', bar: 'bg-success' },
  Error: { key: 'status.error', text: 'text-error', bar: 'bg-error' },
}

/** Doing something right now (and so shown in the tray and the Active filter). */
export function isActive(d: DownloadDto): boolean {
  return d.status === 'Downloading' || d.status === 'FetchingMetadata' || d.status === 'Queued' || d.status === 'Seeding'
}

/** Everything it was asked for is on disk. */
export function isFinished(d: DownloadDto): boolean {
  return d.status === 'Completed' || d.status === 'Seeding'
}

export function ProgressBar({ download }: { download: DownloadDto }) {
  const t = useT()
  const value = Math.min(100, Math.max(0, download.progress))
  const fetching = download.status === 'FetchingMetadata'
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-base-300" role="progressbar" aria-label={t(STATUS[download.status].key)}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={fetching ? undefined : Math.round(value)}>
      <div className={`h-full rounded-full transition-[width] duration-700 ${STATUS[download.status].bar} ${fetching ? 'w-1/3 animate-pulse' : ''}`}
        style={fetching ? undefined : { width: `${value}%` }} />
    </div>
  )
}

/** Uploaded ÷ size, the usual measure of how much a download has given back. */
export const ratioOf = (d: DownloadDto) => (d.totalBytes > 0 ? d.uploadedBytes / d.totalBytes : 0)

/**
 * One download: name, progress, and a line of what is happening; the actions on the right. The
 * name opens its details. Memoized: once-a-second updates keep unchanged rows' objects.
 */
export const DownloadRow = memo(function DownloadRow({ download: d, seriesName, onOpen }: {
  download: DownloadDto
  seriesName?: string
  onOpen: (id: number) => void
}) {
  const t = useT()
  const formatEta = useFormatEta()
  const status = STATUS[d.status]
  const percent = Math.round(d.progress * 10) / 10
  const done = isFinished(d)
  const remaining = d.totalBytes * (1 - d.progress / 100)
  const eta = d.status === 'Downloading' && d.downloadSpeed > 0 && d.totalBytes > 0 ? remaining / d.downloadSpeed : null

  const facts = [
    <span key="status" className={`font-medium ${status.text}`}>{t(status.key)}{d.status === 'Downloading' || d.status === 'Paused' ? ` · ${percent}%` : ''}</span>,
    d.totalBytes > 0 && (
      <span key="size" className="tabular-nums">
        {done ? formatBytes(d.totalBytes) : t('downloads.sizeOf', formatBytes(d.totalBytes * d.progress / 100), formatBytes(d.totalBytes))}
      </span>
    ),
    d.downloadSpeed > 0 && <span key="down" className="inline-flex items-center gap-0.5 tabular-nums"><ArrowDown size={12} />{formatRate(d.downloadSpeed)}</span>,
    d.uploadSpeed > 0 && <span key="up" className="inline-flex items-center gap-0.5 tabular-nums"><ArrowUp size={12} />{formatRate(d.uploadSpeed)}</span>,
    eta !== null && <span key="eta" className="inline-flex items-center gap-1"><Clock size={12} />{formatEta(eta)}</span>,
    isActive(d) && d.peers > 0 && <span key="peers" className="inline-flex items-center gap-1 tabular-nums"><Users size={12} />{d.peers}</span>,
    d.status === 'Seeding' && d.uploadedBytes > 0 && <span key="ratio" className="tabular-nums">{t('downloads.ratio', ratioOf(d).toFixed(2))}</span>,
    d.partialFiles && <span key="files" className="inline-flex items-center gap-1"><Files size={12} />{t('downloads.someFiles', d.partialFiles.selected, d.partialFiles.total)}</span>,
  ].filter(Boolean)

  return (
    <li className="surface p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <button type="button" className="break-release text-left font-medium leading-snug hover:underline" onClick={() => onOpen(d.id)}>{d.name}</button>
          {seriesName && <div className="muted mt-1 inline-flex items-center gap-1 text-xs"><Tv size={12} />{seriesName}</div>}
        </div>
        <DownloadActions download={d} />
      </div>
      {d.status !== 'Completed' && d.status !== 'Error' && <div className="mt-3"><ProgressBar download={d} /></div>}
      <div className="muted mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">{facts}</div>
      {d.error && <p className="break-release mt-2 text-sm text-error">{d.error}</p>}
    </li>
  )
})

/**
 * Pause while doing anything, resume while paused, retry after an error; delete always —
 * asking whether to also delete the files.
 */
export function DownloadActions({ download }: { download: DownloadDto }) {
  const t = useT()
  const connection = useConnection()
  const run = useRun()
  const [confirming, setConfirming] = useState(false)
  const button = 'btn btn-ghost btn-square size-10 sm:size-9'
  const primary = isActive(download)
    ? { label: t('common.pause'), icon: <Pause size={18} />, method: 'downloads.pause' as const }
    : download.status === 'Paused' ? { label: t('common.resume'), icon: <Play size={18} />, method: 'downloads.resume' as const }
    : download.status === 'Error' ? { label: t('common.retry'), icon: <RotateCw size={18} />, method: 'downloads.resume' as const }
    : null

  return (
    <div className="-mr-2 -mt-2 flex shrink-0">
      {primary && (
        <button type="button" className={button} title={primary.label} aria-label={primary.label}
          onClick={() => void run(() => connection.call(primary.method, { id: download.id }))}>{primary.icon}</button>
      )}
      <button type="button" className={`${button} muted hover:text-error`} title={t('common.delete')} aria-label={t('common.delete')}
        onClick={() => setConfirming(true)}><Trash2 size={18} /></button>
      {confirming && <ConfirmDialog
        open
        title={t('downloads.deleteTitle')}
        message={t('downloads.deleteMessage', download.name)}
        options={[
          { label: t('common.cancel'), value: null, tone: 'ghost' },
          { label: t('downloads.keepFiles'), value: false, tone: 'primary' },
          { label: t('downloads.deleteFiles'), value: true, tone: 'error' },
        ]}
        onResult={deleteFiles => {
          setConfirming(false)
          if (deleteFiles !== null) void run(() => connection.call('downloads.delete', { id: download.id, deleteFiles }))
        }}
      />}
    </div>
  )
}
