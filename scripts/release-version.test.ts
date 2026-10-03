import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { changesShippedApp, latestVersion, nextVersion, parseTag, plan } from './release-version.ts'

describe('nextVersion', () => {
  it('adds one patch to the latest tag', () => {
    expect(nextVersion(['v1.0.0', 'v1.1.0', 'v1.2.1'], '1.2.0')).toBe('1.2.2')
  })
  it('starts from the committed version when there is no release yet', () => {
    expect(nextVersion([], '1.2.0')).toBe('1.2.0')
    expect(nextVersion(['not-a-release'], '1.2.0')).toBe('1.2.0')
  })
  it('continues from a minor release tagged by hand', () => {
    expect(nextVersion(['v1.2.0', 'v1.2.7', 'v1.3.0'], '1.2.0')).toBe('1.3.1')
    expect(nextVersion(['v1.9.9', 'v2.0.0'], '1.2.0')).toBe('2.0.1')
  })
  it('compares numerically, not as text', () => {
    expect(latestVersion(['v1.9.0', 'v1.10.0', 'v1.2.30'])).toEqual([1, 10, 0])
    expect(nextVersion(['v1.2.9', 'v1.2.10'], '0.0.0')).toBe('1.2.11')
  })
  it('ignores pre-release and other tags', () => {
    expect(nextVersion(['v1.2.0', 'v1.3.0-rc.1', 'v2.0.0-beta', 'latest', '1.9.0', 'v1.2.0.1'], '0.0.0')).toBe('1.2.1')
    expect(parseTag('v1.3.0-rc.1')).toBeNull()
  })
})

describe('changesShippedApp', () => {
  it('skips docs, tests and CI', () => {
    expect(changesShippedApp(['docs/MAP.md', 'README.md', '.github/workflows/ci.yml', 'apps/e2e/tests/a.e2e.ts', 'apps/client/tests/x.rs', 'apps/worker/test/relay.test.ts', 'apps/web/src/lib/a.test.ts', 'apps/web/CHANGELOG.md'])).toBe(false)
    expect(changesShippedApp([])).toBe(false)
  })
  it('counts anything that ships', () => {
    expect(changesShippedApp(['docs/MAP.md', 'apps/client/src/rpc.rs'])).toBe(true)
    expect(changesShippedApp(['apps/web/src/i18n/en.json'])).toBe(true)
    expect(changesShippedApp(['Cargo.lock'])).toBe(true)
    expect(changesShippedApp(['apps/worker/migrations/0006_x.sql'])).toBe(true)
  })
})

describe('plan', () => {
  const tags = ['v1.2.0', 'v1.2.1']
  it('releases the next patch when the app changed', () => {
    expect(plan({ tags, first: '1.2.0', changed: ['apps/client/src/rpc.rs'] })).toMatchObject({ release: true, tag: 'v1.2.2' })
  })
  it('does not release docs-only changes', () => {
    expect(plan({ tags, first: '1.2.0', changed: ['docs/MAP.md', '.github/workflows/ci.yml'] })).toMatchObject({ release: false, tag: '' })
  })
  it('does not release a commit the latest tag already contains', () => {
    expect(plan({ tags, first: '1.2.0', containedInLatest: true, changed: ['apps/client/src/rpc.rs'] }).release).toBe(false)
  })
  it('releases the first version when nothing is tagged', () => {
    expect(plan({ tags: [], first: '1.2.0' })).toMatchObject({ release: true, tag: 'v1.2.0' })
  })
  it('publishes a tag pushed by hand as it is', () => {
    expect(plan({ tags, first: '1.2.0', explicitTag: 'v1.3.0', changed: [] })).toMatchObject({ release: true, tag: 'v1.3.0' })
  })
})

describe('in a repository', () => {
  const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
  const script = join(import.meta.dirname, 'release-version.ts')
  const plan = (cwd: string, ...args: string[]) => execFileSync('node', [script, ...args], { cwd, encoding: 'utf8' }).trim()
  function commit(cwd: string, file: string) {
    mkdirSync(join(cwd, file, '..'), { recursive: true })
    writeFileSync(join(cwd, file), String(Math.random()))
    run(cwd, 'add', '-A')
    run(cwd, 'commit', '-m', file)
  }

  it('follows the tags and the paths changed since the latest one', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'release-version-'))
    run(cwd, 'init', '-q', '-b', 'main')
    writeFileSync(join(cwd, 'package.json'), '{"version":"1.2.0"}')
    commit(cwd, 'apps/client/src/main.rs')
    expect(plan(cwd, 'plan')).toContain('tag=v1.2.0')
    run(cwd, 'tag', 'v1.2.0')
    expect(plan(cwd, 'plan')).toContain('release=false')
    commit(cwd, 'docs/a.md')
    expect(plan(cwd, 'plan')).toContain('release=false')
    expect(plan(cwd, 'display')).toBe('1.2.0')
    commit(cwd, 'apps/web/src/a.ts')
    expect(plan(cwd, 'plan')).toContain('tag=v1.2.1')
    expect(plan(cwd, 'display')).toBe('1.2.1')
    run(cwd, 'tag', 'v1.2.1')
    run(cwd, 'tag', 'v1.3.0-rc.1')
    commit(cwd, 'apps/web/src/b.ts')
    expect(plan(cwd, 'plan')).toContain('tag=v1.2.2')
    run(cwd, 'tag', 'v1.3.0')
    commit(cwd, 'apps/web/src/c.ts')
    expect(plan(cwd, 'plan')).toContain('tag=v1.3.1')
    // A queued older merge is already inside the newer release.
    expect(plan(cwd, 'plan', '--sha', 'HEAD~1')).toContain('release=false')
  })
})
