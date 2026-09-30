import { MonitorDown, LogOut, Moon, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useT } from '../lib/i18n.tsx'
import { useInstallOffer } from '../lib/install.ts'
import { useTheme } from '../ui/theme.ts'
import { useAccount } from './CloudApp.tsx'
import { BrandMark } from '../ui/BrandMark.tsx'

/** The website's own pages (sign-in, device list, pairing): a slim header over a centred column. */
export function CloudFrame({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const t = useT()
  const { theme, setMode } = useTheme()
  const { account } = useAccount()
  const install = useInstallOffer()
  const next = theme === 'dark' ? 'light' : 'dark'
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
          <button type="button" className="btn btn-ghost btn-square btn-sm" onClick={() => setMode(next)} aria-label={t(`theme.${next}`)} title={t(`theme.${next}`)}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>
      <main className={`mx-auto w-full flex-1 px-4 py-8 sm:py-12 ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>{children}</main>
    </div>
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
        <li><button type="button" onClick={() => void signOut()}><LogOut size={16} />{t('cloud.signOut')}</button></li>
      </ul>
    </div>
  )
}
