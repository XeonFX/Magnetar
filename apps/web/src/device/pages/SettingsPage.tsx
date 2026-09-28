import type { AgentStatusDto, LegacyImportStatusDto, LoginStartupStatus, SettingsDto, SettingsPatch } from '@md/protocol'
import {
  Bell, Bot, Copy, Eye, EyeOff, HardDriveDownload, Mail, RefreshCw, Send, Server, Smartphone, SlidersHorizontal, Upload,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { LANGUAGES, useFormatDate, useT } from '../../lib/i18n.tsx'
import { ConfirmDialog } from '../../ui/Modal.tsx'
import { blurOnEnter, Field, SaveOnBlurInput } from '../../ui/fields.tsx'
import { useCopy, useToast } from '../../ui/toast.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { PageHeader } from '../Shell.tsx'
import { FolderField } from '../components/folders.tsx'
import { RemoteAccessSection } from '../components/remoteAccess.tsx'
import { useRun } from '../useRun.ts'

export function SettingsPage() {
  const t = useT()
  const { settings } = useDevice()
  if (!settings) return <progress className="progress progress-primary w-full" />
  return (
    <>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <div className="flex flex-col gap-4">
        <GeneralSection settings={settings} />
        <RemoteAccessSection />
        <AgentSection />
        <SourcesSection settings={settings} />
        <NotificationSections settings={settings} />
        <ImportSection />
        <AboutSection />
      </div>
    </>
  )
}

export function Section({ icon, title, toggle, children, hint }: { icon: ReactNode; title: string; toggle?: ReactNode; hint?: string; children?: ReactNode }) {
  return (
    <section className="surface p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="text-primary">{icon}</span>
        <h2 className="flex-1 text-lg font-semibold">{title}</h2>
        {toggle}
      </div>
      {hint && <p className="mt-2 text-sm text-base-content/60">{hint}</p>}
      {children && <div className="mt-4">{children}</div>}
    </section>
  )
}

function useSave() {
  const { connection } = useDevice()
  const run = useRun()
  return (patch: SettingsPatch) => void run(() => connection.call('settings.update', patch), 'settings.saveFailed')
}

/** `hideLabel` for switches in a section header, where the title already says what they do. */
function Toggle({ label, checked, onChange, disabled = false, tone = 'toggle-primary', hideLabel = false }: { label?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; tone?: string; hideLabel?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center gap-3">
      <input type="checkbox" className={`toggle ${tone}`} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} aria-label={label} />
      {label && !hideLabel && <span className="text-sm">{label}</span>}
    </label>
  )
}

function TextSetting({ label, value, onSave, type = 'text', help, className = '' }: { label: string; value: string; onSave: (value: string) => void; type?: string; help?: string; className?: string }) {
  return <Field label={label} help={help} className={className}><SaveOnBlurInput type={type} placeholder={label} value={value} onSave={onSave} /></Field>
}

/** Write-only secret: shows whether one is saved, never its value. */
function SecretSetting({ label, isSet, onSave, help, className = '' }: { label: string; isSet: boolean; onSave: (value: string) => void; help?: string; className?: string }) {
  const t = useT()
  const [draft, setDraft] = useState('')
  return (
    <div className={className}>
      <div className="join w-full">
        <label className="floating-label join-item w-full">
          <span>{label}</span>
          <input type="password" autoComplete="new-password" className="input w-full" value={draft}
            placeholder={isSet ? t('settings.secretSaved') : label} onChange={e => setDraft(e.target.value)}
            onBlur={() => { if (draft) { onSave(draft); setDraft('') } }}
            onKeyDown={blurOnEnter} />
        </label>
        {isSet && <button type="button" className="btn join-item" onClick={() => onSave('')}>{t('settings.secretClear')}</button>}
      </div>
      {help && <p className="mt-1 text-xs text-base-content/60">{help}</p>}
    </div>
  )
}

function GeneralSection({ settings }: { settings: SettingsDto }) {
  const t = useT()
  const save = useSave()
  const run = useRun()
  const { connection } = useDevice()
  const [startup, setStartup] = useState<LoginStartupStatus | null>(null)
  const [changing, setChanging] = useState(false)
  useEffect(() => {
    void connection.call('startup.status').then(r => setStartup(r.status)).catch(() => setStartup('unavailable'))
  }, [connection])

  const changeStartup = async (enabled: boolean) => {
    setChanging(true)
    const result = await run(() => connection.call('startup.set', { enabled }), 'settings.startupFailed')
    if (result) setStartup(result.status)
    setChanging(false)
  }

  return (
    <Section icon={<SlidersHorizontal size={20} />} title={t('settings.general')}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
        <div className="sm:col-span-6">
          <Toggle label={t('settings.startWithMac')} checked={startup === 'enabled' || startup === 'requiresApproval'}
            disabled={changing || startup === 'unavailable' || startup === null} onChange={v => void changeStartup(v)} />
          <p className="mt-1 text-xs text-base-content/60">{t(startup === 'unavailable' ? 'settings.startupUnavailable' : 'settings.startupHint')}</p>
          {startup === 'requiresApproval' && <div role="alert" className="alert alert-warning alert-soft mt-2 text-sm">{t('settings.startupApproval')}</div>}
          {startup !== 'unavailable' && startup !== null && (
            <button type="button" className="btn btn-ghost btn-xs mt-1" disabled={changing}
              onClick={() => void connection.call('startup.status').then(r => setStartup(r.status)).catch(() => {})}>{t('settings.startupRefresh')}</button>
          )}
        </div>
        <div className="sm:col-span-4">
          <FolderField label={t('settings.downloadFolder')} value={settings.downloadFolder} onChange={downloadFolder => downloadFolder.trim() && save({ downloadFolder })} />
        </div>
        <label className="floating-label sm:col-span-2">
          <span>{t('settings.language')}</span>
          <select className="select w-full" value={settings.language} onChange={e => save({ language: e.target.value })}>
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-6 sm:col-span-6">
          <Toggle label={t('settings.notifyStart')} checked={settings.notifyOnStart} onChange={notifyOnStart => save({ notifyOnStart })} />
          <Toggle label={t('settings.notifyFinish')} checked={settings.notifyOnComplete} onChange={notifyOnComplete => save({ notifyOnComplete })} />
        </div>
        <div className="sm:col-span-3">
          <label className="floating-label block">
            <span>{t('settings.postDownload')}</span>
            <select className="select w-full" value={settings.postDownloadAction}
              onChange={e => save({ postDownloadAction: e.target.value as SettingsDto['postDownloadAction'] })}>
              <option value="StopSeeding">{t('settings.stopSeeding')}</option>
              <option value="KeepSeeding">{t('settings.keepSeeding')}</option>
            </select>
          </label>
          <p className="mt-1 text-xs text-base-content/60">{t(settings.postDownloadAction === 'KeepSeeding' ? 'settings.keepSeedingHelp' : 'settings.stopSeedingHelp')}</p>
        </div>
        <div className="sm:col-span-6">
          <Toggle label={t('settings.errorReports')} checked={settings.errorReportsEnabled} onChange={errorReportsEnabled => save({ errorReportsEnabled })} />
          <p className="mt-1 text-xs text-base-content/60">{t('settings.errorReportsHint')}</p>
        </div>
      </div>
    </Section>
  )
}

function AgentSection() {
  const t = useT()
  const toast = useToast()
  const run = useRun()
  const { connection } = useDevice()
  const copy = useCopy(t('settings.agentCopied'))
  const [agent, setAgent] = useState<AgentStatusDto | null>(null)
  const [reveal, setReveal] = useState(false)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    void connection.call('agent.status').then(setAgent).catch(() => {})
  }, [connection])
  if (!agent) return null

  const change = async (patch: { enabled?: boolean; allowRemote?: boolean }) => {
    const next = await run(() => connection.call('agent.set', patch), 'settings.saveFailed')
    if (next) setAgent(next)
    if (next && patch.allowRemote !== undefined) toast(t('settings.agentRestart'), 'info')
  }
  const command = `claude mcp add --transport http mediadownloader ${agent.mcpUrl}`

  return (
    <Section icon={<Bot size={20} />} title={t('settings.agentAccess')} hint={t('settings.agentHint')}
      toggle={<Toggle hideLabel label={t('settings.agentAccess')} checked={agent.enabled} onChange={enabled => void change({ enabled })} />}>
      {agent.enabled && (
        <div className="flex flex-col gap-4">
          <div role="alert" className="alert alert-info alert-outline text-sm">{t('settings.agentLoopbackHint')}</div>
          <div>
            <Toggle tone="toggle-warning" label={t('settings.agentRemote')} checked={agent.allowRemote} onChange={allowRemote => void change({ allowRemote })} />
            <p className="mt-1 text-xs text-base-content/60">{t('settings.agentRemoteHint')}</p>
          </div>
          <div className="join w-full">
            <label className="floating-label join-item w-full">
              <span>{t('settings.agentToken')}</span>
              <input readOnly className="input w-full font-mono text-sm" type={reveal ? 'text' : 'password'} value={agent.token} />
            </label>
            <button type="button" className="btn join-item" title={t('settings.agentReveal')} aria-label={t('settings.agentReveal')} onClick={() => setReveal(r => !r)}>{reveal ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            <button type="button" className="btn join-item" title={t('settings.agentCopy')} aria-label={t('settings.agentCopy')} onClick={() => void copy(agent.token)}><Copy size={16} /></button>
            <button type="button" className="btn btn-warning join-item" title={t('settings.agentRegenerate')} aria-label={t('settings.agentRegenerate')} onClick={() => setConfirming(true)}><RefreshCw size={16} /></button>
          </div>
          <CopyField label={t('settings.agentMcpUrl')} value={agent.mcpUrl} onCopy={copy} />
          <CopyField label={t('settings.agentClaudeCommand')} value={command} onCopy={copy} />
          <p className="break-release text-xs text-base-content/60">{t('settings.agentEndpointFile', agent.endpointFile)}</p>
        </div>
      )}
      <ConfirmDialog open={confirming} title={t('settings.agentRegenerateConfirmTitle')} message={t('settings.agentRegenerateConfirm')}
        options={[{ label: t('common.cancel'), value: false, tone: 'ghost' }, { label: t('settings.agentRegenerate'), value: true, tone: 'error' }]}
        onResult={async confirmed => {
          setConfirming(false)
          if (!confirmed) return
          const next = await run(() => connection.call('agent.regenerateToken'))
          if (next) {
            setAgent(next)
            toast(t('settings.agentRegenerated'), 'success')
          }
        }} />
    </Section>
  )
}

function CopyField({ label, value, onCopy }: { label: string; value: string; onCopy: (value: string) => void }) {
  return (
    <div className="join w-full">
      <label className="floating-label join-item w-full">
        <span>{label}</span>
        <input readOnly className="input w-full font-mono text-sm" value={value} />
      </label>
      <button type="button" className="btn join-item" aria-label={label} onClick={() => onCopy(value)}><Copy size={16} /></button>
    </div>
  )
}

function SourcesSection({ settings }: { settings: SettingsDto }) {
  const t = useT()
  const save = useSave()
  const { sources } = useDevice()
  const toggle = (name: string, enabled: boolean) => {
    const disabled = new Set(settings.disabledProviders.map(p => p.toLowerCase()))
    if (enabled) disabled.delete(name.toLowerCase())
    else disabled.add(name.toLowerCase())
    save({ disabledProviders: sources.map(s => s.name).filter(n => disabled.has(n.toLowerCase())) })
  }
  return (
    <Section icon={<Server size={20} />} title={t('settings.sources')} hint={t('settings.sourcesHint')}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {sources.map(s => <Toggle key={s.name} label={s.name} checked={s.enabled} onChange={v => toggle(s.name, v)} />)}
      </div>
    </Section>
  )
}

function NotificationSections({ settings: s }: { settings: SettingsDto }) {
  const t = useT()
  const save = useSave()
  const toast = useToast()
  const run = useRun()
  const { connection } = useDevice()
  const [testing, setTesting] = useState(false)
  const test = async () => {
    setTesting(true)
    const ok = await run(async () => { await connection.call('notifications.test'); return true }, 'settings.testFailed')
    setTesting(false)
    if (ok) toast(t('settings.testSent'), 'success')
  }

  return (
    <>
      <Section icon={<Bell size={20} />} title={t('settings.desktop')} hint={t('settings.desktopHint')}
        toggle={<Toggle hideLabel label={t('settings.desktop')} checked={s.desktopEnabled} onChange={desktopEnabled => save({ desktopEnabled })} />} />
      <Section icon={<Mail size={20} />} title={t('settings.email')}
        toggle={<Toggle hideLabel label={t('settings.email')} checked={s.emailEnabled} onChange={emailEnabled => save({ emailEnabled })} />}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
          <TextSetting className="sm:col-span-5" label={t('settings.smtpHost')} value={s.smtpHost} onSave={smtpHost => save({ smtpHost })} />
          <TextSetting className="sm:col-span-2" type="number" label={t('settings.port')} value={String(s.smtpPort)}
            onSave={v => { const port = Number(v); if (port >= 1 && port <= 65535) save({ smtpPort: port }) }} />
          <div className="flex items-center sm:col-span-2"><Toggle label={t('settings.ssl')} checked={s.smtpUseSsl} onChange={smtpUseSsl => save({ smtpUseSsl })} /></div>
          <TextSetting className="sm:col-span-3" label={t('settings.username')} value={s.smtpUsername} onSave={smtpUsername => save({ smtpUsername })} />
          <SecretSetting className="sm:col-span-4" label={t('settings.password')} isSet={s.smtpPasswordSet} onSave={smtpPassword => save({ smtpPassword })} />
          <TextSetting className="sm:col-span-4" type="email" label={t('settings.from')} value={s.emailFrom} onSave={emailFrom => save({ emailFrom: emailFrom.trim() })} />
          <TextSetting className="sm:col-span-4" type="email" label={t('settings.to')} value={s.emailTo} onSave={emailTo => save({ emailTo: emailTo.trim() })} />
        </div>
      </Section>
      <Section icon={<Smartphone size={20} />} title={t('settings.push')}
        toggle={<Toggle hideLabel label={t('settings.push')} checked={s.pushEnabled} onChange={pushEnabled => save({ pushEnabled })} />}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextSetting label={t('settings.ntfyServer')} value={s.ntfyServer} onSave={ntfyServer => save({ ntfyServer: ntfyServer.trim() })} />
          <TextSetting label={t('settings.topic')} help={t('settings.topicHint')} value={s.ntfyTopic} onSave={ntfyTopic => save({ ntfyTopic })} />
        </div>
      </Section>
      <Section icon={<Send size={20} />} title={t('settings.telegram')}
        toggle={<Toggle hideLabel label={t('settings.telegram')} checked={s.telegramEnabled} onChange={telegramEnabled => save({ telegramEnabled })} />}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SecretSetting label={t('settings.botToken')} help={t('settings.botTokenHint')} isSet={s.telegramBotTokenSet} onSave={telegramBotToken => save({ telegramBotToken })} />
          <TextSetting label={t('settings.chatId')} help={t('settings.chatIdHint')} value={s.telegramChatId} onSave={telegramChatId => save({ telegramChatId })} />
        </div>
      </Section>
      <div>
        <button type="button" className="btn btn-primary" disabled={testing} onClick={() => void test()}>
          {testing ? <span className="loading loading-spinner loading-sm" /> : <Bell size={16} />}{t('settings.sendTest')}
        </button>
      </div>
    </>
  )
}

function ImportSection() {
  const t = useT()
  const toast = useToast()
  const run = useRun()
  const { connection } = useDevice()
  const [status, setStatus] = useState<LegacyImportStatusDto | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void connection.call('legacy.status').then(setStatus).catch(() => {})
  }, [connection])
  if (!status?.available) return null

  const runImport = async () => {
    setBusy(true)
    const result = await run(() => connection.call('legacy.import'), 'import.failed')
    setBusy(false)
    if (!result) return
    toast(t('import.done', result.downloads, result.seriesTasks), 'success')
    if (result.secretsToReenter.length) toast(t('import.reenter', result.secretsToReenter.join(', ')), 'info')
    setStatus(await connection.call('legacy.status'))
  }

  return (
    <Section icon={<HardDriveDownload size={20} />} title={t('import.title')} hint={t('import.hint', status.downloads, status.seriesTasks)}>
      {status.imported && <p className="mb-3 text-sm text-success">{t('import.alreadyImported')}</p>}
      <button type="button" className="btn btn-outline btn-primary" disabled={busy} onClick={() => void runImport()}>
        {busy ? <span className="loading loading-spinner loading-sm" /> : <Upload size={16} />}{t('import.button')}
      </button>
    </Section>
  )
}

function AboutSection() {
  const t = useT()
  const toast = useToast()
  const run = useRun()
  const formatDate = useFormatDate()
  const { connection, updates, info } = useDevice()
  if (!updates) return null

  const check = async () => {
    const status = await run(() => connection.call('updates.check'))
    if (!status) return
    if (status.available) toast(t('settings.updateSnack', status.available.tag), 'info')
    else if (status.lastCheckError) toast(t('settings.lastCheckFailed', status.lastCheckError), 'error')
    else toast(t('settings.upToDate', status.currentVersion), 'success')
  }
  const statusText = updates.checking ? t('settings.checking')
    : updates.lastCheckError ? t('settings.lastCheckFailed', updates.lastCheckError)
    : updates.available ? ''
    : updates.lastCheckedAt ? t('settings.checkedAt', formatDate(updates.lastCheckedAt, true))
    : t('settings.checkAuto')

  return (
    <Section icon={<RefreshCw size={20} />} title={t('settings.about')}
      toggle={<span className="text-sm text-base-content/60">{t('settings.version', updates.currentVersion)}</span>}>
      {updates.available && (
        <div role="alert" className="alert alert-info alert-soft mb-3 text-sm">
          <span>{t('settings.updateAvailable', updates.available.tag)} <a className="link" href={updates.available.releaseUrl} target="_blank" rel="noreferrer noopener">{t('settings.releaseNotes')}</a></span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-outline btn-primary" disabled={updates.checking} onClick={() => void check()}>
          <RefreshCw size={16} className={updates.checking ? 'animate-spin' : ''} />{updates.checking ? t('settings.checking') : t('settings.checkUpdates')}
        </button>
        {updates.available && (updates.canSelfInstall ? (
          <button type="button" className="btn btn-primary" disabled={updates.installing}
            onClick={() => { toast(t('settings.installNote'), 'info'); void run(() => connection.call('updates.install')) }}>
            {updates.installing ? t('settings.installing') : t('settings.install', updates.available.tag)}
          </button>
        ) : (
          <a className="btn btn-primary" href={updates.available.releaseUrl} target="_blank" rel="noreferrer noopener">{t('settings.openRelease')}</a>
        ))}
        <span className="text-sm text-base-content/60">{statusText}</span>
      </div>
      {info && <p className="mt-3 text-xs text-base-content/50">{info.platform} · {info.arch} · {info.dataDirectory}</p>}
    </Section>
  )
}
