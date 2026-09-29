import { lazy, Suspense, type ReactNode } from 'react'
import { Route, Routes } from 'react-router'
import { I18nProvider } from '../lib/i18n.tsx'
import { useDevice } from './DeviceContext.tsx'
import { DownloadsPage } from './pages/DownloadsPage.tsx'
import { Shell } from './Shell.tsx'

// Downloads is where the dashboard opens; the other pages load when first visited.
const SearchPage = lazy(() => import('./pages/SearchPage.tsx').then(m => ({ default: m.SearchPage })))
const SeriesPage = lazy(() => import('./pages/SeriesPage.tsx').then(m => ({ default: m.SeriesPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage.tsx').then(m => ({ default: m.SettingsPage })))

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="flex justify-center py-24"><span className="loading loading-spinner loading-lg text-primary" /></div>}>{children}</Suspense>
}

/** A device's pages, in the language chosen in its settings. */
export function DeviceRoutes({ headerStart, headerEnd, fallbackLanguage }: { headerStart?: ReactNode; headerEnd?: ReactNode; fallbackLanguage: string }) {
  const { settings } = useDevice()
  return (
    <I18nProvider language={settings?.language ?? fallbackLanguage}>
      <Routes>
        <Route element={<Shell headerStart={headerStart} headerEnd={headerEnd} />}>
          <Route index element={<DownloadsPage />} />
          <Route path="search" element={<Page><SearchPage /></Page>} />
          <Route path="series" element={<Page><SeriesPage /></Page>} />
          <Route path="settings" element={<Page><SettingsPage /></Page>} />
          <Route path="*" element={<DownloadsPage />} />
        </Route>
      </Routes>
    </I18nProvider>
  )
}
