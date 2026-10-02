import { Download, Globe, Sparkles } from 'lucide-react'
import { cloud } from '../lib/cloudApi.ts'
import { useFormatDate, useT } from '../lib/i18n.tsx'
import { latestRelease } from '../lib/releases.ts'
import { BUILD } from '../lib/updates.ts'
import { BuildVersion } from '@codefusion-cc/app-update/react'
import { MAGNETAR_REPO } from '@magnetar/protocol/cloud'
import { Changelog } from '../ui/Changelog.tsx'
import { PageHeader, SettingGroup, SettingRow } from '../ui/controls.tsx'
import { CloudFrame } from './CloudFrame.tsx'
import { DownloadApp } from './DownloadApp.tsx'

/** `/about`: which build the website runs, the newest app with its downloads, and what every release brought. */
export function AboutPage() {
  const t = useT()
  const formatDate = useFormatDate()
  const latest = latestRelease.useLatest()
  return (
    <CloudFrame>
      <PageHeader title={t('about.title')} summary={t('about.subtitle')} />
      <div className="flex flex-col gap-5">
        <SettingGroup>
          <SettingRow layout="wide" title={t('about.website')} description={t('about.websiteHint')}>
            <span className="flex items-center gap-2 text-sm"><Globe size={16} className="muted" /><BuildVersion repo={MAGNETAR_REPO} className="tabular-nums" commitClassName="link link-hover font-mono" version={BUILD.version} commit={BUILD.commit} /></span>
          </SettingRow>
          <SettingRow layout="wide" title={t('about.latestApp')}
            description={latest ? (latest.publishedAt ? t('about.latestAppHint', latest.version, formatDate(latest.publishedAt)) : t('settings.version', latest.version))
              : latest === null ? t('releases.unavailable') : t('changelog.loading')}>
            <span className="flex items-center gap-2 text-sm"><Download size={16} className="muted" />{latest ? `v${latest.version}` : '—'}</span>
          </SettingRow>
        </SettingGroup>
        <SettingGroup title={t('about.download')}>
          <div className="pt-1"><DownloadApp /></div>
        </SettingGroup>
        <SettingGroup title={t('changelog.title')} description={t('changelog.hint')}
          action={<Sparkles size={18} className="text-primary" aria-hidden />}>
          <div className="pt-1"><Changelog load={cloud.releases} /></div>
        </SettingGroup>
      </div>
    </CloudFrame>
  )
}
