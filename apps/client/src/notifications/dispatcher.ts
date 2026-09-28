import type { RpcEvents } from '@md/protocol'
import { ApiError } from '../api/errors.ts'
import type { SecretStore } from '../db/secrets.ts'
import type { EventBus } from '../events.ts'
import { logger } from '../log.ts'
import type { AppSettings } from '../settings.ts'
import type { SettingsService } from '../settings.ts'
import { EmailNotifier } from './email.ts'
import { NtfyNotifier } from './ntfy.ts'
import { TelegramNotifier } from './telegram.ts'

const log = logger('notify')

export type NotificationEvent = RpcEvents['notification']

/** A notification channel. `isEnabled` decides from settings whether it fires at all. */
export interface Notifier {
  readonly name: string
  isEnabled(settings: AppSettings, secrets: SecretStore): boolean
  send(event: NotificationEvent, settings: AppSettings, secrets: SecretStore): Promise<void>
}

/** Desktop notifications: every open dashboard shows them through the browser Notification API. */
class DesktopNotifier implements Notifier {
  readonly name = 'Desktop'
  constructor(private readonly events: EventBus) {}
  isEnabled(settings: AppSettings) {
    return settings.desktopEnabled
  }
  async send(event: NotificationEvent) {
    this.events.emit('notification', event)
  }
}

/** Fans an event out to every enabled channel; one failing channel never stops the others. */
export class NotificationDispatcher {
  private readonly notifiers: Notifier[]

  constructor(private readonly settings: SettingsService, events: EventBus) {
    this.notifiers = [new DesktopNotifier(events), new EmailNotifier(), new NtfyNotifier(), new TelegramNotifier()]
  }

  /** Sends to every enabled channel. With `throwOnFailure` (the Settings test button) failures surface. */
  async dispatch(event: NotificationEvent, throwOnFailure = false): Promise<void> {
    const settings = this.settings.get()
    if (event.kind === 'started' && !settings.notifyOnStart) return
    if (event.kind === 'completed' && !settings.notifyOnComplete) return
    // Channels are independent: a slow SMTP handshake must not hold up the push.
    const enabled = this.notifiers.filter(n => n.isEnabled(settings, this.settings.secrets))
    const outcomes = await Promise.allSettled(enabled.map(n => n.send(event, settings, this.settings.secrets)))
    const failures = outcomes.flatMap((outcome, i) => {
      if (outcome.status === 'fulfilled') return []
      const error = outcome.reason as unknown
      log.warn(`${enabled[i]!.name} notification failed`, error)
      return [`${enabled[i]!.name}: ${error instanceof Error ? error.message : String(error)}`]
    })
    if (throwOnFailure && failures.length) throw new ApiError(failures.join('; '))
  }
}
