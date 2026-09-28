import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { paths } from './paths.ts'

interface LockContents {
  pid: number
  dashboardUrl: string | null
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

/**
 * One app per user: two engines on one database would fight over it and over the same files. A
 * lock file records the owner's pid and dashboard URL; it is stale when that process is gone or
 * no longer answers.
 */
export async function acquireInstanceLock(): Promise<{
  acquired: boolean
  dashboardUrl: string | null
  publish(url: string): void
  release(): void
}> {
  if (existsSync(paths.lock)) {
    try {
      const other = JSON.parse(readFileSync(paths.lock, 'utf8')) as LockContents
      if (other.pid !== process.pid && alive(other.pid) && other.dashboardUrl && (await answers(other.dashboardUrl))) {
        return { acquired: false, dashboardUrl: other.dashboardUrl, publish() {}, release() {} }
      }
    } catch {
      // Unreadable lock: treat as stale.
    }
  }
  const write = (dashboardUrl: string | null) => writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, dashboardUrl } satisfies LockContents))
  write(null)
  return {
    acquired: true,
    dashboardUrl: null,
    publish: url => write(url),
    release: () => rmSync(paths.lock, { force: true }),
  }
}
