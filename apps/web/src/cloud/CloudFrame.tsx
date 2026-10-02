import { useTheme } from '@codefusion-cc/theme/react'
import { MonitorDown, LogOut, Moon, Sparkles, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useT } from '../lib/i18n.tsx'
import { useInstallOffer } from '../lib/install.ts'
import { theme } from '../ui/theme.ts'
import { useAccount } from './CloudApp.tsx'
import { BrandMark } from '../ui/BrandMark.tsx'
import { BuildVersion } from '@codefusion-cc/app-update/react'
import { BUILD } from '../lib/updates.ts'
import { MAGNETAR_REPO } from '@magnetar/protocol/cloud'

/** The website's own pages (sign-in, device list, pairing): a slim header over a centred column. */
export function CloudFrame({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const t = useT()
  const { account } = useAccount()
  const install = useInstallOffer()
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-base-300 bg-base-100/90 backdrop-blur">
        <div className={`mx-auto flex h-14 w-full items-center gap-2 px-4 ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>
          <Link to="/" className="flex flex-1 items-center gap-2.5">
            <BrandMark />
            <span className="font-semibold tracking-tight">Magnetar</span>
          </Link>
          {install && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={install} title={t('install.hint')}>
              <MonitorDown size={16} /><span className="hidden sm:inline">{t('install.button')}</span>
            </button>
          )}
          {account && <AccountMenu />}
          <ThemeToggle />
        </div>
      </header>
      <main className={`mx-auto w-full flex-1 px-4 py-8 sm:py-12 ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>{children}</main>
      <footer className="border-t border-base-300">
        <div className={`muted mx-auto flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-4 text-xs ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>
          <span>Magnetar <BuildVersion repo={MAGNETAR_REPO} className="tabular-nums" commitClassName="link link-hover font-mono" version={BUILD.version} commit={BUILD.commit} /></span>
          <Link to="/about" className="link link-hover">{t('footer.whatsNew')}</Link>
          <a href={`https://github.com/${MAGNETAR_REPO}`} className="link link-hover" target="_blank" rel="noreferrer noopener">GitHub</a>
        </div>
      </footer>
    </div>
  )
}

/** Light or dark, the other one than shown, for this browser. */
export function ThemeToggle() {
  const t = useT()
  const { resolved } = useTheme(theme)
  const next = resolved === 'dark' ? 'light' : 'dark'
  return (
    <button type="button" className="btn btn-ghost btn-square btn-sm" onClick={theme.toggle} aria-label={t(`theme.${next}`)} title={t(`theme.${next}`)}>
      {resolved === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
    </button>
  )
}

export function AccountMenu() {
  const t = useT()
  const { account, signOut } = useAccount()
  if (!account) return null
  return (
    <div className="dropdown dropdown-end">
      <button type="button" tabIndex={0} className="btn btn-ghost btn-sm gap-2 px-1.5" aria-label={account.email}>
        {account.picture
          ? <img src={account.picture} alt="" className="size-7 rounded-full" referrerPolicy="no-referrer" />
          : <span className="grid size-7 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-content">{account.email[0]?.toUpperCase()}</span>}
      </button>
      <ul tabIndex={0} className="menu dropdown-content z-50 mt-2 w-60 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
        <li className="menu-title truncate normal-case">{account.email}</li>
        <li><Link to="/about"><Sparkles size={16} />{t('footer.whatsNew')}</Link></li>
        <li><button type="button" onClick={() => void signOut()}><LogOut size={16} />{t('cloud.signOut')}</button></li>
      </ul>
    </div>
  )
}
