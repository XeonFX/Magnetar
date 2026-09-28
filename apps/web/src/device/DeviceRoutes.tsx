import type { ReactNode } from 'react'
import { Route, Routes } from 'react-router'
import { I18nProvider } from '../lib/i18n.tsx'
import { useDevice } from './DeviceContext.tsx'
import { DownloadsPage } from './pages/DownloadsPage.tsx'
import { SearchPage } from './pages/SearchPage.tsx'
import { SeriesPage } from './pages/SeriesPage.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'
import { Shell } from './Shell.tsx'

/** A device's pages, in the language chosen in its settings. */
export function DeviceRoutes({ headerStart, headerEnd, fallbackLanguage }: { headerStart?: ReactNode; headerEnd?: ReactNode; fallbackLanguage: string }) {
  const { settings } = useDevice()
  return (
    <I18nProvider language={settings?.language ?? fallbackLanguage}>
      <Routes>
        <Route element={<Shell headerStart={headerStart} headerEnd={headerEnd} />}>
          <Route index element={<DownloadsPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="series" element={<SeriesPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<DownloadsPage />} />
        </Route>
      </Routes>
    </I18nProvider>
  )
}
