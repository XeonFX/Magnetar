import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const dialog = (page: Page, title: string) => page.locator('dialog[open]').filter({ hasText: title })
const entries = (page: Page) => page.getByRole('list', { name: /^Contents of / }).getByRole('listitem')

/** The download folder as Files shows it, filled with a show, a note, a hidden file and a link out of it. */
async function downloadFolder(page: Page): Promise<string> {
  await page.goto('/files')
  const card = page.getByRole('list', { name: 'Folders you can browse' }).getByRole('button', { name: /Download folder/ })
  await expect(card).toBeVisible()
  const path = (await card.locator('.font-mono').textContent())!.trim()
  mkdirSync(join(path, 'Show S01'), { recursive: true })
  for (const episode of ['E10', 'E2', 'E1']) writeFileSync(join(path, 'Show S01', `Show ${episode}.mkv`), 'x')
  writeFileSync(join(path, 'notes.txt'), 'hello')
  writeFileSync(join(path, '.secret'), 'hidden')
  const outside = mkdtempSync(join(tmpdir(), 'magnetar-outside-'))
  try {
    symlinkSync(outside, join(path, 'escape'))
  } catch {
    // Already there from an earlier run, or links need rights this system doesn't give.
  }
  return path
}

test('Files lists the download folder folders first, by name as people read it, and nothing hidden or outside', async ({ page }) => {
  await downloadFolder(page)
  await page.getByRole('button', { name: /Download folder/ }).click()
  await expect(page.getByRole('heading', { name: 'Download folder', level: 2 })).toBeVisible()
  await expect(page.getByText('notes.txt')).toBeVisible()
  const names = await entries(page).allInnerTexts()
  expect(names.findIndex(n => n.startsWith('Show S01'))).toBeGreaterThanOrEqual(0)
  expect(names.findIndex(n => n.startsWith('Show S01'))).toBeLessThan(names.findIndex(n => n.startsWith('notes.txt')))
  await expect(page.getByText('.secret')).toHaveCount(0)
  await expect(page.getByText('escape', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: /Show S01/ }).click()
  await expect(page.getByRole('heading', { name: 'Show S01', level: 2 })).toBeFocused()
  await expect(entries(page)).toHaveText([/Show E1\.mkv/, /Show E2\.mkv/, /Show E10\.mkv/])
  // The path stays out of the address: on the website it would reach the server.
  expect(page.url()).not.toContain('Show')

  // Back goes up, a folder at a time, as does the breadcrumb.
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Download folder', level: 2 })).toBeVisible()
  await page.goForward()
  await page.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Download folder' }).click()
  await expect(page.getByRole('heading', { name: 'Download folder', level: 2 })).toBeVisible()
})

test('a new folder is made, opened empty, and chosen as the download folder', async ({ page }) => {
  const path = await downloadFolder(page)
  await page.getByRole('button', { name: /Download folder/ }).click()
  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByLabel('New folder name').fill('../escape')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('alert')).toContainText('Choose another name')
  const name = `Season ${Date.now()}`
  await page.getByLabel('New folder name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible()
  await expect(page.getByText('This folder is empty.')).toBeVisible()

  await page.getByRole('button', { name: 'Use as download folder' }).click()
  await expect(page.getByText(`New downloads now go to ${name}`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use as download folder' })).toHaveCount(0)
  await page.goto('/settings/downloads')
  await expect(page.getByRole('textbox', { name: 'Download folder' })).toHaveValue(join(path, name))

  // The old download folder stays in Files, where its files still are.
  await page.goto('/files')
  await expect(page.getByRole('list', { name: 'Folders you can browse' }).getByText(path, { exact: true })).toBeVisible()

  // Put it back for the other tests.
  await page.goto('/settings/downloads')
  const field = page.getByRole('textbox', { name: 'Download folder' })
  await field.fill(path)
  await field.press('Enter')
  await expect(field).toHaveValue(path)
})

test('the folder chooser starts at the chosen folder and picks another inside the roots', async ({ page }) => {
  test.skip(process.platform === 'darwin', 'On macOS the dashboard on the computer shows the system\'s folder chooser.')
  const path = await downloadFolder(page)
  await page.goto('/settings/downloads')
  await page.getByRole('button', { name: 'Browse…' }).click()
  const chooser = dialog(page, 'Choose folder')
  await expect(chooser.getByRole('heading', { name: 'Download folder', level: 2 })).toBeVisible()
  await expect(chooser.getByText('notes.txt')).toHaveCount(0)
  await chooser.getByRole('button', { name: /Show S01/ }).click()
  await expect(chooser.getByText('No folders in here.')).toBeVisible()
  await chooser.getByRole('button', { name: 'Select this folder' }).click()
  await expect(chooser).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Download folder' })).toHaveValue(join(path, 'Show S01'))

  await page.getByRole('button', { name: 'Browse…' }).click()
  await dialog(page, 'Choose folder').getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Files' }).click()
  await dialog(page, 'Choose folder').getByRole('button').filter({ has: page.getByText(path, { exact: true }) }).click()
  await dialog(page, 'Choose folder').getByRole('button', { name: 'Select this folder' }).click()
  await expect(page.getByRole('textbox', { name: 'Download folder' })).toHaveValue(path)
})

test('a folder added on the computer can be browsed, and removed again', async ({ page }) => {
  test.skip(process.platform === 'darwin', 'On macOS adding a folder shows the system\'s folder chooser.')
  const media = mkdtempSync(join(tmpdir(), 'magnetar-media-'))
  mkdirSync(join(media, 'TV'))
  await page.goto('/files')
  await page.getByRole('button', { name: 'Add a folder' }).click()
  await page.getByLabel('Folder path').fill('relative/path')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('full path')
  await page.getByLabel('Folder path').fill(media)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const roots = page.getByRole('list', { name: 'Folders you can browse' })
  await expect(roots.getByText(media, { exact: true })).toBeVisible()

  await roots.getByRole('button', { name: new RegExp(media.split('/').pop()!) }).first().click()
  await expect(entries(page)).toHaveText([/TV/])
  await page.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Files' }).click()
  await roots.getByRole('button', { name: `Stop showing ${media} in Files` }).click()
  await dialog(page, 'Remove from Files?').getByRole('button', { name: 'Remove' }).click()
  await expect(roots.getByText(media, { exact: true })).toHaveCount(0)
})
