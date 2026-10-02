import type { ReleaseArch, ReleaseAssetDto, ReleasePlatform } from '@magnetar/protocol/cloud'
import { formatBytes } from '@magnetar/protocol/bytes'
import { Download, ExternalLink, Laptop, Monitor, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n.tsx'
import { useLatestRelease } from '../lib/releases.ts'
import { RELEASES_PAGE } from '../lib/updates.ts'

const ICONS = { macos: Laptop, windows: Monitor, linux: Terminal }
const NAMES: Record<ReleasePlatform, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' }

interface Visitor {
  platform: ReleasePlatform | null
  arch: ReleaseArch | null
}

/** The visitor's system, as far as the browser tells; Apple silicon unless a Mac says otherwise. */
async function detectVisitor(): Promise<Visitor> {
  const hints = (navigator as { userAgentData?: { getHighEntropyValues: (h: string[]) => Promise<{ platform?: string; architecture?: string }> } }).userAgentData
  const ua = navigator.userAgent
  let platform: ReleasePlatform | null = /Mac OS X|Macintosh/.test(ua) ? 'macos' : /Windows/.test(ua) ? 'windows' : /Linux|X11/.test(ua) && !/Android/.test(ua) ? 'linux' : null
  if (/iPhone|iPad|Android/.test(ua) || (platform === 'macos' && navigator.maxTouchPoints > 1)) platform = null
  let arch: ReleaseArch | null = /arm|aarch64/i.test(ua) ? 'arm64' : null
  if (hints) {
    try {
      const values = await hints.getHighEntropyValues(['architecture'])
      if (values.architecture) arch = values.architecture.startsWith('arm') ? 'arm64' : 'x64'
    } catch {
      // Not allowed here; keep the guess.
    }
  }
  if (!arch) arch = platform === 'macos' ? 'arm64' : 'x64'
  return { platform, arch }
}

const ARCH_NAMES: Record<ReleasePlatform, Record<ReleaseArch, string>> = {
  macos: { arm64: 'Apple silicon', x64: 'Intel' },
  windows: { arm64: 'ARM', x64: 'x64' },
  linux: { arm64: 'ARM64', x64: 'x64' },
}

/** One asset per system: the .zip for macOS rather than the bare executable. */
function pick(assets: ReleaseAssetDto[], platform: ReleasePlatform, arch: ReleaseArch): ReleaseAssetDto | undefined {
  const matching = assets.filter(a => a.platform === platform && a.arch === arch)
  return matching.find(a => a.name.endsWith('.zip')) ?? matching[0]
}

/**
 * Gets the app onto the visitor's computer: one button for their system, the others under it, and
 * what to do on first launch. Falls back to the releases page if GitHub can't be asked.
 */
export function DownloadApp() {
  const t = useT()
  const release = useLatestRelease()
  const [visitor, setVisitor] = useState<Visitor>({ platform: null, arch: null })
  useEffect(() => void detectVisitor().then(setVisitor), [])

  if (release === undefined) return <div className="flex justify-center py-6"><span className="loading loading-spinner text-primary" /></div>
  const main = release && visitor.platform && visitor.arch ? pick(release.assets, visitor.platform, visitor.arch) : undefined
  const others = release ? (['macos', 'windows', 'linux'] as const).flatMap(platform => (['arm64', 'x64'] as const).map(arch => ({ platform, arch, asset: pick(release.assets, platform, arch) })))
    .filter(o => o.asset && o.asset !== main) : []
  const Icon = visitor.platform ? ICONS[visitor.platform] : Download

  return (
    <div className="flex flex-col gap-4">
      {main && visitor.platform ? (
        <a className="btn btn-primary btn-lg justify-start gap-3" href={main.url}>
          <Icon size={20} />
          <span className="flex flex-col items-start leading-tight">
            <span>{t('get.for', NAMES[visitor.platform])}</span>
            <span className="text-xs font-normal opacity-80">{ARCH_NAMES[visitor.platform][main.arch]} · v{release!.version} · {formatBytes(main.size)}</span>
          </span>
        </a>
      ) : (
        <a className="btn btn-primary btn-lg" href={release?.pageUrl ?? RELEASES_PAGE} target="_blank" rel="noreferrer noopener">
          <Download size={20} />{release ? t('get.version', release.version) : t('devices.download')}
        </a>
      )}
      {visitor.platform && main && <p className="muted text-sm">{t(`get.first.${visitor.platform}`)}</p>}
      {!visitor.platform && release && <p className="muted text-sm">{t('get.onComputer')}</p>}
      {others.length > 0 && (
        <details className="text-sm">
          <summary className="link link-hover muted cursor-pointer">{t('get.others')}</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {others.map(({ platform, arch, asset }) => {
              const OtherIcon = ICONS[platform]
              return (
                <li key={asset!.name}>
                  <a className="flex items-center gap-2 rounded-field px-2 py-1.5 hover:bg-base-200" href={asset!.url}>
                    <OtherIcon size={16} className="muted" />
                    <span className="flex-1">{NAMES[platform]} · {ARCH_NAMES[platform][arch]}</span>
                    <span className="muted tabular-nums">{formatBytes(asset!.size)}</span>
                  </a>
                </li>
              )
            })}
            <li><a className="flex items-center gap-2 px-2 py-1.5 link link-hover" href={release?.pageUrl ?? RELEASES_PAGE} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} />{t('get.releaseNotes')}</a></li>
          </ul>
        </details>
      )}
    </div>
  )
}
