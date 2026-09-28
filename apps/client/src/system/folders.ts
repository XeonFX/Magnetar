import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { FolderListing } from '@md/protocol'

/** Lists the subfolders of a folder on the device, for the dashboard's folder browser. */
export function listFolder(path: string | undefined): FolderListing {
  const current = resolve(path?.trim() || homedir())
  const parent = dirname(current) === current ? null : dirname(current)
  if (!existsSync(current)) return { path: current, parent, folders: [], exists: false, error: null }
  try {
    const folders = readdirSync(current, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    return { path: current, parent, folders, exists: true, error: null }
  } catch (error) {
    return { path: current, parent, folders: [], exists: true, error: error instanceof Error ? error.message : String(error) }
  }
}

export function makeFolder(path: string): FolderListing {
  mkdirSync(resolve(path), { recursive: true })
  return listFolder(path)
}

/**
 * Shows the macOS folder chooser via `osascript`: the dashboard runs in a browser, but on the
 * local dashboard the server is the user's own machine. Null when cancelled or unsupported.
 */
export async function pickFolderNatively(start: string | undefined, prompt: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  const escape = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  let script = `POSIX path of (choose folder with prompt "${escape(prompt)}"`
  if (start && existsSync(start)) script += ` default location POSIX file "${escape(start)}"`
  script += ')'
  const proc = Bun.spawn(['/usr/bin/osascript', '-e', script], { stdout: 'pipe', stderr: 'ignore' })
  const output = (await new Response(proc.stdout).text()).trim()
  if ((await proc.exited) !== 0 || !output) return null
  return output.length > 1 ? output.replace(/\/+$/, '') : output
}
