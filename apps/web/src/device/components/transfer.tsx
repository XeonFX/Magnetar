import type { SettingsDto, TransferStatusDto } from '@magnetar/protocol'
import { formatBytes, formatRate } from '@magnetar/protocol/bytes'
import { Gauge, HardDrive, ShieldAlert, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router'
import { useT } from '../../lib/i18n.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { useToast } from '../../ui/toast.tsx'
import { useRun } from '../useRun.ts'

/** Why nothing is downloading, when the engine isn't running: a missing VPN, a failed start. */
export function TransferNotice({ transfer }: { transfer: TransferStatusDto | null }) {
  const t = useT()
  const { basePath } = useDevice()
  if (!transfer || transfer.engine === 'running' || transfer.engine === 'off') return null
  const waiting = transfer.engine === 'waitingForNetwork'
  const starting = transfer.engine === 'starting'
  return (
    <div role="status" className={`surface mb-5 flex items-start gap-3 p-4 ${starting ? '' : waiting ? 'border-warning/40 bg-warning/5' : 'border-error/40 bg-error/5'}`}>
      {starting ? <span className="loading loading-spinner loading-sm mt-0.5 text-primary" />
        : waiting ? <ShieldAlert size={20} className="mt-0.5 shrink-0 text-warning" /> : <TriangleAlert size={20} className="mt-0.5 shrink-0 text-error" />}
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-semibold">{t(starting ? 'transfer.starting' : waiting ? 'transfer.waitingTitle' : 'transfer.failedTitle')}</div>
        {!starting && (
          <p className="muted mt-0.5 break-words">
            {waiting ? t('transfer.waitingText', transfer.networkInterface ?? '') : t('transfer.failedText', transfer.message ?? '')}
          </p>
        )}
      </div>
      {waiting && <Link to={`${basePath}/settings/downloads`} className="btn btn-ghost btn-sm shrink-0">{t('transfer.change')}</Link>}
    </div>
  )
}

/**
 * A full disk: what Magnetar writes can't be saved, which no engine state shows. The app logs these errors as warnings
 * rather than reporting them, so this is where the person hears of it, and what to do about it.
 */
export function DiskFullNotice({ transfer }: { transfer: TransferStatusDto | null }) {
  const t = useT()
  const full = transfer?.diskFull
  if (!full) return null
  return (
    <div role="alert" className="surface mb-5 flex items-start gap-3 border-error/40 bg-error/5 p-4">
      <HardDrive size={20} className="mt-0.5 shrink-0 text-error" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-semibold">{t('transfer.diskFullTitle')}</div>
        <p className="muted mt-0.5 break-words">{full.drive ? t('transfer.diskFullText', full.drive) : t('transfer.diskFullHere')}</p>
      </div>
    </div>
  )
}

/** The alternative ("slow") limits, switched on and off from the Downloads page. */
export function AltSpeedToggle({ settings, transfer }: { settings: SettingsDto; transfer: TransferStatusDto | null }) {
  const t = useT()
  const run = useRun()
  const toast = useToast()
  const { connection } = useDevice()
  const active = transfer?.altSpeedActive ?? settings.altSpeedMode === 'on'
  const limits = active ? [settings.altDownloadLimit, settings.altUploadLimit] : [settings.downloadLimit, settings.uploadLimit]
  const describe = (limit: number) => (limit > 0 ? formatRate(limit) : '∞')
  const title = `${t(active ? 'transfer.altOn' : 'transfer.altOff')} — ↓ ${describe(limits[0]!)} ↑ ${describe(limits[1]!)}${settings.altSpeedMode === 'scheduled' ? ` (${t('transfer.scheduled')})` : ''}`
  return (
    <button type="button" aria-pressed={active} title={title} aria-label={title}
      className={`btn btn-sm gap-1.5 rounded-full ${active ? 'btn-warning btn-soft' : 'btn-ghost muted'}`}
      onClick={async () => {
        const saved = await run(() => connection.call('settings.update', { altSpeedMode: active ? 'off' : 'on' }), 'settings.saveFailed')
        // A switch by hand takes over from the schedule, which stays saved for later.
        if (saved && settings.altSpeedMode === 'scheduled') toast(t('transfer.scheduleOff'), 'info')
      }}>
      <Gauge size={15} />{active ? t('transfer.altShort') : t('transfer.fullShort')}
    </button>
  )
}

/** Free space where new downloads go, in warning colour when it runs low. */
export function FreeSpace({ bytes }: { bytes: number | null | undefined }) {
  const t = useT()
  if (bytes == null) return null
  const low = bytes < 5 * 1024 ** 3
  return (
    <span className={`inline-flex items-center gap-1 tabular-nums ${low ? 'text-warning' : ''}`} title={t('transfer.freeHint')}>
      <HardDrive size={14} />{t('transfer.free', formatBytes(bytes))}
    </span>
  )
}
