import type { AgentClientDto, AgentClientId, AgentStatusDto } from '@magnetar/protocol'
import { Check, ChevronDown, Copy, Plug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '../../lib/i18n.tsx'
import { SettingGroup } from '../../ui/controls.tsx'
import { CopyInput } from '../../ui/fields.tsx'
import { useCopy, useToast } from '../../ui/toast.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { useRun } from '../useRun.ts'

/**
 * The AI agents on this computer, each connected to Magnetar with a click or by hand. Agents found
 * here come first; the rest wait under "Other agents", with how to set them up once installed.
 */
export function AgentClients({ onAgent }: { onAgent: (agent: AgentStatusDto) => void }) {
  const t = useT()
  const run = useRun()
  const toast = useToast()
  const { connection } = useDevice()
  const [clients, setClients] = useState<AgentClientDto[] | null>(null)
  const [connecting, setConnecting] = useState<AgentClientId | null>(null)
  /** An agent that couldn't be connected: its setup by hand opens. */
  const [failed, setFailed] = useState<AgentClientId | null>(null)
  const [showOthers, setShowOthers] = useState(false)
  useEffect(() => {
    void connection.call('agent.clients').then(setClients).catch(() => setClients([]))
  }, [connection])

  const connect = async (client: AgentClientDto) => {
    setConnecting(client.id)
    setFailed(null)
    const result = await run(() => connection.call('agent.connect', { client: client.id }), 'settings.agentConnectFailed')
    setConnecting(null)
    if (!result) return setFailed(client.id)
    setClients(result.clients)
    onAgent(result.agent)
    toast(t('settings.agentConnectedToast', client.name), 'success')
  }

  if (clients === null) {
    return <SettingGroup title={t('settings.agentsTitle')}><span className="loading loading-dots loading-sm" /></SettingGroup>
  }
  const found = clients.filter(c => c.installed)
  const others = clients.filter(c => !c.installed)
  const row = (client: AgentClientDto) => (
    <AgentRow key={client.id} client={client} busy={connecting === client.id} disabled={connecting !== null} failed={failed === client.id}
      onConnect={() => void connect(client)} />
  )
  return (
    <SettingGroup title={t('settings.agentsTitle')} description={t('settings.agentsHint')}>
      {found.length === 0 && <p className="muted pb-3 text-sm">{t('settings.agentNoneFound')}</p>}
      <ul className="divide-y divide-base-300">{found.map(row)}</ul>
      {others.length > 0 && (
        <div className={found.length > 0 ? 'mt-2 border-t border-base-300 pt-2' : ''}>
          <button type="button" className="btn btn-ghost btn-sm -mx-2 gap-1.5" aria-expanded={showOthers} onClick={() => setShowOthers(s => !s)}>
            <ChevronDown size={16} className={`transition-transform ${showOthers ? 'rotate-180' : ''}`} />{t('settings.agentOthers', others.length)}
          </button>
          {showOthers && <ul className="divide-y divide-base-300">{others.map(row)}</ul>}
        </div>
      )}
    </SettingGroup>
  )
}

function AgentRow({ client, busy, disabled, failed, onConnect }: {
  client: AgentClientDto
  busy: boolean
  disabled: boolean
  failed: boolean
  onConnect: () => void
}) {
  const t = useT()
  // Opens by itself when connecting failed, until the user closes it.
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? failed
  const action = t(client.connected ? 'settings.agentReconnect' : 'settings.agentConnect')
  const panel = `agent-manual-${client.id}`
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{client.name}</div>
          <div className={`mt-0.5 flex items-center gap-1 text-sm ${client.connected ? 'text-success' : 'muted'}`}>
            {client.connected && <Check size={14} aria-hidden />}
            {t(client.connected ? 'settings.agentConnected' : client.installed ? 'settings.agentFound' : 'settings.agentNotFound')}
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls={panel} onClick={() => setManual(!open)}>
          {t('settings.agentManual')}<ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {client.installed && (
          <button type="button" className={`btn btn-sm ${client.connected ? 'btn-ghost' : 'btn-primary'}`} disabled={disabled} onClick={onConnect}
            aria-label={`${action}: ${client.name}`}>
            {busy ? <span className="loading loading-spinner loading-xs" /> : <Plug size={14} />}
            {action}
          </button>
        )}
      </div>
      {open && <div id={panel} className="mt-3"><ManualSetup client={client} /></div>}
    </li>
  )
}

function ManualSetup({ client }: { client: AgentClientDto }) {
  const t = useT()
  const copy = useCopy(t('settings.agentCopied'))
  const { manual } = client
  if (manual.kind === 'command') {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="muted text-sm">{t('settings.agentManualCommand')}</span>
        <CopyInput label={client.name} value={manual.text} copyLabel={t('common.copy')} onCopy={copy} small />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="muted break-release text-sm">{t('settings.agentManualFile', manual.file)}</span>
      <div className="relative">
        <pre className="max-h-64 overflow-auto rounded-field bg-base-200 p-3 pr-12 font-mono text-xs"><code>{manual.text}</code></pre>
        <button type="button" className="btn btn-ghost btn-sm btn-square absolute right-1.5 top-1.5" aria-label={`${t('common.copy')}: ${client.name}`}
          title={t('common.copy')} onClick={() => void copy(manual.text)}><Copy size={14} /></button>
      </div>
    </div>
  )
}
