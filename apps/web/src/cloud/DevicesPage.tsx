import type { CloudDeviceDto } from '@md/protocol/cloud'
import { ChevronRight, Laptop, MonitorSmartphone, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { cloud } from '../lib/cloudApi.ts'
import { useFormatDate, useT } from '../lib/i18n.tsx'
import { forgetDeviceKey, listDeviceKeys } from '../lib/keyStore.ts'
import { ConfirmDialog } from '../ui/Modal.tsx'
import { useToast } from '../ui/toast.tsx'
import { CloudFrame } from './CloudFrame.tsx'

export function DevicesPage() {
  const t = useT()
  const toast = useToast()
  const formatDate = useFormatDate()
  const [devices, setDevices] = useState<CloudDeviceDto[] | null>(null)
  const [linked, setLinked] = useState<Set<string>>(new Set())
  const [removing, setRemoving] = useState<CloudDeviceDto | null>(null)

  const load = useCallback(async () => {
    try {
      const [list, keys] = await Promise.all([cloud.devices(), listDeviceKeys().catch(() => [])])
      setDevices(list)
      setLinked(new Set(keys.map(k => k.deviceId)))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
      setDevices([])
    }
  }, [toast])
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [load])

  return (
    <CloudFrame>
      <h1 className="mb-1 text-2xl font-bold sm:text-3xl">{t('devices.title')}</h1>
      <p className="mb-6 text-sm text-base-content/60">{t('devices.subtitle')}</p>
      {devices === null ? (
        <div className="flex justify-center py-16"><span className="loading loading-spinner loading-lg text-primary" /></div>
      ) : devices.length === 0 ? (
        <div className="surface flex flex-col items-center gap-3 px-6 py-12 text-center">
          <MonitorSmartphone size={40} className="text-primary" />
          <h2 className="text-lg font-semibold">{t('devices.emptyTitle')}</h2>
          <p className="max-w-md text-sm text-base-content/60">{t('devices.emptyHint')}</p>
          <a className="link link-primary text-sm" href="https://github.com/XeonFX/MediaDownloader/releases/latest" target="_blank" rel="noreferrer noopener">{t('devices.download')}</a>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {devices.map(device => {
            const hasKey = linked.has(device.id)
            const body = (
              <>
                <div className={`grid size-11 shrink-0 place-items-center rounded-full ${device.online ? 'bg-success/15 text-success' : 'bg-base-300 text-base-content/50'}`}><Laptop size={22} /></div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{device.name}</div>
                  <div className="text-xs text-base-content/60">
                    <span className={device.online ? 'text-success' : ''}>{device.online ? t('devices.online') : t('devices.offline')}</span>
                    {' · '}{device.platform} · v{device.version}
                    {!device.online && device.lastSeenAt && <> · {t('remote.lastSeen', formatDate(device.lastSeenAt, true))}</>}
                  </div>
                  {!hasKey && <div className="mt-1 text-xs text-warning">{t('devices.notLinked')}</div>}
                </div>
              </>
            )
            return (
              <li key={device.id} className="surface flex items-center gap-2 p-2 pr-3">
                {hasKey
                  ? <Link to={`/d/${encodeURIComponent(device.id)}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-field p-2 hover:bg-base-200">{body}<ChevronRight size={18} className="text-base-content/40" /></Link>
                  : <div className="flex min-w-0 flex-1 items-center gap-3 p-2">{body}</div>}
                <button type="button" className="btn btn-ghost btn-sm btn-square text-error" aria-label={t('devices.remove')} title={t('devices.remove')} onClick={() => setRemoving(device)}><Trash2 size={16} /></button>
              </li>
            )
          })}
        </ul>
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
            toast(e instanceof Error ? e.message : String(e), 'error')
          }
        }} />
    </CloudFrame>
  )
}
