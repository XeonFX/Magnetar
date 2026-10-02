import { compareVersions, parseReleaseNotes, type NotesBlock, type NotesInline } from '@codefusion-cc/app-update'
import type { ReleaseDto, ReleasesDto } from '@magnetar/protocol'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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
      {blocks.length ? <ReleaseNotes blocks={blocks} /> : <p className="muted text-sm">{t('changelog.noNotes')}</p>}
      <a className="link link-hover muted mt-3 inline-flex items-center gap-1 text-xs" href={release.url} target="_blank" rel="noreferrer noopener">
        <ExternalLink size={12} />{t('changelog.onGitHub')}
      </a>
    </article>
  )
}

/** Release notes as the page's own elements: text only, links only where `parseReleaseNotes` allows them. */
export function ReleaseNotes({ blocks }: { blocks: NotesBlock[] }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'heading':
            return <h4 key={i} className="muted mt-1 text-xs font-semibold uppercase tracking-wide">{inlines(block.content)}</h4>
          case 'paragraph':
            return <p key={i} className="break-words">{inlines(block.content)}</p>
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul'
            return (
              <List key={i} className={`flex flex-col gap-1 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
                {block.items.map((item, j) => <li key={j} className="break-words">{inlines(item)}</li>)}
              </List>
            )
          }
          case 'code':
            return <pre key={i} className="overflow-x-auto rounded-field bg-base-200 p-3 text-xs"><code>{block.text}</code></pre>
        }
      })}
    </div>
  )
}

function inlines(content: NotesInline[]): ReactNode {
  return content.map((inline, i) => {
    switch (inline.type) {
      case 'text': return inline.text
      case 'strong': return <strong key={i}>{inline.text}</strong>
      case 'emphasis': return <em key={i}>{inline.text}</em>
      case 'code': return <code key={i} className="rounded bg-base-200 px-1 text-[0.85em]">{inline.text}</code>
      case 'link': return <a key={i} className="link" href={inline.href} target="_blank" rel="noreferrer noopener">{inline.text}</a>
    }
  })
}
