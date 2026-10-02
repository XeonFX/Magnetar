/**
 * The features page, /features (in the browser's language) and /features/<language>: what Magnetar does, open to
 * everyone, with screenshots of the real app in the viewer's theme. The page is @codefusion-cc/features-page's;
 * the words are content/*.ts over outline.ts, the screenshots shots/ (apps/e2e/features/screenshots.ts).
 */
import '@codefusion-cc/features-page/styles.css'
import './features.css'
import { countFeatures } from '@codefusion-cc/features-page'
import { applyDocumentLocale } from '@codefusion-cc/i18n/browser'
import { FeatureCards, FeatureNames, FeaturesClosing, FeaturesHero, FeaturesPage as Page, shotUrls } from '@codefusion-cc/features-page/react'
import { useTheme } from '@codefusion-cc/theme/react'
import { ArrowRight, Download, Globe, Images, Languages, ListTree, Lock, LogIn, Search, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { useAccount } from '../cloud/CloudApp.tsx'
import { ThemeToggle } from '../cloud/CloudFrame.tsx'
import { DownloadApp } from '../cloud/DownloadApp.tsx'
import { browserLanguage, I18nProvider, LANGUAGES } from '../lib/i18n.tsx'
import { BrandMark } from '../ui/BrandMark.tsx'
import { Loading } from '../ui/Loading.tsx'
import { theme } from '../ui/theme.ts'
import { featureGroups, FEATURE_LANGUAGES, loadContent, loadedContent } from './content/index.ts'
import type { FeaturesContent } from './content/types.ts'
import { BUILT_ON, HERO_SHOTS, PRIVACY } from './outline.ts'
import SIZES from './shots.json'

const shotUrl = shotUrls(import.meta.glob<string>('./shots/*.webp', { eager: true, query: '?url', import: 'default' }))
const SOURCES = 6
const REPOSITORY = 'https://github.com/XeonFX/Magnetar'

/** The language the address names (null for one the page isn't written in), else the browser's. */
function pageLanguage(param: string | undefined): string | null {
  if (param === undefined) return browserLanguage()
  return FEATURE_LANGUAGES.includes(param) ? param : null
}

export default function FeaturesRoute() {
  const { lang } = useParams()
  const language = pageLanguage(lang)
  // What the page shows for the language asked for: in it, or in English when it could not be loaded.
  const [shown, setShown] = useState<{ asked: string; language: string; content: FeaturesContent } | null>(() => {
    const ready = language ? loadedContent(language) : undefined
    return ready && language ? { asked: language, language, content: ready } : null
  })

  useEffect(() => {
    if (!language || shown?.asked === language) return
    let cancelled = false
    void loadContent(language).then(loaded => { if (!cancelled) setShown({ asked: language, ...loaded }) })
    return () => { cancelled = true }
  }, [language, shown?.asked])

  // An address in a language the page isn't written in: the one in the visitor's.
  if (!language) return <Navigate to="/features" replace />
  // Another language on its way: the page stays as it is (scroll, images) until its words arrive.
  if (!shown) return <Loading screen />
  return (
    <I18nProvider language={shown.language}>
      <Features language={shown.language} content={shown.content} />
    </I18nProvider>
  )
}

/** The tab, a shared link's preview and the document's language say what the page is, until it is left. */
function usePageMeta(language: string, meta: FeaturesContent['meta']) {
  useEffect(() => {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="description"]')
    const before = { lang: document.documentElement.lang, title: document.title, description: existing?.content }
    applyDocumentLocale({ lang: language, title: meta.title, description: meta.description })
    return () => {
      applyDocumentLocale({ lang: before.lang, title: before.title, description: before.description })
      // The description this page made goes with it.
      if (!existing) document.querySelector('meta[name="description"]')?.remove()
    }
  }, [language, meta])
}

function Features({ language, content }: { language: string; content: FeaturesContent }) {
  const mode = useTheme(theme).resolved
  const groups = useMemo(() => featureGroups(content), [content])
  usePageMeta(language, content.meta)

  const shots = useMemo(() => ({ sizes: SIZES, url: shotUrl, mode }), [mode])
  // Every shot in shots.json is on the page (features.test.ts).
  const stats = ([
    ['features', countFeatures(groups), Sparkles],
    ['screenshots', Object.keys(SIZES).length, Images],
    ['sources', SOURCES, Search],
    ['languages', LANGUAGES.length, Languages],
  ] as const).map(([key, value, icon]) => ({ value, label: content.stats[key](value), icon }))

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
          icon: Lock,
          title: content.privacy.title,
          lead: content.privacy.lead,
          children: <FeatureCards items={PRIVACY.map(item => ({ icon: item.icon, ...content.privacy.items[item.id] }))} />,
        },
        {
          id: 'built-on',
          label: content.builtOn.label,
          icon: Globe,
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

/** Where the page sends someone to use Magnetar: their devices when signed in, else sign-in. */
function useAccountLink(content: FeaturesContent) {
  const { account } = useAccount()
  return account ? { to: '/', label: content.header.devices, signedIn: true } : { to: '/login', label: content.header.signIn, signedIn: false }
}

function Header({ language, content }: { language: string; content: FeaturesContent }) {
  const navigate = useNavigate()
  const account = useAccountLink(content)
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
            {LANGUAGES.map(l => <option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}
          </select>
        </label>
        <ThemeToggle />
        <Link to={account.to} className="btn btn-primary btn-sm max-sm:btn-square" aria-label={account.label}>
          {account.signedIn ? <ArrowRight size={16} aria-hidden /> : <LogIn size={16} aria-hidden />}
          <span className="max-sm:hidden">{account.label}</span>
        </Link>
      </div>
    </header>
  )
}

function Closing({ content }: { content: FeaturesContent }) {
  const account = useAccountLink(content)
  return (
    <FeaturesClosing
      id="get-app"
      title={content.closing.title}
      lead={content.closing.lead}
      actions={(
        <div className="flex w-full flex-col items-center gap-4">
          <div className="w-full max-w-md text-left"><DownloadApp /></div>
          <Link to={account.to} className="btn btn-ghost">
            {account.signedIn ? account.label : content.closing.signIn}<ArrowRight size={16} aria-hidden />
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
