import { DEFAULT_CLOUD_URL } from '@md/protocol/cloud'

declare const MD_VERSION: string | undefined

/** Stamped by build.ts from the release tag; dev runs report the package version. */
export const VERSION: string = typeof MD_VERSION === 'string' ? MD_VERSION : '2.0.0-dev'

export const IS_DEV = typeof MD_VERSION !== 'string' || process.env.MD_DEV === '1'

export const PLATFORM = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
export const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'

/** Where the dashboard and relay live. Overridable for local development of the Worker. */
export const CLOUD_URL = (process.env.MD_CLOUD_URL ?? DEFAULT_CLOUD_URL).replace(/\/$/, '')

export const DEFAULT_PORT = 47820

export const GITHUB_REPO = process.env.MD_GITHUB_REPO ?? 'XeonFX/MediaDownloader'

export const USER_AGENT = `MediaDownloader/${VERSION}`
