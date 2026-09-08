import { expect, test, type Page } from '@playwright/test'
import { createFixture } from '../baseline/fixtures'

async function prepareStartup(page: Page, withAccount = false) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.route('https://**/*', route =>
    new URL(route.request().url()).hostname === 'fonts.googleapis.com'
      ? route.fulfill({ status: 200, contentType: 'text/css', body: '' })
      : route.abort(),
  )
  const fixture = createFixture()
  await page.addInitScript(({ accounts, folders }) => {
    const calls: string[] = []
    const unexpected: string[] = []
    const replies: Record<string, unknown> = {
      'system.check': {
        platform: 'windows',
        mail_engine: 'meron_mail',
        meron_mail: { configured: true, available: true, server_path: 'synthetic' },
        gmail_oauth_configured: false,
        outlook_oauth_configured: false,
        database_path: 'synthetic',
      },
      'account.list': { accounts },
      'mail.folderList': { folders },
      'mail.threadList': { threads: [], next_cursor: '', pagination: 'conversation-v1' },
      'tasks.list': { tasks: [] },
      'people.list': { people: [] },
      'calendar.list': { calendars: [] },
      'storage.usage': { cacheBytes: 0, dbBytes: 0 },
      'mail.allocateIdentity': { message_id: '<synthetic-draft@example.test>' },
      'mail.saveDraft': { ok: true },
      'rules.list': { rules: [] },
      'templates.list': { templates: [] },
      'carddav.list': { sources: [] },
      'pgp.certs': { certs: [] },
      'pgp.secretKeys': { keys: [] },
      'smime.certs': { certs: [] },
      'smime.identities': { identities: [] },
      'mail.suggestContacts': { contacts: [] },
      'app.prefsGet': { prefs: { auto_update_check: false } },
      'app.prefsSet': { ok: true },
      'mailto.consumePending': [],
      'i18n.setNativeLabels': { ok: true },
      'composer.pruneMedia': { removed: 0 },
      'labels.list': { labels: [] },
      'mail.scheduledSends': { messages: [] },
      'tray.setUnread': { ok: true },
      'update.status': { state: 'idle', supported: false, managed: false, channel: 'portable', currentVersion: '0.1.0' },
    }
    Object.assign(window, {
      startupProbe: { calls, unexpected },
      go: { main: { App: { Invoke: async (command: string) => {
        calls.push(command)
        if (!Object.hasOwn(replies, command)) {
          unexpected.push(command)
          throw new Error(`Unexpected startup command: ${command}`)
        }
        return structuredClone(replies[command])
      } } } },
    })
  }, { accounts: withAccount ? [{ ...fixture.account, conversation_html: true }] : [], folders: withAccount ? fixture.folders : [] })
  return errors
}

test('production entry boots onboarding and survives reload without React errors', async ({ page }) => {
  const errors = await prepareStartup(page)
  for (let launch = 0; launch < 2; launch++) {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Connect a Mail Account' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeDisabled()
    await page.getByRole('tab', { name: 'IMAP / SMTP' }).click()
    await expect(page.getByRole('tab', { name: 'IMAP / SMTP' })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: 'Exchange', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Exchange', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText(/Something went wrong/)).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => (window as any).startupProbe.calls)).toContain('account.list')
    expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
    expect(errors).toEqual([])
  }
})

test('production shell navigates settings, people, tasks and composer without hook errors', async ({ page }) => {
  const errors = await prepareStartup(page, true)
  await page.goto('/')
  await expect(page.getByTitle('More', { exact: true })).toBeVisible()
  await page.keyboard.press('Control+,')
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByTitle('People', { exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).startupProbe.calls)).toContain('people.list')
  await page.getByTitle('Tasks', { exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).startupProbe.calls)).toContain('tasks.list')
  await page.getByTitle('Tasks', { exact: true }).click()
  await page.keyboard.press('Control+n')
  const editor = page.locator('.tiptap[contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.fill('Synthetic draft. No message is sent.')
  await expect(editor).toContainText('Synthetic draft.')
  await expect(page.getByText(/Something went wrong/)).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
  expect(errors).toEqual([])
})
