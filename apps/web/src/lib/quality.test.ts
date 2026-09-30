import { describe, expect, test } from 'vitest'
import { parseQuality, qualityForm } from './quality.ts'

const form = (overrides: Partial<ReturnType<typeof qualityForm>>) => ({ ...qualityForm(null), ...overrides })

describe('release rules in a form', () => {
  test('saved as typed: GB to MB, blank words to none, "any" resolution to null', () => {
    expect(parseQuality(form({ resolution: '2160p', minSeeders: '5', maxSizeGb: '1.5', preferWords: ' HDR ', excludeWords: '  ' })))
      .toEqual({ values: { resolution: '2160p', minSeeders: 5, maxSizeMb: 1536, preferWords: 'HDR', excludeWords: null }, invalid: false, sizeInvalid: false })
    expect(parseQuality(form({})).values).toEqual({ resolution: null, minSeeders: 1, maxSizeMb: null, preferWords: null, excludeWords: null })
  })

  test('a tiny size still keeps a 1 MB cap rather than none', () => {
    expect(parseQuality(form({ maxSizeGb: '0.0001' })).values.maxSizeMb).toBe(1)
  })

  test('refused: no seeders, fewer than one, and a size that is not positive', () => {
    for (const minSeeders of ['', '0', '-3', 'abc']) expect(parseQuality(form({ minSeeders })).invalid).toBe(true)
    for (const maxSizeGb of ['0', '-1', 'x']) expect(parseQuality(form({ maxSizeGb }))).toMatchObject({ invalid: true, sizeInvalid: true })
  })

  test('a stored rule comes back as it was', () => {
    const values = { resolution: '1080p' as const, minSeeders: 3, maxSizeMb: 4096, preferWords: 'SubsPlease', excludeWords: 'CAM' }
    expect(parseQuality(qualityForm(values)).values).toEqual(values)
  })
})
