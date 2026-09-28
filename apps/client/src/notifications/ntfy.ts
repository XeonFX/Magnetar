import type { AppSettings } from '../settings.ts'
import type { NotificationEvent, Notifier } from './dispatcher.ts'

/** Push notifications via ntfy: subscribe to the topic in the ntfy app on any device. */
export class NtfyNotifier implements Notifier {
  readonly name = 'Push (ntfy)'

  isEnabled(s: AppSettings): boolean {
    return s.pushEnabled && Boolean(s.ntfyServer.trim()) && Boolean(s.ntfyTopic.trim())
  }

  async send(event: NotificationEvent, s: AppSettings): Promise<void> {
    const response = await fetch(`${s.ntfyServer.replace(/\/+$/, '')}/${encodeURIComponent(s.ntfyTopic.trim())}`, {
      method: 'POST',
      body: event.message,
      headers: {
        // Header values must be Latin-1; ntfy decodes RFC 2047 encoded-words.
        title: `=?UTF-8?B?${Buffer.from(event.title).toString('base64')}?=`,
        tags: event.kind === 'completed' ? 'white_check_mark' : 'arrow_down',
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`ntfy answered HTTP ${response.status}`)
  }
}
