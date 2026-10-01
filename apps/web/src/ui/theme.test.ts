import { themeScript } from '@codefusion-cc/theme'
import { createTheme } from '@codefusion-cc/theme/browser'
import { testBrowser } from '@codefusion-cc/theme/testing'
import { describe, expect, it } from 'vitest'
import { themeConfig } from './themeConfig.ts'

const pageBackground = (html: { attributes: Record<string, string> }) => ({
  '--color-base-200': html.attributes['data-theme'] === 'magnetar-dark' ? '#101013' : '#f4f4f6',
})

describe('the theme', () => {
  it('shows the remembered theme before first paint, and the system’s otherwise', () => {
    const remembered = testBrowser({ systemDark: false, stored: { 'magnetar-theme': 'dark' } }).openTab()
    remembered.runScript(themeScript(themeConfig))
    expect(remembered.html).toMatchObject({ attributes: { 'data-theme': 'magnetar-dark' }, colorScheme: 'dark' })

    for (const browser of [testBrowser({ systemDark: true }), testBrowser({ systemDark: true, storage: 'blocked' })]) {
      const tab = browser.openTab()
      tab.runScript(themeScript(themeConfig))
      expect(tab.html.attributes['data-theme']).toBe('magnetar-dark')
    }
  })

  it('keeps a pick for the page when the browser keeps nothing, while the system changes', () => {
    const browser = testBrowser({ storage: 'blocked' })
    const tab = browser.openTab()
    const theme = createTheme(themeConfig, tab.env)
    theme.setMode('dark')
    browser.setSystemDark(true)
    browser.setSystemDark(false)
    expect(theme.get().mode).toBe('dark')
    expect(tab.html.attributes['data-theme']).toBe('magnetar-dark')
  })

  it('shows a pick made in another tab', () => {
    const browser = testBrowser()
    const [settings, other] = [browser.openTab(), browser.openTab()]
    const mine = createTheme(themeConfig, settings.env)
    const theirs = createTheme(themeConfig, other.env)
    mine.setMode('dark')
    expect(theirs.get().mode).toBe('dark')
    expect(other.html.attributes['data-theme']).toBe('magnetar-dark')
  })

  it("gives the browser's bar the page background of the theme picked, not the system's", () => {
    const browser = testBrowser({ systemDark: false, css: pageBackground })
    const tab = browser.openTab({ themeColors: [{ content: '#f4f4f6', media: '(prefers-color-scheme: light)' }] })
    createTheme(themeConfig, tab.env).setMode('dark')
    expect(tab.html.themeColors).toEqual([{ content: '#101013', media: null }])
  })
})
