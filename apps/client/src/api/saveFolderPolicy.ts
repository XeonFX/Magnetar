import { lstatSync, readlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { ApiError } from './errors.ts'

/**
 * Confines an agent-chosen save folder to the download root.
 *
 * An agent picks tool arguments after reading titles and descriptions fetched from torrent sites,
 * which can carry instructions. A chosen folder plus a chosen torrent would otherwise write
 * attacker-named files anywhere the user can write (a LaunchAgents folder, a shell rc directory).
 * People choosing a folder in the dashboard are not restricted.
 */
export function resolveAgentFolder(requested: string | null | undefined, downloadRoot: string): string | null {
  if (!requested?.trim()) return null
  let candidate: string
  let root: string
  try {
    candidate = canonicalize(requested)
    root = canonicalize(downloadRoot)
  } catch {
    throw new ApiError(`'${requested}' is not a usable folder path.`)
  }
  const prefix = root.endsWith(sep) ? root : root + sep
  if (candidate !== root && !candidate.startsWith(prefix)) {
    throw new ApiError(
      `Downloads can only be saved inside the configured download folder ('${downloadRoot}'). '${requested}' is outside it. ` +
      'Use an absolute path inside that folder, or change the download folder in Settings.')
  }
  return candidate
}

/**
 * Absolute path with every symlink along it resolved, including in ancestors and link targets,
 * as far as the path exists. A purely textual check would pass a link inside the root that points
 * outside it. Inspection errors fail closed.
 */
function canonicalize(path: string, linksFollowed = 0): string {
  if (linksFollowed > 40) throw new Error('Too many symbolic links')
  const full = resolve(path)
  const { root } = parse(full)
  let current = root
  for (const component of full.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, component)
    let stats
    try {
      stats = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(current)
      current = canonicalize(isAbsolute(target) ? target : join(dirname(current), target), linksFollowed + 1)
    } else if (!stats.isDirectory()) {
      throw new Error('The folder path contains a file')
    }
  }
  return current.length > root.length ? current.replace(/[\\/]+$/, '') : current
}
