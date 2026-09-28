import { Cloud, Copy, ExternalLink, Link2, Plus, QrCode, ShieldCheck, Unlink } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { useFormatDate, useT } from '../../lib/i18n.tsx'
import { ConfirmDialog, Modal } from '../../ui/Modal.tsx'
import { useCopy } from '../../ui/toast.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { Section } from '../pages/SettingsPage.tsx'
import { useRun } from '../useRun.ts'

/**
 * Connecting this device to mediadownloader.codefusion.cc. Pairing opens the website in a new
 * tab; that browser signs in, approves, and receives its end-to-end key in the link fragment.
 * More browsers (a phone) are linked by scanning a QR code carrying a freshly minted key.
 */
export function RemoteAccessSection() {
  const t = useT()
  const formatDate = useFormatDate()
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

  return (
    <Section icon={<Cloud size={20} />} title={t('remote.title')} hint={t('remote.hint')}
      toggle={remote.paired && (
        <span className={`badge badge-soft ${remote.connected ? 'badge-success' : 'badge-warning'}`}>
          {remote.connected ? t('remote.connected') : t('remote.reconnecting')}
        </span>
      )}>
      {!remote.paired ? (
        local ? (
          remote.pendingPairing ? (
            <div className="flex flex-col gap-3">
              <div role="alert" className="alert alert-info alert-soft text-sm">
                <span className="loading loading-spinner loading-sm" />
                <span>{t('remote.waiting')}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <a className="btn btn-primary btn-sm" href={remote.pendingPairing.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />{t('remote.openAgain')}</a>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run(() => connection.call('remote.cancelPairing'))}>{t('common.cancel')}</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="floating-label flex-1">
                <span>{t('remote.deviceName')}</span>
                <input className="input w-full" maxLength={60} value={name} placeholder={t('remote.deviceName')} onChange={e => setName(e.target.value)} />
              </label>
              <button type="button" className="btn btn-primary" onClick={() => void pair()}><Link2 size={16} />{t('remote.connect')}</button>
            </div>
          )
        ) : null
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <ShieldCheck size={16} className="text-success" />
            <span>{t('remote.linkedTo', remote.accountEmail ?? '')}</span>
            <a className="link link-primary ml-auto" href={remote.cloudUrl} target="_blank" rel="noopener noreferrer">{t('remote.openDashboard')}</a>
          </div>
          <div className="join w-full">
            <label className="floating-label join-item w-full">
              <span>{t('remote.deviceName')}</span>
              <input className="input w-full" maxLength={60} value={name} placeholder={t('remote.deviceName')} onChange={e => setName(e.target.value)} />
            </label>
            <button type="button" className="btn join-item" disabled={!name.trim() || name.trim() === remote.deviceName}
              onClick={() => void run(() => connection.call('remote.rename', { deviceName: name.trim() }))}>{t('remote.rename')}</button>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold">{t('remote.browsers')}</h3>
            <ul className="divide-y divide-base-300 rounded-box border border-base-300">
              {remote.browsers.map(b => (
                <li key={b.keyId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{b.label}{connection.keyId === b.keyId && <span className="badge badge-soft badge-primary badge-sm ml-2">{t('remote.thisBrowser')}</span>}</span>
                  <span className="text-xs text-base-content/60">{b.lastSeenAt ? t('remote.lastSeen', formatDate(b.lastSeenAt, true)) : t('remote.neverUsed')}</span>
                  <button type="button" className="btn btn-ghost btn-xs text-error" onClick={() => setConfirm({ revoke: b.keyId })}>{t('remote.revoke')}</button>
                </li>
              ))}
              {remote.browsers.length === 0 && <li className="px-3 py-2 text-sm text-base-content/60">{t('remote.noBrowsers')}</li>}
            </ul>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="floating-label flex-1">
              <span>{t('remote.browserLabel')}</span>
              <input className="input w-full" maxLength={60} value={label} placeholder={t('remote.browserLabelPlaceholder')} onChange={e => setLabel(e.target.value)} />
            </label>
            <button type="button" className="btn btn-outline btn-primary" onClick={() => void mintLink()}><Plus size={16} />{t('remote.linkBrowser')}</button>
          </div>

          <div>
            <button type="button" className="btn btn-outline btn-error btn-sm" onClick={() => setConfirm('unpair')}><Unlink size={14} />{t('remote.disconnect')}</button>
          </div>
        </div>
      )}
      {remote.lastError && <p className="mt-3 text-sm text-warning">{remote.lastError}</p>}

      <Modal open={link !== null} title={t('remote.linkTitle')} icon={<QrCode size={20} />} onClose={() => setLink(null)}
        actions={<button type="button" className="btn btn-primary btn-sm" onClick={() => setLink(null)}>{t('common.close')}</button>}>
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
    </Section>
  )
}
