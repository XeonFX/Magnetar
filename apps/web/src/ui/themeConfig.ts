import { defineTheme } from '@codefusion-cc/theme'

/**
 * Light, dark, or following the system; remembered per browser (@codefusion-cc/theme). The page
 * (ui/theme.ts) and the script vite.config.ts serves as /theme.js, which shows it before first paint,
 * share it.
 */
export const themeConfig = defineTheme({
  storageKey: 'magnetar-theme',
  html: { attribute: 'data-theme', light: 'magnetar-light', dark: 'magnetar-dark' },
  // The browser's and the installed app's bar take the page background.
  themeColor: '--color-base-200',
})
