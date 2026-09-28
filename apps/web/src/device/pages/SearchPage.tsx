import type { SearchResultDto, SourceOutcomeDto, TorrentDetailsDto } from '@md/protocol'
import { formatBytes } from '@md/protocol/bytes'
import { CircleAlert, CircleCheck, CircleMinus, Copy, Download, ExternalLink, Info, SearchIcon, SearchX, Telescope } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useFormatDate, useT } from '../../lib/i18n.tsx'
import { Modal } from '../../ui/Modal.tsx'
import { Empty } from '../../ui/Empty.tsx'
import { useCopy, useToast } from '../../ui/toast.tsx'
import { useSort } from '../../ui/useSort.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { PageHeader } from '../Shell.tsx'
import { FolderField } from '../components/folders.tsx'
import { useRun } from '../useRun.ts'

const RESOLUTIONS = ['480p', '720p', '1080p', '2160p']

export function SearchPage() {
  const t = useT()
  const formatDate = useFormatDate()
  const { connection, sources, search, setSearch } = useDevice()
  const run = useRun()
  const [details, setDetails] = useState<SearchResultDto | null>(null)
  const [downloading, setDownloading] = useState<SearchResultDto | null>(null)

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

  const { sorted, header } = useSort(search.results ?? [], {
    title: r => r.title.toLowerCase(), source: r => r.source, size: r => r.sizeBytes, seeders: r => r.seeders,
    leechers: r => r.leechers, published: r => r.publishedAt ?? '',
  }, { key: 'seeders', desc: true })
  const results = search.results ? sorted : null

  return (
    <>
      <PageHeader title={t('search.title')} subtitle={t('search.subtitle')} />
      <form onSubmit={e => void submit(e)} className="surface mb-4 flex flex-wrap gap-3 p-4">
        <label className="input min-w-64 flex-[3_1_16rem]">
          <SearchIcon size={16} className="opacity-60" />
          <input type="search" placeholder={t('search.query')} aria-label={t('search.query')} value={search.query}
            onChange={e => setSearch(s => ({ ...s, query: e.target.value }))} />
        </label>
        <label className="select min-w-40 flex-[1_1_10rem]">
          <span className="label">{t('search.source')}</span>
          <select value={search.source} onChange={e => setSearch(s => ({ ...s, source: e.target.value }))}>
            <option value="">{t('search.allSources')}</option>
            {sources.filter(s => s.enabled).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </label>
        <label className="select min-w-40 flex-[1_1_10rem]">
          <span className="label">{t('search.resolution')}</span>
          <select value={search.resolution} onChange={e => setSearch(s => ({ ...s, resolution: e.target.value }))}>
            <option value="">{t('search.resolutionAny')}</option>
            {RESOLUTIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <button type="submit" className="btn btn-primary flex-[1_1_8rem]" disabled={search.searching || !search.query.trim()}>
          {search.searching ? <span className="loading loading-spinner loading-sm" /> : <SearchIcon size={16} />}
          {search.searching ? t('search.searching') : t('search.button')}
        </button>
      </form>

      {search.searching && <progress className="progress progress-primary mb-4 w-full" />}
      {search.outcomes.length > 0 && <Outcomes outcomes={search.outcomes} />}

      {results === null ? (
        <Empty icon={<Telescope size={36} className="text-base-content/50" />} text={t('search.emptyPrompt')} />
      ) : results.length === 0 ? (
        search.searching ? null : <Empty icon={<SearchX size={36} className="text-base-content/50" />} title={t('search.noResults')} text={t('search.noResultsHint')} />
      ) : (
        <>
          <div className="surface hidden overflow-x-auto md:block">
            <table className="table table-sm">
              <thead>
                <tr>
                  {header('title', t('search.colTitle'))}
                  {header('source', t('search.colSource'))}
                  {header('size', t('search.colSize'))}
                  {header('seeders', t('search.colSeeds'), '', true)}
                  {header('leechers', t('search.colLeech'), 'hidden xl:table-cell')}
                  {header('published', t('search.colPublished'), 'hidden xl:table-cell')}
                  <th />
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.resultId} className="hover:bg-base-200/60">
                    <td className="break-release min-w-56 text-sm">{r.title}</td>
                    <td><span className="badge badge-soft badge-secondary badge-sm whitespace-nowrap">{r.source}</span></td>
                    <td className="whitespace-nowrap text-xs tabular-nums">{formatBytes(r.sizeBytes, 2)}</td>
                    <td className="text-sm tabular-nums text-success">{r.seeders}</td>
                    <td className="hidden text-sm tabular-nums text-error xl:table-cell">{r.leechers}</td>
                    <td className="hidden whitespace-nowrap text-xs xl:table-cell">{formatDate(r.publishedAt)}</td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <button type="button" className="btn btn-ghost btn-sm btn-square" title={t('search.details')} aria-label={t('search.details')} onClick={() => setDetails(r)}><Info size={16} /></button>
                        <button type="button" className="btn btn-primary btn-sm" aria-label={t('common.download')} title={t('common.download')} onClick={() => setDownloading(r)}><Download size={14} /><span className="hidden xl:inline">{t('common.download')}</span></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col gap-2 md:hidden">
            {results.map(r => (
              <li key={r.resultId} className="surface p-3">
                <div className="break-release text-sm font-medium">{r.title}</div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="badge badge-soft badge-secondary badge-sm">{r.source}</span>
                  <span className="tabular-nums">{formatBytes(r.sizeBytes, 2)}</span>
                  <span className="tabular-nums text-success">▲ {r.seeders}</span>
                  <span className="tabular-nums text-error">▼ {r.leechers}</span>
                  <span>{formatDate(r.publishedAt)}</span>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDetails(r)}><Info size={14} />{t('search.details')}</button>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => setDownloading(r)}><Download size={14} />{t('common.download')}</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <TorrentInfoDialog result={details} onClose={() => setDetails(null)} onDownload={r => { setDetails(null); setDownloading(r) }} />
      <DownloadDialog result={downloading} onClose={() => setDownloading(null)} />
    </>
  )
}


/**
 * One chip per source. A site that failed, or answered but had everything filtered out, would
 * otherwise look exactly like "nothing found".
 */
function Outcomes({ outcomes }: { outcomes: SourceOutcomeDto[] }) {
  const t = useT()
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {[...outcomes].sort((a, b) => a.source.localeCompare(b.source)).map(o => {
        const kept = o.returned - o.filtered
        const failed = o.status === 'failed'
        const tip = failed ? t('search.outcomeFailedDetail', o.error ?? '')
          : o.filtered > 0 ? t('search.outcomeFiltered', kept, o.returned, o.filtered)
          : t('search.outcomeOk', kept)
        return (
          <div key={o.source} className="tooltip tooltip-bottom" data-tip={tip}>
            <span className={`badge badge-outline gap-1 ${failed ? 'badge-error' : kept === 0 ? '' : 'badge-success'}`} tabIndex={0} aria-label={tip}>
              {failed ? <CircleAlert size={12} /> : kept === 0 ? <CircleMinus size={12} /> : <CircleCheck size={12} />}
              {o.source}: {failed ? t('search.outcomeFailed') : kept}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Details fetched on demand: the only time a lazy source's detail page is loaded. */
function TorrentInfoDialog({ result, onClose, onDownload }: { result: SearchResultDto | null; onClose: () => void; onDownload: (r: SearchResultDto) => void }) {
  const t = useT()
  const formatDate = useFormatDate()
  const copy = useCopy(t('info.copied'))
  const { connection } = useDevice()
  const [details, setDetails] = useState<TorrentDetailsDto | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setDetails(null)
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
  return (
    <Modal open title={t('info.title')} icon={<Info size={20} />} onClose={onClose} wide
      actions={<>
        {row.detailsUrl && <a className="btn btn-ghost btn-sm" href={row.detailsUrl} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} />{t('info.openPage')}</a>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('common.close')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={loading} onClick={() => onDownload(result)}><Download size={14} />{t('common.download')}</button>
      </>}>
      <p className="break-release mb-3 font-medium">{row.title}</p>
      <table className="table table-sm table-zebra mb-3">
        <tbody>
          <tr><td className="text-base-content/60">{t('info.source')}</td><td>{row.source}</td></tr>
          <tr><td className="text-base-content/60">{t('info.size')}</td><td>{formatBytes(row.sizeBytes, 2)}</td></tr>
          <tr><td className="text-base-content/60">{t('info.seeders')}</td><td className="text-success">{row.seeders}</td></tr>
          <tr><td className="text-base-content/60">{t('info.leechers')}</td><td className="text-error">{row.leechers}</td></tr>
          <tr><td className="text-base-content/60">{t('info.published')}</td><td>{formatDate(row.publishedAt, true)}</td></tr>
          {row.infoHash && <tr><td className="text-base-content/60">{t('info.infoHash')}</td><td className="break-release font-mono text-xs">{row.infoHash}</td></tr>}
        </tbody>
      </table>
      {loading && <progress className="progress progress-primary mb-3 w-full" />}
      {details?.description && (
        <>
          <h4 className="mb-1 text-sm font-semibold">{t('info.description')}</h4>
          <pre className="mb-3 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-box border border-base-300 bg-base-200 p-3 font-sans text-sm">{details.description}</pre>
        </>
      )}
      {details?.magnetUri ? (
        <>
          <label className="floating-label block">
            <span>{t('info.magnet')}</span>
            <textarea readOnly className="textarea w-full break-all font-mono text-xs" rows={3} value={details.magnetUri} />
          </label>
          <button type="button" className="btn btn-ghost btn-sm mt-1" onClick={() => void copy(details.magnetUri!)}><Copy size={14} />{t('info.copyMagnet')}</button>
        </>
      ) : loading && <p className="text-sm text-base-content/60">{t('info.resolving')}</p>}
    </Modal>
  )
}

function DownloadDialog({ result, onClose }: { result: SearchResultDto | null; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const run = useRun()
  const { connection, settings } = useDevice()
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (result) setFolder(settings?.downloadFolder ?? '')
  }, [result, settings?.downloadFolder])

  const start = async () => {
    if (!result) return
    setBusy(true)
    const started = await run(() => connection.call('downloads.start', { resultId: result.resultId, folder: folder.trim() || undefined }), 'search.startFailed')
    setBusy(false)
    if (started) {
      toast(t('search.started', result.title), 'success')
      onClose()
    }
  }

  return (
    <Modal open={result !== null} title={t('dialog.downloadTitle')} icon={<Download size={20} />} onClose={onClose}
      actions={<>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!folder.trim() || busy} onClick={() => void start()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : <Download size={14} />}{t('common.download')}
        </button>
      </>}>
      <p className="break-release mb-4 text-sm">{result?.title}</p>
      <FolderField label={t('dialog.folder')} value={folder} help={t('dialog.folderHelp')} onChange={setFolder} />
    </Modal>
  )
}
