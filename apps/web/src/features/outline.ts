/**
 * The features page's outline, the same in every language: its groups and features (their anchors and icons),
 * the shots each one shows, and the cards of its own sections. Each language (content/*.ts) gives the words for
 * exactly these, so TypeScript finds a feature, shot or card a translation misses.
 *
 * A new feature people can see gets an entry here and its words in every language; `npm run screenshots -w
 * @magnetar/e2e` takes its shots (apps/e2e/features/screenshots.ts). What the page says must match the code.
 */
import {
  Activity, AppWindow, AtSign, Bell, BellRing, Bot, CalendarClock, ChartNoAxesColumn, Download, EyeOff, Gauge, Globe, House,
  Import, Laptop, Link2, ListChecks, Lock, Magnet, MonitorSmartphone, PanelTop, Play, QrCode, Radar, RefreshCw, Search,
  ShieldCheck, SlidersHorizontal, Unplug, Languages, type LucideIcon,
} from 'lucide-react'
import type SIZES from './shots.json'

export type ShotName = keyof typeof SIZES

/** The shots beside the header: the dashboard on a computer and on a phone. */
export const HERO_SHOTS = { desktop: 'downloads', phone: 'remote-phone' } as const satisfies Record<string, ShotName>

export const OUTLINE = [
  {
    id: 'find',
    icon: Search,
    features: [
      { id: 'sources', icon: Search, shots: ['search', 'search-phone', 'search-sources'] },
      { id: 'addresses', icon: Link2, shots: [] },
      { id: 'add', icon: Magnet, shots: ['add'] },
      { id: 'series', icon: CalendarClock, shots: ['watchlist'] },
      { id: 'watches', icon: Radar, shots: ['watches'] },
    ],
  },
  {
    id: 'download',
    icon: Download,
    features: [
      { id: 'engine', icon: Gauge, shots: ['downloads'] },
      { id: 'files', icon: ListChecks, shots: ['details'] },
      { id: 'play', icon: Play, shots: ['player'] },
      { id: 'speed', icon: SlidersHorizontal, shots: ['speed'] },
      { id: 'kill-switch', icon: Unplug, shots: [] },
    ],
  },
  {
    id: 'anywhere',
    icon: Globe,
    features: [
      { id: 'website', icon: MonitorSmartphone, shots: ['devices', 'remote-phone'] },
      { id: 'pairing', icon: Link2, shots: ['remote', 'pair'] },
      { id: 'phone', icon: QrCode, shots: ['link-qr'] },
      { id: 'device-addresses', icon: AtSign, shots: ['switcher'] },
      { id: 'install', icon: AppWindow, shots: [] },
    ],
  },
  {
    id: 'notify',
    icon: Bell,
    features: [
      { id: 'channels', icon: Bell, shots: ['notifications'] },
      { id: 'push', icon: BellRing, shots: [] },
    ],
  },
  {
    id: 'app',
    icon: Laptop,
    features: [
      { id: 'desktop', icon: Laptop, shots: ['settings'] },
      { id: 'tray', icon: PanelTop, shots: [] },
      { id: 'updates', icon: RefreshCw, shots: ['about'] },
      { id: 'agents', icon: Bot, shots: ['agents'] },
      { id: 'reports', icon: Activity, shots: [] },
      { id: 'import', icon: Import, shots: [] },
      { id: 'languages', icon: Languages, shots: [] },
    ],
  },
] as const satisfies readonly { id: string; icon: LucideIcon; features: readonly { id: string; icon: LucideIcon; shots: readonly ShotName[] }[] }[]

/** The privacy section's cards. */
export const PRIVACY = [
  { id: 'e2e', icon: ShieldCheck },
  { id: 'worker', icon: EyeOff },
  { id: 'sealed', icon: Lock },
  { id: 'visits', icon: ChartNoAxesColumn },
  { id: 'local', icon: House },
] as const satisfies readonly { id: string; icon: LucideIcon }[]

/** What Magnetar is built on, one row each. */
export const BUILT_ON = ['client', 'engine', 'dashboard', 'worker', 'packages', 'console', 'releases'] as const

export type GroupId = (typeof OUTLINE)[number]['id']
type GroupOf<G extends GroupId> = Extract<(typeof OUTLINE)[number], { id: G }>
export type FeatureIdOf<G extends GroupId> = GroupOf<G>['features'][number]['id']
/** Every shot a feature shows, each once. */
export type FeatureShot = (typeof OUTLINE)[number]['features'][number]['shots'][number]
