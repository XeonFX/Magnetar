import { useEffect, useMemo, useState } from 'react'
import { BrowserRouter } from 'react-router'
import { DeviceProvider } from './device/DeviceContext.tsx'
import { DeviceRoutes } from './device/DeviceRoutes.tsx'
import { browserLanguage } from './lib/i18n.tsx'
import { LocalConnection } from './lib/localConnection.ts'

/** The dashboard as served by the app itself on localhost: no account needed. */
export function LocalApp() {
  const connection = useMemo(() => new LocalConnection(), [])
  const [deviceName, setDeviceName] = useState('Magnetar')
  useEffect(() => {
    const load = () => void connection.call('remote.status').then(s => setDeviceName(s.deviceName)).catch(() => {})
    const offState = connection.onState(state => state.status === 'open' && load())
    const offRemote = connection.on('remote.changed', s => setDeviceName(s.deviceName))
    load()
    return () => {
      offState()
      offRemote()
    }
  }, [connection])

  return (
    <BrowserRouter>
      <DeviceProvider connection={connection} basePath="" deviceName={deviceName}>
        <DeviceRoutes fallbackLanguage={browserLanguage()} />
      </DeviceProvider>
    </BrowserRouter>
  )
}
