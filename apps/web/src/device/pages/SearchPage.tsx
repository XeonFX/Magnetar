import type { SearchResultDto, SourceOutcomeDto, TorrentDetailsDto } from '@md/protocol'
import { formatBytes } from '@md/protocol/bytes'
import { Check, CircleAlert, Copy, Download, ExternalLink, FolderOpen, SearchIcon, SearchX, Sprout, Telescope, X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { useFormatDate, useFormatRelative, useT } from '../../lib/i18n.tsx'
import { askNotificationPermission } from '../../lib/notifications.ts'
import { releaseTags } from '../../lib/releaseTags.ts'
import { PageHeader, Segmented } from '../../ui/controls.tsx'
import { Empty } from '../../ui/Empty.tsx'
import { Modal } from '../../ui/Modal.tsx'
import { useCopy, useToast } from '../../ui/toast.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { FolderField } from '../components/folders.tsx'
import { useRun } from '../useRun.ts'

const RESOLUTIONS = [['', 'search.resolutionAny'], ['720p', '720p'], ['1080p', '1080p'], ['2160p', '4K']] as const

type Sort = 'seeders' | 'newest' | 'largest' | 'smallest'
const SORTS: Record<Sort, (a: SearchResultDto, b: SearchResultDto) => number> = {
  seeders: (a, b) => b.seeders - a.seeders,
  newest: (a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''),
  largest: (a, b) => b.sizeBytes - a.sizeBytes,
  smallest: (a, b) => a.sizeBytes - b.sizeBytes,
}

/** Starts a download and says so, with a way to go and watch it. */
function useStartDownload() {
  const t = useT()
  const toast = useToast()
  const run = useRun()
  const navigate = useNavigate()
  const { connection, basePath } = useDevice()
  return async (result: SearchResultDto, folder?: string): Promise<boolean> => {
    askNotificationPermission()
    const started = await run(() => connection.call('downloads.start', { resultId: result.resultId, folder: folder?.trim() || undefined }), 'search.startFailed')
    if (!started) return false
    toast(t('search.started', result.title), 'success', { label: t('search.viewDownloads'), onClick: () => navigate(basePath || '/') })
    return true
  }
}

export function SearchPage() {
  const t = useT()
  const { connection, sources, search, setSearch } = useDevice()
  const run = useRun()
  const startDownload = useStartDownload()
  const [details, setDetails] = useState<SearchResultDto | null>(null)
  const [sort, setSort] = useState<Sort>('seeders')
  const [added, setAdded] = useState<Set<string>>(new Set())

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    const query = [search.query.trim(), search.resolution].filter(Boolean).join(' ')
    if (!search.query.trim()) return
    if (search.searchId && search.searching) void connection.call('search.cancel', { searchId: search.searchId }).catch(() => {})
    setSearch(s => ({ ...s, searching: true, results: [], outcomes: [], searchId: null }))
    const started = await run(() => connection.call('search.start', { query, source: search.source || undefined }), 'search.failed')
    if (!started) return setSearch(s => ({ ...s, searching: false, results: null }))
    setSearch(s => ({ ...s, searchId: started.searchId }))
  }

  const results = useMemo(() => (search.results ? [...search.results].sort(SORTS[sort]) : null), [search.results, sort])
  const download = async (result: SearchResultDto, folder?: string) => {
    if (await startDownload(result, folder)) setAdded(s => new Set(s).add(result.resultId))
  }

  return (
    <>
      <PageHeader title={t('search.title')} />
      <form onSubmit={e => void submit(e)} className="mb-4 flex flex-col gap-3">
        <div className="flex gap-2">
          <label className="input input-lg min-w-0 flex-1">
            <SearchIcon size={20} className="muted" />
            <input type="search" enterKeyHint="search" placeholder={t('search.query')} aria-label={t('search.query')} value={search.query}
              onChange={e => setSearch(s => ({ ...s, query: e.target.value }))} autoFocus={!search.results} />
          </label>
          <button type="submit" className="btn btn-primary btn-lg px-4 sm:px-6" disabled={search.searching || !search.query.trim()} aria-label={t('search.button')}>
            {search.searching ? <span className="loading loading-spinner loading-sm" /> : <SearchIcon size={18} />}
            <span className="hidden sm:inline">{search.searching ? t('search.searching') : t('search.button')}</span>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label={t('search.resolution')} value={search.resolution} onChange={resolution => setSearch(s => ({ ...s, resolution }))}
            options={RESOLUTIONS.map(([value, label]) => ({ value, label: value ? label : t(label) }))} />
          <select className="select select-sm w-auto rounded-full" aria-label={t('search.source')} value={search.source}
            onChange={e => setSearch(s => ({ ...s, source: e.target.value }))}>
            <option value="">{t('search.allSources')}</option>
            {sources.filter(s => s.enabled).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
          {results && results.length > 1 && (
            <select className="select select-sm ml-auto w-auto rounded-full" aria-label={t('search.sort')} value={sort} onChange={e => setSort(e.target.value as Sort)}>
              {(Object.keys(SORTS) as Sort[]).map(s => <option key={s} value={s}>{t(`search.sort.${s}`)}</option>)}
            </select>
          )}
        </div>
      </form>

      {search.outcomes.length > 0 && <Outcomes outcomes={search.outcomes} total={results?.length ?? 0} searching={search.searching} />}
      {search.searching && !results?.length && <div className="flex justify-center py-16"><span className="loading loading-dots loading-lg text-primary" /></div>}

      {results === null ? (
        <Empty icon={<Telescope size={40} strokeWidth={1.5} className="text-primary" />} title={t('search.emptyTitle')} text={t('search.emptyPrompt')} />
      ) : results.length === 0 ? (
        search.searching ? null : <Empty icon={<SearchX size={40} strokeWidth={1.5} className="muted" />} title={t('search.noResults')} text={t('search.noResultsHint')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {results.map(r => <ResultRow key={r.resultId} result={r} added={added.has(r.resultId)} onOpen={() => setDetails(r)} onDownload={() => void download(r)} />)}
        </ul>
      )}

      <TorrentInfoDialog result={details} added={details ? added.has(details.resultId) : false} onClose={() => setDetails(null)}
        onDownload={(r, folder) => { setDetails(null); void download(r, folder) }} />
    </>
  )
}

function Health({ seeders }: { seeders: number }) {
  const t = useT()
  const tone = seeders >= 10 ? 'text-success' : seeders > 0 ? 'text-warning' : 'text-error'
  return (
    <span className={`inline-flex items-center gap-1 font-medium tabular-nums ${tone}`} title={`${t('search.seeders', seeders)} — ${t('search.seedersHint')}`}
      aria-label={t('search.seeders', seeders)}>
      <Sprout size={13} aria-hidden />{seeders}
    </span>
  )
}

function Tags({ title }: { title: string }) {
  const tags = releaseTags(title)
  const list = [tags.resolution, tags.hdr, tags.codec, tags.source].filter(Boolean)
  if (list.length === 0) return null
  return (
    <span className="inline-flex flex-wrap gap-1">
      {list.map(tag => (
        <span key={tag} className={`badge badge-sm font-semibold ${tag === tags.resolution ? 'badge-neutral' : 'badge-ghost border-base-300'}`}>{tag}</span>
      ))}
    </span>
  )
}

function ResultRow({ result: r, added, onOpen, onDownload }: { result: SearchResultDto; added: boolean; onOpen: () => void; onDownload: () => void }) {
  const t = useT()
  const formatRelative = useFormatRelative()
  return (
    <li className="surface flex items-start gap-3 p-4 transition-colors hover:border-base-content/20">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="break-release font-medium leading-snug">{r.title}</div>
        <div className="muted mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <Tags title={r.title} />
          <span className="tabular-nums">{formatBytes(r.sizeBytes)}</span>
          <Health seeders={r.seeders} />
          {r.publishedAt && <span>{formatRelative(r.publishedAt)}</span>}
          <span>{r.source}</span>
        </div>
      </button>
      <button type="button" className={`btn btn-sm shrink-0 ${added ? 'btn-ghost text-success' : 'btn-primary btn-soft'}`} disabled={added}
        onClick={onDownload} aria-label={added ? t('search.added') : t('common.download')} title={added ? t('search.added') : t('common.download')}>
        {added ? <Check size={16} /> : <Download size={16} />}
        <span className="hidden sm:inline">{added ? t('search.added') : t('common.download')}</span>
      </button>
    </li>
  )
}

/**
 * How each source answered. A site that failed, or answered but had everything filtered out, would
 * otherwise look exactly like "nothing found".
 */
function Outcomes({ outcomes, total, searching }: { outcomes: SourceOutcomeDto[]; total: number; searching: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const failed = outcomes.filter(o => o.status === 'failed')
  const answered = outcomes.length - failed.length
  return (
    <div className="mb-4">
      <div className="muted flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span>{searching ? t('search.searching') : t('search.summary', total, answered, outcomes.length)}</span>
        {failed.length > 0 && <span className="inline-flex items-center gap-1 text-warning"><CircleAlert size={14} />{t('search.failedCount', failed.length)}</span>}
        <button type="button" className="link link-hover text-sm" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? t('search.hideSources') : t('search.showSources')}</button>
      </div>
      {open && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {[...outcomes].sort((a, b) => a.source.localeCompare(b.source)).map(o => {
            const kept = o.returned - o.filtered
            const tip = o.status === 'failed' ? t('search.outcomeFailedDetail', o.error ?? '')
              : o.filtered > 0 ? t('search.outcomeFiltered', kept, o.returned, o.filtered)
              : t('search.outcomeOk', kept)
            return (
              <li key={o.source} className={`badge gap-1 ${o.status === 'failed' ? 'badge-warning badge-soft' : 'badge-ghost border-base-300'}`} title={tip}>
                {o.source}: {o.status === 'failed' ? t('search.outcomeFailed') : kept}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** Details fetched on demand: the only time a lazy source's detail page is loaded. */
function TorrentInfoDialog({ result, added, onClose, onDownload }: {
  result: SearchResultDto | null
  added: boolean
  onClose: () => void
  onDownload: (r: SearchResultDto, folder?: string) => void
}) {
  const t = useT()
  const formatDate = useFormatDate()
  const copy = useCopy(t('info.copied'))
  const { connection, settings } = useDevice()
  const [details, setDetails] = useState<TorrentDetailsDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)

  useEffect(() => {
    setDetails(null)
    setFolder(null)
    if (!result) return
    let cancelled = false
    setLoading(true)
    connection.call('search.details', { resultId: result.resultId })
      .then(d => { if (!cancelled) setDetails(d) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [result, connection])

  if (!result) return <Modal open={false} title="" onClose={onClose}>{null}</Modal>
  const row = details?.result ?? result
  const facts: [string, React.ReactNode][] = [
    [t('info.size'), formatBytes(row.sizeBytes, 2)],
    [t('info.seeders'), <Health key="h" seeders={row.seeders} />],
    [t('info.leechers'), row.leechers],
    [t('info.published'), formatDate(row.publishedAt, true)],
    [t('info.source'), row.source],
  ]
  return (
    <Modal open title={t('info.title')} onClose={onClose} wide
      actions={<>
        {row.detailsUrl && <a className="btn btn-ghost btn-sm mr-auto" href={row.detailsUrl} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} />{t('info.openPage')}</a>}
        {folder === null && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={added} onClick={() => setFolder(settings?.downloadFolder ?? '')}>
            <FolderOpen size={14} />{t('info.downloadTo')}
          </button>
        )}
        <button type="button" className="btn btn-primary btn-sm" disabled={added || (folder !== null && !folder.trim())} onClick={() => onDownload(result, folder ?? undefined)}>
          {added ? <Check size={14} /> : <Download size={14} />}{added ? t('search.added') : t('common.download')}
        </button>
      </>}>
      <p className="break-release mb-3 text-lg font-semibold leading-snug">{row.title}</p>
      <div className="mb-4"><Tags title={row.title} /></div>
      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {facts.map(([label, value]) => (
          <div key={label} className="rounded-field bg-base-200 px-3 py-2">
            <dt className="muted text-xs">{label}</dt>
            <dd className="mt-0.5 text-sm font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {folder !== null && (
        <div className="mb-4 flex items-start gap-2">
          <div className="flex-1"><FolderField label={t('dialog.folder')} value={folder} help={t('dialog.folderHelp')} onChange={setFolder} /></div>
          <button type="button" className="btn btn-ghost btn-square" aria-label={t('common.cancel')} onClick={() => setFolder(null)}><X size={16} /></button>
        </div>
      )}
      {loading && <p className="muted mb-3 flex items-center gap-2 text-sm"><span className="loading loading-spinner loading-xs" />{t('info.resolving')}</p>}
      {details?.description && (
        <>
          <h4 className="mb-1 text-sm font-semibold">{t('info.description')}</h4>
          <pre className="mb-4 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-field bg-base-200 p-3 font-sans text-sm">{details.description}</pre>
        </>
      )}
      {(row.infoHash || details?.magnetUri) && (
        <div className="flex flex-col gap-2">
          {row.infoHash && <p className="muted break-release font-mono text-xs">{t('info.infoHash')}: {row.infoHash}</p>}
          {details?.magnetUri && (
            <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => void copy(details.magnetUri!)}><Copy size={14} />{t('info.copyMagnet')}</button>
          )}
        </div>
      )}
    </Modal>
  )
}
