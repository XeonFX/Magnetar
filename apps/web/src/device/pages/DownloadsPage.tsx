import type { DownloadDto } from '@magnetar/protocol'
import { formatRate } from '@magnetar/protocol/bytes'
import { ArrowDown, ArrowUp, CloudDownload, Plus, Search, Tv } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useT } from '../../lib/i18n.tsx'
import { magnetsIn } from '../../lib/magnets.ts'
import { PageHeader, Segmented } from '../../ui/controls.tsx'
import { Empty } from '../../ui/Empty.tsx'
import { PAGE_SIZE, ShowMore } from '../../ui/ShowMore.tsx'
import { useDevice, useDownloads } from '../DeviceContext.tsx'
import { AddDownloadDialog, DropOverlay, useAddShortcuts, type PendingAdd } from '../components/addDownload.tsx'
import { DownloadDetailsDialog } from '../components/downloadDetails.tsx'
import { DownloadRow, isActive } from '../components/downloads.tsx'
import { LegacyImportBanner } from '../components/legacyImport.tsx'
import { AltSpeedToggle, FreeSpace, TransferNotice } from '../components/transfer.tsx'

type Filter = 'all' | 'active' | 'paused' | 'finished' | 'failed'

const MATCHES: Record<Filter, (d: DownloadDto) => boolean> = {
  all: () => true,
  active: isActive,
  paused: d => d.status === 'Paused',
  finished: d => d.status === 'Completed',
  failed: d => d.status === 'Error',
}
const FILTERS = Object.keys(MATCHES) as Filter[]

export function DownloadsPage() {
  const t = useT()
  const { basePath, settings, transfer, connection } = useDevice()
  const downloads = useDownloads()
  const [filter, setFilter] = useState<Filter>('all')
  const [adding, setAdding] = useState<PendingAdd | null>(null)
  const [details, setDetails] = useState<number | null>(null)
  const dragging = useAddShortcuts(setAdding)
  // Opened for a magnet link or .torrent file (the system's handler, or a link to ?add=).
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    const magnet = params.get('add')
    const path = connection.kind === 'local' ? params.get('torrent') : null
    if (!magnet && !path) return
    setAdding({ magnets: magnet ? magnetsIn(magnet) : [], files: [], paths: path ? [path] : [] })
    setParams({}, { replace: true })
  }, [params, setParams, connection])

  // One pass for every count and total, rather than one filter per chip on each update.
  const { counts, down, up } = useMemo(() => {
    const counts = Object.fromEntries(FILTERS.map(f => [f, 0])) as Record<Filter, number>
    let down = 0
    let up = 0
    for (const d of downloads) {
      for (const f of FILTERS) if (MATCHES[f](d)) counts[f]++
      down += d.downloadSpeed
      up += d.uploadSpeed
    }
    return { counts, down, up }
  }, [downloads])
  const shown = useMemo(() => downloads.filter(MATCHES[filter]), [downloads, filter])
  const add = <button type="button" className="btn btn-primary" onClick={() => setAdding({ magnets: [], files: [] })}><Plus size={16} />{t('add.button')}</button>

  const summary = downloads.length > 0 && (
    <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
      <span>{t('downloads.activeCount', counts.active)}</span>
      <span className="inline-flex items-center gap-1 tabular-nums"><ArrowDown size={14} className="text-info" />{formatRate(down)}</span>
      <span className="inline-flex items-center gap-1 tabular-nums"><ArrowUp size={14} className="text-accent" />{formatRate(up)}</span>
      <FreeSpace bytes={transfer?.freeBytes} />
    </span>
  )

  return (
    <>
      <PageHeader title={t('downloads.title')} summary={summary}
        action={<div className="flex flex-wrap items-center gap-2">
          {settings && transfer && <AltSpeedToggle settings={settings} transfer={transfer} />}
          {downloads.length > 0 && <Link to={`${basePath}/search`} className="btn btn-ghost hidden sm:inline-flex"><Search size={16} />{t('downloads.searchButton')}</Link>}
          {add}
        </div>} />
      <TransferNotice transfer={transfer} />
      <LegacyImportBanner />
      {downloads.length === 0 ? (
        <Empty icon={<CloudDownload size={40} strokeWidth={1.5} className="text-primary" />} title={t('downloads.emptyTitle')} text={t('downloads.emptyHint')}>
          <div className="flex flex-wrap justify-center gap-2">
            <Link to={`${basePath}/search`} className="btn btn-primary"><Search size={16} />{t('downloads.searchButton')}</Link>
            <Link to={`${basePath}/series`} className="btn btn-ghost"><Tv size={16} />{t('downloads.seriesButton')}</Link>
          </div>
          <p className="muted mt-4 text-xs">{t('add.emptyHint')}</p>
        </Empty>
      ) : (
        <>
          <div className="mb-4">
            <Segmented label={t('downloads.filter')} value={filter} onChange={setFilter}
              options={FILTERS.filter(f => f === 'all' || f === filter || counts[f] > 0)
                .map(f => ({ value: f, label: t(`downloads.filter.${f}`), count: counts[f] }))} />
          </div>
          {shown.length === 0
            ? <p className="surface muted p-6 text-center text-sm">{t('downloads.noneInFilter')}</p>
            : <DownloadList key={filter} downloads={shown} onOpen={setDetails} />}
        </>
      )}
      <AddDownloadDialog open={adding !== null} initial={adding} onClose={() => setAdding(null)} />
      <DownloadDetailsDialog id={details} onClose={() => setDetails(null)} />
      {dragging && <DropOverlay />}
    </>
  )
}

/** Downloads as cards, a page at a time; each from a series names it. */
export function DownloadList({ downloads, hideSeries = false, onOpen }: { downloads: DownloadDto[]; hideSeries?: boolean; onOpen?: (id: number) => void }) {
  const t = useT()
  const { series } = useDevice()
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [opened, setOpened] = useState<number | null>(null)
  const names = useMemo(() => new Map(series.map(s => [s.id, s.name])), [series])
  const unknown = t('downloads.unknownSeries')
  const seriesName = (d: DownloadDto) => (d.seriesTaskId === null || hideSeries ? undefined : names.get(d.seriesTaskId) || unknown)
  const open = useCallback((id: number) => (onOpen ?? setOpened)(id), [onOpen])
  return (
    <>
      <ul className="flex flex-col gap-2">
        {downloads.slice(0, limit).map(d => <DownloadRow key={d.id} download={d} seriesName={seriesName(d)} onOpen={open} />)}
      </ul>
      {downloads.length > limit && <ShowMore remaining={downloads.length - limit} onMore={() => setLimit(n => n + PAGE_SIZE)} />}
      {!onOpen && <DownloadDetailsDialog id={opened} onClose={() => setOpened(null)} />}
    </>
  )
}
