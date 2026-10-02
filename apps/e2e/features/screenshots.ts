/**
 * The features page's screenshots (apps/web/src/features/shots/, their sizes in shots.json), each in light and dark:
 * the real app on fresh data. It starts the Worker (wrangler dev, its own local D1) and three copies of the app, each
 * with its own data folder, downloads real, freely licensed torrents (Blender's open films, Ubuntu and Debian
 * images), adds a series and three watches, pairs two of the apps with a dev account on the local website, and
 * links a phone. Run from the repository:
 *
 *     npm run build -w @magnetar/web
 *     MAGNETAR_VERSION=1.1.0 cargo build -p magnetar
 *     npm run screenshots -w @magnetar/e2e [-- --only=search,player] [-- --modes=dark]
 *
 * The app is built with a release's version so it shows what a user's does (updates on, no "dev"). Searches ask the
 * real torrent sources, for the open films' titles only. Everything it starts and writes goes when it ends.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { captureArgs, captureShots, DEVICES, shot, type Device, type Scene } from '@codefusion-cc/features-page/screenshots'

const ROOT = new URL('../../../', import.meta.url).pathname
const WEB = new URL('../../web/src/features/', import.meta.url)
const APP = join(ROOT, process.env.MAGNETAR_BINARY ?? 'target/debug/magnetar')
const WORKER_PORT = 8797
const WEBSITE = `http://localhost:${WORKER_PORT}`
const ACCOUNT = 'alex@example.com'

/** The three copies of the app: the one the shots are of, a second on the account, and one asking to join it. */
const DEVICES_ON_ACCOUNT = {
  main: { port: 47_891, name: 'MacBook-Pro' },
  second: { port: 47_892, name: 'Living-Room-PC' },
  joining: { port: 47_893, name: 'Office-PC' },
} as const
type DeviceKey = keyof typeof DEVICES_ON_ACCOUNT
const local = (key: DeviceKey = 'main') => `http://localhost:${DEVICES_ON_ACCOUNT[key].port}`

/** Freely licensed torrents, from their publishers. */
const TORRENTS = {
  sintel: 'https://webtorrent.io/torrents/sintel.torrent',
  bunny: 'https://webtorrent.io/torrents/big-buck-bunny.torrent',
  cosmos: 'https://webtorrent.io/torrents/cosmos-laundromat.torrent',
  tears: 'https://webtorrent.io/torrents/tears-of-steel.torrent',
  debian: 'https://cdimage.debian.org/debian-cd/current/amd64/bt-cd/debian-13.7.0-amd64-netinst.iso.torrent',
  ubuntu: 'https://releases.ubuntu.com/26.04.1/ubuntu-26.04.1-desktop-amd64.iso.torrent',
}
/** Shown pasted into the Add dialog: three of the same, as magnet links. */
const MAGNETS = [
  'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337',
  'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337',
  'magnet:?xt=urn:btih:209c8226b299b308beaf2b9cd3fb49212dbd13ec&dn=Tears+of+Steel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337',
]

const scratch = mkdtempSync(join(tmpdir(), 'magnetar-shots-'))
const processes: ChildProcess[] = []

function start(command: string, args: string[], options: { cwd: string; env?: Record<string, string>; log: string }): void {
  const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const log = join(scratch, options.log)
  child.stdout?.on('data', chunk => writeFileSync(log, chunk, { flag: 'a' }))
  child.stderr?.on('data', chunk => writeFileSync(log, chunk, { flag: 'a' }))
  processes.push(child)
}

async function waitFor(url: string, what: string, timeout = 120_000): Promise<void> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await fetch(url).then(r => r.ok, () => false)) return
    await sleep(500)
  }
  throw new Error(`${what} didn't start (${url}); its log is in ${scratch}`)
}

/** Stops everything started, and waits (a few seconds at most) until each has gone and written its last log line. */
async function stopAll(): Promise<void> {
  await Promise.all(processes.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
    setTimeout(resolve, 5_000)
    // Each was started as its own group: wrangler's workerd goes with it.
    try { if (child.pid) process.kill(-child.pid, 'SIGTERM') } catch { resolve() }
  })))
  for (const child of processes) {
    child.stdout?.removeAllListeners('data')
    child.stderr?.removeAllListeners('data')
  }
}

async function startServers(): Promise<void> {
  if (!existsSync(APP)) throw new Error(`No app at ${APP}: MAGNETAR_VERSION=1.1.0 cargo build -p magnetar`)
  if (!existsSync(join(ROOT, 'apps/web/dist/index.html'))) throw new Error('No dashboard build: npm run build -w @magnetar/web')
  const worker = join(ROOT, 'apps/worker')
  const persist = join(scratch, 'wrangler')
  await new Promise<void>((resolve, reject) => {
    const migrate = spawn('npx', ['wrangler', 'd1', 'migrations', 'apply', 'magnetar', '--local', '--env', 'dev', '--persist-to', persist], { cwd: worker, stdio: 'ignore' })
    migrate.on('exit', code => (code === 0 ? resolve() : reject(new Error(`D1 migrations failed (${code})`))))
  })
  start('npx', ['wrangler', 'dev', '--env', 'dev', '--port', String(WORKER_PORT), '--persist-to', persist], { cwd: worker, log: 'worker.log' })
  for (const [key, device] of Object.entries(DEVICES_ON_ACCOUNT)) {
    const home = join(scratch, key)
    mkdirSync(join(home, 'downloads'), { recursive: true })
    start(APP, [], {
      cwd: ROOT,
      log: `${key}.log`,
      env: {
        MAGNETAR_PORT: String(device.port),
        MAGNETAR_DATA_DIRECTORY: join(home, 'data'),
        MAGNETAR_DOWNLOAD_FOLDER: join(home, 'downloads'),
        MAGNETAR_LEGACY_DATABASE: join(home, 'no-legacy.db'),
        MAGNETAR_CLOUD_URL: WEBSITE,
        MAGNETAR_NO_TRAY: '1',
        MAGNETAR_NO_BROWSER: '1',
      },
    })
  }
  await waitFor(`${WEBSITE}/app-config.json`, 'The Worker')
  for (const key of Object.keys(DEVICES_ON_ACCOUNT) as DeviceKey[]) await waitFor(`${local(key)}/health`, `The app on ${local(key)}`)
}

/** A call to an app over its dashboard's own socket, from a page on its origin (the socket checks it). */
async function rpc<T = unknown>(page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(([method, params]) => new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(`ws://${location.host}/ws`)
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }))
    socket.onmessage = event => {
      const message = JSON.parse(event.data as string) as { id?: number; result?: T; error?: { message: string } }
      if (message.id !== 1) return
      socket.close()
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolve(message.result as T)
    }
    socket.onerror = () => reject(new Error(`${method}: no socket`))
    // A message the app refuses closes the socket without an answer.
    socket.onclose = () => reject(new Error(`${method}: the socket closed without an answer`))
    setTimeout(() => reject(new Error(`${method}: no answer in 30 s`)), 30_000)
  }), [method, params] as const)
}

interface DownloadRow { id: number; name: string; status: string; progress: number }

async function downloads(page: Page): Promise<DownloadRow[]> {
  return rpc<DownloadRow[]>(page, 'downloads.list')
}

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeout = 240_000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await sleep(1_000)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** A page on an app's origin, for its socket. */
async function socketPage(browser: Browser, key: DeviceKey): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await page.goto(`${local(key)}/health`)
  return page
}

async function startTorrent(page: Page, url: string): Promise<DownloadRow> {
  const file = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(30_000) })).arrayBuffer())
  return rpc<DownloadRow>(page, 'downloads.start', { torrent: file.toString('base64') })
}

/** Signs a browser in to the local website with the dev account. */
async function signIn(page: Page): Promise<void> {
  await page.goto(`${WEBSITE}/login`)
  await page.getByLabel('Email').fill(ACCOUNT)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('heading', { name: 'Your devices' }).waitFor()
}

/** The browsers on the website that stay linked for the whole run: the one that paired, and a phone. */
interface Website { desktop: Page; phone: Page }

/** What the shots show: downloads in every state, a series, watches, settings, and two apps on one account. */
async function prepare(browser: Browser): Promise<Website> {
  const main = await socketPage(browser, 'main')
  console.log('Downloading the open films at full speed…')
  await startTorrent(main, TORRENTS.sintel)
  await startTorrent(main, TORRENTS.bunny)
  await until('Sintel and Big Buck Bunny to finish', async () => {
    const rows = await downloads(main)
    return rows.filter(row => row.status === 'Completed').length >= 2
  })

  // From here on slow mode holds the rest at 2 MB/s, as it shows in the speed settings.
  await rpc(main, 'settings.update', {
    altSpeedMode: 'on', altScheduleFrom: 8 * 60, altScheduleTo: 23 * 60,
    uploadLimit: 1024 * 1024, postDownloadAction: 'SeedToRatio', seedRatio: 1.5,
    desktopEnabled: true, ntfyTopic: 'magnetar-alex', notifyOnStart: false, notifyOnComplete: true,
  })
  const tears = await startTorrent(main, TORRENTS.tears)
  await startTorrent(main, TORRENTS.cosmos)
  await startTorrent(main, TORRENTS.debian)
  await startTorrent(main, TORRENTS.ubuntu)
  await until('Tears of Steel to start', async () => (await downloads(main)).find(row => row.id === tears.id && row.progress > 0.05))
  await rpc(main, 'downloads.pause', { id: tears.id })

  await rpc(main, 'series.create', { name: 'Pioneer One', query: 'Pioneer One', startFrom: 'new', resolution: '1080p', minSeeders: 3, checkIntervalMinutes: 360, preferWords: 'VODO' })
  for (const watch of [
    { query: 'Ubuntu 26.10 desktop', checkIntervalMinutes: 360 },
    { query: 'Blender 5.1 open movie', checkIntervalMinutes: 1440, resolution: '2160p' },
    { query: 'Debian 14', checkIntervalMinutes: 10_080 },
  ]) await rpc(main, 'watches.create', watch)
  await rpc(main, 'agent.set', { enabled: true })

  console.log('Pairing two apps with the dev account…')
  const desktop = await (await browser.newContext({ ...DEVICES.desktop, locale: 'en-US' })).newPage()
  await signIn(desktop)
  for (const key of ['main', 'second'] as const) {
    const page = key === 'main' ? main : await socketPage(browser, key)
    const status = await rpc<{ pendingPairing: { url: string } | null }>(page, 'remote.pair', { deviceName: DEVICES_ON_ACCOUNT[key].name })
    await desktop.goto(status.pendingPairing!.url)
    await desktop.getByRole('button', { name: 'Connect', exact: true }).click()
    await desktop.waitForURL(`${WEBSITE}/${DEVICES_ON_ACCOUNT[key].name}`)
    await until(`${key} to be paired`, async () => (await rpc<{ paired: boolean; connected: boolean }>(page, 'remote.status')).connected)
  }
  const phone = await (await browser.newContext({ ...DEVICES.phone, locale: 'en-US' })).newPage()
  await signIn(phone)
  const link = await rpc<{ url: string }>(main, 'remote.linkBrowser', { label: 'Alex’s iPhone' })
  await phone.goto(link.url)
  await phone.waitForURL(`${WEBSITE}/${DEVICES_ON_ACCOUNT.main.name}`)
  return { desktop, phone }
}

/** The run's theme in this browser, as the dashboard keeps it, and the system's to match. */
async function showMode(page: Page, mode: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: mode })
  await page.evaluate(value => localStorage.setItem('magnetar-theme', value), mode)
}

/**
 * What only this run's setup shows, as a user's install shows it: the scratch folders as the app's default ones, and
 * the local website as the real one. Run just before a shot; the dashboard itself is untouched.
 */
async function tidy(page: Page): Promise<void> {
  const replacements: [string, string][] = []
  for (const root of new Set([scratch, realpathSync(scratch)])) {
    replacements.push([`${root}/main/data`, '/Users/alex/Library/Application Support/cc.codefusion.magnetar'])
    replacements.push([`${root}/main/downloads`, '/Users/alex/Downloads/Magnetar'])
  }
  replacements.push([WEBSITE, 'https://magnetar.codefusion.cc'], [new URL(WEBSITE).host, 'magnetar.codefusion.cc'])
  await page.evaluate(pairs => {
    const swap = (text: string) => pairs.reduce((value, [from, to]) => value.split(from).join(to), text)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const next = swap(node.textContent ?? '')
      if (next !== node.textContent) node.textContent = next
    }
    for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) input.value = swap(input.value)
  }, replacements)
}

/** Nothing focused: no caret or focus ring in the shot. */
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

/** Scrolls the page so this heading sits just under the top, whichever element scrolls. */
async function scrollToText(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().evaluate(element => {
    element.scrollIntoView({ block: 'start' })
    let scroller: Element | null = element.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
    ;(scroller ?? document.scrollingElement)?.scrollBy(0, -32)
  })
}

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true }).first().waitFor()
const dialog = (page: Page, title: string) => page.locator('dialog[open]').filter({ hasText: title })

/** A search, once every source has answered. */
async function search(page: Page, address: string): Promise<void> {
  await page.goto(`${local()}${address}`)
  await heading(page, 'Search')
  await page.locator('button[aria-label="Search"]:not([disabled])').waitFor({ timeout: 60_000 })
  await blur(page)
}

/** A local page on a device, its heading in view. */
const localShot = (name: string, path: string, title: string, options: { device?: Device; ready?: (page: Page) => Promise<unknown> } = {}) =>
  shot(name, async (page: Page) => {
    await page.goto(`${local()}${path}`)
    await heading(page, title)
    await options.ready?.(page)
    await tidy(page)
  }, { device: options.device })

function scenes(website: Website): Scene<BrowserContext, Page>[] {
  return [
    localShot('downloads', '/', 'Downloads', { ready: page => page.getByText('Ubuntu', { exact: false }).first().waitFor() }),
    shot('search', (page: Page) => search(page, '/search/sintel')),
    shot('search-phone', (page: Page) => search(page, '/search/big+buck+bunny?res=1080p'), { device: DEVICES.phone }),
    shot('search-sources', async (page: Page) => {
      await search(page, '/search/tears+of+steel')
      await page.getByRole('button', { name: 'Show sources' }).click()
    }),
    localShot('add', '/', 'Downloads', {
      ready: async page => {
        await page.getByRole('button', { name: 'Add', exact: true }).click()
        const box = dialog(page, 'Add magnet links or torrent files').getByRole('textbox')
        await box.fill(MAGNETS.join('\n'))
        await box.evaluate(element => { element.scrollTop = 0 })
        await blur(page)
      },
    }),
    localShot('watchlist', '/series', 'Watchlist', { ready: page => page.getByText('Pioneer One').first().waitFor() }),
    localShot('watches', '/series/releases', 'Watchlist', { ready: page => page.getByText('Ubuntu 26.10').first().waitFor() }),
    {
      shots: ['details', 'player'],
      run: async ({ page: open, shoot, wants }) => {
        const page = await open()
        await page.goto(local())
        await heading(page, 'Downloads')
        await page.locator('li').filter({ hasText: 'Sintel' }).getByRole('button', { name: 'Sintel', exact: true }).click()
        const details = dialog(page, 'Download details')
        await details.getByText('Sintel.mp4').waitFor()
        await tidy(page)
        await shoot(page, 'details')
        if (!wants('player')) return
        await details.getByRole('button', { name: 'Play Sintel.mp4' }).click()
        const video = page.locator('dialog[open] video')
        await video.waitFor()
        // The first line of the English subtitles, a moment in.
        await page.waitForFunction(() => (document.querySelector('dialog[open] video') as HTMLVideoElement | null)?.textTracks.length)
        await video.evaluate(async (element: HTMLVideoElement) => {
          element.muted = true
          await new Promise(resolve => element.readyState >= 2 ? resolve(null) : element.addEventListener('loadeddata', resolve, { once: true }))
          const tracks = [...element.textTracks]
          const english = tracks.find(track => /\ben\b|english/i.test(track.label)) ?? tracks[0]!
          for (const track of tracks) track.mode = track === english ? 'showing' : 'disabled'
          element.currentTime = 108
          await new Promise(resolve => element.addEventListener('seeked', resolve, { once: true }))
          element.pause()
          // The cues arrive once the track is showing.
          for (let i = 0; i < 50 && !english.activeCues?.length; i++) await new Promise(resolve => setTimeout(resolve, 100))
        })
        await page.waitForTimeout(1_500)
        await shoot(page, 'player')
      },
    },
    {
      shots: ['speed'],
      run: async ({ page: open, shoot }) => {
        const page = await open()
        await page.goto(`${local()}/settings/downloads`)
        await heading(page, 'Settings')
        // Slow mode stays on for the run; its schedule shows while the shot is taken.
        await page.getByRole('radio', { name: 'On a schedule' }).click()
        try {
          await scrollToText(page, 'Speed limits')
          await tidy(page)
          await shoot(page, 'speed')
        } finally {
          await page.getByRole('radio', { name: 'Always' }).click()
        }
      },
    },
    localShot('notifications', '/settings/notifications', 'Settings'),
    localShot('settings', '/settings', 'Settings'),
    localShot('about', '/settings/about', 'Settings'),
    localShot('agents', '/settings/agents', 'Settings'),
    {
      shots: ['remote', 'link-qr'],
      run: async ({ page: open, shoot, wants }) => {
        const page = await open()
        await page.goto(`${local()}/settings/remote`)
        await page.getByText('Connected', { exact: true }).first().waitFor()
        await tidy(page)
        await shoot(page, 'remote')
        if (!wants('link-qr')) return
        await page.getByLabel('Name for the new browser').fill('Pixel 9')
        await page.getByRole('button', { name: 'Link a phone or another browser' }).click()
        await dialog(page, 'Link another browser').locator('img').waitFor()
        await tidy(page)
        await shoot(page, 'link-qr')
        // The QR code's browser never comes: revoke it, so the next mode's list is the same.
        await dialog(page, 'Link another browser').getByRole('button', { name: 'Done' }).click()
        const row = page.locator('div').filter({ hasText: /^Pixel 9/ }).last()
        await page.getByRole('button', { name: 'Revoke' }).last().click()
        await page.locator('dialog[open]').getByRole('button', { name: 'Revoke' }).click()
        await row.waitFor({ state: 'detached' }).catch(() => {})
      },
    },
    {
      shots: ['pair'],
      run: async ({ mode, page: open, shoot }) => {
        const joining = await open()
        await joining.goto(`${local('joining')}/health`)
        const status = await rpc<{ pendingPairing: { url: string } | null }>(joining, 'remote.pair', { deviceName: DEVICES_ON_ACCOUNT.joining.name })
        try {
          const page = website.desktop
          await page.goto(status.pendingPairing!.url)
          await showMode(page, mode)
          await page.reload()
          await page.getByRole('button', { name: 'Connect', exact: true }).waitFor()
          await tidy(page)
          await shoot(page, 'pair')
        } finally {
          await rpc(joining, 'remote.cancelPairing')
        }
      },
    },
    websiteShot('devices', website, 'desktop', '/', page => page.getByRole('heading', { name: 'Your devices' }).waitFor()),
    websiteShot('remote-phone', website, 'phone', `/${DEVICES_ON_ACCOUNT.main.name}`, page => heading(page, 'Downloads')),
    websiteShot('switcher', website, 'desktop', `/${DEVICES_ON_ACCOUNT.main.name}/series`, async page => {
      await heading(page, 'Watchlist')
      await page.getByRole('button', { name: new RegExp(DEVICES_ON_ACCOUNT.main.name) }).first().click()
      await page.getByText(DEVICES_ON_ACCOUNT.second.name).last().waitFor()
    }),
  ]
}

/** A shot on the website in one of the run's linked browsers: their keys can't move to a new context. */
function websiteShot(name: string, website: Website, which: keyof Website, path: string, ready: (page: Page) => Promise<unknown>): Scene<BrowserContext, Page> {
  return {
    shots: [name],
    run: async ({ mode, shoot }) => {
      const page = website[which]
      await page.goto(`${WEBSITE}${path}`)
      await showMode(page, mode)
      await page.reload()
      await ready(page)
      await tidy(page)
      await shoot(page, name)
    },
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void stopAll().finally(() => process.exit(130)))
}

// Until every shot is in, the logs stay for a look.
let failed = true
try {
  await startServers()
  // Chrome rather than Playwright's Chromium: the player needs its H.264.
  const browser = await chromium.launch({ channel: 'chrome', args: ['--hide-scrollbars'] })
  try {
    const website = await prepare(browser)
    const result = await captureShots({
      browser,
      outDir: new URL('shots/', WEB),
      sizesFile: new URL('shots.json', WEB),
      scenes: scenes(website),
      contextOptions: { locale: 'en-US' },
      busy: '[aria-busy="true"], .loading-dots',
      prepare: (context, { mode }) => context.addInitScript(value => {
        try { localStorage.setItem('magnetar-theme', value) } catch { /* about:blank */ }
      }, mode),
      ...captureArgs(process.argv, process.env),
    })
    failed = result.failed.length > 0
  } finally {
    await browser.close()
  }
} finally {
  await stopAll()
  if (!failed) rmSync(scratch, { recursive: true, force: true })
  else console.log(`Logs kept in ${scratch}`)
}
if (failed) process.exitCode = 1
