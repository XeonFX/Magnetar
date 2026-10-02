import { ArrowRight, Download, KeyRound, MonitorSmartphone, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { startGoogleSignIn, takeGoogleSignInResult } from '@codefusion-cc/google-sign-in/browser'
import { cloud, CloudError } from '../lib/cloudApi.ts'
import { errorMessage } from '../lib/errors.ts'
import { useLanguage, useT } from '../lib/i18n.tsx'
import { useAccount } from './CloudApp.tsx'
import { CloudFrame } from './CloudFrame.tsx'
import { DownloadApp } from './DownloadApp.tsx'

/** What to say about a return from Google that brought no credential; a cancelled one says nothing. */
const RETURN_ERRORS = { expired: 'cloud.signInExpired', failed: 'cloud.signInFailed' } as const
/** What to say when the Worker refuses the credential: 503 when Google's keys could not be read. */
const STATUS_ERRORS: Partial<Record<number, 'cloud.signInFailed' | 'cloud.signInUnavailable'>> = { 401: 'cloud.signInFailed', 503: 'cloud.signInUnavailable' }

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
    // Closing Google's account chooser is a choice, not an error to report.
    if ('error' in result) {
      if (result.error !== 'cancelled') setError(t(RETURN_ERRORS[result.error]))
      return
    }
    setBusy(true)
    cloud.completeSignIn(result.credential).then(refresh, e => {
      const key = e instanceof CloudError ? STATUS_ERRORS[e.status] : undefined
      setError(key ? t(key) : errorMessage(e))
    }).finally(() => setBusy(false))
  }, [refresh, t])

  if (account) return <Navigate to={next} replace />

  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      const { nonce, clientId } = await cloud.startSignIn()
      // Google returns to this page, /login with its `next`.
      if (!startGoogleSignIn({ clientId, nonce, locale: language })) {
        setError(t('cloud.signInFailed'))
        setBusy(false)
      }
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const devSignIn = async () => {
    setBusy(true)
    try {
      await cloud.devSignIn(devEmail)
      await refresh()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <CloudFrame wide>
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_26rem] lg:gap-16">
        {/* Most arrive from the app to sign in, so on phones the sign-in card comes first. */}
        <div className="order-2 lg:order-1">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('cloud.heroTitle')}</h1>
          <p className="muted mt-3 max-w-xl text-lg">{t('cloud.heroText')}</p>
          <ul className="mt-8 flex flex-col gap-5">
            <Point icon={<MonitorSmartphone size={20} />} title={t('cloud.pointAnywhere')} text={t('cloud.pointAnywhereText')} />
            <Point icon={<ShieldCheck size={20} />} title={t('cloud.pointPrivate')} text={t('cloud.e2eNote')} />
            <Point icon={<Download size={20} />} title={t('cloud.pointApp')} text={t('cloud.pointAppText')} />
          </ul>
          <Link to="/features" className="link link-primary mt-6 inline-flex items-center gap-1.5 font-medium">{t('cloud.features')}<ArrowRight size={16} aria-hidden /></Link>
          <section className="surface mt-8 max-w-md p-5" aria-labelledby="magnetar-get-app">
            <h2 id="magnetar-get-app" className="mb-3 font-semibold">{t('get.title')}</h2>
            <DownloadApp />
          </section>
        </div>
        <div className="surface order-1 flex flex-col gap-5 p-6 sm:p-8 lg:order-2">
          <div>
            <h2 className="text-xl font-semibold">{t('cloud.signInTitle')}</h2>
            <p className="muted mt-1 text-sm">{t('cloud.signInHint')}</p>
          </div>
          {error && <div role="alert" className="alert alert-error alert-soft text-sm">{error}</div>}
          {config.googleClientId && (
            <button type="button" className="btn btn-lg w-full gap-3 border-base-300 bg-base-100 font-medium" disabled={busy} onClick={() => void signIn()}>
              {busy ? <span className="loading loading-spinner" /> : <GoogleLogo />}{t('cloud.signInGoogle')}
            </button>
          )}
          {config.devLogin && (
            <div className="rounded-box border border-dashed border-warning p-3">
              <p className="mb-2 text-xs text-warning">{t('cloud.devLogin')}</p>
              <div className="join w-full">
                <input className="input join-item w-full" value={devEmail} onChange={e => setDevEmail(e.target.value)} aria-label="Email" />
                <button type="button" className="btn btn-warning join-item" aria-label={t('cloud.devSignIn')} disabled={busy} onClick={() => void devSignIn()}><KeyRound size={16} /></button>
              </div>
            </div>
          )}
        </div>
      </div>
    </CloudFrame>
  )
}

function Point({ icon, title, text }: { icon: ReactNode; title: string; text: ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-field bg-primary/10 text-primary">{icon}</span>
      <div>
        <div className="font-semibold">{title}</div>
        <div className="muted mt-0.5 text-sm">{text}</div>
      </div>
    </li>
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
