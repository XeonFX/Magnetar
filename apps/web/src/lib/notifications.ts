/**
 * Asks for permission to show desktop notifications, once, and only in answer to something the user
 * did (starting a download, switching the channel on): browsers ignore or penalise prompts on load.
 */
export function askNotificationPermission(): void {
  if (!('Notification' in window) || Notification.permission !== 'default') return
  void Notification.requestPermission().catch(() => {})
}
