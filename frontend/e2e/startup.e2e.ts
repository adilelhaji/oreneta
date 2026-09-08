import { expect, test, type Page } from '@playwright/test'
import { createFixture } from '../baseline/fixtures'

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as any).startupProbe?.unexpected ?? [])).toEqual([])
})

type SetupOptions = {
  oauth?: 'waiting' | 'late' | 'success' | 'error'
  discovery?: 'guess' | 'failure'
  saveError?: boolean
  language?: string
  existingEmail?: string
}
async function prepareStartup(page: Page, withAccount = false, options: SetupOptions = {}) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.route('https://**/*', (route) =>
    new URL(route.request().url()).hostname === 'fonts.googleapis.com'
      ? route.fulfill({ status: 200, contentType: 'text/css', body: '' })
      : route.abort(),
  )
  const fixture = createFixture()
  await page.addInitScript(
    ({ accounts, folders, template, options }) => {
      const calls: string[] = []
      const unexpected: string[] = []
      const saves: Array<{ command: string; payload: Record<string, unknown> }> = []
      const replies: Record<string, unknown> = {
        'system.check': {
          platform: 'windows',
          mail_engine: 'meron_mail',
          meron_mail: { configured: true, available: true, server_path: 'synthetic' },
          gmail_oauth_configured: !!options.oauth,
          outlook_oauth_configured: !!options.oauth,
          database_path: 'synthetic',
        },
        'account.list': { accounts },
        'mail.folderList': { folders },
        'mail.threadList': { threads: [], next_cursor: '', pagination: 'conversation-v1' },
        'tasks.list': { tasks: [] },
        'people.list': { people: [] },
        'calendar.list': { calendars: [] },
        'storage.usage': { cacheBytes: 0, dbBytes: 0 },
        'oof.get': { kind: 'imap', settings: { enabled: false, startAt: 0, endAt: 0, subject: '', body: '' } },
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
        'app.prefsGet': { prefs: { auto_update_check: false, language: options.language } },
        'app.prefsSet': { ok: true },
        'mailto.consumePending': [],
        'i18n.setNativeLabels': { ok: true },
        'composer.pruneMedia': { removed: 0 },
        'labels.list': { labels: [] },
        'mail.scheduledSends': { messages: [] },
        'tray.setUnread': { ok: true },
        'update.status': {
          state: 'idle',
          supported: false,
          managed: false,
          channel: 'portable',
          currentVersion: '0.1.0',
        },
      }
      Object.assign(window, {
        startupProbe: { calls, unexpected, saves },
        go: {
          main: {
            App: {
              Invoke: async (command: string, payload: Record<string, unknown>) => {
                calls.push(command)
                if (command === 'account.autodiscover') {
                  if (options.discovery === 'failure') throw new Error('Synthetic discovery outage')
                  return {
                    imap_host: 'imap.example.test',
                    imap_port: 993,
                    smtp_host: 'smtp.example.test',
                    smtp_port: 465,
                    username: payload.email,
                    source: options.discovery === 'guess' ? 'guess' : 'autoconfig',
                  }
                }
                if (command === 'oauth.gmailBegin' || command === 'oauth.outlookBegin') {
                  if (options.oauth === 'error') throw new Error('Synthetic browser unavailable')
                  return { url: 'https://login.example.test/authorize', needs_external_browser: true }
                }
                if (command === 'oauth.gmailPollProfile' || command === 'oauth.outlookPollProfile') {
                  const result = {
                    exchanged: true,
                    profile: {
                      email: 'authorized@example.test',
                      display_name: 'Authorized',
                      avatar_url: '',
                      access_token: 'synthetic-access',
                      refresh_token: 'synthetic-refresh',
                      expires_in: 3600,
                      auth_code: 'synthetic-code',
                    },
                  }
                  if (options.oauth === 'late')
                    return new Promise((resolve) => {
                      ;(window as any).startupProbe.finishOAuth = () => resolve(result)
                    })
                  return options.oauth === 'success' ? result : { exchanged: false }
                }
                if (
                  [
                    'account.addPassword',
                    'account.addEWS',
                    'account.addRSS',
                    'account.addOutlookOAuth',
                    'account.addGmailOAuth',
                  ].includes(command)
                ) {
                  saves.push({ command, payload })
                  if (options.saveError && saves.length === 1) throw new Error('Synthetic credentials rejected')
                  const account = {
                    ...template,
                    id: String(payload.email || 'rss-synthetic'),
                    email: String(payload.email || ''),
                    conversation_html: true,
                  }
                  replies['account.list'] = { accounts: [...accounts, account] }
                  return { account }
                }
                if (!Object.hasOwn(replies, command)) {
                  unexpected.push(command)
                  throw new Error(`Unexpected startup command: ${command}`)
                }
                return structuredClone(replies[command])
              },
            },
          },
        },
      })
    },
    {
      accounts: withAccount
        ? [{ ...fixture.account, email: options.existingEmail ?? fixture.account.email, conversation_html: true }]
        : [],
      folders: withAccount ? fixture.folders : [],
      template: fixture.account,
      options,
    },
  )
  return errors
}

test('production entry boots onboarding and survives reload without React errors', async ({ page }) => {
  const errors = await prepareStartup(page)
  for (let launch = 0; launch < 2; launch++) {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Connect a Mail Account' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Email Address', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Google', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeDisabled()
    await expect(page.getByText(/Google sign-in is not configured/)).toBeVisible()
    await page.getByRole('button', { name: 'Manual setup', exact: true }).click()
    await page.getByRole('button', { name: /Exchange Exchange mail/ }).click()
    await expect(page.getByRole('textbox', { name: 'EWS server URL' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Email Address', exact: true }).fill('invalid')
    await expect(page.getByRole('alert')).toContainText('complete email address')
    await expect(page.getByRole('button', { name: 'Save Account', exact: true })).toBeDisabled()
    await expect(page.getByText(/Something went wrong/)).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => (window as any).startupProbe.calls)).toContain('account.list')
    expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
    expect(errors).toEqual([])
  }
})

test('email-first setup validates input, recommends exact providers and preserves address on Back', async ({
  page,
}) => {
  const errors = await prepareStartup(page)
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Email Address', exact: true }).fill('not-an-address')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('complete email address')
  expect(await page.evaluate(() => (window as any).startupProbe.calls)).not.toContain('account.autodiscover')
  await page.getByRole('textbox', { name: 'Email Address', exact: true }).fill('  person@gmail.com  ')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Sign in with Outlook' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Email Address', exact: true })).toHaveValue('person@gmail.com')
  expect(errors).toEqual([])
})

test('manual discovery, rejected credentials and retry use the existing account save contract', async ({ page }) => {
  const errors = await prepareStartup(page, false, { saveError: true })
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Email Address', exact: true }).fill('new@example.test')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Server settings found')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password')
  await page.getByRole('button', { name: 'Save Account', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Synthetic credentials rejected')
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('synthetic-password')
  await expect(page.getByLabel('IMAP Host', { exact: true })).toHaveValue('imap.example.test')
  await page.getByRole('button', { name: 'Save Account', exact: true }).click()
  await expect(page.getByTitle('More', { exact: true })).toBeVisible()
  const saves = await page.evaluate(() => (window as any).startupProbe.saves)
  expect(saves).toHaveLength(2)
  expect(saves[1].payload).toMatchObject({
    email: 'new@example.test',
    imap_host: 'imap.example.test',
    tls: true,
    smtp_tls: true,
  })
  expect(errors).toEqual([])
})

for (const discovery of ['guess', 'failure'] as const) {
  test(`discovery ${discovery} exposes manual settings and Back discards credentials`, async ({ page }) => {
    await prepareStartup(page, false, { discovery })
    await page.goto('/')
    await page.getByRole('textbox', { name: 'Email Address', exact: true }).fill('person@example.test')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.getByRole('status')).toContainText(
      discovery === 'guess' ? 'No published settings' : 'Could not look up',
    )
    await expect(page.getByLabel('IMAP Host', { exact: true })).toBeVisible()
    await page.getByLabel('Password', { exact: true }).fill('synthetic-secret')
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('textbox', { name: 'Email Address', exact: true }).fill('other@example.test')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
    await expect(page.getByRole('button', { name: 'Save Account', exact: true })).toBeDisabled()
  })
}

test('manual options allow RSS without an email and the same wizard opens inside the app', async ({ page }) => {
  await prepareStartup(page, true)
  await page.goto('/')
  await page.getByTitle('More', { exact: true }).click()
  await page.getByText('Add account', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add Account' })
  await expect(dialog.getByRole('textbox', { name: 'Email Address', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Manual setup', exact: true }).click()
  await dialog.getByRole('button', { name: /RSS \/ Atom/ }).click()
  await expect(dialog.getByRole('textbox', { name: 'Account Name', exact: true })).not.toHaveValue('')
  await expect(dialog.getByRole('button', { name: 'Save Account', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).startupProbe.saves)).toEqual([])
})

test('Back cancels a pending OAuth result without adding its account', async ({ page }) => {
  const errors = await prepareStartup(page, false, { oauth: 'late' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Microsoft', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in with Outlook' }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as any).startupProbe.finishOAuth)).toBe('function')
  await expect(page.getByRole('button', { name: 'Manual setup', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.evaluate(() => (window as any).startupProbe.finishOAuth())
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).startupProbe.saves)).toEqual([])
  expect(errors).toEqual([])
})

test('OAuth uses the browser-authorized identity, not the initially entered address', async ({ page }) => {
  const errors = await prepareStartup(page, false, { oauth: 'success' })
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Email Address', exact: true }).fill('suggested@outlook.com')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in with Outlook' }).click()
  await expect(page.getByTitle('More', { exact: true })).toBeVisible()
  const saves = await page.evaluate(() => (window as any).startupProbe.saves)
  expect(saves).toHaveLength(1)
  expect(saves[0]).toMatchObject({ command: 'account.addOutlookOAuth', payload: { email: 'authorized@example.test' } })
  expect(errors).toEqual([])
})

test('closing Add account invalidates an OAuth poll already in flight', async ({ page }) => {
  const errors = await prepareStartup(page, true, { oauth: 'late' })
  await page.goto('/')
  await page.getByTitle('More', { exact: true }).click()
  await page.getByText('Add account', { exact: true }).click()
  await page.getByRole('button', { name: 'Microsoft', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in with Outlook' }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as any).startupProbe.finishOAuth)).toBe('function')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Add Account' })).toHaveCount(0)
  await page.evaluate(() => (window as any).startupProbe.finishOAuth())
  expect(await page.evaluate(() => (window as any).startupProbe.saves)).toEqual([])
  expect(errors).toEqual([])
})

test('browser launch errors explain failure and allow another method', async ({ page }) => {
  await prepareStartup(page, false, { oauth: 'error' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Google', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in with Google' }).click()
  await expect(page.getByRole('alert')).toContainText('Synthetic browser unavailable')
  await page.getByRole('button', { name: 'Manual setup', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
})

test('Spanish onboarding fits a narrow window without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await prepareStartup(page, false, { language: 'es' })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Continuar', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'startup-results/account-setup-narrow.png', fullPage: true })
})

test('editing an existing account preserves its identity and stored password', async ({ page }) => {
  const errors = await prepareStartup(page, true, { existingEmail: 'alex@intranet' })
  await page.goto('/')
  await expect(page.getByTitle('More', { exact: true })).toBeVisible()
  await page.keyboard.press('Control+,')
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /Alex · Demo/ })
    .click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Account server settings' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Email Address', exact: true })).toBeDisabled()
  await expect(page.getByRole('textbox', { name: 'Email Address', exact: true })).toHaveValue('alex@intranet')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'IMAP Host', exact: true }).fill('imap.updated.test')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Account server settings' })).toHaveCount(0)
  const saves = await page.evaluate(() => (window as any).startupProbe.saves)
  expect(saves).toHaveLength(1)
  expect(saves[0]).toMatchObject({
    command: 'account.addPassword',
    payload: { email: 'alex@intranet', imap_host: 'imap.updated.test' },
  })
  expect(saves[0].payload).not.toHaveProperty('password')
  expect(errors).toEqual([])
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
