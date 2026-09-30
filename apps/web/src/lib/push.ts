import { pushSupport, subscribePush, type PushSupport as BrowserPushSupport } from '@codefusion-cc/web-push/browser'
import type { RpcClient } from './rpcClient.ts'
import { ensureServiceWorker } from './streaming.ts'

export { pushSupport }

/** Why push can't be offered here, or 'ok'; 'server' when the website doesn't send push. */
export type PushSupport = BrowserPushSupport | 'server'

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
  // One subscription for every device this browser links to; one made with an older server key is
  // replaced, and this device forgets that one.
  const { subscription, replaced } = await subscribePush({ registration: await ensureServiceWorker(), key })
  if (replaced) await connection.call('push.unsubscribe', { endpoint: replaced })
  await connection.call('push.subscribe', subscription)
  remember(connection, true)
  return 'ok'
}

/** Stops this device's notifications here; the browser's subscription stays for other devices. */
export async function disablePush(connection: RpcClient): Promise<void> {
  const subscription = await currentSubscription()
  if (subscription) await connection.call('push.unsubscribe', { endpoint: subscription.endpoint })
  remember(connection, false)
}
