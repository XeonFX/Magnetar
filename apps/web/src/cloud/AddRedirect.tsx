import type { CloudDeviceDto } from '@md/protocol/cloud'
import { Laptop, Magnet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { cloud } from '../lib/cloudApi.ts'
import { useT } from '../lib/i18n.tsx'
import { listDeviceKeys } from '../lib/keyStore.ts'
import { CloudFrame } from './CloudFrame.tsx'

/**
 * Where this browser sends magnet links once it handles them (see the Devices page): straight to
 * the one linked device's add dialog, or a choice between several.
 */
export function AddRedirect() {
  const t = useT()
  const [params] = useSearchParams()
  const magnet = params.get('uri') ?? ''
  const [devices, setDevices] = useState<CloudDeviceDto[] | null>(null)
  useEffect(() => {
    void Promise.all([cloud.devices(), listDeviceKeys().catch(() => [])])
      .then(([list, keys]) => setDevices(list.filter(d => keys.some(k => k.deviceId === d.id))))
      .catch(() => setDevices([]))
  }, [])

  const target = (id: string) => `/d/${encodeURIComponent(id)}?add=${encodeURIComponent(magnet)}`
  if (!magnet.toLowerCase().startsWith('magnet:?')) return <Navigate to="/" replace />
  if (devices === null) return <div className="grid min-h-screen place-items-center"><span className="loading loading-spinner loading-lg text-primary" /></div>
  if (devices.length === 1) return <Navigate to={target(devices[0]!.id)} replace />
  return (
    <CloudFrame>
      <div className="surface mx-auto flex max-w-md flex-col gap-4 p-6">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-field bg-primary/10 text-primary"><Magnet size={20} /></span>
          <h1 className="text-lg font-semibold">{t(devices.length ? 'addRedirect.choose' : 'addRedirect.none')}</h1>
        </div>
        <p className="muted break-all font-mono text-xs">{magnet.slice(0, 160)}{magnet.length > 160 ? '…' : ''}</p>
        {devices.map(d => (
          <Link key={d.id} to={target(d.id)} className="btn justify-start"><Laptop size={16} />{d.name}{!d.online && <span className="muted text-xs">({t('devices.offline')})</span>}</Link>
        ))}
        {devices.length === 0 && <Link to="/" className="btn btn-ghost">{t('devices.back')}</Link>}
      </div>
    </CloudFrame>
  )
}

/** Asks the browser to send magnet links to this site; it confirms with the user itself. */
export function canHandleMagnets(): boolean {
  return 'registerProtocolHandler' in navigator
}

export function handleMagnetsHere(): void {
  navigator.registerProtocolHandler('magnet', `${location.origin}/add?uri=%s`)
}
