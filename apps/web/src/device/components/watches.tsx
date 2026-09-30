import type { WatchDto, WatchInput } from '@magnetar/protocol'
import { formatBytes } from '@magnetar/protocol/bytes'
import { BellRing, CircleCheck, Clapperboard, Download, Pencil, Plus, RefreshCw, RotateCcw, Sprout, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useFormatRelative, useT } from '../../lib/i18n.tsx'
import { parseQuality, qualityForm, resolutionLabel, type QualityForm } from '../../lib/quality.ts'
import { Segmented, Switch } from '../../ui/controls.tsx'
import { Field, TextField } from '../../ui/fields.tsx'
import { Empty } from '../../ui/Empty.tsx'
import { ConfirmDialog, Modal } from '../../ui/Modal.tsx'
import { useToast } from '../../ui/toast.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { useRun } from '../useRun.ts'
import { intervalLabel, QualityFields } from './qualityFields.tsx'

const INTERVALS = [60, 180, 360, 720, 1440, 4320, 10080]

/** Films and anything else to wait for a release of: the list, and adding one. */
export function WatchesSection({ start, onStarted }: { start: WatchInput | null; onStarted: () => void }) {
  const t = useT()
  const { watches } = useDevice()
  const [editing, setEditing] = useState<WatchDto | 'new' | null>(null)
  const [draft, setDraft] = useState<WatchInput | null>(null)
  // Opened from Search with its query filled in.
  useEffect(() => {
    if (!start) return
    setDraft(start)
    setEditing('new')
    onStarted()
  }, [start, onStarted])

  const add = <button type="button" className="btn btn-primary" onClick={() => { setDraft(null); setEditing('new') }}><Plus size={16} />{t('watch.add')}</button>
  return (
    <>
      {watches.length === 0 ? (
        <Empty icon={<Clapperboard size={40} strokeWidth={1.5} className="text-primary" />} title={t('watch.emptyTitle')} text={t('watch.emptyHint')}>{add}</Empty>
      ) : (
        <>
          <div className="mb-4 flex justify-end">{add}</div>
          <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {watches.map(watch => <WatchCard key={watch.id} watch={watch} onEdit={() => { setDraft(null); setEditing(watch) }} />)}
          </ul>
        </>
      )}
      <WatchDialog watch={editing} draft={draft} onClose={() => setEditing(null)} />
    </>
  )
}

function WatchCard({ watch, onEdit }: { watch: WatchDto; onEdit: () => void }) {
  const t = useT()
  const formatRelative = useFormatRelative()
  const toast = useToast()
  const run = useRun()
  const { connection, basePath } = useDevice()
  const [busy, setBusy] = useState<'check' | 'download' | null>(null)
  const [deleting, setDeleting] = useState(false)
  const rules = [
    resolutionLabel(watch.resolution),
    watch.maxSizeMb !== null && t('watch.upTo', formatBytes(watch.maxSizeMb * 1024 * 1024, 0)),
    watch.minSeeders > 1 && t('watch.seedersAtLeast', watch.minSeeders),
    watch.preferWords && t('watch.prefers', watch.preferWords),
    watch.autoDownload ? t('watch.autoDownload') : t('watch.notifyOnly'),
  ].filter(Boolean).join(' · ')

  const act = async (kind: 'check' | 'download') => {
    setBusy(kind)
    const done = await run(() => connection.call(kind === 'check' ? 'watches.checkNow' : 'watches.download', { id: watch.id }), 'watch.failed')
    setBusy(null)
    if (done && kind === 'check') toast(('found' in done && done.found) ? t('watch.foundToast') : t('watch.nothingYet'), 'info')
    if (done && kind === 'download') toast(t('search.started', watch.found?.title ?? ''), 'success')
  }
  const rearm = (enabled: boolean) => void run(() => connection.call('watches.update', { id: watch.id, watch: { ...toInput(watch), enabled } }), 'settings.saveFailed')

  return (
    <li className="surface flex flex-col p-5">
      <div className="flex items-start gap-3">
        <span className={`grid size-10 shrink-0 place-items-center rounded-field ${watch.found ? 'bg-success/10 text-success' : watch.enabled ? 'bg-primary/10 text-primary' : 'bg-base-200 muted'}`}>
          {watch.found ? <CircleCheck size={20} /> : <BellRing size={20} />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="break-release font-semibold leading-snug">{watch.query}</h3>
          <p className="muted mt-0.5 text-sm">{rules}</p>
        </div>
        {!watch.found && <Switch label={t('series.enabled')} checked={watch.enabled} onChange={rearm} />}
      </div>

      {watch.found ? (
        <div className="mt-4 rounded-field bg-success/5 p-3 text-sm">
          <div className="text-xs font-medium text-success">{t('watch.foundAt', formatRelative(watch.found.foundAt))}</div>
          <div className="break-release mt-1 font-medium">{watch.found.title}</div>
          <div className="muted mt-1 flex flex-wrap gap-x-3 text-xs">
            <span className="tabular-nums">{formatBytes(watch.found.sizeBytes)}</span>
            <span className="inline-flex items-center gap-1 tabular-nums"><Sprout size={12} />{watch.found.seeders}</span>
            <span>{watch.found.source}</span>
          </div>
        </div>
      ) : (
        <p className="muted mt-4 text-xs">
          {!watch.enabled ? t('series.pausedHint') : watch.lastCheckedAt ? t('watch.checked', formatRelative(watch.lastCheckedAt), intervalLabel(t, watch.checkIntervalMinutes)) : t('series.notCheckedYet')}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-1 border-t border-base-300 pt-3">
        {watch.found ? (
          watch.downloadId !== null
            ? <Link to={basePath || '/'} className="btn btn-ghost btn-sm text-success"><Download size={14} />{t('watch.downloading')}</Link>
            : <button type="button" className="btn btn-primary btn-soft btn-sm" disabled={busy !== null} onClick={() => void act('download')}>
                {busy === 'download' ? <span className="loading loading-spinner loading-xs" /> : <Download size={14} />}{t('common.download')}
              </button>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null || !watch.enabled} onClick={() => void act('check')}>
            {busy === 'check' ? <span className="loading loading-spinner loading-xs" /> : <RefreshCw size={14} />}{t('series.checkNow')}
          </button>
        )}
        {watch.found && <button type="button" className="btn btn-ghost btn-sm" onClick={() => rearm(true)} title={t('watch.againHint')}><RotateCcw size={14} />{t('watch.again')}</button>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}><Pencil size={14} />{t('common.edit')}</button>
        <button type="button" className="btn btn-ghost btn-sm btn-square muted ml-auto hover:text-error" aria-label={t('watch.delete')} title={t('watch.delete')}
          onClick={() => setDeleting(true)}><Trash2 size={16} /></button>
      </div>
      {deleting && <ConfirmDialog open title={t('watch.delete')} message={t('watch.deleteConfirm', watch.query)}
        options={[{ label: t('common.cancel'), value: false, tone: 'ghost' }, { label: t('common.delete'), value: true, tone: 'error' }]}
        onResult={confirmed => {
          setDeleting(false)
          if (confirmed) void run(() => connection.call('watches.delete', { id: watch.id }))
        }} />}
    </li>
  )
}

function toInput(watch: WatchDto): WatchInput {
  return {
    query: watch.query, resolution: watch.resolution, minSeeders: watch.minSeeders, maxSizeMb: watch.maxSizeMb,
    preferWords: watch.preferWords, excludeWords: watch.excludeWords, autoDownload: watch.autoDownload,
    checkIntervalMinutes: watch.checkIntervalMinutes, enabled: watch.enabled,
  }
}

interface Form extends QualityForm {
  query: string
  autoDownload: boolean
  checkIntervalMinutes: number
}

function formFor(input: WatchInput | null): Form {
  return {
    ...qualityForm(input),
    query: input?.query ?? '',
    autoDownload: input?.autoDownload ?? false,
    checkIntervalMinutes: input?.checkIntervalMinutes ?? 360,
  }
}

function WatchDialog({ watch, draft, onClose }: { watch: WatchDto | 'new' | null; draft: WatchInput | null; onClose: () => void }) {
  const t = useT()
  const run = useRun()
  const toast = useToast()
  const { connection } = useDevice()
  const existing = watch === 'new' ? null : watch
  const [form, setForm] = useState(() => formFor(null))
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (watch) setForm(formFor(existing ? toInput(existing) : draft))
    // Resets whenever the dialog opens for another watch.
  }, [watch, draft])

  const set = <K extends keyof Form>(key: K) => (value: Form[K]) => setForm(f => ({ ...f, [key]: value }))
  const quality = parseQuality(form)
  const invalid = form.query.trim().length < 2 || quality.invalid

  const save = async () => {
    const input: WatchInput = {
      query: form.query.trim(),
      ...quality.values,
      autoDownload: form.autoDownload,
      checkIntervalMinutes: form.checkIntervalMinutes,
      enabled: existing ? existing.enabled : true,
    }
    setSaving(true)
    const saved = existing
      ? await run(() => connection.call('watches.update', { id: existing.id, watch: input }), 'settings.saveFailed')
      : await run(() => connection.call('watches.create', input), 'settings.saveFailed')
    setSaving(false)
    if (!saved) return
    if (!existing) toast(t('watch.createdToast'), 'info')
    onClose()
  }
  const intervals = INTERVALS.includes(form.checkIntervalMinutes) ? INTERVALS : [...INTERVALS, form.checkIntervalMinutes].sort((a, b) => a - b)

  return (
    <Modal open={watch !== null} title={existing ? t('watch.editTitle') : t('watch.add')} icon={<BellRing size={20} />} onClose={onClose} wide
      actions={<>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={invalid || saving} onClick={() => void save()}>
          {saving && <span className="loading loading-spinner loading-xs" />}{existing ? t('common.save') : t('watch.add')}
        </button>
      </>}>
      <div className="flex flex-col gap-4">
        <TextField label={t('watch.query')} help={t('watch.queryHelp')} value={form.query} onChange={set('query')} maxLength={200} data-autofocus />
        <QualityFields form={form} set={set} kind="watch" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('series.checkEvery')}>
            <select className="select w-full" value={form.checkIntervalMinutes} onChange={e => set('checkIntervalMinutes')(Number(e.target.value))}>
              {intervals.map(m => <option key={m} value={m}>{intervalLabel(t, m)}</option>)}
            </select>
          </Field>
          <Field label={t('watch.whenFound')}>
            <Segmented label={t('watch.whenFound')} value={form.autoDownload ? 'download' : 'notify'} onChange={v => set('autoDownload')(v === 'download')}
              options={[{ value: 'notify', label: t('watch.tellMe') }, { value: 'download', label: t('watch.downloadIt') }]} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
