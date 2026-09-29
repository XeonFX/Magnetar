import type { DownloadDto } from '@md/protocol'
import { formatRate } from '@md/protocol/bytes'
import { ArrowDown, ArrowUp, CloudDownload, Search, Tv } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { useT } from '../../lib/i18n.tsx'
import { PageHeader, Segmented } from '../../ui/controls.tsx'
import { Empty } from '../../ui/Empty.tsx'
import { useDevice, useDownloads } from '../DeviceContext.tsx'
import { DownloadRow, isActive } from '../components/downloads.tsx'
import { LegacyImportBanner } from '../components/legacyImport.tsx'

type Filter = 'all' | 'active' | 'paused' | 'finished' | 'failed'

const MATCHES: Record<Filter, (d: DownloadDto) => boolean> = {
  all: () => true,
  active: isActive,
  paused: d => d.status === 'Paused',
  finished: d => d.status === 'Completed',
  failed: d => d.status === 'Error',
}

export function DownloadsPage() {
  const t = useT()
  const { basePath } = useDevice()
  const downloads = useDownloads()
  const [filter, setFilter] = useState<Filter>('all')
  const count = (f: Filter) => downloads.filter(MATCHES[f]).length
  const down = downloads.reduce((sum, d) => sum + d.downloadSpeed, 0)
  const up = downloads.reduce((sum, d) => sum + d.uploadSpeed, 0)
  const shown = downloads.filter(MATCHES[filter])

  const summary = downloads.length > 0 && (
    <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
      <span>{t('downloads.activeCount', count('active'))}</span>
      <span className="inline-flex items-center gap-1 tabular-nums"><ArrowDown size={14} className="text-info" />{formatRate(down)}</span>
      <span className="inline-flex items-center gap-1 tabular-nums"><ArrowUp size={14} className="text-accent" />{formatRate(up)}</span>
    </span>
  )

  return (
    <>
      <PageHeader title={t('downloads.title')} summary={summary}
        action={downloads.length > 0 && <Link to={`${basePath}/search`} className="btn btn-primary hidden sm:inline-flex"><Search size={16} />{t('downloads.searchButton')}</Link>} />
      <LegacyImportBanner />
      {downloads.length === 0 ? (
        <Empty icon={<CloudDownload size={40} strokeWidth={1.5} className="text-primary" />} title={t('downloads.emptyTitle')} text={t('downloads.emptyHint')}>
          <div className="flex flex-wrap justify-center gap-2">
            <Link to={`${basePath}/search`} className="btn btn-primary"><Search size={16} />{t('downloads.searchButton')}</Link>
            <Link to={`${basePath}/series`} className="btn btn-ghost"><Tv size={16} />{t('downloads.seriesButton')}</Link>
          </div>
        </Empty>
      ) : (
        <>
          <div className="mb-4">
            <Segmented label={t('downloads.filter')} value={filter} onChange={setFilter}
              options={(['all', 'active', 'paused', 'finished', 'failed'] as const)
                .filter(f => f === 'all' || f === filter || count(f) > 0)
                .map(f => ({ value: f, label: t(`downloads.filter.${f}`), count: count(f) }))} />
          </div>
          {shown.length === 0
            ? <p className="surface muted p-6 text-center text-sm">{t('downloads.noneInFilter')}</p>
            : <DownloadList downloads={shown} />}
        </>
      )}
    </>
  )
}

/** Downloads as cards; each from a series names it. */
export function DownloadList({ downloads, hideSeries = false }: { downloads: DownloadDto[]; hideSeries?: boolean }) {
  const t = useT()
  const { series } = useDevice()
  const seriesName = (d: DownloadDto) =>
    d.seriesTaskId === null || hideSeries ? undefined : series.find(s => s.id === d.seriesTaskId)?.name || t('downloads.unknownSeries')
  return (
    <ul className="flex flex-col gap-2">
      {downloads.map(d => <DownloadRow key={d.id} download={d} seriesName={seriesName(d)} />)}
    </ul>
  )
}
