import type { AccountDto } from '@magnetar/protocol/cloud'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'
import type { AppConfig } from '../lib/cloudApi.ts'
import { cloud } from '../lib/cloudApi.ts'
import { errorMessage } from '../lib/errors.ts'
import { browserLanguage, I18nProvider } from '../lib/i18n.tsx'
import { Loading } from '../ui/Loading.tsx'
import { useToast } from '../ui/toast.tsx'
import { AddRedirect } from './AddRedirect.tsx'
import { DevicesPage } from './DevicesPage.tsx'
import { LinkPage } from './LinkPage.tsx'
import { LoginPage } from './LoginPage.tsx'
import { PairPage } from './PairPage.tsx'
import { RemoteDevice } from './RemoteDevice.tsx'

interface AccountState {
  account: AccountDto | null
  config: AppConfig
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const AccountContext = createContext<AccountState | null>(null)

export function useAccount(): AccountState {
  const value = useContext(AccountContext)
  if (!value) throw new Error('useAccount outside CloudApp')
  return value
}

/** Signed-in pages; anyone else is sent to /login and brought back afterwards. */
function RequireAccount({ children }: { children: ReactNode }) {
  const { account } = useAccount()
  const location = useLocation()
  if (!account) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace state={{ hash: location.hash }} />
  return <>{children}</>
}

export default function CloudApp({ config }: { config: AppConfig }) {
  const [account, setAccount] = useState<AccountDto | null | undefined>(undefined)
  const refresh = useCallback(async () => setAccount(await cloud.me().catch(() => null)), [])
  const toast = useToast()
  // Only look signed out once the server has ended the session: on a shared computer a silent
  // failure would leave the account open behind a signed-out page.
  const signOut = useCallback(async () => {
    try {
      await cloud.signOut()
      setAccount(null)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }, [toast])
  useEffect(() => void refresh(), [refresh])

  if (account === undefined) return <Loading screen />

  return (
    <AccountContext.Provider value={{ account, config, refresh, signOut }}>
      <I18nProvider language={browserLanguage()}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/pair/:pairingId" element={<PairPage />} />
            <Route path="/link" element={<LinkPage />} />
            <Route path="/add" element={<RequireAccount><AddRedirect /></RequireAccount>} />
            <Route path="/d/:deviceId/*" element={<RequireAccount><RemoteDevice /></RequireAccount>} />
            <Route path="*" element={<RequireAccount><DevicesPage /></RequireAccount>} />
          </Routes>
        </BrowserRouter>
      </I18nProvider>
    </AccountContext.Provider>
  )
}
