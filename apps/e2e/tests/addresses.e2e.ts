import { expect, test, type Page } from '@playwright/test'

/** The settings page's own list of sections, apart from the main navigation. */
const sections = (page: Page) => page.getByRole('navigation', { name: 'Settings', exact: true })

test('settings sections have their own addresses, and older links still land', async ({ page }) => {
  await page.goto('/settings?section=agents')
  await expect(page).toHaveURL(/\/settings\/agents$/)
  await expect(sections(page).getByRole('link', { name: 'AI agents' })).toHaveAttribute('aria-current', 'page')

  await sections(page).getByRole('link', { name: 'Notifications' }).click()
  await expect(page).toHaveURL(/\/settings\/notifications$/)
  await page.reload()
  await expect(sections(page).getByRole('link', { name: 'Notifications' })).toHaveAttribute('aria-current', 'page')

  await sections(page).getByRole('link', { name: 'General' }).click()
  await expect(page).toHaveURL(/\/settings$/)
  for (const unknown of ['/settings/nope', '/settings/general', '/settings?section=nope']) {
    await page.goto(unknown)
    await expect(page).toHaveURL(/\/settings$/)
    await expect(sections(page).getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page')
  }
})

test('the Watchlist tab is part of the address', async ({ page }) => {
  await page.goto('/series?tab=releases')
  await expect(page).toHaveURL(/\/series\/releases$/)
  await expect(page.getByRole('radio', { name: /Films & more/ })).toHaveAttribute('aria-checked', 'true')
  await page.reload()
  await expect(page.getByRole('radio', { name: /Films & more/ })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('radio', { name: /Series/ }).click()
  await expect(page).toHaveURL(/\/series$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/series\/releases$/)
  await page.goto('/series/nope')
  await expect(page).toHaveURL(/\/series$/)
})

test('search choices survive a reload, and unknown ones fall back', async ({ page }) => {
  // No query, so no site is asked; the choices alone are kept.
  await page.goto('/search?res=1080p&sort=newest')
  const resolution = (name: string) => page.getByRole('radiogroup', { name: 'Resolution' }).getByRole('radio', { name })
  await expect(resolution('1080p')).toHaveAttribute('aria-checked', 'true')
  await resolution('4K').click()
  await expect(page).toHaveURL(/[?&]res=2160p/)
  await expect(page).toHaveURL(/[?&]sort=newest/)
  await page.reload()
  await expect(resolution('4K')).toHaveAttribute('aria-checked', 'true')

  await page.goto('/search?res=8K&sort=random')
  await expect(resolution('Any')).toHaveAttribute('aria-checked', 'true')
})

test('the downloads filter is part of the address', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const add = page.locator('dialog[open]')
  await add.getByRole('textbox').fill(`magnet:?xt=urn:btih:${'5'.repeat(40)}&dn=Filtered`)
  await add.getByRole('button', { name: 'Download', exact: true }).click()
  const row = page.locator('li').filter({ hasText: 'Filtered' })
  await row.getByRole('button', { name: 'Pause' }).click()
  await expect(row).toContainText('Paused')

  const filter = (name: RegExp) => page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name })
  await filter(/^Paused/).click()
  await expect(page).toHaveURL(/\?filter=paused$/)
  await page.reload()
  await expect(filter(/^Paused/)).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('li').filter({ hasText: 'Filtered' })).toHaveCount(1)
  await filter(/^All/).click()
  await expect(page).toHaveURL(/\/$/)

  await row.getByRole('button', { name: 'Delete' }).click()
  await page.locator('dialog[open]').getByRole('button', { name: 'Keep files' }).click()
})
