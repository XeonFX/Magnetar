import { ArrowUpCircle, Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useT } from '../lib/i18n.tsx'
import { offeredVersion, useLatestRelease } from '../lib/releases.ts'
import { useToast } from '../ui/toast.tsx'
import { useDevice } from './DeviceContext.tsx'
import { useRun } from './useRun.ts'

/** The version whose notice was hidden on this dashboard: hidden until the next one. */
const dismissedKey = (keyId: string | null) => `magnetar-update-dismissed:${keyId ?? 'local'}`

function readDismissed(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Says when the app behind this dashboard is out of date, and updates it with one click. The app checks GitHub
 * every 6 hours itself; on the website, the Worker's view of the newest release also counts, so an app whose last
 * check failed (or that predates checking) is still caught. Hidden per version, and on Settings → About, which
 * says the same with the changelog under it.
 */
export function UpdateBanner() {
  const t = useT()
  const toast = useToast()
  const run = useRun()
  const { connection, updates, info, deviceName, basePath } = useDevice()
  const remote = connection.kind === 'remote'
  const latest = useLatestRelease(remote)
  const { pathname } = useLocation()
  const key = dismissedKey(connection.keyId)
  const [dismissed, setDismissed] = useState(() => readDismissed(key))
  const [busy, setBusy] = useState(false)

  const running = updates?.currentVersion ?? info?.version
  const offered = offeredVersion(running, updates?.available?.version, latest?.version)
  if (!running || !offered || dismissed === offered || pathname.startsWith(`${basePath}/settings/about`)) return null
  const releaseUrl = updates?.available?.releaseUrl ?? latest?.pageUrl
  // The app said it can't install itself (a copy outside Applications, Linux without a key): download instead.
  const downloadOnly = updates?.available ? !updates.canSelfInstall : false
  const installing = updates?.installing === true

  const dismiss = () => {
    setDismissed(offered)
    try {
      localStorage.setItem(key, offered)
    } catch {
      // Hidden for this visit only.
    }
  }
  const update = async () => {
    setBusy(true)
    try {
      // The website heard of the release before the app did: let the app look, then install what it found.
      const status = updates?.available ? updates : await run(() => connection.call('updates.check'))
      if (!status?.available || !status.canSelfInstall) {
        window.open(status?.available?.releaseUrl ?? releaseUrl, '_blank', 'noopener')
        return
      }
      toast(t('settings.installNote'), 'info')
      await run(() => connection.call('updates.install'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 pt-4 sm:px-6 lg:px-10">
      <div role="status" className="alert alert-soft alert-info alert-vertical mx-auto max-w-5xl sm:alert-horizontal">
        <ArrowUpCircle size={18} className="hidden sm:block" />
        <span className="text-left">
          {remote ? t('update.bannerRemote', deviceName, running, offered) : t('update.bannerLocal', offered, running)}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`${basePath}/settings/about`} className="btn btn-ghost btn-sm"><Sparkles size={14} />{t('update.whatsNew')}</Link>
          {downloadOnly ? (
            <a className="btn btn-primary btn-sm" href={releaseUrl} target="_blank" rel="noreferrer noopener">{t('update.download')}</a>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || installing} onClick={() => void update()}>
              {(busy || installing) && <span className="loading loading-spinner loading-xs" />}
              {installing ? t('settings.installing') : t('update.now')}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm btn-square" aria-label={t('update.dismiss')} title={t('update.dismiss')} onClick={dismiss}>
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
