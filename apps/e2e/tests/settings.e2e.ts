import { expect, test } from '@playwright/test'

test('speed limits are checked as typed, saved on leaving the field, and kept', async ({ page }) => {
  await page.goto('/settings?section=downloads')
  // The usual limits come before the alternative ones.
  const download = () => page.getByRole('spinbutton', { name: 'Download' }).first()
  const unit = () => page.getByRole('combobox', { name: 'Unit' }).first()
  await download().fill('10')
  await expect(page.getByText('At least 32 KiB/s, or blank for no limit.')).toBeVisible()
  await download().fill('5')
  await unit().selectOption({ label: 'MiB/s' })
  await download().press('Enter')
  await expect(page.getByText('At least 32 KiB/s')).toHaveCount(0)
  await page.reload()
  await expect(download()).toHaveValue('5')
  await expect(unit()).toHaveValue(String(1024 * 1024))
})

test('the dashboard speaks the chosen language, and back', async ({ page }) => {
  await page.goto('/settings')
  await page.getByLabel('Language').selectOption('de')
  await expect(page.getByRole('link', { name: 'Einstellungen' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Merkliste' })).toBeVisible()
  await page.getByLabel('Sprache').selectOption('en')
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible()
})

test('a series and a watch are set up from the Watchlist page', async ({ page }) => {
  await page.goto('/series')
  await page.getByRole('button', { name: 'Add series' }).first().click()
  const dialog = page.locator('dialog[open]')
  await dialog.getByLabel('Search for').fill('Example Show')
  await dialog.getByRole('radio', { name: '1080p' }).click()
  await dialog.getByRole('button', { name: 'Add series' }).click()
  const card = page.locator('li').filter({ hasText: 'Example Show' })
  await expect(card).toContainText('1080p')
  await expect(card).toContainText('E01')

  await page.getByRole('radio', { name: /Films & more/ }).click()
  await expect(page).toHaveURL(/tab=releases/)
  await page.getByRole('button', { name: 'Watch for a release' }).first().click()
  const watch = page.locator('dialog[open]')
  await watch.getByLabel('What to look for').fill('x')
  await expect(watch.getByRole('button', { name: 'Watch for a release' })).toBeDisabled()
  await watch.getByRole('button', { name: 'Cancel' }).click()
})
