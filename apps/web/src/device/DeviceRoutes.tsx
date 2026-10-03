import { lazy, Suspense, type ReactNode } from 'react'
import { Route, Routes } from 'react-router'
import { I18nProvider } from '../lib/i18n.tsx'
import { updates } from '../lib/updates.ts'
import { Loading } from '../ui/Loading.tsx'
import { useDevice } from './DeviceContext.tsx'
import { DownloadsPage } from './pages/DownloadsPage.tsx'
import { Shell, type DeviceMenu } from './Shell.tsx'

// Downloads is where the dashboard opens; the other pages load when first visited.
const SearchPage = lazy(() => updates.importOrReload(() => import('./pages/SearchPage.tsx')).then(m => ({ default: m.SearchPage })))
const SeriesPage = lazy(() => updates.importOrReload(() => import('./pages/SeriesPage.tsx')).then(m => ({ default: m.SeriesPage })))
const FilesPage = lazy(() => updates.importOrReload(() => import('./pages/FilesPage.tsx')).then(m => ({ default: m.FilesPage })))
const SettingsPage = lazy(() => updates.importOrReload(() => import('./pages/SettingsPage.tsx')).then(m => ({ default: m.SettingsPage })))

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>
}

/** A device's pages, in the language chosen in its settings. */
export function DeviceRoutes({ headerStart, headerEnd, deviceMenu, fallbackLanguage }: {
  headerStart?: ReactNode
  headerEnd?: ReactNode
  deviceMenu?: DeviceMenu
  fallbackLanguage: string
}) {
  const { settings } = useDevice()
  return (
    <I18nProvider language={settings?.language ?? fallbackLanguage}>
      <Routes>
        <Route element={<Shell headerStart={headerStart} headerEnd={headerEnd} deviceMenu={deviceMenu} />}>
          <Route index element={<DownloadsPage />} />
          <Route path="search/*" element={<Page><SearchPage /></Page>} />
          <Route path="series/:tab?" element={<Page><SeriesPage /></Page>} />
          <Route path="files" element={<Page><FilesPage /></Page>} />
          <Route path="settings/:section?" element={<Page><SettingsPage /></Page>} />
          <Route path="*" element={<DownloadsPage />} />
        </Route>
      </Routes>
    </I18nProvider>
  )
}
