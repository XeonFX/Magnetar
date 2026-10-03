/**
 * Which release a merge to main becomes. Used by .github/workflows/release.yml (`plan`) and the Worker deploy in
 * ci.yml (`display`), so the website and the app name the same version for the same code.
 *
 *   node scripts/release-version.ts plan [--sha <commit>] [--tag <v1.3.0>]
 *   node scripts/release-version.ts display [--sha <commit>]
 *
 * The version is the latest plain vX.Y.Z tag plus one patch; minor and major releases are tags pushed by hand.
 * Pre-release tags (v2.0.0-rc.1) are ignored. A merge that changes only docs, tests or CI files is not released.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

export type Version = readonly [major: number, minor: number, patch: number]

/** The version of a plain release tag ("v1.2.3"); a pre-release or any other tag is not a release. */
export function parseTag(tag: string): Version | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const format = (version: Version) => `${version[0]}.${version[1]}.${version[2]}`

/** The highest release version among the tags, numerically (v1.10.0 is above v1.9.0), or null with none. */
export function latestVersion(tags: readonly string[]): Version | null {
  let latest: Version | null = null
  for (const tag of tags) {
    const version = parseTag(tag)
    if (version && (!latest || compare(version, latest) > 0)) latest = version
  }
  return latest
}

/** The next patch release, "1.2.3" after v1.2.2; with no release yet, `first` (the committed version). */
export function nextVersion(tags: readonly string[], first: string): string {
  const latest = latestVersion(tags)
  return latest ? format([latest[0], latest[1], latest[2] + 1]) : first
}

/** Files that never reach a user of the app or the website: documentation, tests, CI and repository housekeeping. */
const unshipped = [
  /^docs\//,
  /^\.github\//,
  /^\.claude\//,
  /^apps\/e2e\//,
  /^apps\/worker\/test\//,
  /^apps\/client\/tests\//,
  /(^|\/)[^/]+\.(md|mdx)$/,
  /\.test\.tsx?$/,
  /^(LICENSE|renovate\.json|\.gitignore|\.gitattributes|\.editorconfig)$/,
]

/** Whether any of the changed files is part of what ships. */
export function changesShippedApp(paths: readonly string[]): boolean {
  return paths.some(path => path !== '' && !unshipped.some(pattern => pattern.test(path)))
}

export interface Plan {
  /** Whether this commit becomes a release. */
  release: boolean
  /** The tag to publish ("v1.2.3"); empty when there is no release. */
  tag: string
  reason: string
}

/** What a commit becomes, given the release tags, its relation to the latest one and the files changed since. */
export function plan(input: { tags: readonly string[]; first: string; explicitTag?: string; containedInLatest?: boolean; changed?: readonly string[] }): Plan {
  if (input.explicitTag) return { release: true, tag: input.explicitTag, reason: 'tag pushed by hand' }
  const latest = latestVersion(input.tags)
  if (latest && input.containedInLatest) return { release: false, tag: '', reason: `already part of v${format(latest)}` }
  if (latest && !changesShippedApp(input.changed ?? [])) return { release: false, tag: '', reason: `only docs, tests or CI changed since v${format(latest)}` }
  return { release: true, tag: `v${nextVersion(input.tags, input.first)}`, reason: latest ? `the app changed since v${format(latest)}` : 'no release yet' }
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

/** The latest release tag and what separates `sha` from it, read from the checkout (which needs its tags). */
function fromRepository(sha: string, explicitTag?: string): Plan & { latest: string | null } {
  const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean)
  const latest = latestVersion(tags)
  const latestTag = latest ? `v${format(latest)}` : null
  const first = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
  let containedInLatest = false
  let changed: string[] = []
  if (latestTag) {
    try {
      git('merge-base', '--is-ancestor', sha, latestTag)
      containedInLatest = true
    } catch {
      changed = git('diff', '--name-only', `${latestTag}...${sha}`).split('\n')
    }
  }
  return { ...plan({ tags, first, explicitTag, containedInLatest, changed }), latest: latestTag }
}

if (process.argv[1] === import.meta.filename) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { sha: { type: 'string' }, tag: { type: 'string' } } })
  const sha = values.sha ?? git('rev-parse', 'HEAD')
  const result = fromRepository(sha, values.tag)
  if (positionals[0] === 'plan') {
    const lines = [`release=${result.release}`, `tag=${result.tag}`, `version=${result.tag.slice(1)}`]
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n')
    console.log(`${lines.join(' ')} (${result.reason})`)
  } else if (positionals[0] === 'display') {
    // The version the website shows: the one this commit is or is about to be released as.
    console.log(result.release ? result.tag.slice(1) : (result.latest ?? result.tag).slice(1))
  } else {
    throw new Error('Usage: release-version.ts plan|display [--sha <commit>] [--tag <tag>]')
  }
}
