import type { AgentStatusDto, HandlerStatus, LoginStartupStatus, SettingsDto, SettingsPatch } from '@magnetar/protocol'
import {
  Bell, Bot, Cloud, Copy, Download, Eye, EyeOff, Info, Mail, RefreshCw, Send, Server, Smartphone, SlidersHorizontal, Sparkles, Upload,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { LANGUAGES, useFormatDate, useT } from '../../lib/i18n.tsx'
import { askNotificationPermission } from '../../lib/notifications.ts'
import { PageHeader, Segmented, SettingGroup, SettingRow, Switch } from '../../ui/controls.tsx'
import { CopyInput, Field, SaveOnBlurInput, blurOnEnter } from '../../ui/fields.tsx'
import { ConfirmDialog } from '../../ui/Modal.tsx'
import { useTheme, type ThemeMode } from '../../ui/theme.ts'
import { useCopy, useToast } from '../../ui/toast.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { usePathChoice } from '../../lib/urlState.ts'
import { BrowserPushChannel } from '../components/browserPush.tsx'
import { FolderField } from '../components/folders.tsx'
import { useLegacyImport } from '../components/legacyImport.tsx'
import { RemoteAccessSection } from '../components/remoteAccess.tsx'
import { NetworkSettings, SeedingRow, SpeedSettings } from '../components/transferSettings.tsx'
import { useRun } from '../useRun.ts'
import { Loading } from '../../ui/Loading.tsx'

const SECTIONS = [
  { id: 'general', icon: SlidersHorizontal },
  { id: 'downloads', icon: Download },
  { id: 'notifications', icon: Bell },
  { id: 'sources', icon: Server },
  { id: 'remote', icon: Cloud },
  { id: 'agents', icon: Bot },
  { id: 'about', icon: Info },
] as const
type SectionId = (typeof SECTIONS)[number]['id']
const SECTION_IDS = SECTIONS.map(s => s.id) as [SectionId, ...SectionId[]]

export function SettingsPage() {
  const t = useT()
  const { settings, basePath } = useDevice()
  // Each section has its own address: /settings is General, /settings/agents the AI agents.
  const { value: shown, redirect } = usePathChoice(useParams().section, SECTION_IDS, 'section')
  const href = (id: SectionId) => `${basePath}/settings${id === 'general' ? '' : `/${id}`}`
  // On a phone the sections scroll sideways; a link straight to one scrolls it into sight.
  const nav = useRef<HTMLElement>(null)
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [shown, settings !== null])
  if (redirect) return <Navigate to={href(redirect)} replace />
  if (!settings) return <Loading />

  return (
    <>
      <PageHeader title={t('settings.title')} summary={t('settings.subtitle')} />
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
        <nav ref={nav} aria-label={t('settings.title')} className="scroll-strip -mx-4 flex gap-1 overflow-x-auto px-4 lg:sticky lg:top-10 lg:mx-0 lg:flex-col lg:self-start lg:px-0">
          {SECTIONS.map(({ id, icon: Icon }) => (
            <Link key={id} to={href(id)} replace aria-current={shown === id ? 'page' : undefined}
              className={`flex shrink-0 items-center gap-2.5 rounded-full px-3.5 py-2 text-sm font-medium transition-colors lg:rounded-field ${
                shown === id ? 'bg-neutral text-neutral-content lg:bg-primary/10 lg:text-primary' : 'muted hover:bg-base-100 hover:text-base-content'}`}>
              <Icon size={16} />{t(`settings.section.${id}`)}
            </Link>
          ))}
        </nav>
        <div className="flex min-w-0 flex-col gap-4">
          {shown === 'general' && <GeneralSection settings={settings} />}
          {shown === 'downloads' && <DownloadsSection settings={settings} />}
          {shown === 'notifications' && <NotificationsSection settings={settings} />}
          {shown === 'sources' && <SourcesSection settings={settings} />}
          {shown === 'remote' && <RemoteAccessSection />}
          {shown === 'agents' && <AgentSection />}
          {shown === 'about' && <><AboutSection /><ImportSection /></>}
        </div>
      </div>
    </>
  )
}

function useSave() {
  const { connection } = useDevice()
  const run = useRun()
  return (patch: SettingsPatch) => void run(() => connection.call('settings.update', patch), 'settings.saveFailed')
}

function GeneralSection({ settings }: { settings: SettingsDto }) {
  const t = useT()
  const save = useSave()
  const run = useRun()
  const { connection } = useDevice()
  const { mode, setMode } = useTheme()
  const [startup, setStartup] = useState<LoginStartupStatus | null>(null)
  const [changing, setChanging] = useState(false)
  const refreshStartup = () => void connection.call('startup.status').then(r => setStartup(r.status)).catch(() => setStartup('unavailable'))
  useEffect(refreshStartup, [connection])

  const changeStartup = async (enabled: boolean) => {
    setChanging(true)
    const result = await run(() => connection.call('startup.set', { enabled }), 'settings.startupFailed')
    if (result) setStartup(result.status)
    setChanging(false)
  }

  return (
    <SettingGroup>
      <SettingRow layout="wide" title={t('settings.language')} htmlFor="magnetar-language">
        <select id="magnetar-language" className="select w-full sm:w-52" value={settings.language} onChange={e => save({ language: e.target.value })}>
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
      </SettingRow>
      <SettingRow layout="wide" title={t('settings.appearance')} description={t('settings.appearanceHint')}>
        <Segmented label={t('settings.appearance')} value={mode} onChange={(m: ThemeMode) => setMode(m)}
          options={(['system', 'light', 'dark'] as const).map(m => ({ value: m, label: t(`settings.theme.${m}`) }))} />
      </SettingRow>
      <SettingRow title={t('settings.startWithMac')}
        description={<>
          {t(startup === 'unavailable' ? 'settings.startupUnavailable' : 'settings.startupHint')}
          {startup === 'requiresApproval' && (
            <span className="mt-2 flex flex-wrap items-center gap-2 text-warning">
              {t('settings.startupApproval')}
              <button type="button" className="btn btn-ghost btn-xs" disabled={changing} onClick={refreshStartup}>{t('settings.startupRefresh')}</button>
            </span>
          )}
        </>}>
        <Switch label={t('settings.startWithMac')} checked={startup === 'enabled' || startup === 'requiresApproval'}
          disabled={changing || startup === 'unavailable' || startup === null} onChange={v => void changeStartup(v)} />
      </SettingRow>
      {connection.kind === 'local' && <HandlerRow />}
      <SettingRow title={t('settings.errorReports')} description={t('settings.errorReportsHint')}>
        <Switch label={t('settings.errorReports')} checked={settings.errorReportsEnabled} onChange={errorReportsEnabled => save({ errorReportsEnabled })} />
      </SettingRow>
    </SettingGroup>
  )
}

/** Whether clicking a magnet link or opening a .torrent file comes here, and making it so. */
function HandlerRow() {
  const t = useT()
  const run = useRun()
  const { connection } = useDevice()
  const [status, setStatus] = useState<HandlerStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void connection.call('handlers.status').then(r => setStatus(r.status)).catch(() => setStatus('unavailable'))
  }, [connection])
  const register = async () => {
    setBusy(true)
    const result = await run(() => connection.call('handlers.register'), 'settings.handlersFailed')
    if (result) setStatus(result.status)
    setBusy(false)
  }
  return (
    <SettingRow layout="wide" title={t('settings.handlers')}
      description={status === 'unavailable' ? t('settings.handlersUnavailable') : status === 'default' ? t('settings.handlersDefault') : t('settings.handlersHint')}>
      {status === 'notDefault' && (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void register()}>
          {busy && <span className="loading loading-spinner loading-xs" />}{t('settings.handlersMake')}
        </button>
      )}
      {status === 'default' && <span className="badge badge-soft badge-success">{t('settings.handlersOn')}</span>}
    </SettingRow>
  )
}

function DownloadsSection({ settings }: { settings: SettingsDto }) {
  const t = useT()
  const save = useSave()
  return (
    <>
      <SettingGroup>
        <SettingRow layout="stack" title={t('settings.downloadFolder')} description={t('settings.downloadFolderHint')}>
          <FolderField hideLabel label={t('settings.downloadFolder')} value={settings.downloadFolder}
            onChange={downloadFolder => downloadFolder.trim() && save({ downloadFolder })} />
        </SettingRow>
        <SeedingRow settings={settings} save={save} />
        <SettingRow title={t('settings.notifyStart')}>
          <Switch label={t('settings.notifyStart')} checked={settings.notifyOnStart} onChange={notifyOnStart => save({ notifyOnStart })} />
        </SettingRow>
        <SettingRow title={t('settings.notifyFinish')}>
          <Switch label={t('settings.notifyFinish')} checked={settings.notifyOnComplete} onChange={notifyOnComplete => save({ notifyOnComplete })} />
        </SettingRow>
      </SettingGroup>
      <SpeedSettings settings={settings} save={save} />
      <NetworkSettings settings={settings} save={save} />
    </>
  )
}

function SecretField({ label, isSet, onSave, help }: { label: string; isSet: boolean; onSave: (value: string) => void; help?: ReactNode }) {
  const t = useT()
  const [draft, setDraft] = useState('')
  return (
    <Field label={label} help={help}>
      <div className="join w-full">
        <input type="password" autoComplete="new-password" className="input join-item w-full min-w-0" value={draft}
          placeholder={isSet ? t('settings.secretSaved') : ''} onChange={e => setDraft(e.target.value)}
          onBlur={() => { if (draft) { onSave(draft); setDraft('') } }} onKeyDown={blurOnEnter} />
        {isSet && <button type="button" className="btn join-item" onClick={() => onSave('')}>{t('settings.secretClear')}</button>}
      </div>
    </Field>
  )
}

function Text({ label, value, onSave, type = 'text', help, className }: { label: string; value: string; onSave: (value: string) => void; type?: string; help?: string; className?: string }) {
  return <Field label={label} help={help} className={className}><SaveOnBlurInput type={type} value={value} onSave={onSave} /></Field>
}

/** One notification channel: its switch, and its settings only while it is on. */
function Channel({ icon, title, description, enabled, onToggle, children }: {
  icon: ReactNode
  title: string
  description?: ReactNode
  enabled: boolean
  onToggle: (enabled: boolean) => void
  children?: ReactNode
}) {
  return (
    <section className="surface p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className={`grid size-9 shrink-0 place-items-center rounded-field ${enabled ? 'bg-primary/10 text-primary' : 'muted bg-base-200'}`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{title}</h2>
          {description && <div className="muted mt-0.5 text-sm">{description}</div>}
        </div>
        <Switch label={title} checked={enabled} onChange={onToggle} />
      </div>
      {enabled && children && <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>}
    </section>
  )
}

function NotificationsSection({ settings: s }: { settings: SettingsDto }) {
  const t = useT()
  const save = useSave()
  const toast = useToast()
  const run = useRun()
  const { connection } = useDevice()
  const [testing, setTesting] = useState(false)
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'denied'))
  const test = async () => {
    setTesting(true)
    const ok = await run(async () => { await connection.call('notifications.test'); return true }, 'settings.testFailed')
    setTesting(false)
    if (ok) toast(t('settings.testSent'), 'success')
  }
  const allow = () => {
    askNotificationPermission()
    // The prompt resolves on its own; read the answer once it has.
    setTimeout(() => setPermission(Notification.permission), 1500)
  }
  const [browserPush, setBrowserPush] = useState(false)
  const anyOn = s.desktopEnabled || s.emailEnabled || s.pushEnabled || s.telegramEnabled || browserPush

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="muted min-w-0 flex-1 text-sm">{t('settings.notificationsHint')}</p>
        <button type="button" className="btn btn-sm" disabled={testing || !anyOn} onClick={() => void test()}>
          {testing ? <span className="loading loading-spinner loading-xs" /> : <Bell size={14} />}{t('settings.sendTest')}
        </button>
      </div>
      {connection.kind === 'remote' && <BrowserPushChannel onChange={setBrowserPush} />}
      <Channel icon={<Bell size={18} />} title={t('settings.desktop')} enabled={s.desktopEnabled}
        onToggle={desktopEnabled => { if (desktopEnabled) askNotificationPermission(); save({ desktopEnabled }) }}
        description={<>
          {t('settings.desktopHint')}
          {s.desktopEnabled && permission === 'default' && (
            <button type="button" className="btn btn-xs btn-primary btn-soft ml-2" onClick={allow}>{t('settings.allowNotifications')}</button>
          )}
          {s.desktopEnabled && permission === 'denied' && <span className="mt-1 block text-warning">{t('settings.notificationsBlocked')}</span>}
        </>} />
      <Channel icon={<Mail size={18} />} title={t('settings.email')} enabled={s.emailEnabled} onToggle={emailEnabled => save({ emailEnabled })}>
        <Text label={t('settings.smtpHost')} value={s.smtpHost} onSave={smtpHost => save({ smtpHost })} />
        <div className="flex items-end gap-3">
          <Text className="w-28" type="number" label={t('settings.port')} value={String(s.smtpPort)}
            onSave={v => { const port = Number(v); if (port >= 1 && port <= 65535) save({ smtpPort: port }) }} />
          <label className="flex h-10 cursor-pointer items-center gap-2 text-sm">
            <Switch label={t('settings.ssl')} checked={s.smtpUseSsl} onChange={smtpUseSsl => save({ smtpUseSsl })} />{t('settings.ssl')}
          </label>
        </div>
        <Text label={t('settings.username')} value={s.smtpUsername} onSave={smtpUsername => save({ smtpUsername })} />
        <SecretField label={t('settings.password')} isSet={s.smtpPasswordSet} onSave={smtpPassword => save({ smtpPassword })} />
        <Text type="email" label={t('settings.from')} value={s.emailFrom} onSave={emailFrom => save({ emailFrom: emailFrom.trim() })} />
        <Text type="email" label={t('settings.to')} value={s.emailTo} onSave={emailTo => save({ emailTo: emailTo.trim() })} />
      </Channel>
      <Channel icon={<Smartphone size={18} />} title={t('settings.push')} description={t('settings.pushHint')} enabled={s.pushEnabled} onToggle={pushEnabled => save({ pushEnabled })}>
        <Text label={t('settings.ntfyServer')} value={s.ntfyServer} onSave={ntfyServer => save({ ntfyServer: ntfyServer.trim() })} />
        <Text label={t('settings.topic')} help={t('settings.topicHint')} value={s.ntfyTopic} onSave={ntfyTopic => save({ ntfyTopic })} />
      </Channel>
      <Channel icon={<Send size={18} />} title={t('settings.telegram')} enabled={s.telegramEnabled} onToggle={telegramEnabled => save({ telegramEnabled })}>
        <SecretField label={t('settings.botToken')} help={t('settings.botTokenHint')} isSet={s.telegramBotTokenSet} onSave={telegramBotToken => save({ telegramBotToken })} />
        <Text label={t('settings.chatId')} help={t('settings.chatIdHint')} value={s.telegramChatId} onSave={telegramChatId => save({ telegramChatId })} />
      </Channel>
    </>
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
    <SettingGroup description={t('settings.sourcesHint')}>
      {sources.map(s => (
        <SettingRow key={s.name} title={s.name}>
          <Switch label={s.name} checked={s.enabled} onChange={v => toggle(s.name, v)} />
        </SettingRow>
      ))}
    </SettingGroup>
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
  const [connectingClaude, setConnectingClaude] = useState(false)
  useEffect(() => {
    void connection.call('agent.status').then(setAgent).catch(() => {})
  }, [connection])
  if (!agent) return null

  const change = async (patch: { enabled?: boolean; allowRemote?: boolean }) => {
    const next = await run(() => connection.call('agent.set', patch), 'settings.saveFailed')
    if (next) setAgent(next)
    if (next && patch.allowRemote !== undefined) toast(t('settings.agentRestart'), 'info')
  }

  /** Registers the MCP server with Claude Code on this computer (turning agent access on). */
  const connectClaude = async () => {
    setConnectingClaude(true)
    const result = await run(() => connection.call('agent.connectClaude'), 'settings.claudeConnectFailed')
    setConnectingClaude(false)
    if (!result) return
    setAgent(result.agent)
    toast(t(result.status === 'connected' ? 'settings.claudeConnected' : 'settings.claudeNotFound'), result.status === 'connected' ? 'success' : 'info')
  }

  return (
    <>
      <SettingGroup>
        <SettingRow title={t('settings.agentAccess')} description={t('settings.agentHint')}>
          <Switch label={t('settings.agentAccess')} checked={agent.enabled} onChange={enabled => void change({ enabled })} />
        </SettingRow>
        {connection.kind === 'local' && (
          <SettingRow layout="wide" title={t('settings.connectClaude')} description={t('settings.connectClaudeHint')}>
            <button type="button" className="btn btn-primary btn-sm" disabled={connectingClaude} onClick={() => void connectClaude()}>
              {connectingClaude ? <span className="loading loading-spinner loading-xs" /> : <Sparkles size={14} />}{t('settings.connectClaude')}
            </button>
          </SettingRow>
        )}
      </SettingGroup>
      {agent.enabled && (
        <SettingGroup title={t('settings.agentDetails')} description={t('settings.agentLoopbackHint')}>
          <SettingRow title={t('settings.agentRemote')} description={t('settings.agentRemoteHint')}>
            <Switch tone="warning" label={t('settings.agentRemote')} checked={agent.allowRemote} onChange={allowRemote => void change({ allowRemote })} />
          </SettingRow>
          <div className="flex flex-col gap-4 py-4 last:pb-0">
            <Field label={t('settings.agentToken')}>
              <div className="join w-full">
                <input readOnly aria-label={t('settings.agentToken')} className="input join-item w-full min-w-0 font-mono text-sm" type={reveal ? 'text' : 'password'} value={agent.token} />
                <button type="button" className="btn join-item" title={t('settings.agentReveal')} aria-label={t('settings.agentReveal')} onClick={() => setReveal(r => !r)}>{reveal ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                <button type="button" className="btn join-item" title={t('settings.agentCopy')} aria-label={t('settings.agentCopy')} onClick={() => void copy(agent.token)}><Copy size={16} /></button>
                <button type="button" className="btn join-item" title={t('settings.agentRegenerate')} aria-label={t('settings.agentRegenerate')} onClick={() => setConfirming(true)}><RefreshCw size={16} /></button>
              </div>
            </Field>
            <CopyField label={t('settings.agentMcpUrl')} value={agent.mcpUrl} onCopy={copy} />
            <CopyField label={t('settings.agentClaudeCommand')} value={agent.claudeCommand} onCopy={copy} />
            <p className="muted break-release text-xs">{t('settings.agentEndpointFile', agent.endpointFile)}</p>
          </div>
        </SettingGroup>
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
    </>
  )
}

function CopyField({ label, value, onCopy }: { label: string; value: string; onCopy: (value: string) => void }) {
  const t = useT()
  return (
    <Field label={label}>
      <CopyInput label={label} value={value} copyLabel={t('common.copy')} onCopy={onCopy} />
    </Field>
  )
}

function ImportSection() {
  const t = useT()
  const { status, busy, runImport } = useLegacyImport()
  if (!status?.available) return null

  return (
    <SettingGroup>
      <SettingRow layout="wide" title={t('import.title')}
        description={<>{t('import.hint', status.downloads, status.seriesTasks)}{status.imported && <span className="mt-1 block text-success">{t('import.alreadyImported')}</span>}</>}>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void runImport()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : <Upload size={14} />}{t('import.button')}
        </button>
      </SettingRow>
    </SettingGroup>
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
    : updates.available ? t('settings.updateAvailable', updates.available.tag)
    : updates.lastCheckedAt ? t('settings.checkedAt', formatDate(updates.lastCheckedAt, true))
    : t('settings.checkAuto')

  return (
    <SettingGroup>
      <SettingRow layout="wide" title={t('settings.version', updates.currentVersion)}
        description={<>
          <span className={updates.available ? 'font-medium text-primary' : ''}>{statusText}</span>
          {updates.available && <> · <a className="link" href={updates.available.releaseUrl} target="_blank" rel="noreferrer noopener">{t('settings.releaseNotes')}</a></>}
        </>}>
        <div className="flex flex-wrap gap-2">
          {updates.available && (updates.canSelfInstall ? (
            <button type="button" className="btn btn-primary btn-sm" disabled={updates.installing}
              onClick={() => { toast(t('settings.installNote'), 'info'); void run(() => connection.call('updates.install')) }}>
              {updates.installing ? t('settings.installing') : t('settings.install', updates.available.tag)}
            </button>
          ) : (
            <a className="btn btn-primary btn-sm" href={updates.available.releaseUrl} target="_blank" rel="noreferrer noopener">{t('settings.openRelease')}</a>
          ))}
          <button type="button" className="btn btn-sm" disabled={updates.checking} onClick={() => void check()}>
            <RefreshCw size={14} className={updates.checking ? 'animate-spin' : ''} />{t('settings.checkUpdates')}
          </button>
        </div>
      </SettingRow>
      {info && (
        <SettingRow layout="wide" title={t('settings.dataFolder')} description={<span className="break-release font-mono text-xs">{info.dataDirectory}</span>}>
          <span className="muted text-sm">{info.platform} · {info.arch}</span>
        </SettingRow>
      )}
    </SettingGroup>
  )
}
