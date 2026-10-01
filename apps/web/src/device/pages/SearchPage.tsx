import type { SearchResultDto, SourceDto, SourceOutcomeDto, TorrentDetailsDto } from '@magnetar/protocol'
import { formatBytes } from '@magnetar/protocol/bytes'
import { BellRing, Check, CircleAlert, Copy, Download, ExternalLink, FolderOpen, SearchIcon, SearchX, Sprout, Telescope, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { useFormatDate, useFormatRelative, useT } from '../../lib/i18n.tsx'
import { RESOLUTIONS } from '../../lib/quality.ts'
import { readSearch, searchAddress, searchKey, type SearchChoices } from '../../lib/urlState.ts'
import { askNotificationPermission } from '../../lib/notifications.ts'
import { releaseTags } from '../../lib/releaseTags.ts'
import { PageHeader, Segmented } from '../../ui/controls.tsx'
import { Empty } from '../../ui/Empty.tsx'
import { Modal } from '../../ui/Modal.tsx'
import { PAGE_SIZE, ShowMore } from '../../ui/ShowMore.tsx'
import { useCopy, useToast } from '../../ui/toast.tsx'
import { useDevice, useSearch } from '../DeviceContext.tsx'
import { FolderField } from '../components/folders.tsx'
import { resolutionOptions } from '../components/qualityFields.tsx'
import { useRun } from '../useRun.ts'


type Sort = 'seeders' | 'newest' | 'largest' | 'smallest'
const SORTS: Record<Sort, (a: SearchResultDto, b: SearchResultDto) => number> = {
  seeders: (a, b) => b.seeders - a.seeders,
  newest: (a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''),
  largest: (a, b) => b.sizeBytes - a.sizeBytes,
  smallest: (a, b) => a.sizeBytes - b.sizeBytes,
}
/** Each sort and its word in addresses (`?sort=new`); the first is the default, left out of them. */
const SORT_WORDS: SearchChoices<string, Sort>['sorts'] = [['seeders', 'seeders'], ['newest', 'new'], ['largest', 'large'], ['smallest', 'small']]
const SORT_NAMES = SORT_WORDS.map(([sort]) => sort)

/** How addresses name a source; an app older than source ids has only names. */
const sourceId = (source: SourceDto) => source.id || source.name

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
  const { connection, connectionState, sources, basePath } = useDevice()
  const { search, setSearch, setSearchAddress } = useSearch()
  const navigate = useNavigate()
  const run = useRun()
  const startDownload = useStartDownload()
  const [details, setDetails] = useState<SearchResultDto | null>(null)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [shown, setShown] = useState(PAGE_SIZE)
  // The search on screen lives in the address bar (/search/dragon?res=720p&source=tpb&sort=new), so a
  // reload, a bookmark, a shared link or Back shows the same one.
  const [params] = useSearchParams()
  const location = useLocation()
  const segment = location.pathname.slice(`${basePath}/search`.length).replace(/^\//, '')
  const choices = useMemo<SearchChoices<string, Sort>>(() => ({
    resolutions: RESOLUTIONS, sorts: SORT_WORDS, sources: sources.map(s => ({ id: sourceId(s), name: s.name })),
  }), [sources])
  const view = useMemo(() => readSearch(segment, params, choices), [segment, params, choices])
  const { sort } = view
  const key = searchKey(view)
  const address = searchAddress(view, choices)
  // A source in the address is checked against the device's own once they are known.
  const settled = !params.get('source') || sources.length > 0
  const proper = !settled || `/search${segment ? `/${segment}` : ''}${location.search}` === address
  const show = (change: Partial<typeof view>, how: { replace: boolean }) => navigate(basePath + searchAddress({ ...view, ...change }, choices), how)

  const start = async (target: typeof view) => {
    if (search.searchId && search.searching) void connection.call('search.cancel', { searchId: search.searchId }).catch(() => {})
    setShown(PAGE_SIZE)
    setSearch(s => ({ ...s, query: target.query, ran: searchKey(target), searching: true, results: [], outcomes: [], searchId: null }))
    const query = [target.query, target.resolution].filter(Boolean).join(' ')
    const started = await run(() => connection.call('search.start', { query, source: target.source || undefined }), 'search.failed')
    if (!started) return setSearch(s => ({ ...s, searching: false, results: null }))
    setSearch(s => ({ ...s, searchId: started.searchId }))
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const query = search.query.trim()
    if (!query) return
    // The same search again is a refresh; a new one is a new history entry, so Back returns to the last.
    if (query === view.query) void start(view)
    else show({ query }, { replace: false })
  }
  // An older or untidy address (?q=dragon&source=The+Pirate+Bay&sort=newest) becomes the proper one in place.
  useEffect(() => {
    if (!proper) navigate(basePath + address + location.hash, { replace: true })
  }, [proper, address])
  // Runs the search the address describes, once connected and the address is the proper one, unless it is
  // the one already on screen.
  useEffect(() => {
    if (key && key !== search.ran && settled && proper && connectionState.status === 'open') void start(view)
  }, [key, settled, proper, connectionState.status])
  // The links back to Search open this one again.
  useEffect(() => {
    if (key && proper) setSearchAddress(address)
  }, [key, proper, address])

  const results = useMemo(() => (search.results ? [...search.results].sort(SORTS[sort]) : null), [search.results, sort])
  // Stable for the memoized rows, so typing a new query doesn't re-render the list below.
  const latest = useRef(startDownload)
  latest.current = startDownload
  const download = useCallback(async (result: SearchResultDto, folder?: string) => {
    if (await latest.current(result, folder)) setAdded(s => new Set(s).add(result.resultId))
  }, [])

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
          <Segmented label={t('search.resolution')} value={view.resolution}
            onChange={resolution => show({ resolution }, { replace: true })} options={resolutionOptions(t)} />
          <select className="select select-sm w-auto rounded-full" aria-label={t('search.source')} value={view.source}
            onChange={e => show({ source: e.target.value }, { replace: true })}>
            <option value="">{t('search.allSources')}</option>
            {sources.filter(s => s.enabled || sourceId(s) === view.source).map(s => <option key={sourceId(s)} value={sourceId(s)}>{s.name}</option>)}
          </select>
          {results && results.length > 1 && (
            <select className="select select-sm ml-auto w-auto rounded-full" aria-label={t('search.sort')} value={sort}
              onChange={e => show({ sort: e.target.value as Sort }, { replace: true })}>
              {SORT_NAMES.map(s => <option key={s} value={s}>{t(`search.sort.${s}`)}</option>)}
            </select>
          )}
        </div>
      </form>

      {search.outcomes.length > 0 && <Outcomes outcomes={search.outcomes} total={results?.length ?? 0} searching={search.searching}
        onWatch={search.searching ? undefined : () => navigate(`${basePath}/series/releases`, {
          state: { watch: { query: view.query, resolution: view.resolution || null } },
        })} />}
      {search.searching && !results?.length && <div className="flex justify-center py-16"><span className="loading loading-dots loading-lg text-primary" /></div>}

      {results === null ? (
        <Empty icon={<Telescope size={40} strokeWidth={1.5} className="text-primary" />} title={t('search.emptyTitle')} text={t('search.emptyPrompt')} />
      ) : results.length === 0 ? (
        search.searching ? null : <Empty icon={<SearchX size={40} strokeWidth={1.5} className="muted" />} title={t('search.noResults')} text={t('search.noResultsHint')} />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {results.slice(0, shown).map(r => <ResultRow key={r.resultId} result={r} added={added.has(r.resultId)} onOpen={setDetails} onDownload={download} />)}
          </ul>
          {results.length > shown && <ShowMore remaining={results.length - shown} onMore={() => setShown(n => n + PAGE_SIZE)} />}
        </>
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

const ResultRow = memo(function ResultRow({ result: r, added, onOpen, onDownload }: {
  result: SearchResultDto
  added: boolean
  onOpen: (result: SearchResultDto) => void
  onDownload: (result: SearchResultDto) => void
}) {
  const t = useT()
  const formatRelative = useFormatRelative()
  return (
    <li className="surface flex items-start gap-3 p-4 transition-colors hover:border-base-content/20">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(r)}>
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
        onClick={() => onDownload(r)} aria-label={added ? t('search.added') : t('common.download')} title={added ? t('search.added') : t('common.download')}>
        {added ? <Check size={16} /> : <Download size={16} />}
        <span className="hidden sm:inline">{added ? t('search.added') : t('common.download')}</span>
      </button>
    </li>
  )
})

/**
 * How each source answered. A site that failed, or answered but had everything filtered out, would
 * otherwise look exactly like "nothing found".
 */
function Outcomes({ outcomes, total, searching, onWatch }: { outcomes: SourceOutcomeDto[]; total: number; searching: boolean; onWatch?: () => void }) {
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
        {onWatch && (
          <button type="button" className="btn btn-ghost btn-xs ml-auto gap-1" onClick={onWatch} title={t('watch.fromSearchHint')}>
            <BellRing size={13} />{t('watch.fromSearch')}
          </button>
        )}
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

/** Sites that only give a day report it as midnight UTC; a time of day would be made up. */
const isDayOnly = (iso: string | null) => iso !== null && /T00:00:00(\.0+)?(Z|\+00:00)$/.test(iso)

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
    [t('info.published'), formatDate(row.publishedAt, !isDayOnly(row.publishedAt))],
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
