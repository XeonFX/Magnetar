import { KeyRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { cloud } from '../lib/cloudApi.ts'
import { errorMessage } from '../lib/errors.ts'
import { useT } from '../lib/i18n.tsx'
import { clearParkedKey, parkedKey, saveDeviceKey } from '../lib/keyStore.ts'
import { useAccount } from './CloudApp.tsx'
import { CloudFrame } from './CloudFrame.tsx'
import { captureFragmentKey } from './PairPage.tsx'

const TARGET = 'magnetar-link-device'

/** Opened from a QR code shown by the device or a linked browser: stores the key it carries. */
export function LinkPage() {
  const t = useT()
  const navigate = useNavigate()
  const { account } = useAccount()
  const [deviceId] = useState(() => {
    captureFragmentKey('link', params => {
      const id = params.get('d')
      if (id) sessionStorage.setItem(TARGET, id)
      return id
    })
    return sessionStorage.getItem(TARGET)
  })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!account || !deviceId) return
    const parked = parkedKey('link', deviceId)
    if (!parked) return setError(t('link.invalid'))
    cloud.devices().then(async devices => {
      if (!devices.some(d => d.id === deviceId)) throw new Error(t('link.otherAccount'))
      await saveDeviceKey(deviceId, parked.keyId, parked.key)
      clearParkedKey()
      sessionStorage.removeItem(TARGET)
      navigate(`/d/${encodeURIComponent(deviceId)}`, { replace: true })
    }).catch(e => setError(errorMessage(e)))
  }, [account, deviceId, navigate, t])

  if (!account) return <Navigate to="/login?next=%2Flink" replace />
  return (
    <CloudFrame>
      <div className="surface mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-10 text-center">
        <div className="grid size-14 place-items-center rounded-box bg-primary/10 text-primary"><KeyRound size={28} /></div>
        <h1 className="text-2xl font-bold">{t('link.title')}</h1>
        {error || !deviceId
          ? <div role="alert" className="alert alert-error alert-soft w-full text-sm">{error ?? t('link.invalid')}</div>
          : <span className="loading loading-spinner loading-lg text-primary" />}
      </div>
    </CloudFrame>
  )
}
