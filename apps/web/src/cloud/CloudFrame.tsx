import { Download, LogOut, Moon, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useT } from '../lib/i18n.tsx'
import { useTheme } from '../ui/theme.ts'
import { useAccount } from './CloudApp.tsx'

/** The website's own pages (sign-in, device list, pairing): a narrow centred column. */
export function CloudFrame({ children }: { children: ReactNode }) {
  const t = useT()
  const [theme, toggleTheme] = useTheme()
  const { account } = useAccount()
  return (
    <div className="flex min-h-screen flex-col">
      <header className="navbar border-b border-base-300 bg-base-100 px-4">
        <Link to="/" className="flex flex-1 items-center gap-3">
          <span className="grid size-8 place-items-center rounded-full bg-primary text-primary-content"><Download size={16} /></span>
          <span className="font-bold tracking-tight">MediaDownloader</span>
        </Link>
        {account && <AccountMenu />}
        <button type="button" className="btn btn-ghost btn-square btn-sm" onClick={toggleTheme} aria-label={theme === 'dark' ? t('theme.light') : t('theme.dark')}>
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">{children}</main>
    </div>
  )
}

export function AccountMenu() {
  const t = useT()
  const { account, signOut } = useAccount()
  if (!account) return null
  return (
    <div className="dropdown dropdown-end">
      <button type="button" tabIndex={0} className="btn btn-ghost btn-sm gap-2 px-2" aria-label={account.email}>
        {account.picture
          ? <img src={account.picture} alt="" className="size-7 rounded-full" referrerPolicy="no-referrer" />
          : <span className="grid size-7 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-content">{account.email[0]?.toUpperCase()}</span>}
        <span className="hidden max-w-40 truncate text-sm sm:inline">{account.email}</span>
      </button>
      <ul tabIndex={0} className="menu dropdown-content z-50 mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
        <li className="menu-title truncate">{account.email}</li>
        <li><button type="button" onClick={() => void signOut()}><LogOut size={16} />{t('cloud.signOut')}</button></li>
      </ul>
    </div>
  )
}
