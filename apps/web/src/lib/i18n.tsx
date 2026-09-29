import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import english from '../i18n/en.json'
import { LANGUAGES } from './languages.ts'

interface Catalog {
  name: string
  strings: Record<string, string>
}

export { LANGUAGES }

const loaders = Object.fromEntries(
  Object.entries(import.meta.glob<Catalog>(['../i18n/*.json', '!../i18n/en.json'], { import: 'default' }))
    .map(([path, load]) => [path.match(/([a-z]{2})\.json$/)![1]!, load]),
) as Record<string, () => Promise<Catalog>>

const loaded: Record<string, Record<string, string>> = { en: english.strings }

export type Translate = (key: string, ...args: (string | number)[]) => string

function translator(strings: Record<string, string>): Translate {
  const fallback = english.strings as Record<string, string>
  return (key, ...args) => {
    const template = strings[key] ?? fallback[key] ?? key
    return args.length ? template.replace(/\{(\d+)\}/g, (match, i: string) => String(args[Number(i)] ?? match)) : template
  }
}

/** The browser's language when a catalog exists for it, else English. */
export function browserLanguage(): string {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const code = tag.slice(0, 2).toLowerCase()
    if (LANGUAGES.some(l => l.code === code)) return code
  }
  return 'en'
}

const I18nContext = createContext<{ language: string; t: Translate }>({ language: 'en', t: translator(english.strings) })

/**
 * Translations for `language`. A language not loaded yet is fetched first; the page waits for it
 * rather than flashing English, and shows English if it can't be loaded.
 */
export function I18nProvider({ language, children }: { language: string; children: ReactNode }) {
  const code = loaders[language] || language === 'en' ? language : 'en'
  const [strings, setStrings] = useState(() => loaded[code] ?? null)
  useEffect(() => {
    if (loaded[code]) return setStrings(loaded[code])
    let cancelled = false
    loaders[code]!().then(catalog => { loaded[code] = catalog.strings }, () => { loaded[code] = english.strings })
      .finally(() => { if (!cancelled) setStrings(loaded[code]!) })
    return () => { cancelled = true }
  }, [code])
  const value = useMemo(() => ({ language: code, t: translator(strings ?? english.strings) }), [code, strings])
  if (!strings) {
    return <div className="grid min-h-screen place-items-center"><span className="loading loading-spinner loading-lg text-primary" /></div>
  }
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useT(): Translate {
  return useContext(I18nContext).t
}

export function useLanguage(): string {
  return useContext(I18nContext).language
}

/** Locale-aware date formatting that follows the dashboard language. */
export function useFormatDate(): (iso: string | null, withTime?: boolean) => string {
  const language = useLanguage()
  return useCallback((iso, withTime = false) => {
    if (!iso) return '—'
    const date = new Date(iso)
    return withTime
      ? date.toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })
      : date.toLocaleDateString(language, { year: 'numeric', month: '2-digit', day: '2-digit' })
  }, [language])
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12], ['year', Infinity]]

function relative(format: Intl.RelativeTimeFormat, seconds: number): string {
  let value = seconds
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit)
    value /= size
  }
  return ''
}

/** "3 yr. ago", "in 5 min." — in the dashboard language. */
export function useFormatRelative(): (iso: string | null) => string {
  const language = useLanguage()
  return useCallback((iso: string | null) => {
    if (!iso) return '—'
    const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' })
    return relative(format, (new Date(iso).getTime() - Date.now()) / 1000)
  }, [language])
}

/** Time left, as "in 4 min." — from now plus `seconds`. */
export function useFormatEta(): (seconds: number) => string {
  const language = useLanguage()
  return useCallback((seconds: number) => {
    const format = new Intl.RelativeTimeFormat(language, { numeric: 'always', style: 'short' })
    return relative(format, Math.max(1, seconds))
  }, [language])
}
