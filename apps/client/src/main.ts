import { App, openInBrowser } from './app.ts'
import { DEFAULT_PORT, IS_DEV, VERSION } from './config.ts'
import { startHttpServer } from './http/server.ts'
import { acquireInstanceLock } from './instance.ts'
import { logger } from './log.ts'
import { DATA_DIR } from './paths.ts'
import { startTelemetry } from './telemetry.ts'
import { startTray } from './tray/tray.ts'

const log = logger('main')

async function waitForPreviousProcess(): Promise<void> {
  const pid = Number(process.env.MD_WAIT_FOR_PID)
  if (!pid) return
  for (let i = 0; i < 120; i++) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await Bun.sleep(250)
  }
}

export async function run(): Promise<void> {
  await waitForPreviousProcess()
  log.info(`MediaDownloader ${VERSION} starting (data: ${DATA_DIR})`)

  const lock = await acquireInstanceLock()
  if (!lock.acquired) {
    // Already running: show that instance's dashboard instead of starting a second engine.
    if (lock.dashboardUrl) openInBrowser(lock.dashboardUrl)
    log.info('Another instance is running; opened its dashboard')
    process.exit(0)
  }

  const app = new App()
  startTelemetry(app)
  app.start()
  const port = Number(process.env.MD_PORT) || DEFAULT_PORT
  const server = startHttpServer(app, port)
  const dashboardUrl = `http://localhost:${server.port}`
  app.agent.publish(dashboardUrl)
  lock.publish(dashboardUrl)

  let stopping = false
  const shutdown = async (code = 0) => {
    if (stopping) return
    stopping = true
    log.info('Shutting down')
    server.stop(true)
    await app.stop()
    lock.release()
    process.exit(code)
  }
  app.updates.onQuitForInstall = async () => {
    stopping = true
    server.stop(true)
    await app.stop()
    lock.release()
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  const trayDisabled = process.env.MD_NO_TRAY === '1' || IS_DEV
  if (!trayDisabled) startTray(app, dashboardUrl, () => void shutdown())
  else if (!IS_DEV && process.env.MD_NO_BROWSER !== '1') openInBrowser(dashboardUrl)
}

process.on('uncaughtException', error => log.error('Uncaught exception', error))
process.on('unhandledRejection', error => log.error('Unhandled rejection', error))

if (import.meta.main) await run()
