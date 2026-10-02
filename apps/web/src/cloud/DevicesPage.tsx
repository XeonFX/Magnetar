import type { CloudDeviceDto } from '@magnetar/protocol/cloud'
import { ArrowUpCircle, ChevronRight, Laptop, Magnet, MonitorSmartphone, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { cloud } from '../lib/cloudApi.ts'
import { errorMessage } from '../lib/errors.ts'
import { useFormatRelative, useT } from '../lib/i18n.tsx'
import { forgetDeviceKey, listDeviceKeys } from '../lib/keyStore.ts'
import { isOutdated } from '@codefusion-cc/app-update'
import { useLatestRelease } from '../lib/releases.ts'
import { Empty } from '../ui/Empty.tsx'
import { Loading } from '../ui/Loading.tsx'
import { ConfirmDialog } from '../ui/Modal.tsx'
import { PageHeader } from '../ui/controls.tsx'
import { useToast } from '../ui/toast.tsx'
import { canHandleMagnets, handleMagnetsHere } from './AddRedirect.tsx'
import { CloudFrame } from './CloudFrame.tsx'
import { devicePath } from './devicePaths.ts'
import { DownloadApp } from './DownloadApp.tsx'

export function DevicesPage() {
  const t = useT()
  const toast = useToast()
  const formatRelative = useFormatRelative()
  const [devices, setDevices] = useState<CloudDeviceDto[] | null>(null)
  const [linked, setLinked] = useState<Set<string>>(new Set())
  const [removing, setRemoving] = useState<CloudDeviceDto | null>(null)
  const latest = useLatestRelease()

  const load = useCallback(async () => {
    try {
      const [list, keys] = await Promise.all([cloud.devices(), listDeviceKeys().catch(() => [])])
      setDevices(list)
      setLinked(new Set(keys.map(k => k.deviceId)))
    } catch (e) {
      toast(errorMessage(e), 'error')
      setDevices([])
    }
  }, [toast])
  // Online dots stay current while the page is looked at; a hidden tab doesn't poll.
  useEffect(() => {
    void load()
    const timer = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    const visible = () => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [load])

  return (
    <CloudFrame>
      <PageHeader title={t('devices.title')} summary={t('devices.subtitle')} />
      {devices === null ? (
        <Loading />
      ) : devices.length === 0 ? (
        <Empty icon={<MonitorSmartphone size={40} strokeWidth={1.5} className="text-primary" />} title={t('devices.emptyTitle')} text={t('devices.emptyHint')}>
          <div className="mx-auto w-full max-w-sm text-left"><DownloadApp /></div>
        </Empty>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {devices.map(device => {
              const hasKey = linked.has(device.id)
              const body = (
                <>
                  <span className="relative grid size-11 shrink-0 place-items-center rounded-field bg-base-200">
                    <Laptop size={22} className={device.online ? '' : 'muted'} />
                    <span className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-base-100 ${device.online ? 'bg-success' : 'bg-base-300'}`} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{device.name}</div>
                    <div className="muted mt-0.5 text-xs">
                      {device.online ? <span className="text-success">{t('devices.online')}</span>
                        : device.lastSeenAt ? t('remote.lastSeen', formatRelative(device.lastSeenAt)) : t('devices.offline')}
                      {' · '}{device.platform}{device.version && <> · v{device.version}</>}
                    </div>
                    {latest && isOutdated(device.version, latest.version) && (
                      <div className="mt-1 flex items-center gap-1 text-xs text-info"><ArrowUpCircle size={12} aria-hidden />{t('devices.outdated', latest.version)}</div>
                    )}
                    {!hasKey && <div className="mt-1 text-xs text-warning">{t('devices.notLinked')}</div>}
                  </div>
                </>
              )
              return (
                <li key={device.id} className="surface flex items-center gap-1 p-2 transition-colors hover:border-base-content/20">
                  {/* Not linked yet: the device page explains how to link this browser. */}
                  <Link to={devicePath(device.name)} className="flex min-w-0 flex-1 items-center gap-3 rounded-field p-2">{body}<ChevronRight size={18} className="muted" /></Link>
                  <button type="button" className="btn btn-ghost btn-sm btn-square muted hover:text-error" aria-label={t('devices.remove')} title={t('devices.remove')} onClick={() => setRemoving(device)}><Trash2 size={16} /></button>
                </li>
              )
            })}
          </ul>
          <p className="muted mt-6 text-sm">{t('devices.addHint')}</p>
          {canHandleMagnets() && linked.size > 0 && (
            <div className="surface mt-6 flex flex-wrap items-center gap-3 p-4">
              <Magnet size={18} className="text-primary" />
              <p className="min-w-0 flex-1 text-sm">{t('devices.magnetsHint')}</p>
              <button type="button" className="btn btn-sm" onClick={() => { handleMagnetsHere(); toast(t('devices.magnetsAsked'), 'info') }}>{t('devices.magnetsButton')}</button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog open={removing !== null} title={t('devices.removeTitle')} message={t('devices.removeConfirm', removing?.name ?? '')}
        options={[{ label: t('common.cancel'), value: false, tone: 'ghost' }, { label: t('devices.remove'), value: true, tone: 'error' }]}
        onResult={async confirmed => {
          const device = removing
          setRemoving(null)
          if (!confirmed || !device) return
          try {
            await cloud.removeDevice(device.id)
            await forgetDeviceKey(device.id).catch(() => {})
            await load()
          } catch (e) {
            toast(errorMessage(e), 'error')
          }
        }} />
    </CloudFrame>
  )
}
