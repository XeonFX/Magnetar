import type { AiringDto, DownloadDto, SeriesTaskDto, ShowInfoDto, WatchInput } from '@magnetar/protocol'
import { ChevronDown, CircleCheck, Clapperboard, ExternalLink, Pencil, Plus, RefreshCw, Trash2, Tv } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useFormatRelative, useT } from '../../lib/i18n.tsx'
import { parseQuality, qualityForm, resolutionLabel, type QualityForm } from '../../lib/quality.ts'
import { PageHeader, Segmented, Switch } from '../../ui/controls.tsx'
import { Field, TextField } from '../../ui/fields.tsx'
import { Empty } from '../../ui/Empty.tsx'
import { ConfirmDialog, Modal } from '../../ui/Modal.tsx'
import { useToast } from '../../ui/toast.tsx'
import { useConnection, useDevice, useDownloads } from '../DeviceContext.tsx'
import { FolderField } from '../components/folders.tsx'
import { intervalLabel, QualityFields } from '../components/qualityFields.tsx'
import { WatchesSection } from '../components/watches.tsx'
import { useRun } from '../useRun.ts'
import { DownloadList } from './DownloadsPage.tsx'

const INTERVALS = [15, 30, 60, 120, 360, 720, 1440]

/** "S03E11", or "E11" when the task isn't tied to a season. */
function episodeLabel(season: number | null, episode: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return season === null ? `E${pad(episode)}` : `S${pad(season)}E${pad(episode)}`
}

export function SeriesPage() {
  const t = useT()
  const { series, watches, basePath } = useDevice()
  const downloads = useDownloads()
  const [editing, setEditing] = useState<SeriesTaskDto | 'new' | null>(null)
  // One pass per update; each card keeps its list until one of its own downloads changes.
  const byTask = useMemo(() => {
    const groups = new Map<number, DownloadDto[]>()
    for (const d of downloads) if (d.seriesTaskId !== null) groups.set(d.seriesTaskId, [...(groups.get(d.seriesTaskId) ?? []), d])
    return groups
  }, [downloads])
  const add = <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} />{t('series.add')}</button>
  // The tab is part of the path: /series and /series/releases.
  const { tab: tabParam } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const tab = tabParam === 'releases' ? 'releases' : 'series'
  // Search hands over "watch for this" with its query.
  const [handed, setHanded] = useState<WatchInput | null>((location.state as { watch?: WatchInput } | null)?.watch ?? null)
  const clearHanded = useCallback(() => setHanded(null), [])

  // Older links named the tab in the query (?tab=releases); unknown tabs fall back to the first.
  if (!tabParam && params.get('tab') === 'releases') return <Navigate to={`${basePath}/series/releases`} replace state={location.state} />
  if (tabParam && tabParam !== 'releases') return <Navigate to={`${basePath}/series`} replace />

  return (
    <>
      <PageHeader title={t('watch.pageTitle')} summary={t(tab === 'series' ? 'series.subtitle' : 'watch.subtitle')} action={tab === 'series' && series.length > 0 && add} />
      <div className="mb-4">
        <Segmented label={t('watch.pageTitle')} value={tab} onChange={next => navigate(`${basePath}/series${next === 'releases' ? '/releases' : ''}`)}
          options={[
            { value: 'series', label: t('series.title'), icon: <Tv size={14} />, count: series.length },
            { value: 'releases', label: t('watch.tab'), icon: <Clapperboard size={14} />, count: watches.length },
          ]} />
      </div>
      {tab === 'releases' ? <WatchesSection start={handed} onStarted={clearHanded} /> : series.length === 0 ? (
        <Empty icon={<Tv size={40} strokeWidth={1.5} className="text-primary" />} title={t('series.emptyTitle')} text={t('series.emptyHint')}>
          {add}
        </Empty>
      ) : (
        <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {series.map(task => <SeriesCard key={task.id} task={task} downloads={byTask.get(task.id) ?? NONE} onEdit={setEditing} />)}
        </ul>
      )}
      <SeriesDialog task={editing} onClose={() => setEditing(null)} />
    </>
  )
}

const NONE: DownloadDto[] = []
const sameRows = (a: DownloadDto[], b: DownloadDto[]) => a.length === b.length && a.every((d, i) => d === b[i])

/** Posters by task and show, kept for the page's lifetime: they only change with the show. */
const posters = new Map<string, Promise<string | null>>()

function usePoster(taskId: number, show: ShowInfoDto | null): string | null {
  const connection = useConnection()
  const [poster, setPoster] = useState<string | null>(null)
  const key = show?.hasPoster ? `${taskId}:${show.tvmazeId}` : null
  useEffect(() => {
    if (!key) return setPoster(null)
    let cancelled = false
    if (!posters.has(key)) {
      posters.set(key, connection.call('series.poster', { id: taskId }).then(r => (r.data ? `data:image/jpeg;base64,${r.data}` : null)).catch(() => {
        posters.delete(key)
        return null
      }))
    }
    void posters.get(key)!.then(url => { if (!cancelled) setPoster(url) })
    return () => { cancelled = true }
  }, [connection, key, taskId])
  return poster
}

const SeriesCard = memo(function SeriesCard({ task, downloads, onEdit }: {
  task: SeriesTaskDto
  downloads: DownloadDto[]
  onEdit: (task: SeriesTaskDto) => void
}) {
  const t = useT()
  const formatRelative = useFormatRelative()
  const toast = useToast()
  const run = useRun()
  const connection = useConnection()
  const poster = usePoster(task.id, task.show)
  const [checking, setChecking] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDownloads, setShowDownloads] = useState(false)

  const checkNow = async () => {
    setChecking(true)
    const done = await run(() => connection.call('series.checkNow', { id: task.id }), 'series.checkFailed')
    setChecking(false)
    if (done) toast(t('series.checkDone'), 'info')
  }

  const details = [
    task.season !== null && t('series.seasonN', task.season),
    resolutionLabel(task.resolution),
    task.titleFilter,
    task.provider,
    t('series.everyN', intervalLabel(t, task.checkIntervalMinutes)),
  ].filter(Boolean).join(' · ')
  const total = task.endEpisode === null ? null : task.endEpisode - task.startEpisode + 1
  const got = Math.max(0, task.lastDownloadedEpisode - task.startEpisode + 1)
  const failed = downloads.filter(d => d.status === 'Error').length
  const show = task.show
  const next = show?.nextEpisode?.airstamp && new Date(show.nextEpisode.airstamp).getTime() > Date.now() ? show.nextEpisode : null
  const showLine = show && [show.network, next ? t('series.airs', airingLabel(next), formatRelative(next.airstamp)) : show.status === 'Ended' ? t('series.ended') : null]
    .filter(Boolean).join(' · ')

  return (
    <li className={`surface flex flex-col p-5 ${task.enabled || task.finished ? '' : 'opacity-80'}`}>
      <div className="flex items-start gap-4">
        {poster
          ? <img src={poster} alt="" className="h-24 w-16 shrink-0 rounded-field object-cover shadow-sm" />
          : <span className={`grid size-12 shrink-0 place-items-center rounded-field ${task.enabled && !task.finished ? 'bg-primary/10 text-primary' : 'bg-base-200 muted'}`}><Tv size={22} /></span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <h2 className="break-release min-w-0 flex-1 font-semibold leading-snug">{task.name || t('series.unnamed')}</h2>
            {!task.finished && (
              <Switch label={t('series.enabled')} checked={task.enabled}
                onChange={enabled => void run(() => connection.call('series.update', { id: task.id, patch: { enabled } }), 'settings.saveFailed')} />
            )}
          </div>
          <p className="muted mt-0.5 text-sm">{details}</p>
          {showLine && <p className="mt-0.5 text-xs text-info">{showLine}</p>}
        </div>
      </div>

      <div className="mt-4">
        {task.finished ? (
          <p className="flex items-center gap-2 text-sm font-medium text-success"><CircleCheck size={16} />{t('series.finishedAll', got)}</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span>
                <span className="muted">{t('series.nextLabel')} </span>
                <span className="font-semibold tabular-nums">{episodeLabel(task.season, task.nextEpisode)}</span>
              </span>
              {total !== null && <span className="muted tabular-nums">{t('series.progress', got, total)}</span>}
            </div>
            {total !== null && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-base-300">
                <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (got / total) * 100)}%` }} />
              </div>
            )}
            <p className="muted mt-2 text-xs">
              {!task.enabled ? t('series.pausedHint') : task.lastCheckedAt ? t('series.checkedAgo', formatRelative(task.lastCheckedAt)) : t('series.notCheckedYet')}
            </p>
            {failed > 0 && <p className="mt-1 text-xs text-warning">{failed === 1 ? t('series.failedOne') : t('series.failedHint', failed)}</p>}
          </>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-1 border-t border-base-300 pt-3">
        {!task.finished && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={checking} onClick={() => void checkNow()}>
            {checking ? <span className="loading loading-spinner loading-xs" /> : <RefreshCw size={14} />}{t('series.checkNow')}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEdit(task)}><Pencil size={14} />{t('common.edit')}</button>
        {downloads.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showDownloads} onClick={() => setShowDownloads(s => !s)}>
            {t('series.downloads', downloads.length)}<ChevronDown size={14} className={`transition-transform ${showDownloads ? 'rotate-180' : ''}`} />
          </button>
        )}
        {show?.url && (
          <a className="btn btn-ghost btn-sm btn-square muted" href={show.url} target="_blank" rel="noreferrer noopener" aria-label={t('series.onTvmaze')} title={t('series.onTvmaze')}>
            <ExternalLink size={14} />
          </a>
        )}
        <button type="button" className="btn btn-ghost btn-sm btn-square muted ml-auto hover:text-error" aria-label={t('series.deleteTask')} title={t('series.deleteTask')}
          onClick={() => setDeleting(true)}><Trash2 size={16} /></button>
      </div>
      {showDownloads && <div className="mt-3"><DownloadList downloads={downloads} hideSeries /></div>}

      {deleting && <ConfirmDialog open title={t('series.deleteTaskTitle')}
        message={downloads.length > 0 ? t('series.deleteConfirmWithDownloads', task.name, downloads.length) : t('series.deleteConfirm', task.name)}
        options={[{ label: t('common.cancel'), value: false, tone: 'ghost' }, { label: t('common.delete'), value: true, tone: 'error' }]}
        onResult={confirmed => {
          setDeleting(false)
          if (confirmed) void run(() => connection.call('series.delete', { id: task.id }))
        }} />}
    </li>
  )
}, (a, b) => a.task === b.task && a.onEdit === b.onEdit && sameRows(a.downloads, b.downloads))

/** "S03E15", or just "E15", for an airing. */
function airingLabel(airing: AiringDto): string {
  return airing.number === null ? '' : episodeLabel(airing.season, airing.number)
}

interface Form extends QualityForm {
  name: string
  query: string
  provider: string
  titleFilter: string
  season: string
  startEpisode: string
  endEpisode: string
  checkIntervalMinutes: number
  downloadFolder: string
  startFrom: 'episode' | 'latest' | 'new'
}

function formFor(task: SeriesTaskDto | null): Form {
  return {
    name: task?.name ?? '',
    query: task?.query ?? '',
    provider: task?.provider ?? '',
    titleFilter: task?.titleFilter ?? '',
    season: task?.season === null || task === null ? '' : String(task.season),
    startEpisode: String(task?.startEpisode ?? 1),
    endEpisode: task?.endEpisode == null ? '' : String(task.endEpisode),
    checkIntervalMinutes: task?.checkIntervalMinutes ?? 60,
    downloadFolder: task?.downloadFolder ?? '',
    ...qualityForm(task),
    startFrom: 'episode',
  }
}

/** Create a series task, or edit one; nothing is saved until Save. */
function SeriesDialog({ task, onClose }: { task: SeriesTaskDto | 'new' | null; onClose: () => void }) {
  const t = useT()
  const run = useRun()
  const { connection, sources, settings } = useDevice()
  const existing = task === 'new' ? null : task
  const [form, setForm] = useState(() => formFor(null))
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (task) setForm(formFor(existing))
    // The dialog resets whenever it opens for another task.
  }, [task])

  const set = <K extends keyof Form>(key: K) => (value: Form[K]) => setForm(f => ({ ...f, [key]: value }))
  const number = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.trunc(Number(v))))
  const start = number(form.startEpisode) ?? 1
  const end = number(form.endEpisode)
  const quality = parseQuality(form)
  const invalid = !form.query.trim() || (end !== null && end < start) || quality.invalid

  const save = async () => {
    const values = {
      name: form.name.trim() || form.query.trim(),
      query: form.query.trim(),
      provider: form.provider || null,
      titleFilter: form.titleFilter.trim() || null,
      season: number(form.season),
      startEpisode: Math.max(1, start),
      endEpisode: end,
      checkIntervalMinutes: form.checkIntervalMinutes,
      downloadFolder: form.downloadFolder.trim() || null,
      ...quality.values,
    }
    setSaving(true)
    const saved = existing
      ? await run(() => connection.call('series.update', { id: existing.id, patch: values }), 'settings.saveFailed')
      : await run(() => connection.call('series.create', { ...values, enabled: true, startFrom: form.startFrom }), 'settings.saveFailed')
    setSaving(false)
    if (saved) onClose()
  }

  const intervals = INTERVALS.includes(form.checkIntervalMinutes) ? INTERVALS : [...INTERVALS, form.checkIntervalMinutes].sort((a, b) => a - b)

  return (
    <Modal open={task !== null} title={existing ? t('series.editTitle') : t('series.add')} onClose={onClose} wide
      actions={<>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={invalid || saving} onClick={() => void save()}>
          {saving ? <span className="loading loading-spinner loading-xs" /> : existing ? null : <Plus size={14} />}
          {existing ? t('common.save') : t('series.add')}
        </button>
      </>}>
      <div className="flex flex-col gap-5">
        <FormSection title={t('series.whatTitle')}>
          <TextField label={t('series.query')} help={t('series.queryHelp')} value={form.query} onChange={set('query')} data-autofocus required />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField label={t('series.name')} help={t('series.nameHelp')} value={form.name} placeholder={form.query} onChange={set('name')} />
            <TextField label={t('series.titleFilter')} help={t('series.titleFilterHelp')} value={form.titleFilter} onChange={set('titleFilter')} />
          </div>
        </FormSection>

        <FormSection title={t('series.episodesTitle')}>
          {!existing && (
            <Segmented label={t('series.startFrom')} value={form.startFrom} onChange={set('startFrom')}
              options={[
                { value: 'episode', label: t('series.startFrom.episode') },
                { value: 'latest', label: t('series.startFrom.latest') },
                { value: 'new', label: t('series.startFrom.new') },
              ]} />
          )}
          <div className="grid grid-cols-3 gap-3">
            <TextField label={t('series.season')} type="number" min={0} value={form.season} onChange={set('season')} />
            {(existing || form.startFrom === 'episode') && (
              <TextField label={t('series.startEpisode')} type="number" min={1} value={form.startEpisode} onChange={set('startEpisode')} />
            )}
            <TextField label={t('series.endEpisode')} type="number" min={1} value={form.endEpisode} onChange={set('endEpisode')} />
          </div>
          {end !== null && end < start
            ? <p className="text-sm text-error">{t('series.endBeforeStart')}</p>
            : <p className="muted text-xs">{t('series.episodesHelp')}</p>}
          {!existing && (
            <p className="rounded-field bg-info/10 px-3 py-2 text-sm text-info">
              {form.startFrom === 'episode' ? t('series.backfillHint', start) : t(`series.startFromHint.${form.startFrom}`)}
            </p>
          )}
        </FormSection>

        <FormSection title={t('series.qualityTitle')}>
          <QualityFields form={form} set={set} kind="series" />
        </FormSection>

        <FormSection title={t('series.whereTitle')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('search.source')}>
              <select className="select w-full" value={form.provider} onChange={e => set('provider')(e.target.value)}>
                <option value="">{t('search.allSources')}</option>
                {sources.filter(s => s.enabled || s.name === form.provider).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </Field>
            <Field label={t('series.checkEvery')}>
              <select className="select w-full" value={form.checkIntervalMinutes} onChange={e => set('checkIntervalMinutes')(Number(e.target.value))}>
                {intervals.map(m => <option key={m} value={m}>{intervalLabel(t, m)}</option>)}
              </select>
            </Field>
          </div>
          <FolderField label={t('series.folder')} value={form.downloadFolder} placeholder={settings?.downloadFolder}
            help={t('series.folderHelp')} onChange={set('downloadFolder')} />
        </FormSection>
      </div>
    </Modal>
  )
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="muted mb-3 text-xs font-semibold uppercase tracking-wider">{title}</legend>
      {children}
    </fieldset>
  )
}
