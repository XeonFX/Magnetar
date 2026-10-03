import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { MAX_CHECK_INTERVAL_MINUTES, MIN_WATCH_INTERVAL_MINUTES, SeriesTaskInput, SeriesTaskPatch, WatchInput } from './model.ts'

const accepts = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success

describe('check intervals', () => {
  const series = (checkIntervalMinutes: unknown) => ({ name: 'Show', query: 'Show', checkIntervalMinutes })

  test('a series rule checks every minute to once a week', () => {
    for (const minutes of [1, 60, 10_080]) {
      expect(accepts(SeriesTaskInput, series(minutes)), `${minutes}`).toBe(true)
      expect(accepts(SeriesTaskPatch, { checkIntervalMinutes: minutes }), `${minutes}`).toBe(true)
    }
    for (const minutes of [0, -1, 10_081, 1e15, Number.MAX_SAFE_INTEGER, 1.5, Number.NaN, Infinity, '60']) {
      expect(accepts(SeriesTaskInput, series(minutes)), `${minutes}`).toBe(false)
      expect(accepts(SeriesTaskPatch, { checkIntervalMinutes: minutes }), `${minutes}`).toBe(false)
    }
    expect(SeriesTaskInput.parse({ name: 'Show', query: 'Show' }).checkIntervalMinutes).toBe(60)
  })

  test('a watch checks every fifteen minutes to once a week', () => {
    for (const minutes of [15, 10_080]) expect(accepts(WatchInput, { query: 'Show', checkIntervalMinutes: minutes })).toBe(true)
    for (const minutes of [14, 10_081, 1e15]) expect(accepts(WatchInput, { query: 'Show', checkIntervalMinutes: minutes })).toBe(false)
  })

  test('the limits are the app’s own', () => {
    const rust = readFileSync(new URL('../../../apps/client/src/protocol/model.rs', import.meta.url), 'utf8')
    const constant = (name: string) => Number(new RegExp(`pub const ${name}: i64 = ([0-9_]+);`).exec(rust)?.[1]?.replaceAll('_', ''))
    expect(constant('MAX_CHECK_INTERVAL_MINUTES')).toBe(MAX_CHECK_INTERVAL_MINUTES)
    expect(constant('MIN_WATCH_INTERVAL_MINUTES')).toBe(MIN_WATCH_INTERVAL_MINUTES)
  })
})
