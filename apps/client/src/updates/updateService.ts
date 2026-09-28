import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { UpdateStatusDto } from '@md/protocol'
import { fromBase64Url } from '@md/protocol/base64'
import { ARCH, GITHUB_REPO, IS_DEV, PLATFORM, VERSION } from '../config.ts'
import type { EventBus } from '../events.ts'
import { logger } from '../log.ts'
import type { NotificationDispatcher } from '../notifications/dispatcher.ts'
import { macAppBundle } from '../paths.ts'
import { MAC_INSTALL_SCRIPT } from './macInstallScript.ts'

const log = logger('updates')
const CHECK_INTERVAL_MS = 6 * 3600_000
const MANIFEST = 'SHA256SUMS.txt'
const SIGNATURE = 'SHA256SUMS.txt.sig'

declare const MD_RELEASE_PUBLIC_KEY: string | undefined
/** Ed25519 public key (base64url) whose private half signs release manifests in CI. */
const RELEASE_PUBLIC_KEY = typeof MD_RELEASE_PUBLIC_KEY === 'string' ? MD_RELEASE_PUBLIC_KEY : ''

interface Release {
  version: string
  tag: string
  releaseUrl: string
  assetName: string | null
  assetUrl: string | null
  manifestUrl: string | null
  signatureUrl: string | null
}

/** The asset for this platform: `MediaDownloader-<version>-<platform>-<arch>.<ext>`. */
export function assetSuffix(): string {
  return `-${PLATFORM}-${ARCH}${PLATFORM === 'macos' ? '.zip' : PLATFORM === 'windows' ? '.exe' : ''}`
}

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** Reads one `<sha256>  <file>` line of a sha256sum manifest. */
export function findChecksum(manifest: string, asset: string): string | null {
  for (const line of manifest.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/)
    if (hash && name?.replace(/^\*/, '') === asset) return hash.toLowerCase()
  }
  return null
}

/**
 * Checks GitHub Releases every 6 hours, notifies once per new version, and installs in place:
 * the macOS .app bundle is swapped by a helper after this process exits (with rollback), the
 * Windows/Linux executable is renamed aside and replaced. Every install needs the manifest
 * signature to verify against the key built into this binary, so a swapped asset *and* manifest
 * are still refused.
 */
export class UpdateService {
  private available: Release | null = null
  private checking = false
  private installing = false
  private lastCheckedAt: string | null = null
  private lastCheckError: string | null = null
  private notifiedVersion: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  onQuitForInstall: (() => Promise<void>) | null = null

  constructor(private readonly events: EventBus, private readonly notifications: NotificationDispatcher) {}

  start(): void {
    cleanupPreviousExecutable()
    if (IS_DEV) return
    const loop = async () => {
      await this.check()
      this.timer = setTimeout(loop, CHECK_INTERVAL_MS)
    }
    this.timer = setTimeout(loop, 60_000)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
  }

  get canSelfInstall(): boolean {
    if (!this.available?.assetUrl || !RELEASE_PUBLIC_KEY) return false
    return PLATFORM === 'macos' ? macAppBundle() !== null : !IS_DEV
  }

  status(): UpdateStatusDto {
    return {
      currentVersion: VERSION,
      available: this.available ? { version: this.available.version, tag: this.available.tag, releaseUrl: this.available.releaseUrl } : null,
      canSelfInstall: this.canSelfInstall,
      checking: this.checking,
      installing: this.installing,
      lastCheckedAt: this.lastCheckedAt,
      lastCheckError: this.lastCheckError,
    }
  }

  async check(): Promise<UpdateStatusDto> {
    if (this.checking) return this.status()
    this.checking = true
    this.changed()
    try {
      await this.fetchLatest()
      this.lastCheckError = null
    } catch (error) {
      this.lastCheckError = error instanceof Error ? error.message : String(error)
      log.warn('Update check failed', error)
    } finally {
      this.checking = false
      this.lastCheckedAt = new Date().toISOString()
      this.changed()
    }
    return this.status()
  }

  private async fetchLatest(): Promise<void> {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'user-agent': 'MediaDownloader', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 404) return
    if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`)
    const release = await response.json() as { tag_name: string; html_url: string; assets: { name: string; browser_download_url: string }[] }
    const version = release.tag_name.replace(/^v/i, '')
    if (!/^\d+\.\d+\.\d+/.test(version) || compareVersions(version, VERSION) <= 0) {
      this.available = null
      return
    }
    const asset = release.assets.find(a => a.name.endsWith(assetSuffix()))
    const url = (name: string) => release.assets.find(a => a.name === name)?.browser_download_url ?? null
    this.available = {
      version,
      tag: release.tag_name,
      releaseUrl: release.html_url,
      assetName: asset?.name ?? null,
      assetUrl: asset?.browser_download_url ?? null,
      manifestUrl: url(MANIFEST),
      signatureUrl: url(SIGNATURE),
    }
    log.info(`Update available: ${release.tag_name} (running ${VERSION})`)
    if (this.notifiedVersion !== version) {
      this.notifiedVersion = version
      void this.notifications.dispatch({
        kind: 'update',
        title: `MediaDownloader ${release.tag_name} is available`,
        message: `You are running ${VERSION}. Install it from Settings or the menu-bar icon, or download it from ${release.html_url}`,
      })
    }
  }

  /**
   * Installs the available update, or opens the release page where that isn't possible. Returns
   * the URL to open when the caller should show the release page instead.
   */
  async install(): Promise<string | null> {
    const update = this.available
    if (!update || this.installing) return null
    if (!this.canSelfInstall) return update.releaseUrl
    this.installing = true
    this.changed()
    const staging = mkdtempSync(join(tmpdir(), 'mediadownloader-update-'))
    try {
      const assetPath = join(staging, update.assetName!)
      const bytes = new Uint8Array(await download(update.assetUrl!, 10 * 60_000))
      await verifyRelease(bytes, update)
      writeFileSync(assetPath, bytes)
      if (PLATFORM === 'macos') await this.installMac(assetPath, staging)
      else await this.installExecutable(assetPath)
      log.info(`Update ${update.tag} staged; restarting`)
      await this.onQuitForInstall?.()
      process.exit(0)
    } catch (error) {
      log.error('Update install failed', error)
      this.lastCheckError = `Update failed: ${error instanceof Error ? error.message : String(error)}`
      this.installing = false
      this.changed()
      rmSync(staging, { recursive: true, force: true })
    }
    return null
  }

  private async installMac(zipPath: string, staging: string): Promise<void> {
    const bundle = macAppBundle()!
    await exec(['/usr/bin/ditto', '-x', '-k', zipPath, staging])
    const newApp = join(staging, 'MediaDownloader.app')
    if (!existsSync(join(newApp, 'Contents', 'MacOS', 'MediaDownloader'))) throw new Error('The downloaded bundle has no MediaDownloader executable')
    // Copy beside the destination and validate it while this app still runs; the helper only
    // renames bundles once we have exited.
    const work = mkdtempSync(join(dirname(bundle), '.MediaDownloader-update-'))
    const script = join(work, 'install.sh')
    writeFileSync(script, MAC_INSTALL_SCRIPT, { mode: 0o700 })
    await exec(['/bin/bash', script, 'prepare', bundle, newApp, work])
    Bun.spawn(['/usr/bin/nohup', '/bin/bash', script, 'install', bundle, '', work, String(process.pid)], {
      stdio: ['ignore', 'ignore', 'ignore'],
    }).unref()
  }

  /**
   * Windows and Linux: a running executable can be renamed but not overwritten. Move it aside,
   * put the new one in its place, start it, and let it delete the old one on start-up.
   */
  private async installExecutable(newPath: string): Promise<void> {
    const current = process.execPath
    const previous = previousExecutablePath(current)
    rmSync(previous, { force: true })
    renameSync(current, previous)
    try {
      renameSync(newPath, current)
    } catch {
      // Staging may be on another volume: copy instead of rename.
      writeFileSync(current, new Uint8Array(await Bun.file(newPath).arrayBuffer()))
    }
    if (process.platform !== 'win32') chmodSync(current, 0o755)
    Bun.spawn([current], { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, MD_WAIT_FOR_PID: String(process.pid) } }).unref()
  }

  private changed(): void {
    this.events.emit('updates.changed', this.status())
  }
}

function previousExecutablePath(current: string): string {
  const name = basename(current)
  return join(dirname(current), name.replace(/(\.exe)?$/i, '.previous$1'))
}

/** Removes the executable an update left behind, once we are the new one. */
function cleanupPreviousExecutable(): void {
  if (PLATFORM === 'macos') return
  const previous = previousExecutablePath(process.execPath)
  if (existsSync(previous)) {
    try {
      rmSync(previous, { force: true })
    } catch {
      // Still locked by the exiting process; the next start tries again.
    }
  }
}

async function download(url: string, timeoutMs: number): Promise<ArrayBuffer> {
  const response = await fetch(url, { headers: { 'user-agent': 'MediaDownloader' }, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
  return response.arrayBuffer()
}

/** The asset's SHA-256 must be in the manifest, and the manifest signed by the release key. */
async function verifyRelease(asset: Uint8Array, update: Release): Promise<void> {
  if (!update.manifestUrl || !update.signatureUrl) throw new Error(`Release ${update.tag} is not signed; update refused.`)
  const manifest = new Uint8Array(await download(update.manifestUrl, 30_000))
  const signature = fromBase64Url((new TextDecoder().decode(await download(update.signatureUrl, 30_000))).trim())
  const key = await crypto.subtle.importKey('raw', fromBase64Url(RELEASE_PUBLIC_KEY), 'Ed25519', false, ['verify'])
  if (!(await crypto.subtle.verify('Ed25519', key, signature, manifest))) throw new Error('The release signature does not match; update refused.')
  const expected = findChecksum(new TextDecoder().decode(manifest), update.assetName!)
  if (!expected) throw new Error(`${MANIFEST} has no entry for ${update.assetName}`)
  const actual = new Bun.CryptoHasher('sha256').update(asset).digest('hex')
  if (actual !== expected) throw new Error(`Checksum mismatch for ${update.assetName}; update refused.`)
}

async function exec(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { stdout: 'ignore', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${basename(command[0]!)} failed: ${(await new Response(proc.stderr).text()).trim().slice(0, 300)}`)
}
