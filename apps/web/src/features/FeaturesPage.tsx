/**
 * The features page, /features (in the browser's language) and /features/<language>: what Magnetar does, open to
 * everyone, with screenshots of the real app in the viewer's theme. The page is @codefusion-cc/features-page's;
 * the words are content/*.ts over outline.ts, the screenshots shots/ (apps/e2e/features/screenshots.ts).
 */
import '@codefusion-cc/features-page/styles.css'
import './features.css'
import { countFeatures, shotNames } from '@codefusion-cc/features-page'
import { FeatureCards, FeatureNames, FeaturesClosing, FeaturesHero, FeaturesPage as Page, shotUrls } from '@codefusion-cc/features-page/react'
import { useTheme } from '@codefusion-cc/theme/react'
import { ArrowRight, Download, Images, Languages, ListTree, LogIn, Moon, Search, Sparkles, Sun } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { useAccount } from '../cloud/CloudApp.tsx'
import { DownloadApp } from '../cloud/DownloadApp.tsx'
import { browserLanguage, I18nProvider, LANGUAGES, useT } from '../lib/i18n.tsx'
import { BrandMark } from '../ui/BrandMark.tsx'
import { Loading } from '../ui/Loading.tsx'
import { theme } from '../ui/theme.ts'
import { featureGroups, FEATURE_LANGUAGES, loadContent, loadedContent } from './content/index.ts'
import type { FeaturesContent } from './content/types.ts'
import { BUILT_ON, HERO_SHOTS, PRIVACY, SECTION_ICONS } from './outline.ts'
import SIZES from './shots.json'

const shotUrl = shotUrls(import.meta.glob<string>('./shots/*.webp', { eager: true, query: '?url', import: 'default' }))
const SOURCES = 6
const REPOSITORY = 'https://github.com/XeonFX/Magnetar'

/** The language the address names, else the browser's when the page is written in it, else English. */
function pageLanguage(param: string | undefined): string | null {
  if (param !== undefined) return FEATURE_LANGUAGES.includes(param) ? param : null
  const browser = browserLanguage()
  return FEATURE_LANGUAGES.includes(browser) ? browser : 'en'
}

export default function FeaturesRoute() {
  const { lang } = useParams()
  const language = pageLanguage(lang)
  const [content, setContent] = useState<{ language: string; content: FeaturesContent } | null>(() => {
    const ready = language ? loadedContent(language) : undefined
    return ready && language ? { language, content: ready } : null
  })

  useEffect(() => {
    if (!language || content?.language === language) return
    let cancelled = false
    void loadContent(language).then(loaded => { if (!cancelled) setContent({ language, content: loaded }) })
    return () => { cancelled = true }
  }, [language, content?.language])

  // An address in a language the page isn't written in: the one in the visitor's.
  if (!language) return <Navigate to="/features" replace />
  if (!content || content.language !== language) return <Loading screen />
  return (
    <I18nProvider language={language}>
      <Features language={language} content={content.content} />
    </I18nProvider>
  )
}

/** The tab, a shared link's preview and the document's language say what the page is, until it is left. */
function usePageMeta(language: string, meta: FeaturesContent['meta']) {
  useEffect(() => {
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]') ?? Object.assign(document.head.appendChild(document.createElement('meta')), { name: 'description' })
    const before = { title: document.title, lang: document.documentElement.lang, description: description.content }
    document.title = meta.title
    document.documentElement.lang = language
    description.content = meta.description
    return () => {
      document.title = before.title
      document.documentElement.lang = before.lang
      description.content = before.description
    }
  }, [language, meta])
}

function Features({ language, content }: { language: string; content: FeaturesContent }) {
  const mode = useTheme(theme).resolved
  const groups = useMemo(() => featureGroups(content), [content])
  usePageMeta(language, content.meta)

  const shots = useMemo(() => ({ sizes: SIZES, url: shotUrl, mode }), [mode])
  const figures = { features: countFeatures(groups), screenshots: new Set([...shotNames(groups), ...Object.values(HERO_SHOTS)]).size, sources: SOURCES, languages: LANGUAGES.length }
  const stats = [
    { value: figures.features, label: content.stats.features(figures.features), icon: Sparkles },
    { value: figures.screenshots, label: content.stats.screenshots(figures.screenshots), icon: Images },
    { value: figures.sources, label: content.stats.sources(figures.sources), icon: Search },
    { value: figures.languages, label: content.stats.languages(figures.languages), icon: Languages },
  ]

  return (
    <Page
      copy={content.copy}
      groups={groups}
      shots={shots}
      header={<Header language={language} content={content} />}
      hero={
        <FeaturesHero
          badge={content.hero.badge}
          title={<>{content.hero.title}<mark>{content.hero.accent}</mark></>}
          lead={content.hero.lead}
          actions={(
            <>
              <a href="#overview" className="btn btn-primary btn-lg"><ListTree size={20} aria-hidden />{content.hero.primary}</a>
              <a href="#get-app" className="btn btn-lg"><Download size={20} aria-hidden />{content.hero.secondary}</a>
            </>
          )}
          shots={HERO_SHOTS}
          stats={stats}
        />
      }
      sections={[
        {
          id: 'privacy',
          label: content.privacy.label,
          icon: SECTION_ICONS.privacy,
          title: content.privacy.title,
          lead: content.privacy.lead,
          children: <FeatureCards items={PRIVACY.map(item => ({ icon: item.icon, ...content.privacy.items[item.id] }))} />,
        },
        {
          id: 'built-on',
          label: content.builtOn.label,
          icon: SECTION_ICONS['built-on'],
          title: content.builtOn.title,
          lead: <>{content.builtOn.lead} <a className="link" href={REPOSITORY}>github.com/XeonFX/Magnetar</a></>,
          children: <FeatureNames items={BUILT_ON.map(id => content.builtOn.items[id])} />,
        },
      ]}
      closing={<Closing content={content} />}
      footer={<Footer />}
    />
  )
}

function Header({ language, content }: { language: string; content: FeaturesContent }) {
  const t = useT()
  const navigate = useNavigate()
  const { account } = useAccount()
  const { resolved } = useTheme(theme)
  const next = resolved === 'dark' ? 'light' : 'dark'
  return (
    <header className="sticky top-0 z-40 border-b border-base-300 bg-base-100/90 backdrop-blur">
      <div className="cf-fp-container flex h-14 items-center gap-2">
        <Link to="/" className="flex min-h-10 flex-1 items-center gap-2.5 rounded-field" aria-label={content.header.home}>
          <BrandMark />
          <span className="font-semibold tracking-tight">Magnetar</span>
        </Link>
        <label className="select select-sm w-auto">
          <Languages size={16} aria-hidden className="opacity-70" />
          <select value={language} aria-label={content.header.language} onChange={e => navigate(`/features/${e.target.value}`, { replace: true })}>
            {LANGUAGES.filter(l => FEATURE_LANGUAGES.includes(l.code)).map(l => <option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}
          </select>
        </label>
        <button type="button" className="btn btn-ghost btn-square btn-sm" onClick={theme.toggle} aria-label={t(`theme.${next}`)} title={t(`theme.${next}`)}>
          {resolved === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
        </button>
        <Link to={account ? '/' : '/login'} className="btn btn-primary btn-sm max-sm:btn-square" aria-label={account ? content.header.devices : content.header.signIn}>
          {account ? <ArrowRight size={16} aria-hidden /> : <LogIn size={16} aria-hidden />}
          <span className="max-sm:hidden">{account ? content.header.devices : content.header.signIn}</span>
        </Link>
      </div>
    </header>
  )
}

function Closing({ content }: { content: FeaturesContent }) {
  const { account } = useAccount()
  return (
    <FeaturesClosing
      id="get-app"
      title={content.closing.title}
      lead={content.closing.lead}
      actions={(
        <div className="flex w-full flex-col items-center gap-4">
          <div className="w-full max-w-md text-left"><DownloadApp /></div>
          <Link to={account ? '/' : '/login'} className="btn btn-ghost">
            {account ? content.header.devices : content.closing.signIn}<ArrowRight size={16} aria-hidden />
          </Link>
        </div>
      )}
    />
  )
}

function Footer() {
  return (
    <footer className="border-t border-base-300">
      <div className="cf-fp-container muted flex flex-wrap items-center justify-between gap-3 py-6 text-sm">
        <span>Magnetar · MIT</span>
        <a className="link link-hover" href={REPOSITORY}>GitHub</a>
      </div>
    </footer>
  )
}
