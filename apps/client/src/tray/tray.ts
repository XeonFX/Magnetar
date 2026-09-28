import { formatRate } from '@md/protocol/bytes'
import type { App } from '../app.ts'
import { openInBrowser } from '../app.ts'
import { VERSION } from '../config.ts'
import { logger } from '../log.ts'

const log = logger('tray')

export type TrayEntry =
  | { kind: 'label'; text: string }
  | { kind: 'separator' }
  | { kind: 'command'; text: string; run: () => void }

/** Rows of the menu-bar / notification-area menu, rebuilt each time it opens. */
export function buildMenu(app: App, dashboardUrl: string, quit: () => void): TrayEntry[] {
  const entries: TrayEntry[] = []
  const active = app.downloads.active()
  if (active.length === 0) {
    entries.push({ kind: 'label', text: 'No active downloads' })
  } else {
    for (const d of active) {
      const name = d.name.length > 44 ? `${d.name.slice(0, 43)}…` : d.name
      const text = d.status === 'FetchingMetadata' ? `${name} — fetching metadata…`
        : d.status === 'Seeding' ? `${name} — ↑ ${formatRate(d.uploadSpeed)} (seeding)`
        : `${name} — ↓ ${formatRate(d.downloadSpeed)}  ${Math.round(d.progress)}%`
      entries.push({ kind: 'label', text })
    }
    entries.push({ kind: 'separator' })
    entries.push({ kind: 'label', text: `Total ↓ ${formatRate(active.reduce((sum, d) => sum + d.downloadSpeed, 0))}` })
  }

  entries.push({ kind: 'separator' })
  entries.push({ kind: 'command', text: `Dashboard — ${new URL(dashboardUrl).host}`, run: () => openInBrowser(dashboardUrl) })
  const remote = app.remote.status()
  if (remote.paired) {
    entries.push({ kind: 'label', text: remote.connected ? `Remote access: ${remote.accountEmail ?? 'connected'}` : 'Remote access: reconnecting…' })
    entries.push({ kind: 'command', text: 'Open remote dashboard', run: () => openInBrowser(remote.cloudUrl) })
  }

  entries.push({ kind: 'separator' })
  const updates = app.updates.status()
  if (updates.installing) {
    entries.push({ kind: 'label', text: `MediaDownloader v${VERSION}` }, { kind: 'label', text: 'Installing update…' })
  } else if (updates.available) {
    const tag = updates.available.tag
    entries.push({ kind: 'label', text: `MediaDownloader v${VERSION} — ${tag} available` })
    entries.push({
      kind: 'command',
      text: `Update to ${tag} ${updates.canSelfInstall ? '(restarts the app)' : '(opens release page)'}`,
      run: () => void app.updates.install().then(page => page && openInBrowser(page)),
    })
  } else {
    const suffix = updates.lastCheckError ? ' — update check failed'
      : updates.lastCheckedAt ? ` — up to date, checked ${new Date(updates.lastCheckedAt).toTimeString().slice(0, 5)}`
      : ''
    entries.push({ kind: 'label', text: `MediaDownloader v${VERSION}${suffix}` })
    entries.push(updates.checking
      ? { kind: 'label', text: 'Checking for updates…' }
      : { kind: 'command', text: 'Check for Updates…', run: () => void app.updates.check() })
  }
  entries.push({ kind: 'separator' })
  entries.push({ kind: 'command', text: 'Quit MediaDownloader', run: quit })
  return entries
}

/** Total download rate for the menu-bar title, or '' when idle. */
export function speedText(app: App): string {
  const total = app.downloads.active()
    .filter(d => d.status !== 'Seeding')
    .reduce((sum, d) => sum + d.downloadSpeed, 0)
  return total > 0 ? formatRate(total) : ''
}

export function startTray(app: App, dashboardUrl: string, quit: () => void): void {
  const menu = () => buildMenu(app, dashboardUrl, quit)
  const title = () => speedText(app)
  try {
    if (process.platform === 'darwin') {
      void import('./macTray.ts').then(m => m.startMacTray(menu, title))
    } else if (process.platform === 'win32') {
      void import('./windowsTray.ts').then(m => m.startWindowsTray(menu, title, () => openInBrowser(dashboardUrl)))
    } else {
      openInBrowser(dashboardUrl)
    }
  } catch (error) {
    log.error('Could not start the tray icon; opening the dashboard instead', error)
    openInBrowser(dashboardUrl)
  }
}
