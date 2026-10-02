import { featuresProblems, outlineProblems } from '@codefusion-cc/features-page/testing'
import { describe, expect, test } from 'vitest'
import { LANGUAGES } from '../lib/languages.ts'
import { featureGroups, FEATURE_LANGUAGES, loadContent } from './content/index.ts'
import type { FeaturesContent } from './content/types.ts'
import { HERO_SHOTS } from './outline.ts'
import SIZES from './shots.json'

const FILES = Object.keys(import.meta.glob('./shots/*.webp'))
/** The page's own anchors besides the features: the header, the overview, its sections and the closing card. */
const SECTIONS = ['top', 'overview', 'privacy', 'built-on', 'get-app']

const contents = Object.fromEntries(await Promise.all(FEATURE_LANGUAGES.map(async code => [code, (await loadContent(code)).content] as const))) as Record<string, FeaturesContent>
const { en } = contents

/** Every string in the content, with where it is, functions called with a few numbers. */
function strings(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]]
  if (typeof value === 'function') return [1, 2, 5].flatMap(n => strings(value(n, 3), `${path}(${n})`))
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${path}[${index}]`))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => strings(item, path ? `${path}.${key}` : key))
  return []
}

describe('the features page', () => {
  test('is written in every language the dashboard has', () => {
    expect([...FEATURE_LANGUAGES].sort()).toEqual(LANGUAGES.map(language => language.code).sort())
  })

  test.each(FEATURE_LANGUAGES)('has every screenshot it shows, in both themes, and something to say of each feature (%s)', code => {
    expect(featuresProblems({ groups: featureGroups(contents[code]!), sizes: SIZES, files: FILES, sections: SECTIONS, extraShots: Object.values(HERO_SHOTS) })).toEqual([])
  })

  test.each(FEATURE_LANGUAGES.filter(code => code !== 'en'))('says in %s what it says in English, point for point', code => {
    expect(outlineProblems(featureGroups(en!), featureGroups(contents[code]!))).toEqual([])
    const blank = strings(contents[code]).filter(([, text]) => !text.trim())
    expect(blank).toEqual([])
    // A translation, not English left in place: product names aside, the titles differ.
    const titles = (content: FeaturesContent) => featureGroups(content).flatMap(group => group.features.map(feature => feature.title))
    const same = titles(contents[code]!).filter((title, index) => title === titles(en!)[index])
    expect(same).toEqual([])
  })

  test('counts features the way each language counts', () => {
    const count = (code: string) => contents[code]!.copy.overview.count
    expect([1, 2, 5].map(count('en'))).toEqual(['1 feature', '2 features', '5 features'])
    for (const code of FEATURE_LANGUAGES) {
      for (const n of [1, 2, 4, 5, 12, 21, 22, 25]) expect(count(code)(n), `${code} ${n}`).toMatch(new RegExp(`^${n}\\D`))
    }
    expect([1, 2, 4, 5, 12, 13, 22, 25].map(count('pl'))).toEqual(['1 funkcja', '2 funkcje', '4 funkcje', '5 funkcji', '12 funkcji', '13 funkcji', '22 funkcje', '25 funkcji'])
    expect([1, 2, 5, 11, 21, 22].map(count('ru'))).toEqual(['1 функция', '2 функции', '5 функций', '11 функций', '21 функция', '22 функции'])
    // The header's figures take the same forms.
    expect([1, 2, 5, 22, 25].map(n => contents.pl!.stats.features(n))).toEqual(['funkcja', 'funkcje', 'funkcji', 'funkcje', 'funkcji'])
    expect([1, 3, 8, 21].map(n => contents.ru!.stats.languages(n))).toEqual(['язык', 'языка', 'языков', 'язык'])
    expect([1, 24].map(n => en!.stats.features(n))).toEqual(['feature', 'features'])
  })

  test.each(FEATURE_LANGUAGES)('loads %s as itself, not as English', async code => {
    expect((await loadContent(code)).language).toBe(code)
  })

  test('falls back to English for a language it has no words in', async () => {
    expect(await loadContent('xx')).toEqual({ language: 'en', content: en })
  })
})
