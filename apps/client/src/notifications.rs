//! Notification channels: desktop (every open dashboard shows it through the browser Notification
//! API), e-mail, ntfy push, Telegram, and push to linked browsers. One failing channel never stops
//! the others.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::future::join_all;
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::db::SecretName;
use crate::error::{ApiError, ApiResult};
use crate::events::EventBus;
use crate::protocol::{NotificationEvent, is_email};
use crate::remote::RemoteService;
use crate::settings::{AppSettings, SettingsService};

const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy)]
enum Channel {
    Desktop,
    Email,
    Push,
    Telegram,
    /// Linked browsers that turned notifications on (see `remote::push`).
    Browsers,
}

impl Channel {
    fn name(self) -> &'static str {
        match self {
            Self::Desktop => "Desktop",
            Self::Email => "Email",
            Self::Push => "Push (ntfy)",
            Self::Telegram => "Telegram",
            Self::Browsers => "Browser push",
        }
    }
}

pub struct NotificationDispatcher {
    settings: Arc<SettingsService>,
    events: EventBus,
    http: reqwest::Client,
    /// Set once the remote service exists (it is built after this).
    browsers: OnceLock<Arc<RemoteService>>,
}

impl NotificationDispatcher {
    pub fn new(settings: Arc<SettingsService>, events: EventBus, http: reqwest::Client) -> Self {
        Self { settings, events, http, browsers: OnceLock::new() }
    }

    pub fn send_to_browsers_through(&self, remote: Arc<RemoteService>) {
        let _ = self.browsers.set(remote);
    }

    fn enabled(&self, s: &AppSettings) -> Vec<Channel> {
        let mut channels = Vec::new();
        if s.desktop_enabled {
            channels.push(Channel::Desktop);
        }
        if s.email_enabled && !s.smtp_host.trim().is_empty() && !s.email_to.trim().is_empty() {
            channels.push(Channel::Email);
        }
        if s.push_enabled && !s.ntfy_server.trim().is_empty() && !s.ntfy_topic.trim().is_empty() {
            channels.push(Channel::Push);
        }
        if s.telegram_enabled && !s.telegram_chat_id.trim().is_empty() && self.settings.secrets.has(SecretName::TelegramBotToken)
        {
            channels.push(Channel::Telegram);
        }
        if self.browsers.get().is_some_and(|remote| !remote.pushes.is_empty()) {
            channels.push(Channel::Browsers);
        }
        channels
    }

    /// Sends to every enabled channel. With `report_failures` (the Settings test button) failures surface.
    pub async fn dispatch(&self, event: NotificationEvent, report_failures: bool) -> ApiResult<()> {
        let s = self.settings.get();
        if (event.kind == "started" && !s.notify_on_start) || (event.kind == "completed" && !s.notify_on_complete) {
            return Ok(());
        }
        // Channels are independent: a slow SMTP handshake must not hold up the push.
        let channels = self.enabled(&s);
        let outcomes = join_all(channels.iter().map(|&channel| self.send(channel, &event, &s))).await;
        let failures: Vec<String> = channels
            .iter()
            .zip(outcomes)
            .filter_map(|(channel, outcome)| {
                let error = outcome.err()?;
                tracing::warn!("{} notification failed: {error:#}", channel.name());
                Some(format!("{}: {error}", channel.name()))
            })
            .collect();
        if report_failures && !failures.is_empty() {
            return Err(ApiError::bad(failures.join("; ")));
        }
        Ok(())
    }

    /// Fire and forget, for events the app raises itself.
    pub fn notify(self: &Arc<Self>, kind: &'static str, title: impl Into<String>, message: impl Into<String>) {
        let dispatcher = self.clone();
        let event = NotificationEvent { kind, title: title.into(), message: message.into() };
        tokio::spawn(async move {
            let _ = dispatcher.dispatch(event, false).await;
        });
    }

    async fn send(&self, channel: Channel, event: &NotificationEvent, s: &AppSettings) -> anyhow::Result<()> {
        match channel {
            Channel::Desktop => {
                self.events.emit("notification", event);
                Ok(())
            }
            Channel::Email => self.email(event, s).await,
            Channel::Push => self.ntfy(event, s).await,
            Channel::Telegram => self.telegram(event, s).await,
            Channel::Browsers => match self.browsers.get() {
                Some(remote) => remote.push(event).await,
                None => Ok(()),
            },
        }
    }

    async fn email(&self, event: &NotificationEvent, s: &AppSettings) -> anyhow::Result<()> {
        // Implicit TLS on 465, STARTTLS elsewhere when SSL is on; plain only when switched off.
        let mut builder = if !s.smtp_use_ssl {
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&s.smtp_host)
        } else if s.smtp_port == 465 {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&s.smtp_host)?
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&s.smtp_host)?
        };
        builder = builder.port(s.smtp_port).timeout(Some(TIMEOUT));
        if !s.smtp_username.is_empty() {
            builder = builder
                .credentials(Credentials::new(s.smtp_username.clone(), self.settings.secrets.get(SecretName::SmtpPassword)));
        }
        // An explicit From, else the SMTP login when it is itself an address, else the To address.
        let from = [&s.email_from, &s.smtp_username, &s.email_to]
            .into_iter()
            .map(|c| c.trim())
            .find(|c| is_email(c))
            .unwrap_or(s.email_to.trim());
        let message = Message::builder()
            .from(from.parse::<Mailbox>()?)
            .to(s.email_to.trim().parse::<Mailbox>()?)
            .subject(format!("[Magnetar] {}", event.title))
            .body(event.message.clone())?;
        builder.build().send(message).await?;
        Ok(())
    }

    async fn ntfy(&self, event: &NotificationEvent, s: &AppSettings) -> anyhow::Result<()> {
        let url = format!(
            "{}/{}",
            s.ntfy_server.trim_end_matches('/'),
            crate::protocol::encoding::encode_uri_component(s.ntfy_topic.trim())
        );
        let response = self
            .http
            .post(url)
            // Header values must be Latin-1; ntfy decodes RFC 2047 encoded-words.
            .header("title", format!("=?UTF-8?B?{}?=", crate::protocol::encoding::to_base64(event.title.as_bytes())))
            .header("tags", if event.kind == "completed" { "white_check_mark" } else { "arrow_down" })
            .body(event.message.clone())
            .timeout(TIMEOUT)
            .send()
            .await?;
        anyhow::ensure!(response.status().is_success(), "ntfy answered HTTP {}", response.status().as_u16());
        Ok(())
    }

    async fn telegram(&self, event: &NotificationEvent, s: &AppSettings) -> anyhow::Result<()> {
        let escape = |text: &str| text.replace('*', "\\*").replace('_', "\\_");
        let token = self.settings.secrets.get(SecretName::TelegramBotToken);
        // Never let the URL reach an error message or a log: it contains the bot token.
        let response = self
            .http
            .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
            .json(&serde_json::json!({
                "chat_id": s.telegram_chat_id,
                "text": format!("*{}*\n{}", escape(&event.title), escape(&event.message)),
                "parse_mode": "Markdown",
            }))
            .timeout(TIMEOUT)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Telegram could not be reached"))?;
        anyhow::ensure!(response.status().is_success(), "Telegram answered HTTP {}", response.status().as_u16());
        Ok(())
    }
}
