import { ExternalLink, Link2, Plus, QrCode, RefreshCw, ShieldCheck, TimerOff, Unlink } from 'lucide-react'
import { reservedDeviceName, toDeviceName } from '@magnetar/protocol/device-name'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import { useFormatEta, useFormatRelative, useT } from '../../lib/i18n.tsx'
import { SettingGroup, SettingRow } from '../../ui/controls.tsx'
import { CopyInput, Field } from '../../ui/fields.tsx'
import { ConfirmDialog, Modal } from '../../ui/Modal.tsx'
import { useCopy, useToast } from '../../ui/toast.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { followLink, type LinkWatch } from '../linkState.ts'
import { useRun } from '../useRun.ts'

/** The link the dialog shows, followed until a browser uses it or it stops working. */
interface ShownLink extends LinkWatch {
  /** As typed; empty when the browser was left unnamed. */
  label: string
  url: string
  qr: string
  ended?: 'expired' | 'revoked'
}

/**
 * Connecting this device to magnetar.codefusion.cc. Pairing opens the website in a new
 * tab; that browser signs in, approves, and receives its end-to-end key in the link fragment.
 * More browsers (a phone) are linked by scanning a QR code carrying a freshly minted key; the
 * dialog showing it closes by itself once that browser has connected.
 */
export function RemoteAccessSection() {
  const t = useT()
  const formatRelative = useFormatRelative()
  const copy = useCopy(t('info.copied'))
  const toast = useToast()
  const run = useRun()
  const { connection, remote } = useDevice()
  const [name, setName] = useState('')
  const [link, setLink] = useState<ShownLink | null>(null)
  const [minting, setMinting] = useState(false)
  // Counts the dialog's requests: closing it makes a link still on its way stale.
  const request = useRef(0)
  const [label, setLabel] = useState('')
  const [confirm, setConfirm] = useState<'unpair' | { revoke: string } | null>(null)
  useEffect(() => setName(remote?.deviceName ?? ''), [remote?.deviceName])

  const closeLink = () => {
    request.current++
    setMinting(false)
    setLink(null)
  }

  // The device lists the browsers again whenever one connects or a link expires.
  const paired = remote?.paired ?? false
  const browsers = remote?.browsers
  useEffect(() => {
    if (!link || link.ended || !browsers) return
    if (!paired) return closeLink()
    const next = followLink(link, browsers, Date.now())
    if (next.state === 'linked') {
      closeLink()
      toast(link.label ? t('remote.browserLinked', next.browser.label) : t('remote.browserLinkedUnnamed'), 'success')
    } else if (next.state !== 'waiting') {
      setLink({ ...link, listed: true, ended: next.state })
    } else if (next.listed !== link.listed) {
      setLink({ ...link, listed: true })
    }
  }, [link, browsers, paired, toast, t])

  if (!remote) return null
  const local = connection.kind === 'local'
  // The name is the device's address on the website, so it is spelled as one: shown as typed, sent as spelled.
  const spelled = name.trim() ? toDeviceName(name) : ''
  const address = `${remote.cloudUrl.replace(/^https?:\/\//, '')}/${spelled}`
  // A word the website keeps for its own pages: say why the address differs from the name typed.
  const reserved = reservedDeviceName(name)
  const nameField = (
    <Field label={t('remote.deviceName')} className="flex-1"
      help={spelled && (reserved ? <span className="text-warning">{t('remote.reservedName', reserved, address)}</span> : t('remote.address', address))}>
      <input className="input w-full" maxLength={60} autoComplete="off" spellCheck={false} value={name} onChange={e => setName(e.target.value)} />
    </Field>
  )

  const pair = async () => {
    // Open the tab inside the click so popup blockers allow it, then point it at the link.
    const tab = window.open('about:blank', '_blank')
    const status = await run(() => connection.call('remote.pair', { deviceName: spelled || undefined }), 'remote.pairFailed')
    if (!status?.pendingPairing) return tab?.close()
    if (tab) {
      tab.opener = null
      tab.location.href = status.pendingPairing.url
    }
  }

  const mintLink = async (forLabel: string) => {
    const mine = ++request.current
    setMinting(true)
    try {
      const minted = await run(() => connection.call('remote.linkBrowser', { label: forLabel || undefined }))
      if (!minted) return
      const deadline = minted.expiresIn === undefined ? undefined : Date.now() + minted.expiresIn * 1000
      const qr = await QRCode.toDataURL(minted.url, { margin: 1, width: 280, errorCorrectionLevel: 'M' })
      // Closed while the link was on its way: nobody will see it, so it should not linger in the list.
      if (request.current !== mine) return void connection.call('remote.revokeBrowser', { keyId: minted.keyId }).catch(() => {})
      setLink({ keyId: minted.keyId, listed: false, deadline, label: forLabel, url: minted.url, qr })
      setLabel('')
    } finally {
      if (request.current === mine) setMinting(false)
    }
  }

  const status = remote.paired && (
    <span className={`badge badge-soft ${remote.connected ? 'badge-success' : 'badge-warning'}`}>
      {remote.connected ? t('remote.connected') : t('remote.reconnecting')}
    </span>
  )

  return (
    <>
      <SettingGroup title={t('remote.title')} description={t('remote.hint')} action={status}>
        {!remote.paired ? (
          !local ? null : remote.pendingPairing ? (
            <div className="flex flex-col gap-3">
              <p className="flex items-center gap-2 text-sm"><span className="loading loading-spinner loading-sm text-primary" />{t('remote.waiting')}</p>
              <div className="flex flex-wrap gap-2">
                <a className="btn btn-primary btn-sm" href={remote.pendingPairing.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />{t('remote.openAgain')}</a>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run(() => connection.call('remote.cancelPairing'))}>{t('common.cancel')}</button>
              </div>
            </div>
          ) : (
            <form className="flex flex-col gap-3 sm:flex-row sm:items-start" onSubmit={e => { e.preventDefault(); void pair() }}>
              {nameField}
              <button type="submit" className="btn btn-primary sm:mt-7"><Link2 size={16} />{t('remote.connect')}</button>
            </form>
          )
        ) : (
          <>
            <SettingRow title={t('remote.linkedTo', remote.accountEmail ?? '')}
              description={<a className="link link-primary" href={remote.cloudUrl} target="_blank" rel="noopener noreferrer">{t('remote.openDashboard')}</a>}>
              <ShieldCheck size={20} className="text-success" />
            </SettingRow>
            <form className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start" onSubmit={e => {
              e.preventDefault()
              if (spelled && spelled !== remote.deviceName) void run(() => connection.call('remote.rename', { deviceName: spelled }))
            }}>
              {nameField}
              <button type="submit" className="btn sm:mt-7" disabled={!spelled || spelled === remote.deviceName}>{t('remote.rename')}</button>
            </form>
            <SettingRow layout="wide" title={t('remote.disconnect')} description={t('remote.disconnectHint')}>
              <button type="button" className="btn btn-sm text-error" onClick={() => setConfirm('unpair')}><Unlink size={14} />{t('remote.disconnect')}</button>
            </SettingRow>
          </>
        )}
        {remote.lastError && <p className="py-3 text-sm text-warning">{remote.lastError}</p>}
      </SettingGroup>

      {remote.paired && (
        <SettingGroup title={t('remote.browsers')} description={t('remote.browsersHint')}>
          {remote.browsers.map(b => (
            <SettingRow key={b.keyId}
              title={b.label}
              description={<>
                {connection.keyId === b.keyId && <span className="badge badge-soft badge-primary badge-sm mr-2">{t('remote.thisBrowser')}</span>}
                {b.lastSeenAt ? t('remote.lastUsed', formatRelative(b.lastSeenAt)) : t('remote.neverUsed')}
              </>}>
              <button type="button" className="btn btn-ghost btn-sm text-error" onClick={() => setConfirm({ revoke: b.keyId })}>{t('remote.revoke')}</button>
            </SettingRow>
          ))}
          {remote.browsers.length === 0 && <p className="muted py-3 text-sm">{t('remote.noBrowsers')}</p>}
          <form className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-end" onSubmit={e => { e.preventDefault(); if (!minting) void mintLink(label.trim()) }}>
            <Field label={t('remote.browserLabel')} className="flex-1">
              <input className="input w-full" maxLength={60} value={label} placeholder={t('remote.browserLabelPlaceholder')} onChange={e => setLabel(e.target.value)} />
            </Field>
            <button type="submit" className="btn" disabled={minting}>
              {minting && !link ? <span className="loading loading-spinner loading-sm" /> : <Plus size={16} />}{t('remote.linkBrowser')}
            </button>
          </form>
        </SettingGroup>
      )}

      <Modal open={link !== null} title={t('remote.linkTitle')} icon={<QrCode size={20} />} onClose={closeLink}
        actions={link?.ended ? <>
          <button type="button" className="btn btn-ghost btn-sm" onClick={closeLink}>{t('common.close')}</button>
          {/* Focus moves here, since the link it replaces had it. */}
          <button type="button" className="btn btn-primary btn-sm" disabled={minting} autoFocus onClick={() => void mintLink(link.label)}>
            {minting ? <span className="loading loading-spinner loading-xs" /> : <RefreshCw size={14} />}{t('remote.newLink')}
          </button>
        </> : <button type="button" className="btn btn-primary btn-sm" onClick={closeLink}>{t('common.done')}</button>}>
        {link && (link.ended ? (
          <div role="alert" className="alert alert-warning alert-soft text-sm">
            {link.ended === 'expired' ? <TimerOff size={18} /> : <Unlink size={18} />}
            {t(link.ended === 'expired' ? 'remote.linkExpired' : 'remote.linkRevoked')}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm">{t('remote.linkHint')}</p>
            <img src={link.qr} alt={t('remote.linkTitle')} className="size-64 rounded-box bg-white p-2" />
            <CopyInput small label={t('remote.linkTitle')} value={link.url} copyLabel={t('common.copy')} onCopy={value => void copy(value)} />
            {link.deadline !== undefined && <LinkExpiry deadline={link.deadline} />}
            <p className="text-xs text-warning">{t('remote.linkWarning')}</p>
          </div>
        ))}
      </Modal>

      <ConfirmDialog open={confirm !== null}
        title={confirm === 'unpair' ? t('remote.disconnectTitle') : t('remote.revokeTitle')}
        message={confirm === 'unpair' ? t('remote.disconnectConfirm') : t('remote.revokeConfirm')}
        options={[{ label: t('common.cancel'), value: false, tone: 'ghost' }, { label: confirm === 'unpair' ? t('remote.disconnect') : t('remote.revoke'), value: true, tone: 'error' }]}
        onResult={confirmed => {
          const action = confirm
          setConfirm(null)
          if (!confirmed || !action) return
          if (action === 'unpair') void run(() => connection.call('remote.unpair'))
          else void run(() => connection.call('remote.revokeBrowser', { keyId: action.revoke }))
        }} />
    </>
  )
}

/** How long a link has left, kept current while it is shown. */
function LinkExpiry({ deadline }: { deadline: number }) {
  const t = useT()
  const formatEta = useFormatEta()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const seconds = (deadline - now) / 1000
  // Gone once the time is up: the device deletes the key then, and the dialog says the link expired.
  if (seconds <= 0) return null
  return <p className="muted text-xs">{t('remote.linkExpires', formatEta(seconds))}</p>
}
