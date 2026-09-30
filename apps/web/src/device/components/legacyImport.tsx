import type { LegacyImportStatusDto } from '@magnetar/protocol'
import { HardDriveDownload, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '../../lib/i18n.tsx'
import { useToast } from '../../ui/toast.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { useRun } from '../useRun.ts'

const DISMISSED = 'magnetar-import-dismissed'

/** Whether a MediaDownloader 1.x database is there to import, and the import itself. */
export function useLegacyImport() {
  const t = useT()
  const toast = useToast()
  const run = useRun()
  const { connection } = useDevice()
  const [status, setStatus] = useState<LegacyImportStatusDto | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void connection.call('legacy.status').then(setStatus).catch(() => {})
  }, [connection])

  const runImport = async () => {
    setBusy(true)
    const result = await run(() => connection.call('legacy.import'), 'import.failed')
    setBusy(false)
    if (!result) return
    toast(t('import.done', result.downloads, result.seriesTasks), 'success')
    if (result.secretsToReenter.length) toast(t('import.reenter', result.secretsToReenter.join(', ')), 'info')
    setStatus(await connection.call('legacy.status'))
  }
  return { status, busy, runImport }
}

/** Offers the 1.x import where a returning user lands, until it is done or dismissed. */
export function LegacyImportBanner() {
  const t = useT()
  const { status, busy, runImport } = useLegacyImport()
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === '1'
    } catch {
      return false
    }
  })
  if (!status?.available || status.imported || dismissed) return null
  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISSED, '1')
    } catch {
      // Storage unavailable: it comes back next time, which is harmless.
    }
  }
  return (
    <div className="surface mb-5 flex flex-col gap-4 border-primary/30 bg-primary/5 p-5 sm:flex-row sm:items-center">
      <span className="grid size-10 shrink-0 place-items-center rounded-field bg-primary/10 text-primary"><HardDriveDownload size={20} /></span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{t('import.bannerTitle')}</div>
        <p className="muted mt-0.5 text-sm">{t('import.hint', status.downloads, status.seriesTasks)}</p>
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss}>{t('common.notNow')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void runImport()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : <Upload size={14} />}{t('import.button')}
        </button>
      </div>
    </div>
  )
}
