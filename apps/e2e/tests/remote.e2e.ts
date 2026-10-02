import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'

const dialog = (page: Page, title: string) => page.locator('dialog[open]').filter({ hasText: title })
const linkedToast = (page: Page) => page.getByRole('status').getByText(/^Browser linked/)

interface Browser { keyId: string; label: string; createdAt: string; lastSeenAt: string | null }

/**
 * The app runs without a relay, so it is never on an account. This stands in for its remote access: the
 * dashboard's socket goes to the real app for everything else, while `remote.status`, `remote.linkBrowser`,
 * `remote.revokeBrowser` and `remote.changed` come from here, the way a device linked to an account answers them.
 */
class FakeRemote {
  browsers: Browser[] = [{ keyId: 'laptop', label: 'Laptop', createdAt: '2026-09-01T10:00:00.000Z', lastSeenAt: null }]
  readonly minted: (string | undefined)[] = []
  readonly revoked: string[] = []
  private socket: WebSocketRoute | null = null
  private held: (() => void)[] | null = null

  static async on(page: Page): Promise<FakeRemote> {
    const remote = new FakeRemote()
    await page.routeWebSocket(/\/ws$/, socket => {
      remote.socket = socket
      const app = socket.connectToServer()
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw)) as { id: number; method: string; params?: { label?: string; keyId?: string } }
        if (message.method === 'remote.status') remote.reply(message.id, remote.status())
        else if (message.method === 'remote.linkBrowser') remote.mint(message.id, message.params?.label)
        else if (message.method === 'remote.revokeBrowser') {
          remote.revoked.push(message.params!.keyId!)
          remote.gone(message.params!.keyId!)
          remote.reply(message.id, remote.status())
        } else app.send(raw)
      })
      app.onMessage(raw => {
        if (!String(raw).includes('"event":"remote.changed"')) socket.send(raw)
      })
    })
    return remote
  }

  status() {
    return {
      cloudUrl: 'https://magnetar.example', paired: true, deviceId: 'dev1', deviceName: 'Mac', accountEmail: 'me@example.com',
      connected: true, pendingPairing: null, browsers: this.browsers, lastError: null,
    }
  }

  /** Tells the dashboard about the browsers now, as the device does whenever they change. */
  changed(browsers: Browser[]) {
    this.browsers = browsers
    this.socket!.send(JSON.stringify({ event: 'remote.changed', data: this.status() }))
  }

  /** A browser connects with the key: the device records the time and tells every dashboard. */
  use(keyId: string) {
    this.changed(this.browsers.map(b => (b.keyId === keyId ? { ...b, lastSeenAt: new Date().toISOString() } : b)))
  }

  /** The key leaves the list: the link went unused until it expired, or someone revoked it. */
  gone(keyId: string) {
    this.changed(this.browsers.filter(b => b.keyId !== keyId))
  }

  /** Holds the next links back until `release`. */
  hold() {
    this.held = []
  }

  release() {
    const held = this.held ?? []
    this.held = null
    for (const send of held) send()
  }

  private mint(id: number, label: string | undefined) {
    this.minted.push(label)
    const keyId = `key${this.minted.length}`
    const send = () => {
      this.changed([...this.browsers, { keyId, label: label ?? 'Linked browser', createdAt: new Date().toISOString(), lastSeenAt: null }])
      this.reply(id, { url: `https://magnetar.example/link#d=dev1&i=${keyId}&k=${'A'.repeat(43)}`, keyId, expiresIn: 600 })
    }
    if (this.held) this.held.push(send)
    else send()
  }

  private reply(id: number, result: unknown) {
    this.socket!.send(JSON.stringify({ id, result }))
  }
}

async function openLink(page: Page, label: string) {
  await page.getByRole('textbox', { name: 'Name for the new browser' }).fill(label)
  await page.getByRole('button', { name: 'Link a phone or another browser' }).click()
  const link = dialog(page, 'Link another browser')
  await expect(link.getByRole('img', { name: 'Link another browser' })).toBeVisible()
  return link
}

/** A browser's row in the list of linked browsers. */
const row = (page: Page, label: string) => page.locator('div.flex')
  .filter({ has: page.getByText(label, { exact: true }) })
  .filter({ has: page.getByRole('button', { name: 'Revoke' }) })
  .last()

test('the link dialog closes by itself once the browser it is for has linked, and says which one', async ({ page }) => {
  const remote = await FakeRemote.on(page)
  await page.goto('/settings/remote')
  const link = await openLink(page, 'My phone')
  await expect(link.getByRole('textbox', { name: 'Link another browser' })).toHaveValue(/i=key1&/)

  // Another browser connecting is not this link being used.
  remote.use('laptop')
  await expect(row(page, 'Laptop')).toContainText('Last used')
  await expect(link).toBeVisible()
  await expect(linkedToast(page)).toHaveCount(0)

  remote.use('key1')
  await expect(link).toBeHidden()
  await expect(linkedToast(page)).toHaveText('Browser linked: My phone')
  await expect(row(page, 'My phone')).toContainText('Last used')
})

test('the dialog counts down the link, says when it expired and offers a new one for the same browser', async ({ page }) => {
  await page.clock.install()
  const remote = await FakeRemote.on(page)
  await page.goto('/settings/remote')
  const link = await openLink(page, 'Tablet')
  await expect(link).toContainText('If no browser opens it, this link stops working in 10 min')
  await page.clock.fastForward('04:00')
  await expect(link).toContainText('stops working in 6 min')

  await page.clock.fastForward('06:00')
  await expect(link).not.toContainText('stops working')
  remote.gone('key1')
  await expect(link).toContainText('This link expired before a browser used it.')
  await expect(link.getByRole('img')).toHaveCount(0)
  await expect(link.getByRole('textbox')).toHaveCount(0)
  await expect(link.getByRole('button', { name: 'New link' })).toBeFocused()

  remote.hold()
  await link.getByRole('button', { name: 'New link' }).click()
  await expect(link.getByRole('button', { name: 'New link' })).toBeDisabled()
  remote.release()
  await expect(link.getByRole('textbox', { name: 'Link another browser' })).toHaveValue(/i=key2&/)
  await expect(link).toContainText('stops working in 10 min')
  expect(remote.minted).toEqual(['Tablet', 'Tablet'])

  remote.use('key2')
  await expect(link).toBeHidden()
  await expect(linkedToast(page)).toHaveText('Browser linked: Tablet')
})

test('a link revoked elsewhere while it is shown says so', async ({ page }) => {
  const remote = await FakeRemote.on(page)
  await page.goto('/settings/remote')
  const link = await openLink(page, 'Tablet')
  remote.gone('key1')
  await expect(link).toContainText('This link was revoked before a browser used it.')
  await expect(link.getByRole('img')).toHaveCount(0)
  await link.getByRole('button', { name: 'New link' }).click()
  await expect(link.getByRole('textbox', { name: 'Link another browser' })).toHaveValue(/i=key2&/)
})

test('a browser named nowhere is announced without a name', async ({ page }) => {
  const remote = await FakeRemote.on(page)
  await page.goto('/settings/remote')
  const link = await openLink(page, '')
  remote.use('key1')
  await expect(link).toBeHidden()
  await expect(linkedToast(page)).toHaveText('Browser linked')
})

test('a link dialog closed by hand stays closed, whatever becomes of its link', async ({ page }) => {
  const remote = await FakeRemote.on(page)
  await page.goto('/settings/remote')
  const link = await openLink(page, 'My phone')
  await link.getByRole('button', { name: 'Done' }).click()
  await expect(link).toBeHidden()

  remote.use('key1')
  await expect(row(page, 'My phone')).toContainText('Last used')
  await expect(dialog(page, 'Link another browser')).toBeHidden()
  await expect(linkedToast(page)).toHaveCount(0)

  // A new link that arrives after its dialog was closed does not open it again, nor stays in the list.
  const second = await openLink(page, 'Tablet')
  remote.gone('key2')
  await expect(second).toContainText('This link was revoked')
  remote.hold()
  await second.getByRole('button', { name: 'New link' }).click()
  await expect(second.getByRole('button', { name: 'New link' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(second).toBeHidden()
  remote.release()
  await expect.poll(() => ({ minted: remote.minted.length, revoked: remote.revoked })).toEqual({ minted: 3, revoked: ['key3'] })
  await expect(row(page, 'Tablet')).toHaveCount(0)
  await expect(dialog(page, 'Link another browser')).toBeHidden()
})

test('leaving the page with the link dialog open forgets the link', async ({ page }) => {
  const remote = await FakeRemote.on(page)
  await page.goto('/settings/remote')
  await openLink(page, 'My phone')
  // In-app navigation (Back), so the section unmounts while the page stays.
  await page.evaluate(() => {
    history.pushState(null, '', '/settings/general')
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page')
  await expect(dialog(page, 'Link another browser')).toBeHidden()

  remote.use('key1')
  await page.getByRole('link', { name: 'Remote access' }).click()
  await expect(row(page, 'My phone')).toContainText('Last used')
  await expect(dialog(page, 'Link another browser')).toBeHidden()
  await expect(linkedToast(page)).toHaveCount(0)
})
