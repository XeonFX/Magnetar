import nodemailer from 'nodemailer'
import type { SecretStore } from '../db/secrets.ts'
import type { AppSettings } from '../settings.ts'
import type { NotificationEvent, Notifier } from './dispatcher.ts'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class EmailNotifier implements Notifier {
  readonly name = 'Email'

  isEnabled(s: AppSettings): boolean {
    return s.emailEnabled && Boolean(s.smtpHost.trim()) && Boolean(s.emailTo.trim())
  }

  async send(event: NotificationEvent, s: AppSettings, secrets: SecretStore): Promise<void> {
    const transport = nodemailer.createTransport({
      host: s.smtpHost,
      port: s.smtpPort,
      // Implicit TLS on 465, STARTTLS elsewhere when SSL is on; plain only when switched off.
      secure: s.smtpUseSsl && s.smtpPort === 465,
      requireTLS: s.smtpUseSsl && s.smtpPort !== 465,
      ignoreTLS: !s.smtpUseSsl,
      auth: s.smtpUsername ? { user: s.smtpUsername, pass: secrets.get('smtpPassword') } : undefined,
      connectionTimeout: 30_000,
    })
    // An explicit From, else the SMTP login when it is itself an address, else the To address.
    const from = [s.emailFrom, s.smtpUsername, s.emailTo].find(c => EMAIL.test(c.trim())) ?? s.emailTo
    await transport.sendMail({ from, to: s.emailTo, subject: `[MediaDownloader] ${event.title}`, text: event.message })
  }
}
