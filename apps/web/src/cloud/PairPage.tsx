import type { PairingInfoDto } from '@magnetar/protocol/cloud'
import { fromBase64Url } from '@magnetar/protocol/base64'
import { Check, Laptop, Link2, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { cloud } from '../lib/cloudApi.ts'
import { errorMessage } from '../lib/errors.ts'
import { useT } from '../lib/i18n.tsx'
import { clearParkedKey, parkKey, parkedKey, saveDeviceKey } from '../lib/keyStore.ts'
import { useAccount } from './CloudApp.tsx'
import { CloudFrame } from './CloudFrame.tsx'
import { devicePath } from './devicePaths.ts'

/** Reads a key from `#i=<keyId>&k=<key>` into session storage and drops it from the address bar. */
export function captureFragmentKey(kind: 'pair' | 'link', target: (params: URLSearchParams) => string | null): void {
  const params = new URLSearchParams(location.hash.slice(1))
  const keyId = params.get('i')
  const key = params.get('k')
  const id = target(params)
  if (!keyId || !key || !id) return
  history.replaceState(history.state, '', location.pathname + location.search)
  try {
    const raw = fromBase64Url(key)
    if (raw.length === 32) parkKey(kind, id, keyId, raw)
  } catch {
    // A mangled link: pairing still works, this browser just won't be linked.
  }
}

/**
 * Opened from the device's own dashboard. The signed-in user approves; the Worker binds the device
 * to the account, and the key that came in the fragment is stored so this browser is linked at once.
 */
export function PairPage() {
  const t = useT()
  const navigate = useNavigate()
  const { pairingId = '' } = useParams()
  const { account } = useAccount()
  const [captured] = useState(() => {
    captureFragmentKey('pair', () => pairingId)
    return true
  })
  const [info, setInfo] = useState<PairingInfoDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!account || !captured) return
    cloud.pairing(pairingId).then(setInfo, e => setError(errorMessage(e)))
  }, [account, pairingId, captured])

  if (!account) return <Navigate to={`/login?next=${encodeURIComponent(`/pair/${pairingId}`)}`} replace />

  const approve = async () => {
    setBusy(true)
    setError(null)
    try {
      const { deviceId } = await cloud.approvePairing(pairingId)
      const parked = parkedKey('pair', pairingId)
      if (parked) await saveDeviceKey(deviceId, parked.keyId, parked.key)
      clearParkedKey()
      navigate(devicePath(deviceId), { replace: true })
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <CloudFrame>
      <div className="surface mx-auto flex max-w-md flex-col items-center gap-5 px-6 py-10 text-center">
        <div className="grid size-14 place-items-center rounded-box bg-primary/10 text-primary"><Link2 size={28} /></div>
        <h1 className="text-2xl font-bold">{t('pair.title')}</h1>
        {error && <div role="alert" className="alert alert-error alert-soft w-full text-sm">{error}</div>}
        {!info && !error && <span className="loading loading-spinner loading-lg text-primary" />}
        {info && info.state === 'pending' && (
          <>
            <div className="flex w-full items-center gap-3 rounded-box border border-base-300 bg-base-200 p-4 text-left">
              <Laptop size={28} className="shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="truncate font-semibold">{info.name}</div>
                <div className="text-xs text-base-content/60">{info.platform} · Magnetar {info.version}</div>
              </div>
            </div>
            <p className="text-sm">{t('pair.question', account.email)}</p>
            {!parkedKey('pair', pairingId) && <p className="text-xs text-warning">{t('pair.noKey')}</p>}
            <div className="flex w-full gap-2">
              <button type="button" className="btn btn-ghost flex-1" onClick={() => navigate('/')}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-primary flex-1" disabled={busy} onClick={() => void approve()}>
                {busy ? <span className="loading loading-spinner loading-sm" /> : <Check size={16} />}{t('pair.approve')}
              </button>
            </div>
            <p className="flex items-start gap-2 text-left text-xs text-base-content/60"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-success" />{t('cloud.e2eNote')}</p>
          </>
        )}
        {info && info.state !== 'pending' && <p className="text-sm text-base-content/70">{info.state === 'expired' ? t('pair.expired') : t('pair.alreadyApproved')}</p>}
      </div>
    </CloudFrame>
  )
}
