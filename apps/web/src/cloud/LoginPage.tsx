import { KeyRound, Lock, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { cloud } from '../lib/cloudApi.ts'
import { startGoogleSignIn, takeGoogleSignInResult } from '../lib/googleSignIn.ts'
import { useLanguage, useT } from '../lib/i18n.tsx'
import { useAccount } from './CloudApp.tsx'
import { CloudFrame } from './CloudFrame.tsx'

function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

export function LoginPage() {
  const t = useT()
  const language = useLanguage()
  const { account, config, refresh } = useAccount()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [devEmail, setDevEmail] = useState('dev@localhost')
  const handled = useRef(false)

  // Coming back from Google: the token is in the fragment, verified by the Worker.
  useEffect(() => {
    if (handled.current) return
    handled.current = true
    const result = takeGoogleSignInResult()
    if (!result) return
    if ('error' in result) return setError(result.error)
    setBusy(true)
    cloud.completeSignIn(result.credential).then(refresh, e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false))
  }, [refresh])

  if (account) return <Navigate to={next} replace />

  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      const { nonce, clientId } = await cloud.startSignIn()
      startGoogleSignIn(clientId, nonce, next, language)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const devSignIn = async () => {
    setBusy(true)
    try {
      await cloud.devSignIn(devEmail)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <CloudFrame>
      <div className="surface mx-auto flex max-w-md flex-col items-center gap-5 px-6 py-10 text-center">
        <div className="grid size-14 place-items-center rounded-full bg-primary/10 text-primary"><Lock size={28} /></div>
        <div>
          <h1 className="text-2xl font-bold">{t('cloud.signInTitle')}</h1>
          <p className="mt-2 text-sm text-base-content/60">{t('cloud.signInHint')}</p>
        </div>
        {error && <div role="alert" className="alert alert-error alert-soft w-full text-sm">{error}</div>}
        {config.googleClientId && (
          <button type="button" className="btn btn-lg w-full gap-3 border-base-300 bg-base-100" disabled={busy} onClick={() => void signIn()}>
            {busy ? <span className="loading loading-spinner" /> : <GoogleLogo />}{t('cloud.signInGoogle')}
          </button>
        )}
        {config.devLogin && (
          <div className="w-full rounded-box border border-dashed border-warning p-3 text-left">
            <p className="mb-2 text-xs text-warning">{t('cloud.devLogin')}</p>
            <div className="join w-full">
              <input className="input join-item w-full" value={devEmail} onChange={e => setDevEmail(e.target.value)} aria-label="Email" />
              <button type="button" className="btn btn-warning join-item" aria-label="Sign in" disabled={busy} onClick={() => void devSignIn()}><KeyRound size={16} /></button>
            </div>
          </div>
        )}
        <p className="flex items-start gap-2 text-left text-xs text-base-content/60">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-success" />{t('cloud.e2eNote')}
        </p>
      </div>
    </CloudFrame>
  )
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="size-5" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}
