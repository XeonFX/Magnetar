import { StrictMode, Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { LocalApp } from './LocalApp.tsx'
import { loadAppConfig, type AppConfig } from './lib/cloudApi.ts'
import { installErrorReporting } from './lib/errorReport.ts'
import { captureInstallOffer } from './lib/install.ts'
import { ToastProvider } from './ui/toast.tsx'

const CloudApp = lazy(() => import('./cloud/CloudApp.tsx'))

captureInstallOffer()

/** One build, two homes: the device serves it on localhost, the Worker at magnetar.codefusion.cc. */
function Root() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadAppConfig().then(c => {
      if (c.mode === 'cloud') {
        installErrorReporting()
        // Push, playback through the relay and installing as an app all go through it.
        void navigator.serviceWorker?.register('/sw.js', { scope: '/' }).catch(() => {})
      }
      setConfig(c)
    }, e => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (error) {
    return <div className="grid min-h-screen place-items-center p-6"><div role="alert" className="alert alert-error max-w-lg">{error}</div></div>
  }
  if (!config) return <div className="grid min-h-screen place-items-center"><span className="loading loading-spinner loading-lg text-primary" /></div>
  return config.mode === 'local'
    ? <LocalApp />
    : <Suspense fallback={<div className="grid min-h-screen place-items-center"><span className="loading loading-spinner loading-lg text-primary" /></div>}><CloudApp config={config} /></Suspense>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <Root />
    </ToastProvider>
  </StrictMode>,
)
