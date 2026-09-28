import type { SeriesTaskDto, SeriesTaskPatch } from '@md/protocol'
import { Plus, RefreshCw, Trash2, Tv } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useFormatDate, useT } from '../../lib/i18n.tsx'
import { Empty } from '../../ui/Empty.tsx'
import { blurOnEnter, Field, SaveOnBlurInput } from '../../ui/fields.tsx'
import { ConfirmDialog, Modal } from '../../ui/Modal.tsx'
import { useToast } from '../../ui/toast.tsx'
import { useDevice, useDownloads } from '../DeviceContext.tsx'
import { PageHeader } from '../Shell.tsx'
import { FolderField } from '../components/folders.tsx'
import { useRun } from '../useRun.ts'
import { DownloadList } from './DownloadsPage.tsx'

export function SeriesPage() {
  const t = useT()
  const { series } = useDevice()
  const [creating, setCreating] = useState(false)
  const add = <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} />{t('series.add')}</button>

  return (
    <>
      <PageHeader title={t('series.title')} subtitle={t('series.subtitle')} action={series.length > 0 && add} />
      {series.length === 0 ? (
        <Empty icon={<div className="grid size-18 place-items-center rounded-full border-2 border-primary text-primary"><Tv size={32} /></div>}
          title={t('series.emptyTitle')} text={t('series.emptyHint')}>
          {add}
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {series.map(task => <SeriesCard key={task.id} task={task} />)}
        </div>
      )}
      <CreateSeriesDialog open={creating} onClose={() => setCreating(false)} />
    </>
  )
}

function SeriesCard({ task }: { task: SeriesTaskDto }) {
  const t = useT()
  const formatDate = useFormatDate()
  const toast = useToast()
  const run = useRun()
  const { connection, sources, settings } = useDevice()
  const downloads = useDownloads()
  const [checking, setChecking] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const taskDownloads = downloads.filter(d => d.seriesTaskId === task.id)

  const save = (patch: SeriesTaskPatch) => void run(() => connection.call('series.update', { id: task.id, patch }), 'settings.saveFailed')
  const checkNow = async () => {
    setChecking(true)
    const done = await run(() => connection.call('series.checkNow', { id: task.id }), 'series.checkFailed')
    setChecking(false)
    if (done) toast(t('series.checkDone'), 'info')
  }

  const badge = task.finished ? <span className="badge badge-soft badge-success badge-sm">{t('series.finished')}</span>
    : !task.enabled ? <span className="badge badge-soft badge-sm">{t('series.disabled')}</span>
    : <span className="badge badge-soft badge-info badge-sm">{t('series.next', task.nextEpisode)}</span>

  return (
    <details className="collapse collapse-arrow surface">
      <summary className="collapse-title flex items-center gap-3 pr-10">
        <Tv size={20} className={task.enabled ? 'text-primary' : 'text-base-content/40'} />
        <span className="min-w-0 truncate font-medium">{task.name || t('series.unnamed')}</span>
        {badge}
      </summary>
      <div className="collapse-content">
        <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-6">
          <Text className="sm:col-span-3" label={t('series.name')} value={task.name} onSave={name => save({ name })} />
          <Text className="sm:col-span-3" label={t('series.query')} help={t('series.queryHelp')} value={task.query} onSave={query => save({ query })} />
          <div className="sm:col-span-6">
            <FolderField label={t('series.folder')} value={task.downloadFolder ?? ''} placeholder={settings?.downloadFolder}
              help={t('series.folderHelp')} onChange={folder => save({ downloadFolder: folder.trim() || null })} />
          </div>
          <label className="floating-label sm:col-span-2">
            <span>{t('search.source')}</span>
            <select className="select w-full" value={task.provider ?? ''} onChange={e => save({ provider: e.target.value || null })}>
              <option value="">{t('search.allSources')}</option>
              {sources.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          </label>
          <Text className="sm:col-span-2" label={t('series.titleFilter')} help={t('series.titleFilterHelp')} value={task.titleFilter ?? ''} onSave={v => save({ titleFilter: v.trim() || null })} />
          <NumberField className="sm:col-span-2" label={t('series.season')} value={task.season} min={0} optional onSave={season => save({ season })} />
          <NumberField className="sm:col-span-2" label={t('series.startEpisode')} value={task.startEpisode} min={1} onSave={v => v !== null && save({ startEpisode: v })} />
          <NumberField className="sm:col-span-2" label={t('series.endEpisode')} value={task.endEpisode} min={1} optional onSave={endEpisode => save({ endEpisode })} />
          <NumberField className="sm:col-span-2" label={t('series.checkEvery')} value={task.checkIntervalMinutes} min={5} onSave={v => v !== null && save({ checkIntervalMinutes: v })} />
          <label className="flex cursor-pointer items-center gap-3 sm:col-span-6">
            <input type="checkbox" className="toggle toggle-primary" checked={task.enabled} onChange={e => save({ enabled: e.target.checked })} />
            <span>{t('series.enabled')}</span>
          </label>
          <p className="text-xs text-base-content/60 sm:col-span-6">
            {t('series.lastDownloaded')}: {task.lastDownloadedEpisode === 0 ? t('series.nothingYet') : t('series.episode', task.lastDownloadedEpisode)}
            {' · '}{t('series.lastChecked')}: {task.lastCheckedAt ? formatDate(task.lastCheckedAt, true) : t('series.never')}
          </p>
        </div>

        <h3 className="mb-2 mt-5 text-sm font-semibold">{t('series.downloads', taskDownloads.length)}</h3>
        {taskDownloads.length === 0
          ? <p className="text-sm text-base-content/60">{t('series.noDownloads')}</p>
          : <DownloadList downloads={taskDownloads} actions />}

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn btn-outline btn-primary btn-sm" disabled={checking} onClick={() => void checkNow()}>
            {checking ? <span className="loading loading-spinner loading-xs" /> : <RefreshCw size={14} />}{t('series.checkNow')}
          </button>
          <button type="button" className="btn btn-outline btn-error btn-sm" onClick={() => setDeleting(true)}><Trash2 size={14} />{t('series.deleteTask')}</button>
        </div>
      </div>
      <ConfirmDialog open={deleting} title={t('series.deleteTaskTitle')}
        message={taskDownloads.length > 0 ? t('series.deleteConfirmWithDownloads', task.name, taskDownloads.length) : t('series.deleteConfirm', task.name)}
        options={[{ label: t('common.cancel'), value: false, tone: 'ghost' }, { label: t('common.delete'), value: true, tone: 'error' }]}
        onResult={confirmed => {
          setDeleting(false)
          if (confirmed) void run(() => connection.call('series.delete', { id: task.id }))
        }} />
    </details>
  )
}

function Text({ label, help, value, onSave, className = '' }: { label: string; help?: string; value: string; onSave: (value: string) => void; className?: string }) {
  return <Field label={label} help={help} className={className}><SaveOnBlurInput value={value} placeholder={label} onSave={onSave} /></Field>
}

function NumberField({ label, value, min, optional = false, onSave, className = '' }: {
  label: string; value: number | null; min: number; optional?: boolean; onSave: (value: number | null) => void; className?: string
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  useEffect(() => setDraft(value === null ? '' : String(value)), [value])
  const commit = () => {
    const parsed = draft.trim() === '' ? null : Math.max(min, Math.trunc(Number(draft)))
    if (parsed === null && !optional) return setDraft(value === null ? '' : String(value))
    if (parsed !== null && !Number.isFinite(parsed)) return setDraft(value === null ? '' : String(value))
    if (parsed !== value) onSave(parsed)
  }
  return (
    <Field label={label} className={className}>
      <input type="number" inputMode="numeric" min={min} className="input w-full" value={draft} placeholder={label}
        onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={blurOnEnter} />
    </Field>
  )
}


const EMPTY_FORM = { name: '', query: '', provider: '', titleFilter: '', season: '', startEpisode: '1', endEpisode: '', checkIntervalMinutes: '60' }

function CreateSeriesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const run = useRun()
  const { connection, sources } = useDevice()
  const [form, setForm] = useState(EMPTY_FORM)
  useEffect(() => {
    if (open) setForm(EMPTY_FORM)
  }, [open])
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [key]: e.target.value }))
  const number = (v: string) => (v.trim() === '' ? null : Number(v))

  const create = async () => {
    const created = await run(() => connection.call('series.create', {
      name: form.name.trim(), query: form.query.trim(), provider: form.provider || null, titleFilter: form.titleFilter.trim() || null,
      season: number(form.season), startEpisode: number(form.startEpisode) ?? 1, endEpisode: number(form.endEpisode),
      checkIntervalMinutes: number(form.checkIntervalMinutes) ?? 60, enabled: true,
    }), 'settings.saveFailed')
    if (created) onClose()
  }

  return (
    <Modal open={open} title={t('series.add')} icon={<Tv size={20} />} onClose={onClose} wide
      actions={<>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!form.name.trim() || !form.query.trim()} onClick={() => void create()}><Plus size={14} />{t('series.add')}</button>
      </>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('series.name')}><input className="input w-full" placeholder={t('series.name')} value={form.name} onChange={set('name')} autoFocus /></Field>
        <Field label={t('series.query')} help={t('series.queryHelp')}><input className="input w-full" placeholder={t('series.query')} value={form.query} onChange={set('query')} /></Field>
        <Field label={t('search.source')}>
          <select className="select w-full" value={form.provider} onChange={set('provider')}>
            <option value="">{t('search.allSources')}</option>
            {sources.filter(s => s.enabled).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={t('series.titleFilter')} help={t('series.titleFilterHelp')}><input className="input w-full" placeholder={t('series.titleFilter')} value={form.titleFilter} onChange={set('titleFilter')} /></Field>
        <Field label={t('series.season')}><input type="number" min={0} className="input w-full" placeholder={t('series.season')} value={form.season} onChange={set('season')} /></Field>
        <Field label={t('series.startEpisode')}><input type="number" min={1} className="input w-full" placeholder={t('series.startEpisode')} value={form.startEpisode} onChange={set('startEpisode')} /></Field>
        <Field label={t('series.endEpisode')}><input type="number" min={1} className="input w-full" placeholder={t('series.endEpisode')} value={form.endEpisode} onChange={set('endEpisode')} /></Field>
        <Field label={t('series.checkEvery')}><input type="number" min={5} className="input w-full" placeholder={t('series.checkEvery')} value={form.checkIntervalMinutes} onChange={set('checkIntervalMinutes')} /></Field>
      </div>
    </Modal>
  )
}
