import type { DownloadDto } from '@md/protocol'
import { formatRate } from '@md/protocol/bytes'
import { ArrowDown, ArrowUp, CloudDownload, Info, Loader, Search, Tv, User } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useT } from '../../lib/i18n.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { PageHeader } from '../Shell.tsx'
import { DownloadActions, DownloadName, ProgressBar, Size, Speed, StatusBadge } from '../components/downloads.tsx'

type SortKey = 'name' | 'progress' | 'status' | 'speed' | 'size' | 'peers' | 'series'

export function DownloadsPage() {
  const t = useT()
  const { downloads, series, basePath } = useDevice()
  const [tab, setTab] = useState<'manual' | 'series'>('manual')
  const manual = downloads.filter(d => d.seriesTaskId === null)
  const automatic = downloads.filter(d => d.seriesTaskId !== null)
  const seriesName = (d: DownloadDto) => series.find(s => s.id === d.seriesTaskId)?.name || t('downloads.unknownSeries')
  const active = downloads.filter(d => ['Downloading', 'FetchingMetadata', 'Queued'].includes(d.status)).length
  const down = downloads.reduce((sum, d) => sum + d.downloadSpeed, 0)
  const up = downloads.reduce((sum, d) => sum + d.uploadSpeed, 0)

  return (
    <>
      <PageHeader title={t('downloads.title')} subtitle={t('downloads.subtitle')} />
      {downloads.length === 0 ? (
        <div className="surface flex flex-col items-center gap-4 px-6 py-16 text-center">
          <div className="grid size-18 place-items-center rounded-full border-2 border-primary text-primary"><CloudDownload size={32} /></div>
          <div>
            <h2 className="text-lg font-semibold">{t('downloads.emptyTitle')}</h2>
            <p className="mt-1 max-w-md text-sm text-base-content/60">{t('downloads.emptyHint')}</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Link to={`${basePath}/search`} className="btn btn-primary"><Search size={16} />{t('downloads.searchButton')}</Link>
            <Link to={`${basePath}/series`} className="btn btn-outline btn-primary"><Tv size={16} />{t('downloads.seriesButton')}</Link>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat className="col-span-2 sm:col-span-1" icon={<Loader size={20} />} tone="text-primary" value={String(active)} label={t('downloads.active')} />
            <Stat icon={<ArrowDown size={20} />} tone="text-success" value={formatRate(down)} label={t('downloads.download')} />
            <Stat icon={<ArrowUp size={20} />} tone="text-info" value={formatRate(up)} label={t('downloads.upload')} />
          </div>
          <div role="tablist" className="tabs tabs-box mb-3 w-fit">
            <button type="button" role="tab" className={`tab gap-2 ${tab === 'manual' ? 'tab-active' : ''}`} onClick={() => setTab('manual')}>
              <User size={16} />{t('downloads.manualTab', manual.length)}
            </button>
            <button type="button" role="tab" className={`tab gap-2 ${tab === 'series' ? 'tab-active' : ''}`} onClick={() => setTab('series')}>
              <Tv size={16} />{t('downloads.seriesTab', automatic.length)}
            </button>
          </div>
          {tab === 'manual'
            ? manual.length === 0
              ? <p className="surface p-4 text-sm text-base-content/60">{t('downloads.noManual')}</p>
              : <DownloadList downloads={manual} actions />
            : automatic.length === 0
              ? <p className="surface p-4 text-sm text-base-content/60">{t('downloads.noAuto')}</p>
              : <>
                  <div role="alert" className="alert alert-info alert-soft mb-3 text-sm"><Info size={18} /><span>{t('downloads.autoInfo')}</span></div>
                  <DownloadList downloads={automatic} seriesName={seriesName} />
                </>}
        </>
      )}
    </>
  )
}

function Stat({ icon, tone, value, label, className = '' }: { icon: ReactNode; tone: string; value: string; label: string; className?: string }) {
  return (
    <div className={`surface flex items-center gap-4 p-4 ${className}`}>
      <div className={`grid size-10 place-items-center rounded-full border border-current ${tone}`}>{icon}</div>
      <div className="min-w-0">
        <div className="truncate text-lg font-semibold tabular-nums">{value}</div>
        <div className="text-xs text-base-content/60">{label}</div>
      </div>
    </div>
  )
}

/** A sortable table on wide screens; stacked cards on phones. */
export function DownloadList({ downloads, actions = false, seriesName }: {
  downloads: DownloadDto[]
  actions?: boolean
  seriesName?: (d: DownloadDto) => string
}) {
  const t = useT()
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null)
  const sorted = useMemo(() => {
    if (!sort) return downloads
    const value = (d: DownloadDto): string | number => ({
      name: d.name.toLowerCase(), progress: d.progress, status: d.status, speed: d.downloadSpeed,
      size: d.totalBytes, peers: d.peers, series: seriesName?.(d) ?? '',
    })[sort.key]
    return [...downloads].sort((a, b) => {
      const [x, y] = [value(a), value(b)]
      const order = x < y ? -1 : x > y ? 1 : 0
      return sort.desc ? -order : order
    })
  }, [downloads, sort, seriesName])

  const header = (key: SortKey, label: string, className = '') => (
    <th className={className}>
      <button type="button" className="inline-flex items-center gap-1 font-semibold"
        onClick={() => setSort(s => (s?.key === key ? { key, desc: !s.desc } : { key, desc: false }))}>
        {label}{sort?.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  )

  return (
    <>
      <div className="surface hidden overflow-x-auto md:block">
        <table className="table table-sm">
          <thead>
            <tr>
              {header('name', t('downloads.colName'))}
              {seriesName && header('series', t('downloads.colSeries'))}
              {header('progress', t('downloads.colProgress'), 'w-52')}
              {header('status', t('downloads.colStatus'))}
              {header('speed', t('downloads.colSpeed'))}
              {header('size', t('downloads.colSize'), 'hidden xl:table-cell')}
              {header('peers', t('downloads.colPeers'), 'hidden xl:table-cell')}
              {actions && <th className="w-32" />}
            </tr>
          </thead>
          <tbody>
            {sorted.map(d => (
              <tr key={d.id} className="hover:bg-base-200/60">
                <td className="min-w-64"><DownloadName download={d} /></td>
                {seriesName && <td><span className="badge badge-soft badge-secondary badge-sm">{seriesName(d)}</span></td>}
                <td><ProgressBar download={d} /></td>
                <td><StatusBadge status={d.status} /></td>
                <td><Speed download={d} /></td>
                <td className="hidden xl:table-cell"><Size bytes={d.totalBytes} /></td>
                <td className="hidden text-xs tabular-nums xl:table-cell">{d.peers}</td>
                {actions && <td><DownloadActions download={d} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-2 md:hidden">
        {sorted.map(d => (
          <li key={d.id} className="surface p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1"><DownloadName download={d} /></div>
              {actions && <DownloadActions download={d} />}
            </div>
            <div className="mt-2"><ProgressBar download={d} /></div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusBadge status={d.status} />
              {seriesName && <span className="badge badge-soft badge-secondary badge-sm">{seriesName(d)}</span>}
              <Size bytes={d.totalBytes} />
              <Speed download={d} />
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
