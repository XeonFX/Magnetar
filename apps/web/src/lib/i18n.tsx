import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'

interface Catalog {
  name: string
  strings: Record<string, string>
}

const catalogs = Object.fromEntries(
  Object.entries(import.meta.glob<Catalog>('../i18n/*.json', { eager: true, import: 'default' }))
    .map(([path, catalog]) => [path.match(/([a-z]{2})\.json$/)![1]!, catalog]),
) as Record<string, Catalog>

export const LANGUAGES = Object.entries(catalogs).map(([code, catalog]) => ({ code, name: catalog.name }))
  .sort((a, b) => (a.code === 'en' ? -1 : b.code === 'en' ? 1 : a.name.localeCompare(b.name)))

export type Translate = (key: string, ...args: (string | number)[]) => string

function translator(language: string): Translate {
  const strings = catalogs[language]?.strings ?? {}
  const fallback = catalogs.en!.strings
  return (key, ...args) => {
    const template = strings[key] ?? fallback[key] ?? key
    return args.length ? template.replace(/\{(\d+)\}/g, (match, i: string) => String(args[Number(i)] ?? match)) : template
  }
}

/** The browser's language when a catalog exists for it, else English. */
export function browserLanguage(): string {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const code = tag.slice(0, 2).toLowerCase()
    if (catalogs[code]) return code
  }
  return 'en'
}

const I18nContext = createContext<{ language: string; t: Translate }>({ language: 'en', t: translator('en') })

export function I18nProvider({ language, children }: { language: string; children: ReactNode }) {
  const value = useMemo(() => ({ language, t: translator(catalogs[language] ? language : 'en') }), [language])
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
