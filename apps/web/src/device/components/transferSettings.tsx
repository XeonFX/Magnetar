import type { NetworkInterfaceDto, SettingsDto, SettingsPatch } from '@magnetar/protocol'
import { MIN_SPEED_LIMIT } from '@magnetar/protocol/limits'
import { Gauge, Network, ShieldCheck } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useLanguage, useT } from '../../lib/i18n.tsx'
import { Segmented, SettingGroup, SettingRow } from '../../ui/controls.tsx'
import { blurOnEnter } from '../../ui/fields.tsx'
import { useDevice } from '../DeviceContext.tsx'

type Save = (patch: SettingsPatch) => void

const KIB = 1024
const MIB = 1024 * 1024

/** Seeding after a download finishes: stop, keep going, or until a ratio. */
export function SeedingRow({ settings, save }: { settings: SettingsDto; save: Save }) {
  const t = useT()
  const help = {
    StopSeeding: 'settings.stopSeedingHelp',
    KeepSeeding: 'settings.keepSeedingHelp',
    SeedToRatio: 'settings.seedRatioHelp',
  }[settings.postDownloadAction]
  return (
    <SettingRow layout="stack" title={t('settings.postDownload')} description={t(help, settings.seedRatio)}>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label={t('settings.postDownload')} value={settings.postDownloadAction} onChange={postDownloadAction => save({ postDownloadAction })}
          options={[
            { value: 'StopSeeding', label: t('settings.stopSeeding') },
            { value: 'SeedToRatio', label: t('settings.seedToRatio') },
            { value: 'KeepSeeding', label: t('settings.keepSeeding') },
          ]} />
        {settings.postDownloadAction === 'SeedToRatio' && (
          <NumberInput label={t('settings.seedRatio')} value={settings.seedRatio} min={0.1} max={100} step={0.1} suffix="×"
            onSave={seedRatio => save({ seedRatio })} />
        )}
      </div>
    </SettingRow>
  )
}

function NumberInput({ label, value, min, max, step, suffix, onSave }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix: string
  onSave: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const parsed = Number(draft)
  const valid = draft.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max
  return (
    <label className={`input input-sm w-28 ${valid ? '' : 'input-error'}`}>
      <input type="number" inputMode="decimal" aria-label={label} min={min} max={max} step={step} value={draft}
        onChange={e => setDraft(e.target.value)} onKeyDown={blurOnEnter}
        onBlur={() => (valid && parsed !== value ? onSave(parsed) : setDraft(String(value)))} />
      <span className="muted">{suffix}</span>
    </label>
  )
}

/**
 * A speed cap in bytes per second, typed in KiB/s or MiB/s. Blank or 0 is no cap; anything else
 * must be at least what the engine accepts.
 */
function SpeedInput({ label, value, onSave }: { label: string; value: number; onSave: (value: number) => void }) {
  const t = useT()
  const id = useId()
  const initialUnit = value >= MIB && value % MIB === 0 ? MIB : KIB
  const [unit, setUnit] = useState(initialUnit)
  const [draft, setDraft] = useState(value ? String(value / initialUnit) : '')
  useEffect(() => {
    const u = value >= MIB && value % MIB === 0 ? MIB : KIB
    setUnit(u)
    setDraft(value ? String(value / u) : '')
  }, [value])
  const bytes = draft.trim() === '' ? 0 : Math.round(Number(draft) * unit)
  const error = !Number.isFinite(bytes) || bytes < 0 ? t('settings.speedInvalid')
    : bytes !== 0 && bytes < MIN_SPEED_LIMIT ? t('settings.speedTooLow', MIN_SPEED_LIMIT / KIB) : null
  const commit = (nextUnit = unit) => {
    const next = draft.trim() === '' ? 0 : Math.round(Number(draft) * nextUnit)
    if (Number.isFinite(next) && (next === 0 || next >= MIN_SPEED_LIMIT) && next !== value) onSave(next)
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium" id={id}>{label}</span>
      <div className="join">
        <input type="number" inputMode="decimal" min={0} step="any" aria-labelledby={id} placeholder={t('settings.noLimit')}
          className={`input join-item w-32 ${error ? 'input-error' : ''}`} value={draft}
          onChange={e => setDraft(e.target.value)} onBlur={() => commit()} onKeyDown={blurOnEnter} />
        <select className="select join-item w-24" aria-label={t('settings.speedUnit')} value={unit}
          onChange={e => { const u = Number(e.target.value); setUnit(u); commit(u) }}>
          <option value={KIB}>KiB/s</option>
          <option value={MIB}>MiB/s</option>
        </select>
      </div>
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  )
}

const toTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const fromTime = (text: string) => {
  const [h, m] = text.split(':').map(Number)
  return h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m
}

/** Usual caps, the alternative ones, and when the alternative ones apply. */
export function SpeedSettings({ settings, save }: { settings: SettingsDto; save: Save }) {
  const t = useT()
  const language = useLanguage()
  // Monday first, named in the dashboard's language (1 Jan 2024 was a Monday).
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(language, { weekday: 'short', timeZone: 'UTC' })), [language])
  const toggleDay = (day: number) => {
    const next = settings.altScheduleDays.includes(day) ? settings.altScheduleDays.filter(d => d !== day) : [...settings.altScheduleDays, day]
    save({ altScheduleDays: next.sort() })
  }
  return (
    <SettingGroup title={t('settings.speedTitle')} description={t('settings.speedHint')} action={<Gauge size={20} className="muted" />}>
      <SettingRow layout="stack" title={t('settings.usualLimits')}>
        <div className="flex flex-wrap gap-4">
          <SpeedInput label={t('settings.downloadLimit')} value={settings.downloadLimit} onSave={downloadLimit => save({ downloadLimit })} />
          <SpeedInput label={t('settings.uploadLimit')} value={settings.uploadLimit} onSave={uploadLimit => save({ uploadLimit })} />
        </div>
      </SettingRow>
      <SettingRow layout="stack" title={t('settings.altLimits')} description={t('settings.altLimitsHint')}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <SpeedInput label={t('settings.downloadLimit')} value={settings.altDownloadLimit} onSave={altDownloadLimit => save({ altDownloadLimit })} />
            <SpeedInput label={t('settings.uploadLimit')} value={settings.altUploadLimit} onSave={altUploadLimit => save({ altUploadLimit })} />
          </div>
          <Segmented label={t('settings.altWhen')} value={settings.altSpeedMode} onChange={altSpeedMode => save({ altSpeedMode })}
            options={[
              { value: 'off', label: t('settings.altOff') },
              { value: 'scheduled', label: t('settings.altScheduled') },
              { value: 'on', label: t('settings.altAlways') },
            ]} />
          {settings.altSpeedMode === 'scheduled' && (
            <div className="flex flex-col gap-3 rounded-field bg-base-200 p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>{t('settings.altFrom')}</span>
                <input type="time" className="input input-sm w-32" aria-label={t('settings.altFrom')} value={toTime(settings.altScheduleFrom)}
                  onChange={e => { const m = fromTime(e.target.value); if (m !== null && m !== settings.altScheduleFrom) save({ altScheduleFrom: m }) }} />
                <span>{t('settings.altTo')}</span>
                <input type="time" className="input input-sm w-32" aria-label={t('settings.altTo')} value={toTime(settings.altScheduleTo)}
                  onChange={e => { const m = fromTime(e.target.value); if (m !== null && m !== settings.altScheduleTo) save({ altScheduleTo: m }) }} />
              </div>
              <div role="group" aria-label={t('settings.altDays')} className="flex flex-wrap gap-1">
                {days.map((name, day) => (
                  <button key={day} type="button" aria-pressed={settings.altScheduleDays.includes(day)} onClick={() => toggleDay(day)}
                    className={`btn btn-xs min-w-11 rounded-full ${settings.altScheduleDays.includes(day) ? 'btn-neutral' : 'btn-ghost border-base-300 bg-base-100'}`}>
                    {name}
                  </button>
                ))}
              </div>
              <p className="muted text-xs">
                {settings.altScheduleFrom > settings.altScheduleTo ? t('settings.altOvernight') : settings.altScheduleFrom === settings.altScheduleTo ? t('settings.altAllDay') : t('settings.altWindow')}
              </p>
            </div>
          )}
        </div>
      </SettingRow>
    </SettingGroup>
  )
}

/** Torrent traffic only through one network connection (a VPN), and none without it. */
export function NetworkSettings({ settings, save }: { settings: SettingsDto; save: Save }) {
  const t = useT()
  const { connection, transfer } = useDevice()
  const [list, setList] = useState<{ supported: boolean; interfaces: NetworkInterfaceDto[] } | null>(null)
  const refresh = () => void connection.call('network.interfaces').then(setList).catch(() => setList({ supported: false, interfaces: [] }))
  useEffect(refresh, [connection])
  if (!list) return null
  const chosen = settings.networkInterface
  const missing = chosen !== '' && !list.interfaces.some(i => i.name === chosen)
  return (
    <SettingGroup title={t('settings.networkTitle')} description={t('settings.networkHint')} action={<Network size={20} className="muted" />}>
      {!list.supported ? (
        <p className="muted text-sm">{t('settings.networkUnsupported')}</p>
      ) : (
        <SettingRow layout="stack" title={t('settings.networkInterface')} htmlFor="magnetar-interface"
          description={chosen
            ? <span className={missing ? 'text-warning' : 'inline-flex items-center gap-1 text-success'}>
                {missing ? t('settings.networkMissing', chosen) : <><ShieldCheck size={14} />{t('settings.networkBound', chosen)}</>}
              </span>
            : t('settings.networkAny')}>
          <div className="flex gap-2">
            <select id="magnetar-interface" className="select w-full sm:max-w-md" value={chosen} onFocus={refresh}
              onChange={e => save({ networkInterface: e.target.value })}>
              <option value="">{t('settings.networkAnyOption')}</option>
              {missing && <option value={chosen}>{t('settings.networkMissingOption', chosen)}</option>}
              {list.interfaces.map(i => (
                <option key={i.name} value={i.name}>{i.vpn ? `${i.name} — VPN` : i.name} ({i.addresses.slice(0, 2).join(', ')})</option>
              ))}
            </select>
          </div>
        </SettingRow>
      )}
      {transfer?.engine === 'waitingForNetwork' && <p className="pt-3 text-sm text-warning">{t('transfer.waitingText', transfer.networkInterface ?? '')}</p>}
    </SettingGroup>
  )
}
