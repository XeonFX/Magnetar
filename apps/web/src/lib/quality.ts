import type { SeriesResolution } from '@magnetar/protocol'

export const resolutionLabel = (r: SeriesResolution | null) => (r === '2160p' ? '4K' : r)

/** The release rules series tasks and watches share, as a form edits them. */
export interface QualityForm {
  resolution: SeriesResolution | ''
  minSeeders: string
  maxSizeGb: string
  preferWords: string
  excludeWords: string
}

export interface QualityValues {
  resolution: SeriesResolution | null
  minSeeders: number
  maxSizeMb: number | null
  preferWords: string | null
  excludeWords: string | null
}

export function qualityForm(values: Partial<QualityValues> | null): QualityForm {
  return {
    resolution: values?.resolution ?? '',
    minSeeders: String(values?.minSeeders ?? 1),
    maxSizeGb: values?.maxSizeMb == null ? '' : String(Math.round((values.maxSizeMb / 1024) * 10) / 10),
    preferWords: values?.preferWords ?? '',
    excludeWords: values?.excludeWords ?? '',
  }
}

/** The form's rules as saved, and what is wrong with them. */
export function parseQuality(form: QualityForm): { values: QualityValues; invalid: boolean; sizeInvalid: boolean } {
  const seeders = form.minSeeders.trim() === '' ? NaN : Math.trunc(Number(form.minSeeders))
  const maxSize = form.maxSizeGb.trim() === '' ? null : Number(form.maxSizeGb)
  const sizeInvalid = maxSize !== null && !(maxSize > 0)
  return {
    values: {
      resolution: form.resolution || null,
      minSeeders: Math.max(1, Number.isFinite(seeders) ? seeders : 1),
      maxSizeMb: maxSize === null || sizeInvalid ? null : Math.max(1, Math.round(maxSize * 1024)),
      preferWords: form.preferWords.trim() || null,
      excludeWords: form.excludeWords.trim() || null,
    },
    invalid: !(seeders >= 1) || sizeInvalid,
    sizeInvalid,
  }
}
