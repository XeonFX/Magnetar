import { CloudOff, Download, Loader, Search, Settings, ShieldAlert, Tv, WifiOff } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router'
import { useT } from '../lib/i18n.tsx'
import { useDevice, useDownloads } from './DeviceContext.tsx'
import { isActive } from './components/downloads.tsx'
import { BrandMark } from '../ui/BrandMark.tsx'

/**
 * The dashboard frame. Wide screens get a sidebar with the device's status; phones get a slim top
 * bar and a tab bar at the bottom, within thumb reach.
 */
export function Shell({ headerStart, headerEnd }: { headerStart?: ReactNode; headerEnd?: ReactNode }) {
  const t = useT()
  const { basePath, info, connectionState } = useDevice()
  const active = useDownloads().filter(isActive).length

  const nav = [
    { to: basePath || '/', end: true, icon: Download, label: t('nav.downloads'), badge: active },
    { to: `${basePath}/search`, end: false, icon: Search, label: t('nav.search') },
    { to: `${basePath}/series`, end: false, icon: Tv, label: t('nav.series') },
    { to: `${basePath}/settings`, end: false, icon: Settings, label: t('nav.settings') },
  ]

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen flex-col gap-6 border-r border-base-300 bg-base-100 px-3 py-5 lg:flex">
        <div className="flex items-center gap-1 px-2">
          {headerStart}
          <Brand />
        </div>
        <nav aria-label={t('nav.menu')} className="flex flex-col gap-0.5">
          {nav.map(item => (
            <NavLink key={item.to} to={item.to} end={item.end}
              className={({ isActive: current }) => `flex items-center gap-3 rounded-field px-3 py-2 text-sm font-medium transition-colors ${
                current ? 'bg-primary/10 text-primary' : 'muted hover:bg-base-200 hover:text-base-content'}`}>
              <item.icon size={18} />
              <span className="flex-1">{item.label}</span>
              {!!item.badge && <span className="badge badge-sm badge-primary tabular-nums">{item.badge}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="flex-1" />
        <DeviceStatus end={headerEnd} />
        {info && <p className="muted px-3 text-xs">MediaDownloader {info.version}</p>}
      </aside>

      <div className="flex min-h-screen min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-base-300 bg-base-100/90 px-3 backdrop-blur lg:hidden">
          {headerStart}
          <div className="min-w-0 flex-1"><DeviceStatus compact /></div>
          {headerEnd}
        </header>
        <ConnectionBanner />
        <main className="pb-tabbar mx-auto w-full max-w-5xl flex-1 px-4 pt-5 sm:px-6 lg:px-10 lg:pt-10">
          {connectionState.status === 'open' || info ? <Outlet /> : <div className="flex justify-center py-24"><span className="loading loading-spinner loading-lg text-primary" /></div>}
        </main>
        <nav aria-label={t('nav.menu')}
          className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-base-300 bg-base-100/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          {nav.map(item => (
            <NavLink key={item.to} to={item.to} end={item.end}
              className={({ isActive: current }) => `relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium ${current ? 'text-primary' : 'muted'}`}>
              <span className="relative">
                <item.icon size={22} />
                {!!item.badge && <span className="badge badge-xs badge-primary absolute -top-1.5 left-3.5 tabular-nums">{item.badge}</span>}
              </span>
              <span className="max-w-full truncate px-1">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  )
}

function Brand() {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <BrandMark />
      <span className="truncate font-semibold tracking-tight">MediaDownloader</span>
    </div>
  )
}

/** Which device this is and whether it is reachable. */
function DeviceStatus({ compact = false, end }: { compact?: boolean; end?: ReactNode }) {
  const t = useT()
  const { deviceName, connection, connectionState } = useDevice()
  const online = connectionState.status === 'open'
  const where = connection.kind === 'remote' ? t('remote.viaRelay') : t('shell.thisComputer')
  const dot = <span className={`inline-block size-2 shrink-0 rounded-full ${online ? 'bg-success' : 'bg-warning'}`} />
  if (compact) {
    return (
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-semibold">{deviceName}</div>
        <div className="muted flex items-center gap-1.5 text-xs">{dot}<span className="truncate">{online ? where : t('connection.reconnecting')}</span></div>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 rounded-box border border-base-300 p-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{deviceName}</div>
        <div className="muted mt-0.5 flex items-center gap-1.5 text-xs">{dot}<span className="truncate">{online ? where : t('connection.reconnecting')}</span></div>
      </div>
      {end}
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
    <div className="px-4 pt-4 sm:px-6 lg:px-10">
      <div role="alert" className={`alert alert-soft ${tone} mx-auto max-w-5xl`}>{icon}<span>{text}</span></div>
    </div>
  )
}
