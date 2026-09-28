import { ArrowLeft, QrCode } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { DeviceProvider } from '../device/DeviceContext.tsx'
import { DeviceRoutes } from '../device/DeviceRoutes.tsx'
import { cloud } from '../lib/cloudApi.ts'
import { browserLanguage, useT } from '../lib/i18n.tsx'
import { getDeviceKey, type StoredDeviceKey } from '../lib/keyStore.ts'
import { RelayConnection } from '../lib/relayConnection.ts'
import { AccountMenu } from './CloudFrame.tsx'
import { CloudFrame } from './CloudFrame.tsx'

/** A device's dashboard through the relay, end-to-end encrypted with this browser's key. */
export function RemoteDevice() {
  const t = useT()
  const { deviceId = '' } = useParams()
  const [key, setKey] = useState<StoredDeviceKey | null | undefined>(undefined)
  const [connection, setConnection] = useState<RelayConnection | null>(null)
  const [name, setName] = useState('')

  useEffect(() => {
    let cancelled = false
    void getDeviceKey(deviceId).catch(() => undefined).then(k => !cancelled && setKey(k ?? null))
    void cloud.devices().then(list => !cancelled && setName(list.find(d => d.id === deviceId)?.name ?? '')).catch(() => {})
    return () => { cancelled = true }
  }, [deviceId])

  useEffect(() => {
    if (!key) return
    const relay = new RelayConnection(deviceId, key)
    setConnection(relay)
    return () => relay.close()
  }, [deviceId, key])

  if (key === undefined) return <div className="grid min-h-screen place-items-center"><span className="loading loading-spinner loading-lg text-primary" /></div>
  if (key === null) {
    return (
      <CloudFrame>
        <div className="surface mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-10 text-center">
          <QrCode size={40} className="text-primary" />
          <h1 className="text-xl font-bold">{t('devices.notLinkedTitle')}</h1>
          <p className="text-sm text-base-content/70">{t('devices.notLinkedHint')}</p>
          <Link to="/" className="btn btn-ghost btn-sm"><ArrowLeft size={14} />{t('devices.back')}</Link>
        </div>
      </CloudFrame>
    )
  }
  if (!connection) return null

  return (
    <DeviceProvider connection={connection} basePath={`/d/${encodeURIComponent(deviceId)}`} deviceName={name || t('devices.device')}>
      <DeviceRoutes fallbackLanguage={browserLanguage()}
        headerStart={<Link to="/" className="btn btn-ghost btn-square btn-sm" aria-label={t('devices.back')} title={t('devices.back')}><ArrowLeft size={18} /></Link>}
        headerEnd={<AccountMenu />} />
    </DeviceProvider>
  )
}
