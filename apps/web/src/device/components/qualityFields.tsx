import type { SeriesResolution } from '@magnetar/protocol'
import { useT } from '../../lib/i18n.tsx'
import { parseQuality, resolutionLabel, RESOLUTIONS, type QualityForm } from '../../lib/quality.ts'
import { Segmented } from '../../ui/controls.tsx'
import { Field, TextField } from '../../ui/fields.tsx'

type T = ReturnType<typeof useT>

/** The resolutions to choose from, "any" first. */
export function resolutionOptions(t: T): { value: SeriesResolution | ''; label: string }[] {
  return RESOLUTIONS.map(value => ({ value, label: value ? resolutionLabel(value)! : t('search.resolutionAny') }))
}

/** "Every 6 hours" and the like, in whole days, hours or minutes. */
export function intervalLabel(t: T, minutes: number): string {
  return minutes % 1440 === 0 ? t('series.interval.days', minutes / 1440)
    : minutes % 60 === 0 ? t('series.interval.hours', minutes / 60)
    : t('series.interval.minutes', minutes)
}

/** Resolution, seeders, size and words, for a series task (with hints) or a watch. */
export function QualityFields<F extends QualityForm>({ form, set, kind }: {
  form: F
  set: <K extends keyof QualityForm>(key: K) => (value: F[K]) => void
  kind: 'series' | 'watch'
}) {
  const t = useT()
  const { sizeInvalid } = parseQuality(form)
  const series = kind === 'series'
  return (
    <>
      <Field label={t('search.resolution')}>
        <Segmented label={t('search.resolution')} value={form.resolution} onChange={set('resolution')} options={resolutionOptions(t)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <TextField label={t('series.minSeeders')} help={series ? t('series.minSeedersHelp') : undefined} type="number" min={1}
          value={form.minSeeders} onChange={set('minSeeders')} />
        <TextField label={series ? t('series.maxSize') : t('watch.maxSize')}
          help={sizeInvalid ? <span className="text-error">{t('settings.speedInvalid')}</span> : series ? t('series.maxSizeHelp') : undefined}
          type="number" min={0.1} step={0.1} value={form.maxSizeGb} placeholder={t('settings.noLimit')} onChange={set('maxSizeGb')} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField label={t('series.prefer')} help={series ? t('series.preferHelp') : undefined} value={form.preferWords}
          placeholder={series ? 'SubsPlease, HEVC' : 'REMUX, HDR'} maxLength={200} onChange={set('preferWords')} />
        <TextField label={t('series.exclude')} help={series ? t('series.excludeHelp') : undefined} value={form.excludeWords}
          placeholder={series ? 'CAM, dubbed' : 'CAM, TS, dubbed'} maxLength={200} onChange={set('excludeWords')} />
      </div>
    </>
  )
}
