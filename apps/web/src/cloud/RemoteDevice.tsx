import type { CloudDeviceDto } from '@magnetar/protocol/cloud'
import { sameDeviceName } from '@magnetar/protocol/device-name'
import { ArrowLeft, Laptop, QrCode, SearchX } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { DeviceProvider, useDevice } from '../device/DeviceContext.tsx'
import { DeviceRoutes } from '../device/DeviceRoutes.tsx'
import { cloud } from '../lib/cloudApi.ts'
import { browserLanguage, useT } from '../lib/i18n.tsx'
import { getDeviceKey, type StoredDeviceKey } from '../lib/keyStore.ts'
import { RelayConnection } from '../lib/relayConnection.ts'
import { Loading } from '../ui/Loading.tsx'
import { AccountMenu } from './CloudFrame.tsx'
import { CloudFrame } from './CloudFrame.tsx'
import { deviceIdPath, devicePath, samePageOn } from './devicePaths.ts'
import { DeviceSwitcher } from './DeviceSwitcher.tsx'

/**
 * The account's devices for finding one by its address: the list last fetched at once, then a fresh one each
 * time the address names another device. `state` says whether the list on hand is from this visit.
 */
function useDeviceList(address: string) {
  const [devices, setDevices] = useState(() => cloud.knownDevices())
  const [state, setState] = useState<'loading' | 'fresh' | 'failed'>('loading')
  const load = useCallback(() => {
    let cancelled = false
    setState('loading')
    cloud.devices().then(list => {
      if (cancelled) return
      setDevices(list)
      setState('fresh')
    }, () => !cancelled && setState('failed'))
    return () => { cancelled = true }
  }, [])
  // Names match in any case, so moving to the device's own spelling is not another device.
  useEffect(load, [load, address.toLowerCase()])
  return { devices, state, retry: load, setDevices }
}

/** What to show while the device an address names is not known: loading, a failed list, or no such device. */
function DeviceLookup({ devices, state, retry, name }: ReturnType<typeof useDeviceList> & { name: string }) {
  const t = useT()
  if (state === 'failed') {
    return (
      <CloudFrame>
        <div role="alert" className="surface mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-10 text-center">
          <p className="text-sm">{t('devices.loadFailed')}</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={retry}>{t('common.retry')}</button>
        </div>
      </CloudFrame>
    )
  }
  // A list from before this visit may predate a rename: only a fresh one may say the device is not there.
  if (!devices || state !== 'fresh') return <Loading screen />
  return (
    <CloudFrame>
      <div className="surface mx-auto flex max-w-md flex-col gap-4 p-6">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-field bg-warning/10 text-warning"><SearchX size={20} /></span>
          <h1 className="min-w-0 break-words text-lg font-semibold">{t('devices.notFoundTitle', name)}</h1>
        </div>
        <p className="muted text-sm">{t('devices.notFoundHint')}</p>
        {devices.map(d => <Link key={d.id} to={devicePath(d.name)} className="btn justify-start"><Laptop size={16} />{d.name}</Link>)}
        <Link to="/" className="btn btn-ghost"><ArrowLeft size={14} />{t('devices.back')}</Link>
      </div>
    </CloudFrame>
  )
}

/** `/d/<device id>/…`: the same page under the device's name, which is what the address bar should show. */
export function DeviceIdRedirect() {
  const { deviceId = '' } = useParams()
  const { pathname, search, hash } = useLocation()
  const list = useDeviceList(deviceId)
  const device = list.devices?.find(d => d.id === deviceId)
  if (!device) return <DeviceLookup {...list} name={deviceId} />
  return <Navigate replace to={samePageOn(pathname, search, deviceIdPath(deviceId), devicePath(device.name)) + hash} />
}

/** A device's dashboard through the relay, end-to-end encrypted with this browser's key, found by its name. */
export function RemoteDevice() {
  const { deviceName = '' } = useParams()
  const { pathname, search, hash } = useLocation()
  const list = useDeviceList(deviceName)
  const { setDevices } = list
  const device = list.devices?.find(d => sameDeviceName(d.name, deviceName))
  // The app was renamed while its page is open: the list learns the name, and the address follows.
  const renamed = useCallback((id: string, name: string) => setDevices(all => all?.map(d => (d.id === id ? { ...d, name } : d)) ?? all), [setDevices])
  if (!device) return <DeviceLookup {...list} name={deviceName} />
  // Names match in any case; the address shows the device's own spelling.
  if (device.name !== deviceName) return <Navigate replace to={samePageOn(pathname, search, devicePath(deviceName), devicePath(device.name)) + hash} />
  // Keyed by device: switching to another starts clean, with nothing of the last one's key, connection or state.
  return <DeviceView key={device.id} device={device} onRenamed={renamed} />
}

function DeviceView({ device, onRenamed }: { device: CloudDeviceDto; onRenamed: (id: string, name: string) => void }) {
  const t = useT()
  const [key, setKey] = useState<StoredDeviceKey | null | undefined>(undefined)
  const [connection, setConnection] = useState<RelayConnection | null>(null)

  useEffect(() => {
    let cancelled = false
    void getDeviceKey(device.id).catch(() => undefined).then(k => !cancelled && setKey(k ?? null))
    return () => { cancelled = true }
  }, [device.id])

  useEffect(() => {
    if (!key) return
    const relay = new RelayConnection(device.id, key)
    setConnection(relay)
    return () => relay.close()
  }, [device.id, key])

  if (key === undefined) return <Loading screen />
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
    <DeviceProvider connection={connection} basePath={devicePath(device.name)} deviceName={device.name}>
      <FollowRename device={device} onRenamed={onRenamed} />
      <DeviceRoutes fallbackLanguage={browserLanguage()}
        headerStart={<Link to="/" className="btn btn-ghost btn-square btn-sm" aria-label={t('devices.back')} title={t('devices.back')}><ArrowLeft size={18} /></Link>}
        headerEnd={<AccountMenu />}
        deviceMenu={(label, placement) => <DeviceSwitcher placement={placement}>{label}</DeviceSwitcher>} />
    </DeviceProvider>
  )
}

/**
 * Moves the address to the device's new name when the app says it was renamed, keeping the page and its connection.
 * The account's list has the last word: an app from before names were addresses may still call itself by a name the
 * account gave another device.
 */
function FollowRename({ device, onRenamed }: { device: CloudDeviceDto; onRenamed: (id: string, name: string) => void }) {
  const { remote } = useDevice()
  const navigate = useNavigate()
  const location = useLocation()
  const here = useRef(location)
  here.current = location
  const reported = remote?.deviceName
  useEffect(() => {
    if (!reported || reported === device.name) return
    let cancelled = false
    void cloud.devices().then(list => {
      const name = list.find(d => d.id === device.id)?.name
      if (cancelled || !name || name === device.name) return
      const { pathname, search, hash } = here.current
      onRenamed(device.id, name)
      navigate(samePageOn(pathname, search, devicePath(device.name), devicePath(name)) + hash, { replace: true })
    }, () => {})
    return () => { cancelled = true }
  }, [reported])
  return null
}
