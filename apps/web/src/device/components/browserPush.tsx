import { BellRing, Share } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '../../lib/i18n.tsx'
import { disablePush, enablePush, pushStatus, pushSupport, type PushSupport } from '../../lib/push.ts'
import { Switch } from '../../ui/controls.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { useRun } from '../useRun.ts'

/**
 * Notifications on this phone or browser even with the website closed. Offered on the website
 * only: the dashboard on the computer running the app has desktop notifications.
 */
export function BrowserPushChannel({ onChange }: { onChange?: (on: boolean) => void }) {
  const t = useT()
  const run = useRun()
  const { connection } = useDevice()
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<PushSupport>(() => pushSupport())

  useEffect(() => {
    let cancelled = false
    void pushStatus(connection).then(value => !cancelled && setOn(value)).catch(() => !cancelled && setOn(false))
    return () => { cancelled = true }
  }, [connection])
  useEffect(() => { if (on !== null) onChange?.(on) }, [on, onChange])

  const toggle = async (next: boolean) => {
    setBusy(true)
    if (next) {
      const outcome = await run(() => enablePush(connection), 'push.failed')
      if (outcome) setProblem(outcome)
      setOn(outcome === 'ok')
    } else {
      await run(() => disablePush(connection), 'push.failed')
      setOn(false)
    }
    setBusy(false)
  }

  const hint = problem === 'install' ? (
    <span className="mt-1 flex items-center gap-1 text-warning"><Share size={14} />{t('push.installFirst')}</span>
  ) : problem === 'denied' ? <span className="mt-1 block text-warning">{t('push.blocked')}</span>
    : problem === 'server' ? <span className="mt-1 block text-warning">{t('push.noServer')}</span>
    : problem === 'unsupported' ? <span className="mt-1 block text-warning">{t('push.unsupported')}</span> : null

  return (
    <section className="surface border-primary/30 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-field bg-primary/10 text-primary"><BellRing size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{t('push.title')}</h2>
          <p className="muted mt-0.5 text-sm">{t('push.hint')}{hint}</p>
        </div>
        {busy || on === null ? <span className="loading loading-spinner loading-sm mt-1 text-primary" />
          : <Switch label={t('push.title')} checked={on} disabled={problem === 'unsupported' || problem === 'install'} onChange={v => void toggle(v)} />}
      </div>
    </section>
  )
}
