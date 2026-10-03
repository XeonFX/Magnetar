import type { FolderEntryDto } from '@magnetar/protocol'

/**
 * Paths on the device, as the file browser builds them. The device decides what may be browsed; these only join
 * and split the paths it handed out, with the separator it named.
 */

export type Separator = '/' | '\\'

/** How the device joins names, read from a path it wrote: Windows paths start with a drive (`C:\`) or a share (`\\nas`). */
export function separatorOf(path: string): Separator {
  return /^[A-Za-z]:\\|^\\\\/.test(path) ? '\\' : '/'
}

/** `name` inside `folder`, as the device joins them: one separator between, none doubled after a root like `/` or `C:\`. */
export function joinPath(folder: string, name: string, separator: Separator): string {
  return folder.endsWith(separator) ? `${folder}${name}` : `${folder}${separator}${name}`
}

/** The last name of a path. The device writes no separator at the end but after a disk's root (`/`, `C:\`): that is itself. */
export function baseName(path: string, separator: Separator): string {
  if (path.endsWith(separator)) return path
  return path.slice(path.lastIndexOf(separator) + 1) || path
}

export interface Crumb {
  name: string
  path: string
}

/**
 * The way from `root` down to `path`: the root, then each folder below it. A path that isn't below the root
 * (which the device never answers) is the root alone.
 */
export function crumbs(root: string, path: string, separator: Separator): Crumb[] {
  const first: Crumb = { name: baseName(root, separator), path: root }
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`
  if (path === root || !path.startsWith(prefix)) return [first]
  const trail = [first]
  let at = root
  for (const name of path.slice(prefix.length).split(separator).filter(Boolean)) {
    at = joinPath(at, name, separator)
    trail.push({ name, path: at })
  }
  return trail
}

/** The folder above `path`, while that is still inside `root`; null at the root. */
export function parentOf(root: string, path: string, separator: Separator): string | null {
  const trail = crumbs(root, path, separator)
  return trail.length > 1 ? trail[trail.length - 2]!.path : null
}

/** Whether `path` is `folder` or inside it, by their words. */
export function isWithin(path: string, folder: string, separator: Separator): boolean {
  const plain = (p: string) => (p.length > 1 && p.endsWith(separator) ? p.slice(0, -1) : p)
  const [p, f] = [plain(path), plain(folder)]
  return p === f || p.startsWith(f.endsWith(separator) ? f : `${f}${separator}`)
}

/**
 * The next page's entries after the ones shown. A folder that changed between pages can hand one again (a file
 * added before it moved the rest along): it is shown once.
 */
export function appendPage(shown: FolderEntryDto[], next: FolderEntryDto[]): FolderEntryDto[] {
  const seen = new Set(shown.map(e => e.name))
  const added: FolderEntryDto[] = []
  for (const entry of next) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    added.push(entry)
  }
  return added.length === 0 ? shown : [...shown, ...added]
}
