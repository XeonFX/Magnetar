import { compareVersions, parseReleaseNotes } from '@codefusion-cc/app-update'
import { ReleaseNotes, type ReleaseNotesClasses } from '@codefusion-cc/app-update/react'
import type { ReleaseDto, ReleasesDto } from '@magnetar/protocol'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFormatDate, useT } from '../lib/i18n.tsx'
import { releasesProblemText } from '../lib/releases.ts'
import { MAGNETAR_REPO } from '@magnetar/protocol/cloud'

/** Releases shown before "Older releases" when none is newer than the one running. */
const SHOWN = 3

type State = { status: 'loading' } | { status: 'ready'; releases: ReleaseDto[]; problem: ReleasesDto['problem'] } | { status: 'failed' }

/**
 * What each release brings, newest first, from its notes on GitHub. With `running`, the release this app runs is
 * marked and the ones after it stand out as new; older ones fold away. `load` reads the releases: the device's own
 * (`updates.releases`) or the website's (`/api/releases`).
 */
export function Changelog({ load, running }: { load: () => Promise<ReleasesDto>; running?: string | null }) {
  const t = useT()
  const formatDate = useFormatDate()
  const [state, setState] = useState<State>({ status: 'loading' })
  const read = useCallback(() => {
    let cancelled = false
    setState({ status: 'loading' })
    load().then(
      ({ releases, problem }) => !cancelled && setState({ status: 'ready', releases, problem }),
      () => !cancelled && setState({ status: 'failed' }),
    )
    return () => { cancelled = true }
  }, [load])
  useEffect(read, [read])

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label={t('changelog.loading')}>
        {[0, 1].map(i => <div key={i} className="skeleton h-24 w-full" />)}
      </div>
    )
  }
  if (state.status === 'failed' || (state.problem && !state.releases.length)) {
    const text = state.status === 'ready' && state.problem ? releasesProblemText(t, state.problem, null, formatDate) : t('releases.unavailable')
    return (
      <div role="alert" className="alert alert-soft alert-warning">
        <span>{text}</span>
        <button type="button" className="btn btn-sm" onClick={read}><RefreshCw size={14} />{t('changelog.retry')}</button>
      </div>
    )
  }
  if (!state.releases.length) return <p className="muted text-sm">{t('changelog.empty')}</p>

  const { releases } = state
  const newer = running ? releases.filter(r => compareVersions(r.version, running) === 1).length : 0
  const installed = running ? releases.findIndex(r => compareVersions(r.version, running) === 0) : -1
  const split = Math.max(SHOWN, newer, installed + 1)
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3">
        {releases.slice(0, split).map(release => <li key={release.tag}><Release release={release} running={running} /></li>)}
      </ol>
      {releases.length > split && (
        <details className="group">
          <summary className="link link-hover muted cursor-pointer text-sm">{t('changelog.older', releases.length - split)}</summary>
          <ol className="mt-3 flex flex-col gap-3">
            {releases.slice(split).map(release => <li key={release.tag}><Release release={release} running={running} /></li>)}
          </ol>
        </details>
      )}
    </div>
  )
}

function Release({ release, running }: { release: ReleaseDto; running?: string | null }) {
  const t = useT()
  const formatDate = useFormatDate()
  const blocks = useMemo(() => parseReleaseNotes(release.notes, { repo: MAGNETAR_REPO }), [release.notes])
  const order = running ? compareVersions(release.version, running) : null
  const title = release.name && release.name !== release.tag ? release.name : `Magnetar ${release.version}`
  return (
    <article className="rounded-field border border-base-300 p-4" aria-label={title}>
      <header className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="font-semibold">{title}</h3>
        {order === 0 && <span className="badge badge-sm badge-soft badge-success">{t('changelog.installed')}</span>}
        {order === 1 && !release.prerelease && <span className="badge badge-sm badge-soft badge-primary">{t('changelog.new')}</span>}
        {release.prerelease && <span className="badge badge-sm badge-soft badge-warning">{t('changelog.prerelease')}</span>}
        <span className="flex-1" />
        {release.publishedAt && <time className="muted text-xs" dateTime={release.publishedAt}>{formatDate(release.publishedAt)}</time>}
      </header>
      {blocks.length ? <ReleaseNotes notes={blocks} classes={NOTES_CLASSES} /> : <p className="muted text-sm">{t('changelog.noNotes')}</p>}
      <a className="link link-hover muted mt-3 inline-flex items-center gap-1 text-xs" href={release.url} target="_blank" rel="noreferrer noopener">
        <ExternalLink size={12} />{t('changelog.onGitHub')}
      </a>
    </article>
  )
}

/** The app's look for release notes. */
const NOTES_CLASSES: ReleaseNotesClasses = {
  root: 'flex flex-col gap-2 text-sm',
  heading: 'muted mt-1 text-xs font-semibold uppercase tracking-wide',
  paragraph: 'break-words',
  list: 'flex flex-col gap-1 pl-5 list-disc',
  orderedList: 'flex flex-col gap-1 pl-5 list-decimal',
  item: 'break-words',
  code: 'overflow-x-auto rounded-field bg-base-200 p-3 text-xs',
  inlineCode: 'rounded bg-base-200 px-1 text-[0.85em]',
  link: 'link',
}
