/** Shapes of the Worker's HTTP API at magnetar.codefusion.cc. */

export const DEFAULT_CLOUD_URL = 'https://magnetar.codefusion.cc'

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
  /** Unique on the account and the first part of the device's address (`deviceName.ts`). */
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
  /** The name the device got: what it asked for, made unique on the account. */
  deviceName: string
}

/** Device → Worker: `/api/pair/poll`, and `/api/pair/ack` once the app has stored the token an approval gave it. */
export interface PairPollRequest {
  pairingId: string
  pollSecret: string
}

/**
 * `/api/pair/poll`. An approval is answered the same to every poll until the app confirms it (`/api/pair/ack`) or, for
 * an app that never does, until ten minutes after the pairing's end; then it reads as expired.
 */
export type PairPollResponse =
  | { state: 'pending' }
  | { state: 'expired' }
  | { state: 'approved'; deviceId: string; deviceToken: string; deviceName: string; accountEmail: string }

/**
 * Where Magnetar is developed and released (GitHub owner/name). Clients built before the move to codefusion-cc ask
 * for XeonFX/Magnetar, which GitHub redirects here as long as no repository takes that name again.
 */
export const MAGNETAR_REPO = 'codefusion-cc/magnetar'

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

export type { ReleaseDto, ReleasesDto, ReleasesProblem } from './model.ts'

/** `/api/releases/latest`: the app's newest release, for the website's download buttons. */
export interface LatestReleaseDto {
  version: string
  publishedAt: string | null
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
