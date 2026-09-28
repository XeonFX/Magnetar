import type { DownloadDto, DownloadStatus } from '@md/protocol'
import { formatBytes, formatRate } from '@md/protocol/bytes'
import { Pause, Play, RotateCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../lib/i18n.tsx'
import { ConfirmDialog } from '../../ui/Modal.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { useRun } from '../useRun.ts'

const STATUS_KEYS: Record<DownloadStatus, string> = {
  Queued: 'status.queued', FetchingMetadata: 'status.fetchingMetadata', Downloading: 'status.downloading',
  Seeding: 'status.seeding', Paused: 'status.paused', Completed: 'status.completed', Error: 'status.error',
}

export function StatusBadge({ status }: { status: DownloadStatus }) {
  const t = useT()
  const tone = status === 'Downloading' ? 'badge-primary'
    : status === 'Seeding' || status === 'Completed' ? 'badge-success'
    : status === 'Paused' ? 'badge-warning'
    : status === 'Error' ? 'badge-error'
    : 'badge-ghost'
  return <span className={`badge badge-soft badge-sm whitespace-nowrap ${tone}`}>{t(STATUS_KEYS[status])}</span>
}

export function ProgressBar({ download }: { download: DownloadDto }) {
  const tone = download.status === 'Completed' || download.status === 'Seeding' ? 'progress-success'
    : download.status === 'Error' ? 'progress-error'
    : download.status === 'Paused' ? 'progress-warning'
    : 'progress-primary'
  const value = Math.round(download.progress * 10) / 10
  return (
    <div className="flex items-center gap-2">
      {download.status === 'FetchingMetadata'
        ? <progress className="progress progress-primary w-full" />
        : <progress className={`progress w-full ${tone}`} value={value} max={100} />}
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-base-content/70">{value}%</span>
    </div>
  )
}

export function Speed({ download }: { download: DownloadDto }) {
  if (!download.downloadSpeed && !download.uploadSpeed) return null
  return (
    <span className="whitespace-nowrap text-xs tabular-nums text-base-content/70">
      ↓ {formatRate(download.downloadSpeed)}<br />↑ {formatRate(download.uploadSpeed)}
    </span>
  )
}

export function DownloadName({ download }: { download: DownloadDto }) {
  return (
    <div className="min-w-0">
      <div className="break-release text-sm font-medium">{download.name}</div>
      {download.error && <div className="break-release text-xs text-error">{download.error}</div>}
    </div>
  )
}

/**
 * Pause while doing anything, resume while paused, retry after an error; delete always —
 * asking whether to also delete the files.
 */
export function DownloadActions({ download }: { download: DownloadDto }) {
  const t = useT()
  const { connection } = useDevice()
  const run = useRun()
  const [confirming, setConfirming] = useState(false)
  const active = ['Downloading', 'FetchingMetadata', 'Seeding', 'Queued'].includes(download.status)

  return (
    <div className="flex justify-end gap-1">
      {active && (
        <button type="button" className="btn btn-ghost btn-sm btn-square" title={t('common.pause')} aria-label={t('common.pause')}
          onClick={() => void run(() => connection.call('downloads.pause', { id: download.id }))}><Pause size={16} /></button>
      )}
      {download.status === 'Paused' && (
        <button type="button" className="btn btn-ghost btn-sm btn-square" title={t('common.resume')} aria-label={t('common.resume')}
          onClick={() => void run(() => connection.call('downloads.resume', { id: download.id }))}><Play size={16} /></button>
      )}
      {download.status === 'Error' && (
        <button type="button" className="btn btn-ghost btn-sm btn-square" title={t('common.retry')} aria-label={t('common.retry')}
          onClick={() => void run(() => connection.call('downloads.resume', { id: download.id }))}><RotateCw size={16} /></button>
      )}
      <button type="button" className="btn btn-ghost btn-sm btn-square text-error" title={t('common.delete')} aria-label={t('common.delete')}
        onClick={() => setConfirming(true)}><Trash2 size={16} /></button>
      <ConfirmDialog
        open={confirming}
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
      />
    </div>
  )
}

export function Size({ bytes }: { bytes: number }) {
  return <span className="whitespace-nowrap text-xs tabular-nums">{bytes ? formatBytes(bytes) : '—'}</span>
}
