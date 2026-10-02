import type { AccountDto, AppConfig, CloudDeviceDto, LatestReleaseDto, PairApproveResponse, PairingInfoDto, ReleasesDto } from '@magnetar/protocol/cloud'

export type { AppConfig }

export async function loadAppConfig(): Promise<AppConfig> {
  const response = await fetch('/app-config.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`Could not load the app configuration (HTTP ${response.status})`)
  return (await response.json()) as AppConfig
}

export class CloudError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'CloudError'
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      message = ((await response.json()) as { error?: string }).error ?? message
    } catch {
      // keep the status
    }
    throw new CloudError(response.status, message)
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

/**
 * The account's devices as `cloud.devices()` last listed them, for the account `me()` last saw (another account
 * in the same tab starts without them), and the listing under way, which callers share.
 */
let knownDevices: CloudDeviceDto[] | null = null
let knownAccount: string | null = null
let listing: Promise<CloudDeviceDto[]> | null = null

export const cloud = {
  /** The signed-in account, or null when signed out. */
  async me(): Promise<AccountDto | null> {
    let account: AccountDto | null
    try {
      account = await api<AccountDto>('/api/me')
    } catch (error) {
      if (!(error instanceof CloudError && error.status === 401)) throw error
      account = null
    }
    if ((account?.id ?? null) !== knownAccount) {
      knownAccount = account?.id ?? null
      knownDevices = null
    }
    return account
  },
  startSignIn: () => api<{ nonce: string; clientId: string }>('/api/auth/start', { method: 'POST', body: '{}' }),
  completeSignIn: (credential: string) => api<AccountDto>('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential }) }),
  devSignIn: (email: string) => api<AccountDto>('/api/auth/dev', { method: 'POST', body: JSON.stringify({ email }) }),
  async signOut(): Promise<void> {
    await api<void>('/api/auth/logout', { method: 'POST', body: '{}' })
    knownDevices = null
  },
  devices(): Promise<CloudDeviceDto[]> {
    listing ??= api<CloudDeviceDto[]>('/api/devices')
      .then(list => (knownDevices = list))
      .finally(() => { listing = null })
    return listing
  },
  /** The devices as last listed, to show a page at once while they are listed again; null before the first list. */
  knownDevices: () => knownDevices,
  removeDevice: (id: string) => api<void>(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  pairing: (id: string) => api<PairingInfoDto>(`/api/pair/${encodeURIComponent(id)}`),
  latestRelease: () => api<LatestReleaseDto>('/api/releases/latest'),
  /** The releases and what each brings, newest first; `problem` says why there are none when GitHub couldn't be read. */
  releases: () => api<ReleasesDto>('/api/releases'),
  approvePairing: (id: string) => api<PairApproveResponse>(`/api/pair/${encodeURIComponent(id)}/approve`, { method: 'POST', body: '{}' }),
}
