/** Shapes of the Worker's HTTP API at mediadownloader.codefusion.cc. */

export const DEFAULT_CLOUD_URL = 'https://mediadownloader.codefusion.cc'

/** Registered with Google as the OAuth redirect URI. */
export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback'

/** `/app-config.json`: tells the one dashboard build whether the app or the website serves it. */
export interface AppConfig {
  mode: 'local' | 'cloud'
  googleClientId?: string
  /** Development-only passwordless sign-in, never enabled in production. */
  devLogin?: boolean
}

export interface AccountDto {
  id: string
  email: string
  name: string | null
  picture: string | null
}

export interface CloudDeviceDto {
  id: string
  name: string
  platform: string
  version: string
  online: boolean
  lastSeenAt: string | null
  createdAt: string
}

/** Device → Worker: begin pairing. */
export interface PairStartRequest {
  name: string
  platform: string
  version: string
}

export interface PairStartResponse {
  pairingId: string
  /** Proves to the Worker, on poll, that this is the device that started the pairing. */
  pollSecret: string
  expiresAt: string
}

/** What the website shows before the signed-in user approves a pairing. */
export interface PairingInfoDto {
  pairingId: string
  name: string
  platform: string
  version: string
  expiresAt: string
  state: 'pending' | 'approved' | 'expired'
}

export interface PairApproveResponse {
  deviceId: string
}

export type PairPollResponse =
  | { state: 'pending' }
  | { state: 'expired' }
  | { state: 'approved'; deviceId: string; deviceToken: string; accountEmail: string }

export type ReleasePlatform = 'macos' | 'windows' | 'linux'
export type ReleaseArch = 'arm64' | 'x64'

/** One download of the app, from the latest GitHub release. */
export interface ReleaseAssetDto {
  name: string
  url: string
  size: number
  platform: ReleasePlatform
  arch: ReleaseArch
}

/** `/api/releases/latest`: the app's newest release, for the website's download buttons. */
export interface LatestReleaseDto {
  version: string
  publishedAt: string
  pageUrl: string
  assets: ReleaseAssetDto[]
}

/** Error report forwarded to CodeFusion Console. Scrubbed by the sender. */
export interface FailureReport {
  source: 'error' | 'rejection' | 'render'
  name: string
  message: string
  stack: string | null
  page: string
  version: string
  client: string
}
