import { fromBase64Url, toBase64Url } from '@magnetar/protocol/base64'
import type { RpcClient } from './rpcClient.ts'
import { ensureServiceWorker } from './streaming.ts'

/** Why push can't be offered here, or 'ok'. */
export type PushSupport = 'ok' | 'unsupported' | 'install' | 'denied' | 'server'

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1)
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

/** Push needs a service worker and PushManager; on iPhone and iPad, the site added to the Home Screen. */
export function pushSupport(): PushSupport {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return 'unsupported'
  if (!('PushManager' in window)) return isIos() && !standalone() ? 'install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return 'ok'
}

let serverKey: Promise<string | null> | null = null

/** The Worker's VAPID public key, or null when this server doesn't send push. */
function vapidKey(): Promise<string | null> {
  serverKey ??= fetch('/api/push/key').then(r => (r.ok ? r.json() as Promise<{ publicKey: string }> : null)).then(k => k?.publicKey ?? null).catch(() => null)
  return serverKey
}

const flag = (keyId: string | null) => `magnetar-push:${keyId ?? ''}`

/** Whether this browser gets this device's notifications by push (so the page need not show them). */
export function pushEnabledFor(connection: RpcClient): boolean {
  try {
    return localStorage.getItem(flag(connection.keyId)) === '1'
  } catch {
    return false
  }
}

function remember(connection: RpcClient, on: boolean): void {
  try {
    if (on) localStorage.setItem(flag(connection.keyId), '1')
    else localStorage.removeItem(flag(connection.keyId))
  } catch {
    // Only decides whether the page also shows notifications itself.
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration('/')
  return (await registration?.pushManager.getSubscription()) ?? null
}

/** Whether the device has this browser's subscription. */
export async function pushStatus(connection: RpcClient): Promise<boolean> {
  if (pushSupport() !== 'ok' || !(await vapidKey())) return false
  const subscription = await currentSubscription()
  if (!subscription) return false
  const { subscribed } = await connection.call('push.status', { endpoint: subscription.endpoint })
  remember(connection, subscribed)
  return subscribed
}

/**
 * Asks for permission, subscribes this browser (once, shared by every device it links to) and
 * gives the device the subscription over the encrypted channel.
 */
export async function enablePush(connection: RpcClient): Promise<PushSupport> {
  const key = await vapidKey()
  if (!key) return 'server'
  if (await Notification.requestPermission() !== 'granted') return 'denied'
  const registration = await ensureServiceWorker()
  let subscription = await registration.pushManager.getSubscription()
  // A subscription made with another server key can't be used: replace it.
  const current = subscription?.options.applicationServerKey
  if (subscription && current && toBase64Url(new Uint8Array(current)) !== key) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) })
  const json = subscription.toJSON()
  await connection.call('push.subscribe', { endpoint: subscription.endpoint, p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' })
  remember(connection, true)
  return 'ok'
}

/** Stops this device's notifications here; the browser's subscription stays for other devices. */
export async function disablePush(connection: RpcClient): Promise<void> {
  const subscription = await currentSubscription()
  if (subscription) await connection.call('push.unsubscribe', { endpoint: subscription.endpoint })
  remember(connection, false)
}
