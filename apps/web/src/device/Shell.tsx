import { CloudOff, Download, Loader, Menu, Moon, Search, Settings, ShieldAlert, Sun, Tv, WifiOff } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { useT } from '../lib/i18n.tsx'
import { useTheme } from '../ui/theme.ts'
import { useDevice } from './DeviceContext.tsx'

/** The dashboard frame: a drawer that is always open on wide screens and slides in on phones. */
export function Shell({ headerStart, headerEnd }: { headerStart?: ReactNode; headerEnd?: ReactNode }) {
  const t = useT()
  const { basePath, info, connectionState, deviceName, connection } = useDevice()
  const [theme, toggleTheme] = useTheme()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  useEffect(() => setDrawerOpen(false), [location.pathname])

  // Ask once, as the legacy dashboard did; desktop notifications need the permission.
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission().catch(() => {})
  }, [])

  const nav = [
    { to: basePath || '/', end: true, icon: <Download size={18} />, label: t('nav.downloads') },
    { to: `${basePath}/search`, end: false, icon: <Search size={18} />, label: t('nav.search') },
    { to: `${basePath}/series`, end: false, icon: <Tv size={18} />, label: t('nav.series') },
    { to: `${basePath}/settings`, end: false, icon: <Settings size={18} />, label: t('nav.settings') },
  ]

  return (
    <div className="drawer lg:drawer-open">
      <input id="md-drawer" type="checkbox" className="drawer-toggle" checked={drawerOpen} onChange={e => setDrawerOpen(e.target.checked)} />
      <div className="drawer-content flex min-h-screen flex-col">
        <header className="navbar sticky top-0 z-30 gap-2 border-b border-base-300 bg-base-100/90 px-3 backdrop-blur sm:px-4">
          <label htmlFor="md-drawer" className="btn btn-ghost btn-square btn-sm lg:hidden" aria-label={t('nav.menu')}><Menu size={20} /></label>
          {headerStart}
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{deviceName}</div>
            {connection.kind === 'remote' && <div className="truncate text-xs text-base-content/60">{t('remote.viaRelay')}</div>}
          </div>
          {headerEnd}
          <button type="button" className="btn btn-ghost btn-square btn-sm" onClick={toggleTheme}
            aria-label={theme === 'dark' ? t('theme.light') : t('theme.dark')} title={theme === 'dark' ? t('theme.light') : t('theme.dark')}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </header>
        <ConnectionBanner />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
          {connectionState.status === 'open' || info ? <Outlet /> : <div className="flex justify-center py-24"><span className="loading loading-spinner loading-lg text-primary" /></div>}
        </main>
      </div>
      <div className="drawer-side z-40">
        <label htmlFor="md-drawer" aria-label={t('nav.closeMenu')} className="drawer-overlay" />
        <aside className="flex min-h-full w-64 flex-col border-r border-base-300 bg-base-200">
          <div className="flex items-center gap-3 px-5 py-5">
            <div className="grid size-9 place-items-center rounded-full bg-primary text-primary-content"><Download size={18} /></div>
            <span className="text-lg font-bold tracking-tight">MediaDownloader</span>
          </div>
          <ul className="menu w-full gap-1 px-3">
            {nav.map(item => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className={({ isActive }) => (isActive ? 'bg-primary/15 font-medium text-primary' : '')}>
                  {item.icon}{item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <div className="flex-1" />
          <p className="px-5 pb-5 text-center text-xs text-base-content/50">MediaDownloader {info ? `v${info.version}` : ''}</p>
        </aside>
      </div>
    </div>
  )
}

function ConnectionBanner() {
  const t = useT()
  const { connectionState } = useDevice()
  const [visible, setVisible] = useState(false)
  // Brief reconnects are normal; only mention them if they last.
  useEffect(() => {
    if (connectionState.status === 'open') return setVisible(false)
    const timer = setTimeout(() => setVisible(true), connectionState.status === 'connecting' ? 1500 : 400)
    return () => clearTimeout(timer)
  }, [connectionState])
  if (!visible || connectionState.status === 'open' || connectionState.status === 'closed') return null

  const [tone, icon, text] =
    connectionState.status === 'device-offline' ? ['alert-warning', <CloudOff key="i" size={18} />, t('remote.deviceOffline')]
    : connectionState.status === 'rejected' ? ['alert-error', <ShieldAlert key="i" size={18} />, t(connectionState.reason)]
    : connectionState.status === 'reconnecting' ? ['alert-warning', <WifiOff key="i" size={18} />, t('connection.reconnecting')]
    : ['alert-info', <Loader key="i" size={18} className="animate-spin" />, t('connection.connecting')]
  return (
    <div className="px-4 pt-4 sm:px-6">
      <div role="alert" className={`alert ${tone} mx-auto max-w-6xl`}>{icon}<span>{text}</span></div>
    </div>
  )
}

/** Page heading used by every dashboard page. */
export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-base-content/60">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}
