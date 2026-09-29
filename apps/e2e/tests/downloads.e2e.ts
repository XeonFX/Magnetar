import { expect, test, type Page } from '@playwright/test'

const magnet = (hash: string, name: string) => `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`
const dialog = (page: Page, title: string) => page.locator('dialog[open]').filter({ hasText: title })

test('magnets pasted into the add dialog start as downloads that can be paused, inspected and deleted', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Downloads', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const add = dialog(page, 'Add magnet links or torrent files')
  await expect(add.getByRole('button', { name: 'Download', exact: true })).toBeDisabled()
  await add.getByRole('textbox').fill(`notes ${magnet('1'.repeat(40), 'First show')} and ${magnet('2'.repeat(40), 'Second show')} end`)
  await expect(add.getByText('2 magnet links found')).toBeVisible()
  await add.getByRole('button', { name: 'Download 2' }).click()
  await expect(page.getByText('Started 2 downloads')).toBeVisible()
  await expect(add).toBeHidden()

  const first = page.locator('li').filter({ hasText: 'First show' })
  await expect(first).toContainText(/Fetching metadata|Queued/)
  await first.getByRole('button', { name: 'Pause' }).click()
  await expect(first).toContainText('Paused')
  await first.getByRole('button', { name: 'Resume' }).click()
  await expect(first).toContainText(/Fetching metadata|Queued/)

  await first.getByRole('button', { name: 'First show' }).click()
  const details = dialog(page, 'Download details')
  await expect(details).toContainText("The file list appears once the torrent's details have arrived from peers.")
  await details.getByRole('button', { name: 'Close' }).first().click()

  await first.getByRole('button', { name: 'Delete' }).click()
  await dialog(page, 'Delete download').getByRole('button', { name: 'Keep files' }).click()
  await expect(page.locator('li').filter({ hasText: 'First show' })).toHaveCount(0)
  await expect(page.locator('li').filter({ hasText: 'Second show' })).toHaveCount(1)
})

test('a magnet link handed to the dashboard, or pasted on the page, opens the add dialog filled in', async ({ page }) => {
  const link = magnet('3'.repeat(40), 'Linked')
  await page.goto(`/?add=${encodeURIComponent(link)}`)
  const add = dialog(page, 'Add magnet links or torrent files')
  await expect(add.getByRole('textbox')).toHaveValue(link)
  await expect(page).toHaveURL(/\/$/)
  await add.getByRole('button', { name: 'Cancel' }).click()
  await expect(add).toBeHidden()

  const pasted = magnet('4'.repeat(40), 'Pasted')
  await page.evaluate(text => {
    const data = new DataTransfer()
    data.setData('text', text)
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  }, pasted)
  await expect(add.getByRole('textbox')).toHaveValue(pasted)
})

test('a bad magnet link is refused with the reason, and the dialog stays open', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const add = dialog(page, 'Add magnet links or torrent files')
  await add.getByRole('textbox').fill('magnet:?xt=urn:btih:nothash')
  await add.getByRole('button', { name: 'Download', exact: true }).click()
  await expect(add.getByRole('alert')).toContainText('no valid info hash')
  await expect(add).toBeVisible()
})
