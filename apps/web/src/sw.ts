/*
 * Magnetar's service worker, on the website only; built into /sw.js by @codefusion-cc/web-push/vite.
 *
 * Notifications from linked devices: each is sealed on the device for this browser and opened by the browser's push
 * service before it arrives here, as `{ title, body, url, tag }`. A click opens the device's page the push names.
 * Playback through the relay: lib/streamWorker.ts.
 */
import { handlePushes } from '@codefusion-cc/web-push/service-worker'
import { handleStreams } from './lib/streamWorker.ts'

handlePushes({ title: 'Magnetar', icon: '/icon-192.png', badge: '/icon-192.png' })
handleStreams()
