import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Per-user writable data. Separate from the legacy .NET app's folder, so both can run side by side
 * and the legacy database is only ever read (by the importer).
 */
function resolveDataDirectory(): string {
  const configured = process.env.MD_DATA_DIRECTORY
  if (configured) return resolve(configured)
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'cc.codefusion.mediadownloader')
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'CodeFusion', 'MediaDownloader')
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'mediadownloader')
}

export const DATA_DIR = resolveDataDirectory()
mkdirSync(DATA_DIR, { recursive: true })

export const paths = {
  database: join(DATA_DIR, 'mediadownloader.db'),
  secretKey: join(DATA_DIR, 'secret.key'),
  torrentFiles: join(DATA_DIR, 'torrents'),
  logs: join(DATA_DIR, 'logs'),
  endpoint: join(DATA_DIR, 'endpoint.json'),
  lock: join(DATA_DIR, 'instance.lock'),
}

export const DEFAULT_DOWNLOAD_FOLDER = join(homedir(), 'Downloads', 'MediaDownloader')

/** Where the legacy .NET MediaDownloader kept its database. */
export function legacyDatabasePath(): string | null {
  if (process.env.MD_LEGACY_DATABASE) return resolve(process.env.MD_LEGACY_DATABASE)
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'MediaDownloader', 'mediadownloader.db')
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'MediaDownloader', 'mediadownloader.db')
  return null
}

/** The enclosing `.app` bundle when running from one on macOS. */
export function macAppBundle(): string | null {
  if (process.platform !== 'darwin') return null
  const macos = dirname(process.execPath)
  const contents = dirname(macos)
  const bundle = dirname(contents)
  return macos.endsWith('/Contents/MacOS') && bundle.endsWith('.app') ? bundle : null
}
