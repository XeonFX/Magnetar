import { Copy, ExternalLink, Link2, Plus, QrCode, ShieldCheck, Unlink } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { useFormatRelative, useT } from '../../lib/i18n.tsx'
import { SettingGroup, SettingRow } from '../../ui/controls.tsx'
import { Field } from '../../ui/fields.tsx'
import { ConfirmDialog, Modal } from '../../ui/Modal.tsx'
import { useCopy } from '../../ui/toast.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { useRun } from '../useRun.ts'

/**
 * Connecting this device to magnetar.codefusion.cc. Pairing opens the website in a new
 * tab; that browser signs in, approves, and receives its end-to-end key in the link fragment.
 * More browsers (a phone) are linked by scanning a QR code carrying a freshly minted key.
 */
export function RemoteAccessSection() {
  const t = useT()
  const formatRelative = useFormatRelative()
  const copy = useCopy(t('info.copied'))
  const run = useRun()
  const { connection, remote } = useDevice()
  const [name, setName] = useState('')
  const [link, setLink] = useState<{ url: string; qr: string } | null>(null)
  const [label, setLabel] = useState('')
  const [confirm, setConfirm] = useState<'unpair' | { revoke: string } | null>(null)
  useEffect(() => setName(remote?.deviceName ?? ''), [remote?.deviceName])
  if (!remote) return null
  const local = connection.kind === 'local'

  const pair = async () => {
    // Open the tab inside the click so popup blockers allow it, then point it at the link.
    const tab = window.open('about:blank', '_blank')
    const status = await run(() => connection.call('remote.pair', { deviceName: name.trim() || undefined }), 'remote.pairFailed')
    if (!status?.pendingPairing) return tab?.close()
    if (tab) {
      tab.opener = null
      tab.location.href = status.pendingPairing.url
    }
  }

  const mintLink = async () => {
    const minted = await run(() => connection.call('remote.linkBrowser', { label: label.trim() || undefined }))
    if (!minted) return
    setLink({ url: minted.url, qr: await QRCode.toDataURL(minted.url, { margin: 1, width: 280, errorCorrectionLevel: 'M' }) })
    setLabel('')
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
            <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={e => { e.preventDefault(); void pair() }}>
              <Field label={t('remote.deviceName')} className="flex-1">
                <input className="input w-full" maxLength={60} value={name} onChange={e => setName(e.target.value)} />
              </Field>
              <button type="submit" className="btn btn-primary"><Link2 size={16} />{t('remote.connect')}</button>
            </form>
          )
        ) : (
          <>
            <SettingRow title={t('remote.linkedTo', remote.accountEmail ?? '')}
              description={<a className="link link-primary" href={remote.cloudUrl} target="_blank" rel="noopener noreferrer">{t('remote.openDashboard')}</a>}>
              <ShieldCheck size={20} className="text-success" />
            </SettingRow>
            <form className="flex flex-col gap-3 py-4 sm:flex-row sm:items-end" onSubmit={e => {
              e.preventDefault()
              if (name.trim() && name.trim() !== remote.deviceName) void run(() => connection.call('remote.rename', { deviceName: name.trim() }))
            }}>
              <Field label={t('remote.deviceName')} className="flex-1">
                <input className="input w-full" maxLength={60} value={name} onChange={e => setName(e.target.value)} />
              </Field>
              <button type="submit" className="btn" disabled={!name.trim() || name.trim() === remote.deviceName}>{t('remote.rename')}</button>
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
          <form className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-end" onSubmit={e => { e.preventDefault(); void mintLink() }}>
            <Field label={t('remote.browserLabel')} className="flex-1">
              <input className="input w-full" maxLength={60} value={label} placeholder={t('remote.browserLabelPlaceholder')} onChange={e => setLabel(e.target.value)} />
            </Field>
            <button type="submit" className="btn"><Plus size={16} />{t('remote.linkBrowser')}</button>
          </form>
        </SettingGroup>
      )}

      <Modal open={link !== null} title={t('remote.linkTitle')} icon={<QrCode size={20} />} onClose={() => setLink(null)}
        actions={<button type="button" className="btn btn-primary btn-sm" onClick={() => setLink(null)}>{t('common.done')}</button>}>
        {link && (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm">{t('remote.linkHint')}</p>
            <img src={link.qr} alt={t('remote.linkTitle')} className="size-64 rounded-box bg-white p-2" />
            <div className="join w-full">
              <input readOnly className="input join-item w-full font-mono text-xs" value={link.url} aria-label={t('remote.linkTitle')} />
              <button type="button" className="btn join-item" aria-label={t('info.copied')} onClick={() => void copy(link.url)}><Copy size={16} /></button>
            </div>
            <p className="text-xs text-warning">{t('remote.linkWarning')}</p>
          </div>
        )}
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
