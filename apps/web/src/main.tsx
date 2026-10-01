import { StrictMode, Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { LocalApp } from './LocalApp.tsx'
import { loadAppConfig, type AppConfig } from './lib/cloudApi.ts'
import { reporting } from './lib/console.ts'
import { updates } from './lib/updates.ts'
import { captureInstallOffer } from './lib/install.ts'
import { ToastProvider } from './ui/toast.tsx'
import { errorMessage } from './lib/errors.ts'
import { Loading } from './ui/Loading.tsx'

const CloudApp = lazy(() => updates.importOrReload(() => import('./cloud/CloudApp.tsx')))

captureInstallOffer()

/** One build, two homes: the device serves it on localhost, the Worker at magnetar.codefusion.cc. */
function Root() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadAppConfig().then(c => {
      if (c.mode === 'cloud') {
        reporting.installBrowserFailureReporting()
        // Push, playback through the relay and installing as an app all go through it.
        void navigator.serviceWorker?.register('/sw.js', { scope: '/' }).catch(() => {})
      }
      setConfig(c)
    }, e => setError(errorMessage(e)))
  }, [])

  if (error) {
    return <div className="grid min-h-screen place-items-center p-6"><div role="alert" className="alert alert-error max-w-lg">{error}</div></div>
  }
  if (!config) return <Loading screen />
  return config.mode === 'local'
    ? <LocalApp />
    : <Suspense fallback={<Loading screen />}><CloudApp config={config} /></Suspense>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <Root />
    </ToastProvider>
  </StrictMode>,
)
