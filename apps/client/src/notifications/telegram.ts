import type { SecretStore } from '../db/secrets.ts'
import type { AppSettings } from '../settings.ts'
import type { NotificationEvent, Notifier } from './dispatcher.ts'

/** Messages through the user's own Telegram bot (token + chat id). */
export class TelegramNotifier implements Notifier {
  readonly name = 'Telegram'

  isEnabled(s: AppSettings, secrets: SecretStore): boolean {
    return s.telegramEnabled && Boolean(s.telegramChatId.trim()) && secrets.has('telegramBotToken')
  }

  async send(event: NotificationEvent, s: AppSettings, secrets: SecretStore): Promise<void> {
    const escape = (text: string) => text.replaceAll('*', '\\*').replaceAll('_', '\\_')
    // Never let the URL reach an error message or a log: it contains the bot token.
    let response: Response
    try {
      response = await fetch(`https://api.telegram.org/bot${secrets.get('telegramBotToken')}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: s.telegramChatId, text: `*${escape(event.title)}*\n${escape(event.message)}`, parse_mode: 'Markdown' }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new Error('Telegram could not be reached')
    }
    if (!response.ok) throw new Error(`Telegram answered HTTP ${response.status}`)
  }
}
