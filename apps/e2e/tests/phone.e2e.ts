import { expect, test } from '@playwright/test'

test('on a phone the tab bar moves between pages and the theme follows the choice', async ({ page }) => {
  await page.goto('/')
  const tabs = page.locator('nav').last()
  await tabs.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings/)
  await page.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'magnetar-dark')
  await page.getByRole('radio', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'magnetar-light')
  await tabs.getByRole('link', { name: 'Downloads' }).click()
  await expect(page.getByRole('heading', { name: 'Downloads', exact: true })).toBeVisible()
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(width, 'no sideways scrolling').toBeLessThanOrEqual(0)
})
