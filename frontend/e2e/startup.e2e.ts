import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { createFixture } from '../baseline/fixtures'
import { defaultCustomInput, deriveThemeTokens } from '../src/lib/themes'
import { SHORTCUT_SCHEMES } from '../src/lib/shortcuts'

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as any).startupProbe?.unexpected ?? [])).toEqual([])
})

type SetupOptions = {
  graph?: 'success' | 'pending' | 'late' | 'error'
  graphAccount?: boolean
  mixedGraphAccount?: boolean
  oauth?: 'waiting' | 'late' | 'success' | 'error'
  discovery?: 'guess' | 'failure'
  saveError?: boolean
  /**
   * The stored interface language. English unless given, so the checks that
   * read English text keep reading it; null leaves the row out, as on a fresh
   * profile, which starts in Catalan (#231, ADR-0062).
   */
  language?: string | null
  /**
   * The stored list view. The table unless given, so the checks written
   * against the table keep reading it; null leaves the row out, as on a
   * profile that never chose, which gets the automatic view (#283).
   */
  listView?: 'auto' | 'cards' | 'table' | null
  existingEmail?: string
  navigation?: boolean
  theme?: string
  hideAccounts?: boolean
  preferences?: Record<string, unknown>
  readerStress?: boolean
  /** A Gmail-style reply with quoted history and a fixed 1200px table (ADR-0046). */
  readerQuote?: boolean
  /** The first message asks for a read receipt (ADR-0048). */
  readReceipt?: boolean
  updatesSupported?: boolean
  syncHealth?: boolean
  manualRefresh?: boolean
  /** Translation models the synthetic core says are installed (#106). */
  installedModels?: string[]
  /** One conversation with an Arabic subject and sender (#226, ADR-0061). */
  arabicSubject?: boolean
}

// The registry the core ships, so the models the app is told about are real.
const translationRegistry = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../meron-core/src/translation/registry.json', import.meta.url)), 'utf8'),
) as Record<string, Record<string, { name: string; size: number; expectedSha256Hash: string }>>
function translationStatus(installed: string[] = []) {
  const pairs = Object.entries(translationRegistry).map(([key, parts]) => {
    const files = Object.entries(parts).map(([part, f]) => ({
      part,
      name: f.name,
      size: f.size,
      sha256: f.expectedSha256Hash,
    }))
    return {
      from: key.slice(0, 2),
      to: key.slice(2),
      files,
      size: files.reduce((n, f) => n + f.size, 0),
      installed: installed.includes(key),
    }
  })
  return {
    pairs,
    languages: [...new Set(pairs.flatMap((p) => [p.from, p.to]))].sort(),
    used: pairs.filter((p) => p.installed).reduce((n, p) => n + p.size, 0),
    quota: 1024 ** 3,
    source: 'https://github.com/adilelhaji/oreneta/releases/download/translation-models-0.3.3/',
    downloading: {},
  }
}

// Automated accessibility audit of the production entry: onboarding, and the
// mail workspace with an account, in both appearances. Critical and serious
// WCAG 2.1 A/AA violations fail the run; the complete result, moderate and
// minor findings included, is attached so #37 can read it. An automated audit
// checks what a rule can check — names, roles, contrast, structure — and is
// not the keyboard, focus and screen-reader evidence #37 still requires.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

for (const theme of ['oreneta-light', 'oreneta-dark']) {
  test(`accessibility audit: ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const errors = await prepareStartup(page, true, { navigation: true, theme })
    // Inbox categories (#91): tabs with counts and their coverage line.
    await page.addInitScript(() => {
      const replies = (window as any).startupProbe.replies
      replies['categories.list'] = {
        categories: [{ id: 'news', name: 'Newsletters', colour: '#2056dd', matchMode: 'any', conditions: [] }],
      }
      replies['categories.counts'] = {
        counts: [{ category: 'news', conversations: 2, unread: 1 }, { category: '', conversations: 3, unread: 0 }],
        conversations: 5,
        messages: 8,
      }
    })
    await page.goto('/')
    await expect(page.getByRole('textbox').first()).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Inbox categories' })).toBeVisible()
    const blocking: string[] = []
    const audit = async (screen: string) => {
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
      const body = JSON.stringify(
        {
          screen,
          theme,
          url: results.url,
          violations: results.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            help: violation.help,
            nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
          })),
          passes: results.passes.length,
          incomplete: results.incomplete.map((rule) => rule.id),
        },
        null,
        2,
      )
      // Attached to the report and written beside the screenshots, so the
      // uploaded evidence carries the full audit without opening the report.
      await info.attach(`axe-${screen}-${theme}`, { body, contentType: 'application/json' })
      writeFileSync(info.outputPath(`axe-${screen}.json`), body)
      for (const violation of results.violations) {
        if (violation.impact === 'critical' || violation.impact === 'serious') {
          blocking.push(`${screen}: ${violation.id} (${violation.impact}) on ${violation.nodes.length} node(s)`)
        }
      }
    }
    await audit('mailbox')
    // The conversation pane with a message open, which is where most of the
    // day is spent.
    const row = page.getByRole('row').first()
    if (await row.isVisible()) {
      await row.click()
      await audit('conversation')
    }
    // The address book with a local contact open, then its editor (ADR-0012).
    await page.evaluate(() => {
      ;(window as any).startupProbe.replies['people.list'] = {
        people: [
          {
            id: 'local::local:synthetic',
            source: 'local',
            account: '',
            book: 'local',
            name: 'Synthetic Contact',
            organisation: 'Example Org',
            note: '',
            photo: '',
            emails: [{ addr: 'synthetic@example.test', label: '' }],
            phones: [],
            version: '1',
            editable: true,
          },
        ],
      }
    })
    await page.getByTitle('People', { exact: true }).click()
    await page.getByRole('option', { name: /Synthetic Contact/ }).click()
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
    await audit('people')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await info.attach(`people-editor-${theme}`, {
      body: await page.screenshot({ path: info.outputPath('people-editor.png'), animations: 'disabled' }),
      contentType: 'image/png',
    })
    await audit('people-editor')
    await page.keyboard.press('Escape')
    // Tasks with lists, a standalone task, and its editor (ADR-0013).
    await page.evaluate(() => {
      const replies = (window as any).startupProbe.replies
      replies['tasks.lists'] = {
        lists: [
          { id: 'mail', name: '', position: 0, open: 0 },
          { id: 'list:home', name: 'Home', position: 1, open: 1 },
        ],
      }
      replies['tasks.list'] = {
        tasks: [
          {
            id: 2, thread_id: '', account_id: '', folder_id: '', note: 'Washer is in the drawer', due_at: null,
            completed_at: null, created_at: 0, subject: '', from_name: '', from_addr: '', linked: false,
            list_id: 'list:home', title: 'Fix the tap', priority: 2, reminder_at: null, revision: 1,
          },
          {
            id: 3, thread_id: '', account_id: '', folder_id: '', note: '', due_at: 1760000000,
            completed_at: null, created_at: 0, subject: '', from_name: '', from_addr: '', linked: false,
            list_id: 'list:home', title: 'Water the plants', priority: 1, reminder_at: null, revision: 1,
            recurrence: { freq: 'weekly', interval: 1, weekdays: [1] },
          },
        ],
      }
      replies['tasks.get'] = {
        title: 'Fix the tap', note: 'Washer is in the drawer', due_at: null, list_id: 'list:home',
        priority: 2, reminder_at: null, revision: 1, linked: false,
        recurrence: { freq: 'monthly', interval: 1, weekdays: [], month_week: null },
      }
    })
    await page.getByTitle('Tasks', { exact: true }).click()
    await expect(page.getByText('Fix the tap')).toBeVisible()
    // A repeating task says how it repeats, and completing it asks (ADR-0053).
    await expect(page.getByText('Every week')).toBeVisible()
    await audit('tasks')
    await page.getByText('Fix the tap').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await info.attach(`task-editor-${theme}`, {
      body: await page.screenshot({ path: info.outputPath('task-editor.png'), animations: 'disabled' }),
      contentType: 'image/png',
    })
    await expect(page.getByLabel('Repeats')).toHaveValue('monthly')
    await audit('task-editor')
    await page.keyboard.press('Escape')
    // Notes: the list with a tagged, pinned note and that note open (ADR-0015).
    await page.evaluate(() => {
      const replies = (window as any).startupProbe.replies
      const note = {
        id: 'note:synthetic', title: 'Synthetic note', html: '<p>Kept on this computer.</p>',
        text: 'Kept on this computer.', tags: ['ideas'], pinned: true, revision: 1, created_at: 0,
        updated_at: 1760000000, deleted_at: null,
      }
      replies['notes.list'] = {
        notes: [{ ...note, preview: note.text }],
        tags: [{ tag: 'ideas', count: 1 }],
      }
      replies['notes.get'] = { note }
    })
    await page.getByTitle('Notes', { exact: true }).click()
    await page.getByRole('button', { name: /Synthetic note/ }).click()
    await expect(page.getByLabel('Title')).toHaveValue('Synthetic note')
    await info.attach(`notes-${theme}`, {
      body: await page.screenshot({ path: info.outputPath('notes.png'), animations: 'disabled' }),
      contentType: 'image/png',
    })
    await audit('notes')
    // Attachments across accounts, with coverage said (#93).
    await page.evaluate(() => {
      ;(window as any).startupProbe.replies['attachments.list'] = {
        items: [
          {
            account: 'synthetic@example.test', folder: 'INBOX', uid: 2, thread_key: 'k', thread_id: 'synthetic@example.test#INBOX#2',
            subject: 'Quarterly numbers', from_name: 'Synthetic Sender', from_addr: 'sender@example.test', date: 1760000000,
            index: 0, filename: 'report.pdf', mime: 'application/pdf', size: 90000, key: null, kind: 'pdf', unavailable: '',
          },
        ],
        total: 1,
        coverage: { messages: 10, downloaded: 7 },
      }
    })
    await page.getByTitle('Attachments', { exact: true }).click()
    await expect(page.getByText('report.pdf')).toBeVisible()
    await audit('attachments')
    // Chat over XMPP (#111): a conversation with each kind of send state.
    await page.evaluate(() => {
      const replies = (window as any).startupProbe.replies
      replies['chat.accounts'] = [{ id: 'c1', jid: 'ana@chat.test', host: '', port: 5222 }]
      replies['chat.status'] = { c1: { account: 'c1', state: 'online' } }
      replies['chat.conversations'] = [
        { conversation: 'pau@chat.test', last_body: '¿Sigues ahí?', last_stamp: 1760000120, last_direction: 'out', unread: 1 },
      ]
      replies['chat.history'] = [
        { account: 'c1', conversation: 'pau@chat.test', id: 'm1', stanza_id: 'a1', direction: 'in', sender: 'pau@chat.test', body: 'Hola Ana', stamp: 1760000000, state: 'received' },
        { account: 'c1', conversation: 'pau@chat.test', id: 's1', stanza_id: null, direction: 'out', sender: 'ana@chat.test', body: 'Hola', stamp: 1760000060, state: 'delivered' },
        { account: 'c1', conversation: 'pau@chat.test', id: 's2', stanza_id: null, direction: 'out', sender: 'ana@chat.test', body: '¿Sigues ahí?', stamp: 1760000120, state: 'uncertain' },
      ]
    })
    await page.getByTitle('Chat', { exact: true }).click()
    await page.getByRole('button', { name: /pau@chat.test/ }).click()
    await expect(page.getByText('May not have arrived')).toBeVisible()
    await audit('chat')
    expect(blocking).toEqual([])
    expect(errors).toEqual([])
  })
}

test('accessibility audit: onboarding', async ({ page }, info) => {
  const errors = await prepareStartup(page)
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: 'Email Address', exact: true })).toBeVisible()
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  const body = JSON.stringify(results.violations, null, 2)
  await info.attach('axe-onboarding', { body, contentType: 'application/json' })
  writeFileSync(info.outputPath('axe-onboarding.json'), body)
  const blocking = results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => `${violation.id} (${violation.impact}) on ${violation.nodes.length} node(s)`)
  expect(blocking).toEqual([])
  expect(errors).toEqual([])
})

test('onboarding remains keyboard reachable in a short zoom-equivalent viewport', async ({ page }) => {
  const errors = await prepareStartup(page)
  await page.goto('/')
  const email = page.getByRole('textbox', { name: 'Email Address', exact: true })
  await email.focus()
  // 1024x700 desktop content at 250% native zoom is about 410x280 CSS px.
  await page.setViewportSize({ width: 410, height: 280 })
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(email).toBeFocused()
  await expect(email).toBeInViewport()
  const box = (await email.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(410)
  for (const name of ['Continue', 'Google', 'Microsoft', 'Microsoft Graph — Read-only', 'Manual setup']) {
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name, exact: true })).toBeFocused()
    await expect(page.getByRole('button', { name, exact: true })).toBeInViewport()
  }
  expect(errors).toEqual([])
})

for (const width of [1440, 1024]) {
  test(`keyboard zoom to 200% keeps the mailbox, reader and composer on screen and survives a reload, ${width}px (#181)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    const errors = await prepareStartup(page, true, { navigation: true })
    await page.goto('/')
    const search = page.getByRole('textbox').first()
    await expect(search).toBeVisible()
    const rootSize = () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
    expect(await rootSize()).toBe('32px')
    await expect(page.getByText('Size 200%')).toBeVisible()
    const onScreen = async (where: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), where).toBe(true)
      const outside = await page.evaluate(() => [...document.querySelectorAll('button, [role=button]')]
        .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1) })
        .map((element) => element.getAttribute('aria-label') ?? element.textContent?.trim()))
      expect(outside, where).toEqual([])
    }
    await onScreen('mailbox')
    // The reader and the composer at the same size.
    await page.getByRole('row').filter({ hasText: 'Sep 8' }).first().click()
    await expect(page.getByText('No Conversation Selected')).toBeHidden()
    await onScreen('reader')
    await page.keyboard.press(`${mod}+KeyN`)
    await expect(page.getByPlaceholder('Subject')).toBeVisible()
    await onScreen('composer')
    await page.screenshot({ path: info.outputPath('zoom-200-composer.png') })
    await page.goto('/')
    await expect(page.getByRole('textbox').first()).toBeVisible()
    // While typing: the text and the focus stay where they were.
    await search.click()
    await search.fill('budget')
    await page.keyboard.press(`${mod}+Minus`)
    expect(await rootSize()).toBe('28px')
    await expect(search).toBeFocused()
    await expect(search).toHaveValue('budget')
    await page.reload()
    await expect(page.getByRole('textbox').first()).toBeVisible()
    expect(await rootSize()).toBe('28px')
    await page.keyboard.press(`${mod}+Digit0`)
    expect(await rootSize()).toBe('16px')
    expect(errors).toEqual([])
  })
}

for (const theme of ['oreneta-light', 'oreneta-dark']) {
  for (const width of [1440, 600]) {
    test(`secondary screen design: ${theme}, ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors = await prepareStartup(page, true, { navigation: true, language: 'es', theme })
      await page.goto('/')
      // The mailbox is up. (Its search field, the first textbox before #344, is
      // a button in the top band below 769 px.)
      await expect(page.locator('[data-thread-list]')).toBeVisible()
      const openArea = async (name: string) => {
        // Narrow: the areas are items of the More menu (#289).
        if (width < 769) {
          await page.getByRole('button', { name: 'Más', exact: true }).click()
          await page.getByRole('menuitem', { name, exact: true }).click()
        } else {
          await page.getByRole('button', { name, exact: true }).click()
        }
      }
      const bounds = async () => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        for (const button of await page.getByRole('button').all()) {
          if (await button.isVisible()) expect(await button.evaluate((element) => {
            const box = element.getBoundingClientRect(); return box.left >= -1 && box.right <= innerWidth + 1
          })).toBe(true)
        }
      }
      await page.evaluate(() => {
        const replies = (window as any).startupProbe.replies
        replies['people.list'] = { people: [{ id: 'synthetic-person', source: 'local', account: 'synthetic-account', book: '', name: 'Alejandra Martínez — Coordinación internacional de proyectos', organisation: 'Departamento de investigación y atención al cliente', note: 'Contacto sintético para comprobar texto largo y navegación.', photo: '', emails: [{ addr: 'coordinacion.internacional.proyectos@example.test', label: 'Trabajo' }], phones: [{ number: '+34 600 000 000', label: 'Móvil' }] }] }
        replies['tasks.list'] = { tasks: [{ id: 1, thread_id: 'thread-1', account_id: 'synthetic-account', folder_id: 'INBOX', subject: 'Revisar la propuesta de coordinación internacional y confirmar los próximos pasos', from_name: 'Alejandra Martínez', from_addr: 'alejandra@example.test', note: 'Revisión pendiente con información detallada', due_at: Math.floor(Date.now() / 1000) - 86400, completed_at: null, created_at: 0 }] }
        replies['calendar.events'] = { events: [] }
        replies['calendar.list'] = { calendars: [{ id: 'local-test', name: 'Planificación del equipo internacional', is_default: true, enabled: true, kind: 'local', read_only: false, synced_at: 0 }] }
        replies['calendar.setEnabled'] = { ok: true }
      })
      await openArea('Personas')
      const person = page.getByRole('option', { name: /Alejandra Martínez/ })
      await person.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('heading', { name: /Alejandra Martínez/ })).toBeVisible()
      await bounds()
      await page.evaluate(() => { document.documentElement.style.zoom = '2' })
      await bounds()
      await page.evaluate(() => { document.documentElement.style.zoom = '' })
      await page.setViewportSize({ width, height: 1000 })
      await info.attach('people', { body: await page.screenshot({ path: info.outputPath('people.png'), animations: 'disabled' }), contentType: 'image/png' })
      if (width < 769) {
        await page.getByRole('button', { name: 'Atrás', exact: true }).click()
        await expect(person).toBeFocused()
      }
      await openArea('Tareas')
      const task = page.getByRole('button', { name: /Revisar la propuesta de coordinación internacional/ })
      await expect(task).toBeVisible()
      await task.focus()
      await expect(task).toBeFocused()
      await bounds()
      await page.evaluate(() => { document.documentElement.style.zoom = '2' })
      await bounds()
      await page.evaluate(() => { document.documentElement.style.zoom = '' })
      await page.setViewportSize({ width, height: 1000 })
      await info.attach('tasks', { body: await page.screenshot({ path: info.outputPath('tasks.png'), animations: 'disabled' }), contentType: 'image/png' })
      await task.focus()
      await page.keyboard.press('Enter')
      await expect(task).toHaveCount(0)
      // Return to the list before opening its compact menu.
      if (width < 769) await page.getByRole('button', { name: 'Volver a los chats', exact: true }).click()
      await openArea('Calendario')
      const month = page.getByRole('button', { name: 'Mes', exact: true })
      await month.click()
      await expect(month).toHaveAttribute('aria-pressed', 'true')
      const monthName = await page.evaluate(() => new Date().toLocaleDateString('es', { month: 'long', year: 'numeric' }))
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(new RegExp(monthName, 'i'))
      await expect(page.getByText('lun', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Periodo siguiente' })).toBeVisible()
      await page.getByRole('button', { name: 'Periodo siguiente' }).click()
      await page.getByRole('button', { name: 'Periodo anterior' }).click()
      await expect(page.getByRole('button', { name: 'Planificación del equipo internacional', exact: true }).first()).toBeVisible()
      await bounds()
      await page.evaluate(() => { document.documentElement.style.zoom = '2' })
      await bounds()
      await expect(page.getByRole('button', { name: 'Nuevo evento', exact: true })).toBeVisible()
      if (width < 769) {
        const more = page.getByRole('button', { name: 'Más', exact: true })
        await more.click()
        const settings = page.getByRole('menuitem', { name: /Ajustes/ })
        await settings.scrollIntoViewIfNeeded()
        await expect(settings).toBeInViewport({ ratio: 1 })
        expect(await settings.evaluate((element) => {
          const box = element.parentElement!.getBoundingClientRect()
          return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
        })).toBe(true)
        const lastItem = page.getByRole('menuitem', { name: 'Acerca de Oreneta', exact: true })
        await lastItem.scrollIntoViewIfNeeded()
        await expect(lastItem).toBeInViewport({ ratio: 1 })
        await bounds()
        await page.keyboard.press('Escape')
        await expect(more).toBeFocused()
      }
      await page.evaluate(() => { document.documentElement.style.zoom = '' })
      await page.setViewportSize({ width, height: 1000 })
      await info.attach('calendar', { body: await page.screenshot({ path: info.outputPath('calendar.png'), animations: 'disabled' }), contentType: 'image/png' })
      expect(await page.evaluate(() => (window as any).startupProbe.calls.some((command: string) => ['mail.send', 'calendar.create', 'calendar.update', 'calendar.delete', 'calendar.respond'].includes(command)))).toBe(false)
      expect(errors).toEqual([])
    })
  }
}

for (const theme of ['oreneta-light', 'oreneta-dark']) {
  for (const width of [1440, 600]) {
    test(`manual refresh reports mixed requests without false completion: ${theme}, ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors = await prepareStartup(page, true, { navigation: true, language: 'es', theme, syncHealth: true, manualRefresh: true, preferences: { session_account: 'unified' } })
      await page.goto('/')
      // The account sync status is the top band's (#345): with nothing
      // prominent there is no bar under the header.
      await expect(page.locator('[data-band-end] [data-sync-status-button]')).toBeVisible()
      await page.evaluate(() => {
        const probe = (window as any).startupProbe
        probe.syncReply = (payload: any) => ({ ok: true, online: payload.account_id === 'synthetic-account' })
        probe.refreshStart = probe.requests.length
      })
      await page.keyboard.press('Control+Shift+r')
      const summary = page.getByRole('status').filter({ hasText: 'Comprobaciones de correo:' })
      await expect(summary).toContainText('1 aceptadas, 1 sin confirmar, 0 ya en curso y 0 omitidas')
      await expect(summary).toContainText('La finalización no está verificada')
      expect(await page.evaluate(() => { const probe = (window as any).startupProbe; return probe.requests.slice(probe.refreshStart).filter((item: any) => item.command === 'mail.sync').map((item: any) => item.payload.account_id) })).toEqual(['synthetic-account', 'second-account'])
      expect(await summary.evaluate((element) => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && element.scrollWidth <= element.clientWidth })).toBe(true)
      expect(await summary.locator('svg').evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(14)
      await page.evaluate(() => { document.documentElement.style.zoom = '2' })
      expect(await summary.evaluate((element) => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth })).toBe(true)
      await page.evaluate(() => { document.documentElement.style.zoom = '' })
      await info.attach('manual-refresh', { body: await page.screenshot({ path: info.outputPath('manual-refresh.png'), animations: 'disabled' }), contentType: 'image/png' })
      await page.evaluate(() => {
        const probe = (window as any).startupProbe
        probe.syncReply = () => ({ ok: true, online: true })
      })
      await page.keyboard.press('Control+k')
      const palette = page.getByRole('dialog', { name: 'Paleta de comandos' })
      await palette.getByRole('combobox').fill('sync')
      await palette.getByRole('option', { name: /^Sincronizar/ }).click()
      await expect(summary).toContainText('2 aceptadas, 0 sin confirmar')
      expect(await page.evaluate(() => (window as any).startupProbe.calls.includes('mail.send'))).toBe(false)
      expect(errors).toEqual([])
    })
  }
}

for (const theme of ['oreneta-light', 'oreneta-dark']) {
  for (const width of [1440, 600]) {
    test(`account sync observations remain honest and reachable: ${theme}, ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors = await prepareStartup(page, true, { navigation: true, language: 'es', theme, syncHealth: true })
      await page.goto('/')
      // The status is the top band's, there before any failure, and its live
      // region is the one that announces (#345). The bar under the header,
      // with its own button and detail, comes with the failures.
      const band = page.getByRole('banner').locator('[data-band-end]')
      const status = band.getByRole('status')
      const bandButton = band.locator('[data-sync-status-button]')
      const health = page.getByRole('region', { name: 'Sincronización de cuentas' })
      const toggle = health.getByRole('button', { name: 'Sincronización de cuentas', exact: true })
      await bandButton.focus()
      await page.evaluate(() => {
        const probe = (window as any).startupProbe
        probe.emit('mail.syncError', { account: 'synthetic-account', message: 'synthetic-private-diagnostic' })
        probe.emit('mail.syncError', { account: 'second-account', message: 'second diagnostic' })
        probe.emit('mail.synced', { account: 'synthetic-account', folder: 'Sent' })
        probe.emit('calendar.synced', { account: 'second-account' })
      })
      await expect(bandButton).toBeFocused()
      await expect(status).toContainText('2 requieren atención')
      await expect(health).toBeVisible()
      await toggle.focus()
      await page.keyboard.press('Enter')
      const first = health.getByRole('listitem', { name: 'Alex · Demo', exact: true })
      const second = health.getByRole('listitem', { name: 'Second account', exact: true })
      await expect(first).toContainText('Problema de sincronización pendiente')
      await expect(second).toContainText('Problema de sincronización pendiente')
      await expect(health).not.toContainText('synthetic-private-diagnostic')
      await first.getByRole('button', { name: 'Cerrar', exact: true }).click()
      await expect(first).toBeFocused()
      await toggle.click(); await toggle.click()
      await expect(first).toContainText('Problema de sincronización pendiente')
      const before = await page.evaluate(() => (window as any).startupProbe.requests.length)
      await second.getByRole('button', { name: 'Reintentar', exact: true }).click()
      await expect(second).toContainText('Solicitud sin confirmar')
      expect(await page.evaluate((start) => (window as any).startupProbe.requests.slice(start).filter((item: any) => item.command === 'mail.sync'), before)).toEqual([{ command: 'mail.sync', payload: { account_id: 'second-account' } }])
      await page.evaluate(() => { (window as any).startupProbe.replies['mail.sync'] = { ok: true, online: true } })
      await second.getByRole('button', { name: 'Reintentar', exact: true }).click()
      await expect(second).toContainText('Solicitud aceptada; finalización sin verificar')
      await expect(second).toContainText('Problema de sincronización pendiente')
      await page.evaluate(() => { document.documentElement.style.zoom = '2' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.evaluate(() => { document.documentElement.style.zoom = '' })
      await info.attach('account-sync-health', { body: await page.screenshot({ path: info.outputPath('account-sync-health.png'), animations: 'disabled' }), contentType: 'image/png' })
      await second.getByRole('button', { name: 'Ajustes de la cuenta', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Ajustes', exact: true })
      await expect(settings.locator('[data-settings-section="account"]')).toContainText('second@example.test')
      await page.keyboard.press('Escape')
      expect(await page.evaluate(() => (window as any).startupProbe.calls.some((command: string) => ['mail.send', 'mail.saveDraft'].includes(command)))).toBe(false)
      await page.reload()
      await expect(status).toHaveText('Sincronización completa sin verificar')
      await expect(health).toHaveCount(0)
      expect(errors).toEqual([])
    })
  }
}

for (const theme of ['oreneta-light', 'oreneta-dark']) {
  for (const width of [1440, 600]) {
    test(`localized settings discovery preserves edits and focus: ${theme}, ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors = await prepareStartup(page, true, { navigation: true, language: 'es', theme, updatesSupported: true })
      await page.goto('/')
      // The mail search: the band's field, or below 769 px the band's search
      // button that opens it (#344).
      const opener = width < 769 ? page.locator('[data-band-search-button]') : page.getByRole('textbox').first()
      await opener.focus()
      await page.keyboard.press('Control+k')
      const palette = page.getByRole('dialog', { name: 'Paleta de comandos' })
      const commands = palette.getByRole('combobox')
      await expect(commands).toBeFocused()
      await commands.fill('日本語')
      await expect(palette.getByRole('option')).toHaveCount(0)
      await expect(palette.getByRole('status')).toHaveText('No hay comandos coincidentes.')
      await commands.press('Enter')
      await expect(palette).toBeVisible()
      await commands.fill('tipografia')
      await expect(palette.getByRole('option', { name: 'Tipografía Ajuste', exact: true })).toBeVisible()
      const initialCommand = await commands.getAttribute('aria-activedescendant')
      await commands.press('ArrowDown')
      await expect(commands).not.toHaveAttribute('aria-activedescendant', initialCommand!)
      await commands.press('ArrowUp')
      await expect(commands).toHaveAttribute('aria-activedescendant', initialCommand!)
      await commands.press('Enter')
      const settings = page.getByRole('dialog', { name: 'Ajustes', exact: true })
      await expect(settings.locator('[data-settings-section="typography"]')).toBeFocused()
      const search = settings.getByRole('combobox', { name: 'Buscar ajustes' })
      await search.fill('firma')
      const initialSetting = await search.getAttribute('aria-activedescendant')
      await search.press('ArrowDown')
      await expect(search).not.toHaveAttribute('aria-activedescendant', initialSetting!)
      await search.press('ArrowUp')
      await expect(search).toHaveAttribute('aria-activedescendant', initialSetting!)
      await search.press('Enter')
      const signature = settings.locator('[data-settings-section="signature"]')
      await expect(signature).toBeFocused()
      const editor = signature.locator('[contenteditable="true"]')
      await editor.fill('Firma sintética pendiente — no enviar')
      // Searching and navigating must not discard an editor's pending debounce.
      await search.fill('actualizaciones')
      await search.press('Enter')
      await expect(settings.locator('[data-settings-section="updates"]')).toBeFocused()
      await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}').signature)).toContain('Firma sintética pendiente')
      await search.fill('privacidad')
      await search.press('Enter')
      await expect(settings.locator('[data-settings-section="privacy"]')).toBeFocused()
      await page.evaluate(() => { document.documentElement.style.zoom = '2' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expect(search).toBeInViewport()
      await page.evaluate(() => { document.documentElement.style.zoom = '' })
      await info.attach('settings-discovery', { body: await page.screenshot({ path: info.outputPath('settings-discovery.png'), animations: 'disabled' }), contentType: 'image/png' })
      await page.keyboard.press('Escape')
      await expect(settings).toHaveCount(0)
      await expect(opener).toBeFocused()
      await page.reload()
      await page.keyboard.press('Control+k')
      await commands.fill('signature')
      await commands.press('Enter')
      await expect(settings.locator('[data-settings-section="signature"] [contenteditable="true"]')).toContainText('Firma sintética pendiente')
      expect(await page.evaluate(() => (window as any).startupProbe.calls.includes('mail.send'))).toBe(false)
      expect(errors).toEqual([])
    })
  }
}

test('settings discovery keeps exact account context and omits unavailable update controls', async ({ page }) => {
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('updates')
  await expect(palette.getByRole('option', { name: 'Updates Setting', exact: true })).toHaveCount(0)
  await palette.getByRole('combobox').fill('second@example.test')
  await page.keyboard.press('Tab')
  await expect(palette.getByRole('option', { name: 'Account settings: Second account Setting', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(palette.getByRole('option', { name: 'Account signature: Second account Setting', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings.locator('[data-settings-section="accountSignature"]')).toBeFocused()
  await expect(settings.locator('[data-settings-section="account"]')).toContainText('second@example.test')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('navigation', { name: 'Accounts and folders' }).getByRole('button', { name: 'Inbox 3', exact: true })).toHaveAttribute('aria-current', 'page')
  expect(await page.evaluate(() => (window as any).startupProbe.calls.includes('mail.send'))).toBe(false)
  expect(errors).toEqual([])
})

test('Graph command discovery exposes read-only restrictions without running writes', async ({ page }) => {
  const errors = await prepareStartup(page, true, { navigation: true, graphAccount: true })
  await page.goto('/')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('compose new')
  const command = palette.getByRole('option', { name: /^Compose new message No account available for sending/ })
  await expect(command).toHaveAttribute('aria-disabled', 'true')
  await palette.getByRole('combobox').press('Enter')
  await expect(palette).toBeVisible()
  expect(await page.evaluate(() => (window as any).startupProbe.calls.filter((command: string) => ['mail.send', 'mail.saveDraft', 'mail.markAllRead'].includes(command)))).toEqual([])
  expect(errors).toEqual([])
})

test('Graph command discovery can compose from a different sendable account without sending', async ({ page }) => {
  const errors = await prepareStartup(page, true, { navigation: true, graphAccount: true, mixedGraphAccount: true })
  await page.goto('/')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('compose new')
  await expect(palette.getByRole('option', { name: /^Compose new message Action/ })).not.toHaveAttribute('aria-disabled', 'true')
  await palette.getByRole('combobox').press('Enter')
  await expect(palette).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('meron-compose-tabs') ?? '[]')[0]?.compose?.accountId)).toBe('second-account')
  expect(await page.evaluate(() => (window as any).startupProbe.calls.includes('mail.send'))).toBe(false)
  expect(errors).toEqual([])
})

for (const theme of ['oreneta-light', 'oreneta-dark']) {
  for (const width of [1440, 600]) {
    test(`mailbox column configuration persists without window overflow: ${theme}, ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors = await prepareStartup(page, true, { navigation: true, theme })
      await page.goto('/')
      const table = page.getByRole('table')
      await expect(table).toBeVisible()
      const open = page.getByRole('button', { name: 'Columns', exact: true })
      await open.focus()
      await page.keyboard.press('Enter')
      const editor = page.getByRole('dialog', { name: 'Columns' })
      await expect(editor).toBeFocused()
      await editor.getByRole('combobox', { name: 'Apply to' }).selectOption('folder')
      await editor.getByRole('checkbox', { name: 'Account', exact: true }).check()
      const move = editor.getByRole('button', { name: 'Move up: Account' })
      await move.focus()
      await page.keyboard.press('Enter')
      await editor.getByRole('spinbutton', { name: 'Width (px): From' }).fill('640')
      await editor.getByRole('spinbutton', { name: 'Width (px): Account' }).fill('500')
      await info.attach('mailbox-column-editor', { body: await page.screenshot({ path: info.outputPath('columns-editor.png'), animations: 'disabled' }), contentType: 'image/png' })
      await editor.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(open).toBeFocused()
      await expect(table.getByRole('columnheader')).toHaveText(['Select this conversation', 'From', 'Subject', 'Account', 'Date'])
      await expect(table.getByRole('columnheader', { name: 'Account' }).getByRole('button')).toHaveCount(0)
      const viewport = table.locator('..')
      expect(await viewport.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const checkbox = table.getByRole('checkbox').first()
      await checkbox.check()
      await expect(checkbox).toBeChecked()
      await checkbox.uncheck()
      await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}').mailbox_views?.folders.length)).toBe(1)
      await page.reload()
      await expect(table.getByRole('columnheader')).toHaveText(['Select this conversation', 'From', 'Subject', 'Account', 'Date'])
      await page.evaluate(() => { document.documentElement.style.zoom = '2' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.evaluate(() => { document.documentElement.style.zoom = '' })
      await open.click()
      await editor.getByRole('button', { name: 'Use general view' }).click()
      await expect(table.getByRole('columnheader', { name: 'Account', exact: true })).toHaveCount(0)
      expect(errors).toEqual([])
    })
  }
}

test('mailbox general view changes preserve folder exceptions across navigation and reload', async ({ page }) => {
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  const open = page.getByRole('button', { name: 'Columns', exact: true })
  const editor = page.getByRole('dialog', { name: 'Columns' })
  const accountHeader = page.getByRole('table').getByRole('columnheader', { name: 'Account', exact: true })
  await open.click()
  await editor.getByRole('combobox').selectOption('folder')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await open.click()
  await editor.getByRole('combobox').selectOption('general')
  await editor.getByRole('checkbox', { name: 'Account', exact: true }).check()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(accountHeader).toHaveCount(0)
  const nav = page.getByRole('navigation', { name: 'Accounts and folders' })
  await nav.getByRole('button', { name: 'Sent', exact: true }).click()
  await open.click()
  await expect(editor.getByRole('checkbox', { name: 'Account', exact: true })).toBeChecked()
  await editor.getByRole('button', { name: 'Close', exact: true }).click()
  await page.reload()
  await open.click()
  await expect(editor.getByRole('checkbox', { name: 'Account', exact: true })).toBeChecked()
  await editor.getByRole('button', { name: 'Close', exact: true }).click()
  await nav.getByRole('button', { name: 'Inbox 3', exact: true }).click()
  await expect(accountHeader).toHaveCount(0)
  await open.click()
  await editor.getByRole('button', { name: 'Use general view' }).click()
  await expect(accountHeader).toBeVisible()
  expect(errors).toEqual([])
})

test('future mailbox views survive hydration, cancellation and reload until explicit reset', async ({ page }) => {
  const future = { version: 7, opaque: ['preserve', { unrelated: true }] }
  const errors = await prepareStartup(page, true, { navigation: true, preferences: { mailbox_views: future } })
  await page.goto('/')
  await page.getByRole('button', { name: 'Columns', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Columns' })
  await expect(editor.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await editor.getByRole('button', { name: 'Close', exact: true }).click()
  expect(await page.evaluate(() => (window as any).startupProbe.requests.filter((request: any) => request.command === 'app.prefsSet' && request.payload.key === 'mailbox_views'))).toEqual([])
  await page.reload()
  await page.getByRole('button', { name: 'Columns', exact: true }).click()
  await editor.getByRole('button', { name: 'Reset all column views' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}').mailbox_views)).toBeNull()
  expect(errors).toEqual([])
})

test('Spanish column editor remains usable at 200 percent in a narrow window', async ({ page }, info) => {
  await page.setViewportSize({ width: 600, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, language: 'es', theme: 'oreneta-dark' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Columnas', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Columnas' })
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  await expect(editor.getByRole('button', { name: 'Guardar', exact: true })).toBeInViewport()
  expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.evaluate(() => { document.documentElement.style.zoom = '' })
  await info.attach('columnas-es', { body: await page.screenshot({ path: info.outputPath('columnas-es.png'), animations: 'disabled' }), contentType: 'image/png' })
  expect(errors).toEqual([])
})

for (const theme of ['oreneta-light', 'oreneta-dark']) {
  for (const width of [1440, 600]) {
    test(`reader body size and scoped controls: ${theme}, ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors = await prepareStartup(page, true, { navigation: true, theme, readerStress: true })
      await page.goto('/')
      await page
        .getByRole('table')
        .getByRole('button', { name: /Pilot checklist/ })
        .click()
      const size = page.getByRole('combobox', { name: 'Message text size' })
      const collapse = page.getByTitle('Collapse message', { exact: true }).first()
      await expect(collapse).toHaveAttribute('aria-expanded', 'true')
      const headerFont = await collapse.evaluate((el) => getComputedStyle(el).fontSize)
      const plain = page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })
      const plainFont = await plain.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
      const html = page.frameLocator('iframe[title="Message HTML"]').first()
      await expect(html.getByText('Wide synthetic invoice')).toBeVisible()
      await size.selectOption('200')
      await expect(html.locator('body')).toHaveCSS('zoom', '2')
      await expect(collapse).toHaveCSS('font-size', headerFont)
      await expect(plain).toHaveCSS('font-size', `${plainFont * 2}px`)
      await expect(html.locator('table')).toHaveAttribute('width', '1800')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const groups = page.getByRole('group', { name: /More message actions —/ })
      const firstGroup = groups.first()
      await expect(firstGroup.getByRole('button', { name: 'Forward', exact: true })).toBeInViewport()
      expect(await firstGroup.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await size.selectOption('100')
      await collapse.focus()
      await page.keyboard.press('Space')
      const expand = page.getByTitle('Expand message', { exact: true }).first()
      await expect(expand).toHaveAttribute('aria-expanded', 'false')
      await expand.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTitle('Collapse message', { exact: true }).first()).toHaveAttribute(
        'aria-expanded',
        'true',
      )
      await info.attach('reader-controls', {
        body: await page.screenshot({ path: info.outputPath('reader-controls.png'), animations: 'disabled' }),
        contentType: 'image/png',
      })
      await firstGroup.getByRole('button', { name: 'Open in new tab', exact: true }).click()
      await expect(size).toHaveValue('100')
      await size.selectOption('150')
      await expect(size).toHaveValue('150')
      await expect(page.frameLocator('iframe[title^="Pilot checklist"]').locator('body')).toHaveCSS('zoom', '1.5')
      await page.getByTitle('Plain view', { exact: true }).click()
      const standaloneBody = page
        .locator('.font-message')
        .filter({ hasText: 'Please review the pilot checklist' })
        .last()
      await expect(standaloneBody).toHaveCSS('font-size', '22.5px')
      await page.getByRole('button', { name: 'Reset to default', exact: true }).click()
      await expect(size).toHaveValue('100')
      expect(await page.evaluate(() => (window as any).startupProbe.calls.includes('mail.send'))).toBe(false)
      expect(errors).toEqual([])
    })
  }
}

// S01-07 / ADR-0046: quoted history folds behind a toggle that works with no
// script in the frame (production CSP), and a fixed-width message can be fitted
// to the reading pane from its menu.
test('reader folds quoted text and fits a fixed-width message to the pane', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, readerQuote: true })
  await page.goto('/')
  await page
    .getByRole('table')
    .getByRole('button', { name: /Pilot checklist/ })
    .click()

  const frame = page.frameLocator('iframe[title="Message HTML"]').first()
  await expect(frame.getByText('Fold check reply')).toBeVisible()
  const quoted = frame.getByText('Quoted synthetic history')
  await expect(quoted).toBeHidden()
  await frame.getByText('Show quoted text').click()
  await expect(quoted).toBeVisible()
  await frame.getByText('Hide quoted text').click()
  await expect(quoted).toBeHidden()

  // The plain-text reply folds its ">" quote the same way.
  const plainQuote = page.getByText(/Please review the plain quoted line/)
  await expect(page.getByText('Thanks Morgan. I will review the checklist today.')).toBeVisible()
  await expect(plainQuote).toHaveCount(0)
  await page.getByRole('button', { name: 'Show quoted text', exact: true }).click()
  await expect(plainQuote).toBeVisible()

  // Off by default: the 1200px table keeps its size and scrolls on its own.
  const table = frame.locator('table')
  await expect(table).toHaveAttribute('width', '1200')
  await expect(frame.locator('.oreneta-table-scroll')).toHaveCount(1)

  await page
    .getByRole('group', { name: /More message actions — Morgan Rivera/ })
    .first()
    .getByRole('button', { name: 'More message actions', exact: true })
    .click()
  await page.getByText('Fit to window', { exact: true }).click()

  await expect(frame.locator('html[data-oreneta-fit]')).toHaveCount(1)
  await expect
    .poll(() =>
      table.evaluate((el) => {
        const doc = el.ownerDocument
        return el.getBoundingClientRect().right <= doc.documentElement.clientWidth + 1
      }),
    )
    .toBe(true)
  expect(await frame.locator('.oreneta-table-scroll').count()).toBe(0)
  const fitted = await table.evaluate((el) => {
    const doc = el.ownerDocument
    return {
      zoom: Number(getComputedStyle(doc.body).zoom),
      noSideScroll: doc.documentElement.scrollWidth <= doc.documentElement.clientWidth,
      width: el.getAttribute('width'),
    }
  })
  expect(fitted.zoom).toBeLessThan(1)
  expect(fitted.zoom).toBeGreaterThan(0.3)
  expect(fitted.noSideScroll).toBe(true)
  expect(fitted.width).toBe('1200')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  // The fold survives the reload the fit causes.
  await expect(quoted).toBeHidden()
  expect(errors).toEqual([])
})

test('a read receipt request is asked about in a bar that blocks nothing, and sent only on the click', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, readReceipt: true })
  await page.goto('/')
  await page
    .getByRole('table')
    .getByRole('button', { name: /Pilot checklist/ })
    .click()

  const bar = page.getByRole('group', { name: 'Read receipt requested' })
  await expect(bar).toBeVisible()
  await expect(bar).toContainText('The sender asked to be told when you read this.')
  const receiptCalls = () =>
    page.evaluate(() =>
      (window as any).startupProbe.requests.filter((r: { command: string }) => r.command.startsWith('receipts.')),
    )
  // Opening the message only asked the core where the request stands.
  expect((await receiptCalls()).every((r: { command: string }) => r.command === 'receipts.status')).toBe(true)
  // The message itself is not held back behind the question.
  await expect(page.getByText('Thanks Morgan. I will review the checklist today.')).toBeVisible()

  await bar.getByRole('button', { name: 'Send receipt' }).click()
  await expect(page.getByText('A read receipt was sent.')).toBeVisible()
  await expect(bar).toHaveCount(0)
  const answers = (await receiptCalls()).filter((r: { command: string }) => r.command === 'receipts.answer')
  expect(answers).toHaveLength(1)
  expect(answers[0].payload).toMatchObject({ id: 'message-1', folder: 'INBOX', send: true })
  expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
  expect(errors).toEqual([])
})

// SET-01 / ADR-0049: General → Notifications. Do not disturb is turned on from
// the More menu, the side navigation says so, and one click there resumes.
test('do not disturb shows an indicator in the side navigation and Resume clears it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await expect(page.getByRole('table')).toBeVisible()
  const quietPushes = () =>
    page.evaluate(() =>
      (window as any).startupProbe.requests
        .filter((r: { command: string }) => r.command === 'notify.setQuiet')
        .map((r: { payload: unknown }) => r.payload),
    )
  // Not quiet at start, and the bridge was told so.
  await expect.poll(async () => (await quietPushes()).at(-1)).toMatchObject({ indefinite: false, quiet: false })
  const indicator = page.getByRole('status', { name: 'Do not disturb is on until you turn it off' })
  await expect(indicator).toHaveCount(0)

  // The side navigation's own More button (the narrow-window header has one too).
  await page.locator('aside').getByTitle('More', { exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Do not disturb until turned off', exact: true }).click()
  await expect(indicator).toBeVisible()
  await expect.poll(async () => (await quietPushes()).at(-1)).toMatchObject({ indefinite: true, quiet: true })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).startupProbe.requests
            .filter((r: any) => r.command === 'app.prefsSet' && r.payload.key === 'notification_prefs')
            .at(-1)?.payload.value.pause,
      ),
    )
    .toEqual({ until: null })

  await indicator.getByRole('button', { name: 'Resume notifications', exact: true }).click()
  await expect(indicator).toHaveCount(0)
  await expect.poll(async () => (await quietPushes()).at(-1)).toMatchObject({ indefinite: false, quiet: false })
  expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
  expect(errors).toEqual([])
})

test('shared dialog focus returns to opener and busy Escape does not close parent', async ({ page }) => {
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await page.keyboard.press('Control+k')
  await page.getByRole('dialog').getByRole('combobox').fill('design catalogue')
  await page.getByRole('option', { name: 'Open design catalogue Action' }).click()
  const parent = page.getByRole('dialog', { name: 'Design catalogue', exact: true })
  await expect(parent).toBeFocused()
  const opener = parent.getByRole('button', { name: 'Open focus example' })
  await opener.focus()
  await page.keyboard.press('Enter')
  const child = page.getByRole('dialog', { name: 'Focus example', exact: true })
  await expect(child).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(child.getByRole('button', { name: 'Close' })).toBeFocused()
  await page.keyboard.press('Tab')
  const busy = child.getByRole('checkbox', { name: 'Keep this dialog open' })
  await expect(busy).toBeFocused()
  await page.keyboard.press('Space')
  await page.keyboard.press('Escape')
  await expect(child).toBeVisible()
  await expect(parent).toBeVisible()
  await page.keyboard.press('Space')
  await page.keyboard.press('Escape')
  await expect(child).toHaveCount(0)
  await expect(opener).toBeFocused()
  await page.keyboard.press('Enter')
  await child.getByRole('button', { name: 'Close' }).click()
  await expect(opener).toBeFocused()
  expect(errors).toEqual([])
})

for (const theme of ['oreneta-light', 'oreneta-dark']) {
  for (const width of [1440, 720]) {
    test(`table reviewed selection: ${theme}, ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors = await prepareStartup(page, true, { navigation: true, theme })
      await page.goto('/')
      const table = page.getByRole('table')
      const pilot = table.getByRole('button', { name: /Pilot checklist/ })
      const check = table.getByRole('checkbox', { name: /Budget review/ })
      await expect(table).toBeVisible()
      await check.focus()
      await page.keyboard.press('Space')
      await expect(check).toBeChecked()
      await expect(check).toHaveCSS('outline-width', '2px')
      await expect(page.getByText('1 selected', { exact: true })).toBeVisible()
      expect(await page.evaluate(() => (window as any).startupProbe.calls.includes('mail.threadRead'))).toBe(false)
      await pilot.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
      if (width < 769) await page.getByTitle('Back to Chats', { exact: true }).click()
      await expect(pilot).toHaveAttribute('aria-current', 'true')
      await expect(check).not.toBeChecked()
      await check.focus()
      await page.keyboard.press('Space')
      await expect(check).toBeChecked()
      await expect(pilot).toHaveAttribute('aria-current', 'true')
      await expect(table.getByRole('button', { name: /Unread: Budget review/ })).toBeVisible()
      const openedRow = table.locator('tr[data-opened]')
      const selectedRow = table.locator('tr[data-bulk-selected]')
      const readRow = table.getByRole('button', { name: /Meeting notes/ }).locator('..').locator('..')
      const unreadRow = table.getByRole('button', { name: /Unread: Budget review/ }).locator('..').locator('..')
      await expect(openedRow.locator('td').first()).toHaveCSS('box-shadow', /inset/)
      await expect(selectedRow.locator('td').first()).toHaveCSS('box-shadow', 'none')
      await expect(unreadRow.locator('[data-unread-marker]')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(readRow.locator('[data-unread-marker]')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      expect((await readRow.boundingBox())!.height).toBeGreaterThanOrEqual(36)
      expect((await readRow.locator('[data-unread-marker]').boundingBox())!.width).toBe(6)
      await expect(table.locator('thead')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      expect(await table.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await info.attach('table-selection', {
        body: await page.screenshot({ path: info.outputPath('table-selection.png'), animations: 'disabled' }),
        contentType: 'image/png',
      })
      await page.keyboard.press('Space')
      await expect(check).not.toBeChecked()
      // All three states can coexist on one row; selection must not erase
      // the opened edge or unread marker. Reordering keeps the edge at left.
      const pilotCheck = table.getByRole('checkbox', { name: /Pilot checklist/ })
      await pilotCheck.check()
      await expect(openedRow).toHaveAttribute('data-bulk-selected', 'true')
      await expect(openedRow.locator('td').first()).toHaveCSS('box-shadow', /inset/)
      await pilotCheck.uncheck()
      await page.getByRole('button', { name: 'Columns', exact: true }).click()
      const editor = page.getByRole('dialog', { name: 'Columns' })
      await editor.getByRole('button', { name: 'Move up: Subject' }).click()
      await editor.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(table.getByRole('columnheader').nth(1)).toHaveText('Subject')
      await expect(openedRow.locator('td').first()).toHaveCSS('box-shadow', /inset/)
      await expect(pilot).toHaveAttribute('aria-current', 'true')
      await page.emulateMedia({ forcedColors: 'active' })
      await pilotCheck.check()
      await pilotCheck.focus()
      await expect(pilotCheck).toHaveCSS('outline-width', '3px')
      await expect(openedRow.locator('td').first()).toHaveCSS('border-left-width', '3px')
      await expect(openedRow.locator('td').first()).toHaveCSS('border-left-style', 'solid')
      await expect(unreadRow.locator('[data-unread-marker]')).toHaveCSS('border-top-width', '2px')
      await expect(openedRow).toHaveAttribute('data-bulk-selected', 'true')
      await page.emulateMedia({ forcedColors: 'none' })
      expect(errors).toEqual([])
    })
  }
}

for (const appearance of ['light', 'dark'] as const) {
  for (const width of [1440, 600]) {
    test(`shared design catalogue: ${appearance}, ${width}px, focus, controls and wrapping`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: appearance, reducedMotion: 'reduce' })
      const errors = await prepareStartup(page, true, { navigation: true, theme: 'default' })
      await page.goto('/')
      await expect(page.getByRole('button', { name: 'New message', exact: true })).toBeVisible()
      await page.keyboard.press('Control+k')
      await page.getByRole('dialog').getByRole('combobox').fill('design catalogue')
      await page.getByRole('option', { name: 'Open design catalogue Action' }).click()
      const catalogue = page.getByRole('dialog', { name: 'Design catalogue' })
      await expect(catalogue).toBeVisible()

      const primary = catalogue.getByRole('button', { name: 'Primary', exact: true })
      await primary.focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      await expect(primary).toBeFocused()
      await expect(primary).toHaveCSS('outline-style', 'solid')
      await expect(primary).toHaveCSS('outline-width', '2px')
      // The ring is the solid accent, not a translucent mix (#287).
      await expect(primary).toHaveCSS('outline-color', appearance === 'light' ? 'rgb(32, 86, 221)' : 'rgb(126, 166, 255)')
      await expect(primary).toHaveCSS('color', appearance === 'light' ? 'rgb(255, 255, 255)' : 'rgb(16, 27, 46)')
      await primary.hover()
      await page.mouse.down()
      await expect(primary).toHaveCSS('scale', 'none')
      await expect(primary).toHaveCSS('box-shadow', 'none')
      await page.mouse.up()
      await expect(catalogue.getByRole('button', { name: 'Disabled danger', exact: true })).toBeDisabled()
      await expect(catalogue.getByRole('button', { name: 'Icon button, disabled', exact: true })).toBeDisabled()

      const invalid = catalogue.getByRole('textbox', { name: 'Invalid field' })
      await invalid.focus()
      await expect(invalid).toHaveAttribute('aria-invalid', 'true')
      await expect(invalid).toHaveCSS('outline-width', '2px')
      // Unfocused field and select outlines use the 3:1 input border, not the divider (#287).
      const inputBorder = appearance === 'light' ? 'rgb(107, 122, 147)' : 'rgb(125, 145, 180)'
      await expect(catalogue.getByRole('textbox', { name: 'Small field' })).toHaveCSS('border-top-color', inputBorder)
      await expect(catalogue.getByRole('combobox', { name: 'Select field' })).toHaveCSS('border-top-color', inputBorder)

      const select = catalogue.getByRole('button', { name: 'Selectable and removable', exact: true })
      await select.scrollIntoViewIfNeeded()
      const box = await select.boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(20)
      // Hit the visible side edge of the pill, outside the text but inside its rounded boundary.
      await select.click({ position: { x: 2, y: box!.height / 2 } })
      await expect(select).toHaveAttribute('aria-pressed', 'false')
      await select.focus()
      await page.keyboard.press('Space')
      await expect(select).toHaveAttribute('aria-pressed', 'true')
      await page.keyboard.press('Tab')
      const remove = catalogue.getByRole('button', { name: 'Remove selectable chip' })
      await expect(remove).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(remove).toHaveCount(0)
      await expect(catalogue.getByRole('button', { name: 'Toggle · on' })).toHaveAttribute('aria-pressed', 'true')

      const longMenu = catalogue.getByRole('menuitem', { name: /Archivar los mensajes seleccionados/ })
      await longMenu.scrollIntoViewIfNeeded()
      expect(await longMenu.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      const longAction = catalogue.getByRole('button', { name: 'Volver a comprobar la conexión' })
      await longAction.scrollIntoViewIfNeeded()
      expect(await catalogue.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      expect(await longAction.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await info.attach('catalogue-feedback', {
        body: await page.screenshot({ path: info.outputPath('catalogue-feedback.png'), animations: 'disabled' }),
        contentType: 'image/png',
      })

      await page.evaluate(() => {
        ;(window as any).runtime = {
          ...(window as any).runtime,
          BrowserOpenURL: (url: string) => {
            ;(window as any).designLink = url
          },
        }
      })
      const docs = catalogue.getByRole('button', { name: 'Art direction' })
      await docs.focus()
      await page.keyboard.press('Enter')
      expect(await page.evaluate(() => (window as any).designLink)).toBe(
        'https://github.com/adilelhaji/oreneta/blob/main/docs/design/art-direction.md',
      )
      await primary.focus()
      await info.attach('catalogue-controls', {
        body: await page.screenshot({ path: info.outputPath('catalogue-controls.png'), animations: 'disabled' }),
        contentType: 'image/png',
      })
      expect(errors).toEqual([])
    })
  }
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
  if (options.readerStress) {
    fixture.account.conversation_html = true
    fixture.messages[0].from_name = 'Morgan Alexandra Rivera — Customer Success and International Operations'
    fixture.messages[0].from_addr = 'customer-success-and-international-operations@example.test'
    fixture.messages[0].body_html =
      '<p>Wide synthetic invoice</p><table width="1800"><tr><td style="min-width:900px">Original first column</td><td style="min-width:900px">Original second column</td></tr></table>'
  }
  if (options.readReceipt) fixture.messages[0].receipt_requested = true
  if (options.arabicSubject) {
    fixture.threads[2].subject = RTL_SUBJECT
    fixture.threads[2].from_name = RTL_SENDER
  }
  if (options.readerQuote) {
    fixture.account.conversation_html = true
    fixture.messages[0].body_html =
      '<div dir="ltr"><p>Fold check reply</p><table width="1200" style="width:1200px"><tr><td style="min-width:1200px;background:#eef">Fixed synthetic table</td></tr></table></div>' +
      '<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Mon, Oct 12, 2026 at 10:02 AM Alex &lt;alex@example.test&gt; wrote:<br></div>' +
      '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex"><div>Quoted synthetic history</div></blockquote></div>'
    fixture.messages[1].body =
      'Thanks Morgan. I will review the checklist today.\n\nOn Mon, Oct 12, 2026, Morgan Rivera wrote:\n> Hello Alex,\n> Please review the plain quoted line.'
  }
  await page.addInitScript(
    ({ accounts, folders, template, options, threads, messages, translation }) => {
      const calls: string[] = []
      const requests: Array<{ command: string; payload: Record<string, unknown> }> = []
      const unexpected: string[] = []
      const saves: Array<{ command: string; payload: Record<string, unknown> }> = []
      let graphPolls = 0
      const replies: Record<string, unknown> = {
        ...(options.syncHealth ? { 'mail.sync': { ok: true, online: false } } : {}),
        'system.check': {
          platform: 'windows',
          mail_engine: 'meron_mail',
          meron_mail: { configured: true, available: true, server_path: 'synthetic' },
          gmail_oauth_configured: !!options.oauth,
          outlook_oauth_configured: !!options.oauth || !!options.graph,
          database_path: 'synthetic',
        },
        'account.list': { accounts },
        'mail.folderList': { folders },
        'mail.threadList': { threads: [], next_cursor: '', pagination: 'conversation-v1' },
        'tasks.list': { tasks: [] },
        'tasks.lists': { lists: [] },
        'notes.list': { notes: [], tags: [] },
        'backup.profileRestoreStatus': { state: 'none' },
        'attachments.list': { items: [], total: 0, coverage: { messages: 0, downloaded: 0 } },
        'profiles.list': {
          profiles: [{ id: 'default', name: '', created_at: 0, active: true, has_data: true }],
          active: 'default',
        },
        'people.list': { people: [] },
        'people.duplicates': { groups: [] },
        // Contact groups and the book's names for nameless senders (ADR-0052).
        'people.groups': { groups: [] },
        'people.names': { names: {} },
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
        'app.prefsGet': {
          prefs: {
            auto_update_check: false,
            ...(options.language === null ? {} : { language: options.language ?? 'en' }),
            ...(options.listView === null ? {} : { list_view: options.listView ?? 'table' }),
            ...(options.navigation
              ? {
                  session_account: template.id,
                  session_folder: 'INBOX',
                  ...(options.theme === 'default' ? {} : { theme_id: options.theme ?? 'indigo' }),
                  mark_read_mode: 'manual',
                  sticky_filters: true,
                  ...(options.hideAccounts ? { hidden_sidenav_accounts: [template.id, 'second-account'] } : {}),
                }
              : {}),
            ...options.preferences,
          },
        },
        'app.prefsSet': { ok: true },
        'mailto.consumePending': [],
        'i18n.setNativeLabels': { ok: true },
        'composer.pruneMedia': { removed: 0 },
        'labels.list': { labels: [] },
        'categories.list': { categories: [] },
        'spam.lists': { entries: [] },
        'privacy.info': { title: 'EasyPrivacy', version: 'test', rules: 1000, source: 'bundled' },
        'translation.status': translation,
        'cloud.list': [],
        // The event editor and invitation cards check the person's own schedule (ADR-0043).
        'calendar.conflicts': { conflicts: [] },
        'invite.counterStatus': { organizer: false, event: null, sequence: null, outdated: false },
        'notes.attachments': { attachments: [] },
        'backupSchedule.status': {
          schedule: { enabled: false, folder: '', every_hours: 24, keep: 7, max_bytes: null },
          last_attempt: null,
          last_success: null,
          last_error: null,
          next_run: null,
          backups: [],
          password_saved: false,
          running: false,
        },
        // Automatic archiving (ADR-0054): off, as a fresh account has it.
        'autoArchive.status': {
          policy: {
            enabled: false,
            older_than: { value: 6, unit: 'months' },
            folders: [{ name: 'INBOX', older_than: null }],
            destination: 'server',
            keep_server_copy: false,
            include_starred: false,
            include_unread: false,
          },
          confirmed: false,
          last_attempt: null,
          last_success: null,
          last_error: null,
          next_run: null,
          running: false,
          local_supported: true,
          folders: [
            { name: 'INBOX', display_name: 'INBOX', refused: null },
            { name: 'Drafts', display_name: 'Drafts', refused: 'drafts' },
          ],
          runs: [],
        },
        'chat.accounts': [],
        'chat.status': {},
        'chat.conversations': [],
        'chat.history': [],
        'chat.markRead': { ok: true },
        // Presence, status requests and room occupants (ADR-0055).
        'chat.presence': { own: { show: 'available', status: '' }, contacts: {}, requests: [] },
        'chat.occupants': [],
        // Group chats and their invitations (ADR-0044).
        'chat.rooms': [],
        'chat.invitations': [],
        // Muted conversations (ADR-0064).
        'chat.muted': { muted: [] },
        'cloud.providers': [
          { id: 'nextcloud', name: 'Nextcloud', usable: true },
          { id: 'owncloud', name: 'ownCloud', usable: true },
          { id: 'dropbox', name: 'Dropbox', usable: false },
        ],
        // Folder moves (ADR-0050): nothing moves unless a test says how.
        'mail.folderMove': { ok: true, renames: [], folders },
        'mail.scheduledSends': { messages: [] },
        'mail.outgoingAttempts': { attempts: [] },
        // Read receipts (ADR-0048): the core asks, and the person answers.
        ...(options.readReceipt
          ? {
              'receipts.status': { state: 'ask', to: ['morgan@example.test'], automatic: false },
              'receipts.answer': { state: 'sent', to: ['morgan@example.test'], automatic: false },
            }
          : {}),
        'localDrafts.list': { drafts: [] },
        'localDrafts.get': { draft: null },
        'localDrafts.save': { applied: true, revision: 1, deleted: false },
        'localDrafts.delete': { applied: true, revision: 2, deleted: true },
        'tray.setUnread': { ok: true },
        // Do not disturb and quiet hours reach the bridge as intervals (ADR-0049).
        'notify.setQuiet': { ok: true },
        'update.status': {
          state: 'idle',
          supported: !!options.updatesSupported,
          managed: false,
          channel: 'portable',
          currentVersion: '0.1.0',
        },
      }
      Object.assign(
        (replies['app.prefsGet'] as { prefs: Record<string, unknown> }).prefs,
        JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}'),
      )
      Object.assign(window, {
        startupProbe: { calls, unexpected, saves, requests, replies },
        go: {
          main: {
            App: {
              Invoke: async (command: string, payload: Record<string, unknown>) => {
                calls.push(command)
                requests.push({ command, payload: structuredClone(payload) })
                if (command === 'mail.sync' && options.manualRefresh && (window as any).startupProbe.syncReply) return (window as any).startupProbe.syncReply(payload)
                if (command === 'oauth.graphBegin') return { attempt: 'graph-attempt' }
                if (command === 'oauth.graphPoll')
                  return { state: 'authorized', account: 'graph-account', mail_backend_ready: false }
                if (command === 'oauth.graphCancel' || command === 'graph.activationCancel') return { ok: true }
                if (command === 'graph.activationBegin') {
                  graphPolls = 0
                  if (options.graph === 'late')
                    return new Promise((resolve) => {
                      ;(window as any).startupProbe.finishGraph = () =>
                        resolve({ account: 'graph-account', generation: 'graph-generation' })
                    })
                  return { account: 'graph-account', generation: 'graph-generation' }
                }
                if (command === 'graph.activationPoll') {
                  graphPolls++
                  if (options.graph === 'error')
                    return {
                      account: 'graph-account',
                      state: 'failed',
                      error: 'throttled',
                      retry_after_seconds: 60,
                      mail_backend_ready: false,
                    }
                  if (options.graph === 'pending' || graphPolls < 2)
                    return {
                      account: 'graph-account',
                      state: 'syncing',
                      pages: 2,
                      changes: 100,
                      mail_backend_ready: false,
                    }
                  replies['account.list'] = {
                    accounts: [
                      ...accounts,
                      {
                        ...template,
                        id: 'graph-account',
                        email: 'graph@example.test',
                        display_name: 'Graph reader',
                        auth_type: 'graph_oauth',
                        provider: 'outlook',
                      },
                    ],
                  }
                  return { account: 'graph-account', state: 'ready', pages: 3, changes: 101, mail_backend_ready: true }
                }
                if (options.navigation && command === 'mail.folderList') {
                  const accountId = String(payload.account_id)
                  return {
                    folders:
                      accountId === template.id
                        ? folders
                        : [
                            {
                              id: 'OtherInbox',
                              account_id: accountId,
                              name: 'Other mailbox',
                              role: 'inbox',
                              unread: 7,
                            },
                          ],
                  }
                }
                if (options.navigation && command === 'mail.threadList') {
                  return {
                    threads:
                      payload.account_id === template.id && String(payload.folder_id).toLowerCase() === 'inbox'
                        ? threads
                        : [],
                    next_cursor: '',
                    pagination: 'conversation-v1',
                  }
                }
                if (options.navigation && command === 'mail.threadRead') {
                  return {
                    messages:
                      payload.thread_id === 'thread-1'
                        ? messages
                        : threads.filter((thread) => thread.thread_id === payload.thread_id),
                    next_cursor: '',
                  }
                }
                if (command === 'app.prefsSet') {
                  const prefs = (replies['app.prefsGet'] as { prefs: Record<string, unknown> }).prefs
                  prefs[String(payload.key)] = structuredClone(payload.value)
                  sessionStorage.setItem('synthetic-prefs', JSON.stringify(prefs))
                }
                // The manual setup tests both servers before saving (#269);
                // the synthetic core passes every step.
                if (command === 'account.testConnection') {
                  const server = (protocol: string, host: unknown, port: unknown) => ({
                    protocol,
                    host,
                    port,
                    security: 'tls',
                    ok: true,
                    steps: ['dns', 'tcp', 'tls', 'auth'].map((step) => ({ step, status: 'ok' })),
                  })
                  return {
                    ok: true,
                    incoming: server(payload.incoming === 'pop3' ? 'pop3' : 'imap', payload.imap_host, payload.imap_port),
                    outgoing: server('smtp', payload.smtp_host, payload.smtp_port),
                  }
                }
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
      if (options.syncHealth) {
        const listeners = new Map<string, Set<(detail: unknown) => void>>()
        ;(window as any).startupProbe.emit = (name: string, detail: unknown) => listeners.get(name)?.forEach((listener) => listener(detail))
        ;(window as any).runtime = { EventsOn: (name: string, callback: (detail: unknown) => void) => {
          if (!listeners.has(name)) listeners.set(name, new Set())
          listeners.get(name)!.add(callback)
          return () => listeners.get(name)?.delete(callback)
        } }
      }
    },
    {
      accounts: withAccount
        ? [
            {
              ...fixture.account,
              ...(options.graphAccount ? { auth_type: 'graph_oauth' as const, provider: 'outlook' } : {}),
              email: options.existingEmail ?? fixture.account.email,
              conversation_html: true,
              ...(options.syncHealth ? { paused: false } : {}),
            },
            ...(options.navigation && (!options.graphAccount || options.mixedGraphAccount)
              ? [
                  {
                    ...fixture.account,
                    id: 'second-account',
                    display_name: 'Second account',
                    email: 'second@example.test',
                    included_in_unified: !!options.manualRefresh,
                    ...(options.syncHealth ? { paused: false } : {}),
                  },
                ]
              : []),
          ]
        : [],
      folders: withAccount
        ? [
            ...fixture.folders,
            ...(options.navigation
              ? [
                  {
                    id: 'project-42',
                    account_id: fixture.account.id,
                    name: 'Projects/Reviews',
                    role: '',
                    delimiter: '/',
                    unread: 2,
                  },
                ]
              : []),
          ]
        : [],
      threads: options.navigation ? fixture.threads : [],
      messages: options.navigation ? fixture.messages : [],
      template: fixture.account,
      options,
      translation: translationStatus(options.installedModels),
    },
  )
  return errors
}

for (const theme of ['oreneta-light', 'oreneta-dark']) {
  for (const width of [599, 600, 601, 768, 769, 1024, 1025]) {
    test(`mail boundary ${width}px retains reader, back and composer (${theme})`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors = await prepareStartup(page, true, { navigation: true, theme })
      await page.goto('/')
      await verifyMailBoundary(page, width)
      if (width === 600 || width === 769)
        await info.attach('production-boundary-composer', {
          body: await page.screenshot({ path: info.outputPath('boundary-composer.png'), animations: 'disabled' }),
          contentType: 'image/png',
        })
      expect(errors).toEqual([])
    })
  }
}

// A thread list widened on a large screen is remembered in pixels. On a
// narrower window it must give way before the reader does: at 769 and 1025
// pixels a remembered 560-pixel list left the reader 150 to 185 pixels.
for (const width of [769, 1024, 1025, 1440]) {
  test(`a remembered wide thread list leaves the reader room at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors = await prepareStartup(page, true, { navigation: true, preferences: { thread_list_width: 560 } })
    await page.goto('/')
    const list = page.locator('[data-thread-list]')
    const reader = page.locator('[data-message-pane]')
    await expect(list).toBeVisible()
    await expect(reader).toBeVisible()
    const listBox = (await list.boundingBox())!
    const readerBox = (await reader.boundingBox())!
    expect(listBox.width).toBeGreaterThanOrEqual(280 - 1)
    expect(readerBox.width).toBeGreaterThanOrEqual(360 - 1)
    expect(readerBox.x + readerBox.width).toBeLessThanOrEqual(width + 1)
    // Where there is room, the remembered width is kept.
    if (width >= 1440) expect(Math.round(listBox.width)).toBe(560)
    expect(errors).toEqual([])
  })
}

// #283: the message list at the sizes a window is kept maximised at. A
// profile that never resized the list gets 360 px of it and the automatic
// view, which draws two-line rows (sender and date over subject and preview)
// under date groups while the list is narrow. The sender and the subject of an
// ordinary conversation read whole, in Catalan, English and Arabic, light and
// dark, without touching the separator.
const READABLE_SUBJECTS = [
  'Budget review: Q4 planning',
  'Meeting notes and next steps',
  'Invoice with an attachment',
  'Welcome to the internal demo',
]

/** Whether a two-line row shows its sender and subject whole, and how tall it is. */
async function rowReading(list: ReturnType<Page['locator']>, subject: string) {
  const row = list.getByTitle(subject, { exact: true })
  await expect(row).toBeVisible()
  return row.evaluate((button) => {
    const sender = button.querySelector('[data-thread-sender]') as HTMLElement
    const title = button.querySelector('[data-thread-subject]') as HTMLElement
    const line = title.closest('p') as HTMLElement
    const senderBox = sender.getBoundingClientRect()
    const titleBox = title.getBoundingClientRect()
    const lineBox = line.getBoundingClientRect()
    return {
      senderWhole: sender.scrollWidth <= sender.clientWidth + 1,
      // The subject's own box inside its line: a cut subject runs past the
      // end of the line, on the right or (Arabic) on the left.
      subjectWhole: titleBox.left >= lineBox.left - 1 && titleBox.right <= lineBox.right + 1,
      subjectBelowSender: titleBox.top >= senderBox.bottom - 1,
      height: Math.round(button.getBoundingClientRect().height),
    }
  })
}

for (const language of ['ca', 'en', 'ar'] as const) {
  for (const theme of ['oreneta-light', 'oreneta-dark']) {
    for (const width of [1280, 1456, 1920]) {
      test(`the message list reads sender and subject without resizing: ${language}, ${theme}, ${width}px (#283)`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 900 })
        const errors = await prepareStartup(page, true, { navigation: true, language, theme, listView: null })
        await page.goto('/')
        const html = page.locator('html')
        await expect(html).toHaveAttribute('lang', language)
        await expect(html).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr')
        const list = page.locator('[data-thread-list]')
        const reader = page.locator('[data-message-pane]')
        await expect(list).toHaveAttribute('data-list-view', 'cards')
        await expect(list.getByRole('table')).toHaveCount(0)
        await expect(list.locator('[data-date-group]').first()).toBeVisible()

        const listBox = (await list.boundingBox())!
        const readerBox = (await reader.boundingBox())!
        expect(Math.round(listBox.width)).toBe(360)
        expect(readerBox.width).toBeGreaterThanOrEqual(360 - 1)
        expect(readerBox.x + readerBox.width).toBeLessThanOrEqual(width + 1)
        // Arabic mirrors the shell: the list sits to the right of the reader.
        if (language === 'ar') expect(listBox.x).toBeGreaterThan(readerBox.x)
        else expect(listBox.x).toBeLessThan(readerBox.x)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

        for (const subject of READABLE_SUBJECTS) {
          const { height, ...whole } = await rowReading(list, subject)
          expect(whole, subject).toEqual({ senderWhole: true, subjectWhole: true, subjectBelowSender: true })
          // Compact two-line rows: about 56 px.
          expect(height, subject).toBeGreaterThanOrEqual(50)
          expect(height, subject).toBeLessThanOrEqual(64)
        }

        await settled(page)
        const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
        const body = JSON.stringify({ language, theme, width, violations: results.violations }, null, 2)
        await info.attach(`axe-message-list-${language}-${theme}-${width}`, { body, contentType: 'application/json' })
        const blocking = results.violations
          .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
          .map(
            (violation) =>
              `${violation.id} (${violation.impact}) on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
          )
        await info.attach(`message-list-${language}-${theme}-${width}`, {
          body: await page.screenshot({ path: info.outputPath('message-list.png'), animations: 'disabled' }),
          contentType: 'image/png',
        })
        expect(blocking).toEqual([])
        expect(errors).toEqual([])
      })
    }
  }
}

test('the resized message list is kept across restarts and the automatic view follows it (#283)', async ({ page }) => {
  await page.setViewportSize({ width: 1456, height: 900 })
  const errors = await prepareStartup(page, true, { navigation: true, theme: 'oreneta-light', listView: null })
  await page.goto('/')
  const list = page.locator('[data-thread-list]')
  const handle = page.getByRole('separator', { name: 'Resize thread list' })
  const stored = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}'))
  await expect(handle).toHaveAttribute('aria-valuenow', '360')
  await expect(list).toHaveAttribute('data-list-view', 'cards')

  // Wide enough for columns: the automatic view turns into the table.
  await handle.focus()
  await page.keyboard.press('End')
  await expect(handle).toHaveAttribute('aria-valuenow', '560')
  await expect(list).toHaveAttribute('data-list-view', 'table')
  await expect(list.getByRole('table')).toBeVisible()
  await expect.poll(async () => (await stored()).thread_list_width).toBe(560)
  await page.reload()
  await expect(handle).toHaveAttribute('aria-valuenow', '560')
  expect(Math.round((await list.boundingBox())!.width)).toBe(560)
  await expect(list.getByRole('table')).toBeVisible()

  // Narrower than the default: two-line rows that still read whole.
  await handle.focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '296')
  await expect.poll(async () => (await stored()).thread_list_width).toBe(296)
  await page.reload()
  await expect(handle).toHaveAttribute('aria-valuenow', '296')
  expect(Math.round((await list.boundingBox())!.width)).toBe(296)
  await expect(list).toHaveAttribute('data-list-view', 'cards')
  expect(await rowReading(list, 'Budget review: Q4 planning')).toMatchObject({
    senderWhole: true,
    subjectWhole: true,
    subjectBelowSender: true,
  })
  // Resizing is not choosing a view: the profile still has none stored.
  expect((await stored()).list_view).toBeUndefined()
  // The rows open a conversation like the table does.
  await list.getByTitle('Pilot checklist — synthetic conversation', { exact: true }).click()
  await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('a remembered wide list squeezed by the window draws two-line rows (#283)', async ({ page }) => {
  // A remembered 560 px list and the reader's 360 px do not fit in 880 px
  // (the folder pane is hidden at this width): the list gives way, too narrow
  // for columns, and the automatic view follows the drawn width.
  await page.setViewportSize({ width: 880, height: 900 })
  const errors = await prepareStartup(page, true, {
    navigation: true,
    theme: 'oreneta-dark',
    listView: null,
    preferences: { thread_list_width: 560 },
  })
  await page.goto('/')
  const list = page.locator('[data-thread-list]')
  await expect(list).toHaveAttribute('data-list-view', 'cards')
  const drawn = Math.round((await list.boundingBox())!.width)
  expect(drawn).toBeGreaterThanOrEqual(280)
  expect(drawn).toBeLessThan(520)
  expect((await page.locator('[data-message-pane]').boundingBox())!.width).toBeGreaterThanOrEqual(360 - 1)
  expect(await rowReading(list, 'Budget review: Q4 planning')).toMatchObject({
    senderWhole: true,
    subjectWhole: true,
    subjectBelowSender: true,
  })
  expect(errors).toEqual([])
})

test('mail layout at 200-percent desktop zoom equivalent (1440 physical / 720 CSS pixels)', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 720, height: 900 },
    deviceScaleFactor: 2,
    locale: 'en-US',
  })
  try {
    const page = await context.newPage()
    const errors = await prepareStartup(page, true, { navigation: true, theme: 'oreneta-dark' })
    await page.goto('http://127.0.0.1:4182/')
    await verifyMailBoundary(page, 720)
    expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await context.close()
  }
})

// Right-to-left layout for Arabic (#226, ADR-0061), on the production entry.
// The shell mirrors (side rail on the right, the list to the right of the
// reader, the way back on the right with its chevron turned), nothing spills
// past either edge at 100% or 200%, axe finds nothing critical or serious,
// and a Latin subject keeps reading left to right inside the Arabic list.
const RTL_SUBJECT = 'مراجعة الميزانية: تخطيط الربع الرابع'
const RTL_SENDER = 'ليلى حداد'

for (const theme of ['oreneta-light', 'oreneta-dark']) {
  for (const width of [600, 1024, 1440]) {
    test(`Arabic interface mirrors the shell without overflow and passes axe: ${theme}, ${width}px (#226)`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors = await prepareStartup(page, true, { navigation: true, language: 'ar', theme })
      await page.goto('/')
      const html = page.locator('html')
      await expect(html).toHaveAttribute('dir', 'rtl')
      await expect(html).toHaveAttribute('lang', 'ar')
      const list = page.locator('[data-thread-list]')
      await expect(list).toBeVisible()
      const row = page.getByRole('table').getByRole('button', { name: /Pilot checklist/ })
      await expect(row).toBeVisible()

      // A Latin subject in the Arabic list reads left to right, isolated from
      // the interface around it.
      const subject = row.locator('[dir="auto"]').first()
      expect(await subject.evaluate((element) => getComputedStyle(element).direction)).toBe('ltr')
      expect(await row.evaluate((element) => getComputedStyle(element).direction)).toBe('rtl')

      const inView = async (where: string) => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), where).toBe(true)
        const outside = await page.evaluate(() =>
          [...document.querySelectorAll('button, [role=button], input')]
            .filter((element) => {
              const box = element.getBoundingClientRect()
              return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1)
            })
            .map(
              (element) =>
                // An unnamed field is reported by its tag and placeholder rather than as "".
                (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim()) ||
                `${element.tagName.toLowerCase()} "${element.getAttribute('placeholder') ?? ''}"`,
            ),
        )
        expect(outside, where).toEqual([])
      }

      if (width >= 769) {
        // The rail hugs the right edge and the list sits to the right of the reader.
        const rail = page.locator('main > aside').first()
        const railBox = (await rail.boundingBox())!
        expect(Math.round(railBox.x + railBox.width)).toBeGreaterThanOrEqual(width - 1)
        const listBox = (await list.boundingBox())!
        const readerBox = (await page.locator('[data-message-pane]').boundingBox())!
        expect(listBox.x).toBeGreaterThan(readerBox.x)
      }
      await inView('mailbox')

      const blocking: string[] = []
      const audit = async (screen: string) => {
        const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
        const body = JSON.stringify({ screen, theme, width, violations: results.violations }, null, 2)
        await info.attach(`axe-rtl-${screen}-${theme}-${width}`, { body, contentType: 'application/json' })
        writeFileSync(info.outputPath(`axe-rtl-${screen}.json`), body)
        for (const violation of results.violations) {
          if (violation.impact === 'critical' || violation.impact === 'serious') {
            const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ')
            blocking.push(`${screen}: ${violation.id} (${violation.impact}) on ${targets}`)
          }
        }
      }
      await audit('mailbox')

      await row.click()
      await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
      if (width < 769) {
        // One pane at a time: the way back sits at the start (right) edge and
        // its chevron is mirrored to point right, towards where the list was.
        const back = page.getByTitle('الرجوع إلى الدردشات', { exact: true })
        const backBox = (await back.boundingBox())!
        expect(backBox.x + backBox.width / 2).toBeGreaterThan(width / 2)
        expect(await back.locator('svg').evaluate((element) => getComputedStyle(element).transform)).toBe(
          'matrix(-1, 0, 0, 1, 0, 0)',
        )
      }
      await inView('reader')
      await audit('conversation')
      await info.attach('rtl-reader', {
        body: await page.screenshot({ path: info.outputPath('rtl-reader.png'), animations: 'disabled' }),
        contentType: 'image/png',
      })

      // 200%: the app's own zoom (#181), the reader and then the composer.
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
      for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px')
      await inView('reader at 200%')
      await page.keyboard.press(`${mod}+KeyN`)
      await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible()
      await inView('composer at 200%')
      await info.attach('rtl-composer-200', {
        body: await page.screenshot({ path: info.outputPath('rtl-composer-200.png'), animations: 'disabled' }),
        contentType: 'image/png',
      })
      await page.keyboard.press(`${mod}+Digit0`)

      expect(blocking).toEqual([])
      expect(errors).toEqual([])
    })
  }
}

// What a check of "nothing leaves the window" has to read in right to left:
// `scrollWidth` only grows with overflow on the scrollable side (the left), so
// controls and headings pushed past the right edge are looked for directly.
async function rtlInView(page: Page, where: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), where).toBe(true)
  const outside = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'button, [role=button], [role=tab], [role=option], a[href], input, select, textarea, h1, h2, h3',
      ),
    ]
      .filter((element) => {
        const box = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') return false
        return box.left < -1 || box.right > innerWidth + 1
      })
      .map(
        (element) =>
          // An unnamed field is reported by its tag and placeholder rather than as "".
          (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim().slice(0, 40)) ||
          `${element.tagName.toLowerCase()} "${element.getAttribute('placeholder') ?? ''}"`,
      ),
  )
  expect(outside, where).toEqual([])
}

// The other screens in Arabic (#226): people, tasks, notes, calendar, chat and
// settings, each without overflow on either side and with axe clean.
for (const theme of ['oreneta-light', 'oreneta-dark']) {
  for (const width of [600, 1024]) {
    test(`Arabic secondary screens stay inside the window and pass axe: ${theme}, ${width}px (#226)`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors = await prepareStartup(page, true, { navigation: true, language: 'ar', theme })
      await page.goto('/')
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
      await expect(page.locator('[data-thread-list]')).toBeVisible()
      await page.evaluate(() => {
        const replies = (window as any).startupProbe.replies
        replies['people.list'] = {
          people: [
            {
              id: 'local::layla', source: 'local', account: '', book: 'local', name: 'ليلى حداد',
              organisation: 'قسم البحث', note: 'ملاحظة قصيرة\nSecond line in English', photo: '',
              emails: [{ addr: 'layla@example.test', label: '' }], phones: [], version: '1', editable: true,
            },
            {
              id: 'local::morgan', source: 'local', account: '', book: 'local', name: 'Morgan Rivera',
              organisation: 'Example Org', note: '', photo: '',
              emails: [{ addr: 'morgan@example.test', label: '' }], phones: [], version: '1', editable: true,
            },
          ],
        }
        replies['tasks.lists'] = { lists: [{ id: 'mail', name: '', position: 0, open: 1 }] }
        replies['tasks.list'] = {
          tasks: [
            {
              id: 1, thread_id: '', account_id: '', folder_id: '', note: 'Review the figures', due_at: null,
              completed_at: null, created_at: 0, subject: '', from_name: '', from_addr: '', linked: false,
              list_id: 'mail', title: 'مراجعة الميزانية قبل الاجتماع', priority: 2, reminder_at: null, revision: 1,
            },
          ],
        }
        const note = {
          id: 'note:ar', title: 'ملاحظة الاجتماع', html: '<p>نص الملاحظة</p><p>English line</p>',
          text: 'نص الملاحظة\nEnglish line', tags: [], pinned: false, revision: 1, created_at: 0,
          updated_at: 1760000000, deleted_at: null,
        }
        replies['notes.list'] = { notes: [{ ...note, preview: note.text }], tags: [] }
        replies['notes.get'] = { note }
        replies['calendar.list'] = {
          calendars: [{ id: 'local-ar', name: 'تقويم الفريق', is_default: true, enabled: true, kind: 'local', read_only: false, synced_at: 0 }],
        }
        replies['calendar.events'] = { events: [] }
        replies['chat.accounts'] = [{ id: 'c1', jid: 'ana@chat.test', host: '', port: 5222 }]
        replies['chat.status'] = { c1: { account: 'c1', state: 'online' } }
        replies['chat.conversations'] = [
          { conversation: 'pau@chat.test', last_body: 'مرحبا', last_stamp: 1760000120, last_direction: 'in', unread: 1 },
        ]
        replies['chat.history'] = [
          { account: 'c1', conversation: 'pau@chat.test', id: 'm1', stanza_id: 'a1', direction: 'in', sender: 'pau@chat.test', body: 'مرحبا يا آنا', stamp: 1760000000, state: 'received' },
          { account: 'c1', conversation: 'pau@chat.test', id: 's1', stanza_id: null, direction: 'out', sender: 'ana@chat.test', body: 'Hello Pau', stamp: 1760000060, state: 'delivered' },
        ]
      })

      const blocking: string[] = []
      const check = async (screen: string) => {
        await rtlInView(page, screen)
        const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
        const body = JSON.stringify({ screen, theme, width, violations: results.violations }, null, 2)
        await info.attach(`axe-rtl-${screen}-${theme}-${width}`, { body, contentType: 'application/json' })
        writeFileSync(info.outputPath(`axe-rtl-${screen}.json`), body)
        for (const violation of results.violations) {
          if (violation.impact === 'critical' || violation.impact === 'serious') {
            const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ')
            blocking.push(`${screen}: ${violation.id} (${violation.impact}) on ${targets}`)
          }
        }
        await info.attach(`rtl-${screen}`, {
          body: await page.screenshot({ path: info.outputPath(`rtl-${screen}.png`), animations: 'disabled' }),
          contentType: 'image/png',
        })
      }
      // The rail on a wide window; the "More" menu on a narrow one.
      const openArea = async (name: string) => {
        if (width < 769) {
          await page.getByRole('button', { name: 'المزيد', exact: true }).first().click()
          await page.getByRole('menuitem', { name, exact: true }).last().click()
        } else {
          await page.getByTitle(name, { exact: true }).click()
        }
      }

      await openArea('الأشخاص')
      await page.getByRole('option', { name: /ليلى حداد/ }).click()
      await expect(page.getByRole('heading', { name: 'ليلى حداد' })).toBeVisible()
      await check('people')
      if (width < 769) await page.getByRole('button', { name: 'رجوع', exact: true }).click()

      await openArea('المهام')
      await expect(page.getByText('مراجعة الميزانية قبل الاجتماع')).toBeVisible()
      await check('tasks')

      await openArea('الملاحظات')
      await page.getByRole('button', { name: /ملاحظة الاجتماع/ }).click()
      await expect(page.getByLabel('العنوان')).toHaveValue('ملاحظة الاجتماع')
      await check('notes')

      await openArea('التقويم')
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await check('calendar')

      await openArea('الدردشة')
      await page.getByRole('button', { name: /pau@chat.test/ }).click()
      await expect(page.getByText('مرحبا يا آنا')).toBeVisible()
      await check('chat')

      await page.keyboard.press('Control+Comma')
      await expect(page.getByRole('dialog').first()).toBeVisible()
      await check('settings')
      await page.keyboard.press('Escape')

      expect(blocking).toEqual([])
      expect(errors).toEqual([])
    })
  }
}

// A context menu opened near the right edge, where a right-to-left menu
// normally opens: it extends leftwards, stays whole and its labels do not wrap.
test('Arabic context menu near the right edge is fully visible with unwrapped labels (#226)', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, language: 'ar' })
  await page.goto('/')
  await page.evaluate(() => {
    ;(window as any).startupProbe.replies['mail.priorityReason'] = {
      priority: false,
      reasons: [],
      sender: 'morgan@example.test',
      override: null,
    }
  })
  const row = page.getByRole('table').getByRole('button', { name: /Pilot checklist/ })
  await expect(row).toBeVisible()
  const box = (await row.boundingBox())!
  await page.mouse.click(600 - 20, box.y + box.height / 2, { button: 'right' })
  const menu = page.locator('[data-thread-context-menu]')
  await expect(menu).toBeVisible()
  const menuBox = (await menu.boundingBox())!
  expect(menuBox.x).toBeGreaterThanOrEqual(0)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(600)
  // Opened towards the end of the line: its right edge at the pointer.
  expect(Math.abs(menuBox.x + menuBox.width - (600 - 20))).toBeLessThanOrEqual(1)
  const wrapped = await menu.evaluate((element) =>
    [...element.querySelectorAll('button span')]
      .filter((span) => span.getBoundingClientRect().height > 0)
      .filter((span) => {
        const lineHeight = parseFloat(getComputedStyle(span).lineHeight) || 20
        return span.getBoundingClientRect().height > lineHeight * 1.5
      })
      .map((span) => span.textContent),
  )
  expect(wrapped).toEqual([])
  expect(errors).toEqual([])
})

// Menus (#289): a context menu and its submenu are WAI-ARIA menus with no axe
// violation at all, and are driven by the keyboard: arrows wrap, Home and End,
// typeahead, the arrow towards the end of the line opens the submenu and the
// one towards its start closes it (mirrored in Arabic), Escape closes only the
// innermost menu, and focus returns to where it came from. Rows are 28 px.
for (const language of ['en', 'ar'] as const) {
  test(`thread context menu: roles, axe and keyboard, ${language} (#289)`, async ({ page }, info) => {
    const errors = await prepareStartup(page, true, { navigation: true, language })
    await page.goto('/')
    await page.evaluate(() => {
      ;(window as any).startupProbe.replies['mail.priorityReason'] = {
        priority: false,
        reasons: [],
        sender: 'morgan@example.test',
        override: null,
      }
    })
    const rtl = language === 'ar'
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight'
    const back = rtl ? 'ArrowRight' : 'ArrowLeft'
    const row = page.getByRole('table').getByRole('button', { name: /Pilot checklist/ })
    await expect(row).toBeVisible()
    await row.focus()
    await row.click({ button: 'right' })

    const menu = page.getByRole('menu', { name: 'Pilot checklist' })
    await expect(menu).toBeVisible()
    const items = menu.getByRole('menuitem')
    await expect(items.first()).toBeFocused()
    expect(Math.round((await items.first().boundingBox())!.height)).toBe(28)

    await page.keyboard.press('ArrowUp')
    await expect(items.last()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(items.first()).toBeFocused()
    await page.keyboard.press('End')
    await expect(items.last()).toBeFocused()
    await page.keyboard.press('Home')
    await expect(items.first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(1)).toBeFocused()

    if (!rtl) {
      // Typeahead: "A" goes to the first item after the focused one that
      // starts with it, Archive thread.
      await page.keyboard.press('a')
      await expect(menu.getByRole('menuitem', { name: 'Archive thread', exact: true })).toBeFocused()
    }

    const trigger = menu.locator('[aria-haspopup="menu"]').first()
    await trigger.focus()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press(forward)
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const submenu = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`)
    await expect(submenu).toHaveAttribute('role', 'menu')
    await expect(submenu).toHaveAttribute('aria-labelledby', (await trigger.getAttribute('id'))!)
    await expect(submenu.getByRole('menuitem').first()).toBeFocused()
    // Opened past the end of its row: right of it in English, left in Arabic.
    const triggerBox = (await trigger.boundingBox())!
    const submenuBox = (await submenu.boundingBox())!
    if (rtl) expect(submenuBox.x + submenuBox.width).toBeLessThanOrEqual(triggerBox.x + 1)
    else expect(submenuBox.x).toBeGreaterThanOrEqual(triggerBox.x + triggerBox.width - 1)

    const results = await new AxeBuilder({ page }).include('[role="menu"]').withTags(AXE_TAGS).analyze()
    const body = JSON.stringify(results.violations, null, 2)
    await info.attach(`axe-menus-${language}`, { body, contentType: 'application/json' })
    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([])

    await page.keyboard.press(back)
    await expect(submenu).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')

    // Enter opens it too; Escape closes only the submenu, then the menu.
    await page.keyboard.press('Enter')
    await expect(submenu.getByRole('menuitem').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(submenu).toHaveCount(0)
    await expect(menu).toBeVisible()
    await expect(trigger).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(row).toBeFocused()
    expect(errors).toEqual([])
  })
}

for (const language of ['en', 'ar'] as const) {
  test(`a menu button opens its menu from the keyboard and gives focus back, ${language} (#289)`, async ({
    page,
  }) => {
    const errors = await prepareStartup(page, true, { navigation: true, language })
    await page.goto('/')
    const catalog = JSON.parse(
      readFileSync(fileURLToPath(new URL(`../../locales/${language}.json`, import.meta.url)), 'utf8'),
    ) as Record<string, string>
    const name = catalog['threads.actions.title']
    const trigger = page.getByRole('button', { name, exact: true })
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name, exact: true })
    await expect(menu).toBeVisible()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const items = menu.getByRole('menuitem')
    await expect(items.first()).toBeFocused()
    await page.keyboard.press('End')
    await expect(items.last()).toBeFocused()
    // Keys typed in a menu stay there: "e" (archive) does not reach the app.
    await page.keyboard.press('e')
    await expect(menu).toBeVisible()
    const commands = await page.evaluate(() =>
      ((window as any).startupProbe.requests as { command: string }[]).map((request) => request.command),
    )
    expect(commands).not.toContain('mail.archive')
    const results = await new AxeBuilder({ page }).include('[role="menu"]').withTags(AXE_TAGS).analyze()
    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([])
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // Tab closes it as well, and moves on from the trigger, not from the
    // removed menu at the end of the page.
    await page.keyboard.press('Enter')
    await expect(items.first()).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(menu).toHaveCount(0)
    await expect(trigger).not.toBeFocused()
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    await expect(trigger).toBeFocused()
    expect(errors).toEqual([])
  })
}

test('switching from Arabic back to English restores left to right without a reload (#226)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, language: 'ar' })
  await page.goto('/')
  const html = page.locator('html')
  await expect(html).toHaveAttribute('dir', 'rtl')
  const rail = page.locator('main > aside').first()
  expect(Math.round((await rail.boundingBox())!.x)).toBeGreaterThan(1300)
  const navigations: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url())
  })
  await page.getByRole('textbox').first().focus()
  await page.keyboard.press('Control+Comma')
  const language = page.locator('select').filter({ has: page.locator('option[value="ar"]') })
  await expect(language).toHaveValue('ar')
  await language.selectOption('en')
  await expect(html).toHaveAttribute('dir', 'ltr')
  await expect(html).toHaveAttribute('lang', 'en')
  await page.keyboard.press('Escape')
  expect(Math.round((await rail.boundingBox())!.x)).toBe(0)
  expect(navigations).toEqual([])
  expect(errors).toEqual([])
})

// The other way round: an Arabic subject and sender in the English interface
// read right to left, and the row around them does not turn.
test('an Arabic subject in the English interface reads right to left inside a left-to-right row (#226)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, arabicSubject: true })
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
  const row = page.getByRole('table').getByRole('button', { name: RTL_SUBJECT })
  await expect(row).toBeVisible()
  expect(await row.locator('[dir="auto"]').first().evaluate((element) => getComputedStyle(element).direction)).toBe(
    'rtl',
  )
  expect(await row.evaluate((element) => getComputedStyle(element).direction)).toBe('ltr')
  const sender = page.getByRole('table').locator('[dir="auto"]', { hasText: RTL_SENDER })
  expect(await sender.evaluate((element) => getComputedStyle(element).direction)).toBe('rtl')
  expect(errors).toEqual([])
})

test('Graph setup is explicit and finishes only after initial mailbox readiness', async ({ page }) => {
  const errors = await prepareStartup(page, false, { graph: 'success' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Microsoft Graph — Read-only', exact: true }).click()
  await expect(page.getByText(/Sending, editing, attachments/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save Account', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Sign in with Microsoft Graph', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Preparing folders and Inbox' })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).startupProbe.calls.filter((c: string) => c === 'graph.activationPoll').length,
      ),
    )
    .toBeGreaterThanOrEqual(2)
  await expect(page.getByRole('button', { name: 'Sign in with Microsoft Graph', exact: true })).toHaveCount(0)
  const calls = await page.evaluate(() => (window as any).startupProbe.calls as string[])
  expect(calls).not.toContain('account.addOutlookOAuth')
  expect(calls).not.toContain('account.addPassword')
  expect(calls).not.toContain('mail.send')
  expect(errors).toEqual([])
})

test('Graph setup cancels a late activation when leaving the wizard', async ({ page }) => {
  const errors = await prepareStartup(page, false, { graph: 'late' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Microsoft Graph — Read-only', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in with Microsoft Graph', exact: true }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as any).startupProbe.finishGraph)).toBe('function')
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.evaluate(() => (window as any).startupProbe.finishGraph())
  await expect.poll(() => page.evaluate(() => (window as any).startupProbe.calls)).toContain('graph.activationCancel')
  await expect(page.getByRole('textbox', { name: 'Email Address', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('Graph setup exposes throttling and permits an explicit retry', async ({ page }) => {
  const errors = await prepareStartup(page, false, { graph: 'error' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Microsoft Graph — Read-only', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in with Microsoft Graph', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('throttled')
  await expect(page.getByRole('alert')).toContainText('60')
  await page.getByRole('button', { name: 'Sign in with Microsoft Graph', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).startupProbe.calls.filter((c: string) => c === 'oauth.graphBegin').length),
    )
    .toBe(2)
  expect(errors).toEqual([])
})

test('Graph mailbox reader remains read-only without automatic flag or draft writes', async ({ page }) => {
  const errors = await prepareStartup(page, true, {
    navigation: true,
    graphAccount: true,
    preferences: { mark_read_mode: 'immediately' },
  })
  await page.goto('/')
  await page
    .getByRole('button', { name: /Pilot checklist/ })
    .first()
    .click()
  await expect(page.getByRole('status').filter({ hasText: 'Microsoft Graph — read-only' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Reply' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Archive thread', exact: true }).first()).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Mark as read', exact: true }).first()).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Label', exact: true }).first()).toBeEnabled()
  await page.getByRole('button', { name: 'Conversation details', exact: true }).first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: /New message to/ })).toBeDisabled()
  const calls = await page.evaluate(() => (window as any).startupProbe.calls as string[])
  for (const command of ['mail.markRead', 'mail.saveDraft', 'mail.send']) expect(calls).not.toContain(command)
  expect(errors).toEqual([])
})

async function verifyMailBoundary(page: Page, width: number) {
  const list = page.locator('[data-thread-list]')
  await expect(list).toBeInViewport({ ratio: 0.95 })
  const inbox = page.getByRole('table')
  await inbox.getByRole('button', { name: /Pilot checklist/ }).click()
  const reply = page.getByPlaceholder('Write a message...')
  await expect(reply).toBeInViewport({ ratio: 1 })
  await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeInViewport()
  await expect(page.getByRole('button', { name: 'More actions', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'Archive thread', exact: true })).toBeInViewport({ ratio: 1 })
  const box = await reply.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
  if (width < 769) {
    await expect(list).not.toBeVisible()
    await page.getByTitle('Back to Chats', { exact: true }).click()
    await expect(list).toBeInViewport({ ratio: 0.95 })
    await expect(inbox.getByRole('button', { name: /Pilot checklist/ })).toHaveAttribute('aria-current', 'true')
    await inbox.getByRole('button', { name: /Budget review/ }).click()
    await expect(reply).toBeInViewport({ ratio: 1 })
    await page.getByTitle('Back to Chats', { exact: true }).click()
  }
  if (width > 1024) {
    await page
      .getByRole('navigation', { name: 'Accounts and folders' })
      .getByRole('button', { name: 'Sent', exact: true })
      .click()
  } else {
    await page.getByTitle('Switch folder', { exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Sent', exact: true }).click()
  }
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).startupProbe.requests.filter((r: any) => r.command === 'mail.threadList').at(-1)?.payload,
      ),
    )
    .toMatchObject({ account_id: 'synthetic-account', folder_id: 'Sent' })
  await page.keyboard.press('Control+n')
  await expect(page.locator('.tiptap[contenteditable="true"]')).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'Discard', exact: true })).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

for (const theme of ['oreneta-light', 'oreneta-dark']) {
  test(`a stored table supports open, reply draft, selection and navigation (${theme})`, async ({
    page,
  }, info) => {
    const errors = await prepareStartup(page, true, { navigation: true, theme })
    await page.goto('/')
    const table = page.getByRole('table')
    await expect(table).toBeVisible()
    const first = table.getByRole('button', { name: /Pilot checklist/ })
    await first.focus()
    await page.keyboard.press('Enter')
    await expect(first).toHaveAttribute('aria-current', 'true')
    await expect(page.getByTitle('Collapse message', { exact: true })).toHaveCount(2)
    await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
    await page.getByTitle('Collapse message', { exact: true }).first().click()
    await expect(page.getByTitle('Expand message', { exact: true })).toBeVisible()
    await page.getByTitle('Expand message', { exact: true }).click()
    await info.attach('production-conventional-reader', {
      body: await page.screenshot({ path: info.outputPath('mail-reader.png'), animations: 'disabled' }),
      contentType: 'image/png',
    })
    const reply = page.getByPlaceholder('Write a message...')
    await reply.fill('Synthetic reply draft — do not send')
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).startupProbe.requests.filter((r: any) => r.command === 'mail.saveDraft').at(-1)?.payload,
        ),
      )
      .toMatchObject({
        account_id: 'synthetic-account',
        to: 'morgan@example.test',
        body: 'Synthetic reply draft — do not send',
      })
    await table.getByRole('button', { name: /Budget review/ }).click()
    await expect(table.getByRole('button', { name: /Budget review/ })).toHaveAttribute('aria-current', 'true')
    await expect(reply).toHaveValue('')
    const nav = page.getByRole('navigation', { name: 'Accounts and folders' })
    await nav.getByRole('button', { name: 'Sent', exact: true }).click()
    await expect(table).toHaveCount(0)
    await nav.getByRole('button', { name: 'Inbox 3', exact: true }).click()
    await expect(table).toBeVisible()
    expect(await page.evaluate(() => (window as any).startupProbe.calls.includes('mail.send'))).toBe(false)
    expect(errors).toEqual([])
  })
}

// The same workflow on what a profile that never chose a view gets (#283):
// the automatic view's two-line rows at the default 360 px.
for (const theme of ['oreneta-light', 'oreneta-dark']) {
  test(`the default rows support open, reply draft, selection and navigation (${theme}, #283)`, async ({ page }) => {
    await page.setViewportSize({ width: 1456, height: 900 })
    const errors = await prepareStartup(page, true, { navigation: true, theme, listView: null })
    await page.goto('/')
    const list = page.locator('[data-thread-list]')
    await expect(list).toHaveAttribute('data-list-view', 'cards')
    const first = list.getByTitle('Pilot checklist — synthetic conversation', { exact: true })
    await first.focus()
    await page.keyboard.press('Enter')
    await expect(first).toHaveAttribute('aria-current', 'true')
    await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
    const reply = page.getByPlaceholder('Write a message...')
    await reply.fill('Synthetic reply draft — do not send')
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).startupProbe.requests.filter((r: any) => r.command === 'mail.saveDraft').at(-1)?.payload,
        ),
      )
      .toMatchObject({
        account_id: 'synthetic-account',
        to: 'morgan@example.test',
        body: 'Synthetic reply draft — do not send',
      })
    const budget = list.getByTitle('Budget review: Q4 planning', { exact: true })
    await budget.click()
    await expect(budget).toHaveAttribute('aria-current', 'true')
    await expect(first).not.toHaveAttribute('aria-current', 'true')
    await expect(reply).toHaveValue('')

    // Selecting without opening: Ctrl+click starts a selection, Close ends it.
    await list.getByTitle('Meeting notes and next steps', { exact: true }).click({ modifiers: ['Control'] })
    await expect(list.getByText('1 selected', { exact: true })).toBeVisible()
    await expect(budget).toHaveAttribute('aria-current', 'true')
    await list.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(list.getByText('1 selected', { exact: true })).toHaveCount(0)

    const nav = page.getByRole('navigation', { name: 'Accounts and folders' })
    await nav.getByRole('button', { name: 'Sent', exact: true }).click()
    await expect(budget).toHaveCount(0)
    await nav.getByRole('button', { name: 'Inbox 3', exact: true }).click()
    await expect(budget).toBeVisible()
    await expect(list).toHaveAttribute('data-list-view', 'cards')
    expect(await page.evaluate(() => (window as any).startupProbe.calls.includes('mail.send'))).toBe(false)
    expect(errors).toEqual([])
  })
}

// SET-09 / ADR-0047: Mail → Replies and forwards. The preference is changed in
// Settings, persisted as one row, and shapes the reply the full editor opens.
test('reply preferences change where the quote goes and how its header reads', async ({ page }) => {
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  const group = settings.locator('[data-settings-section="repliesForwards"]')
  await expect(group).toContainText('Replies and forwards')
  await group.getByRole('button', { name: 'Below the quote', exact: true }).click()
  await group.getByRole('button', { name: 'Full header', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).startupProbe.requests
            .filter((r: any) => r.command === 'app.prefsSet' && r.payload.key === 'reply_forward')
            .at(-1)?.payload.value,
      ),
    )
    .toMatchObject({ replyPosition: 'below', headerStyle: 'outlook', includeOriginal: true, forwardMode: 'inline' })
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)

  const table = page.getByRole('table')
  await table.getByRole('button', { name: /Pilot checklist/ }).click()
  await page.getByPlaceholder('Write a message...').fill('Sounds good')
  await page.getByTitle('Open full editor', { exact: true }).click()
  const body = page.getByPlaceholder('Write your message...')
  await expect(body).toBeVisible()
  const text = await body.inputValue()
  // The newest message of the thread is the one answered (pickReplyTarget).
  expect(text).toMatch(/^-----\nFrom: .+ <[^>]+@example\.test>\nSent: .+2026.+\nTo: .+\nSubject: Pilot checklist[^\n]*\n> /)
  expect(text).toContain('\n> Thanks Morgan. I will review the checklist today.\n')
  // Below the quote: the user's own words come after the original.
  expect(text.endsWith('\n\nSounds good')).toBe(true)
  await expect(page.getByPlaceholder('Subject', { exact: true })).toHaveValue('Re: Pilot checklist — synthetic conversation')
  expect(await page.evaluate(() => (window as any).startupProbe.calls.includes('mail.send'))).toBe(false)
  expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
  expect(errors).toEqual([])
})

test('legacy cards/chat stay selected until explicit layout controls change them and persist across reload', async ({
  page,
}) => {
  const errors = await prepareStartup(page, true, {
    navigation: true,
    theme: 'indigo-dark',
    preferences: { conversation_layout: 'chat', list_view: 'cards', list_density: 'relaxed' },
  })
  await page.goto('/')
  await expect(page.getByRole('table')).toHaveCount(0)
  await page.getByText('Pilot checklist — synthetic conversation', { exact: true }).first().click()
  await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
  await expect(page.getByTitle('Collapse message', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: 'Traditional', exact: true }).click()
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await page.getByRole('button', { name: 'Compact', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}')))
    .toMatchObject({
      conversation_layout: 'traditional',
      list_view: 'table',
      list_density: 'compact',
      theme_id: 'indigo-dark',
      mark_read_mode: 'manual',
    })
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByRole('table')).toBeVisible()
  await page
    .getByRole('table')
    .getByRole('button', { name: /Pilot checklist/ })
    .click()
  await expect(page.getByTitle('Collapse message', { exact: true })).toHaveCount(2)
  // Back to the automatic view (#283): stored as a choice, drawn as rows at 360 px.
  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: 'Automatic', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}').list_view))
    .toBe('auto')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-thread-list]')).toHaveAttribute('data-list-view', 'cards')
  await expect(page.getByRole('table')).toHaveCount(0)
  expect(errors).toEqual([])
})

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

for (const theme of ['indigo', 'indigo-dark', 'oreneta-light', 'oreneta-dark']) {
  test(`production mailbox navigation uses real folder IDs and account-scoped caches (${theme})`, async ({
    page,
  }, info) => {
    const errors = await prepareStartup(page, true, { navigation: true, theme })
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Accounts and folders' })
    await expect(nav).toBeInViewport()
    await expect(nav.getByRole('button', { name: 'Inbox 3', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByText('Pilot checklist — synthetic conversation', { exact: true }).first()).toBeVisible()
    await info.attach('production-mail-navigation', {
      body: await page.screenshot({ path: info.outputPath('mail-navigation.png'), animations: 'disabled' }),
      contentType: 'image/png',
    })
    await nav.getByRole('button', { name: 'Sent', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(nav.getByRole('button', { name: 'Sent', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).startupProbe.requests.filter((request: any) => request.command === 'mail.threadList').at(-1)
              ?.payload,
        ),
      )
      .toMatchObject({ account_id: 'synthetic-account', folder_id: 'Sent' })
    await nav.getByRole('searchbox').pressSequentially('reviews')
    await expect(nav.getByRole('searchbox')).toBeFocused()
    await nav.getByRole('button', { name: 'Reviews 2', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).startupProbe.requests.filter((request: any) => request.command === 'mail.threadList').at(-1)
              ?.payload,
        ),
      )
      .toMatchObject({ account_id: 'synthetic-account', folder_id: 'project-42' })
    await nav.getByRole('button', { name: /Second account/ }).click()
    await expect(nav.getByRole('searchbox')).toHaveValue('')
    await expect(nav.getByRole('button', { name: 'Other mailbox 7', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Reviews 2', exact: true })).toHaveCount(0)
    await nav.getByRole('button', { name: 'Unified inbox', exact: true }).click()
    await expect(nav.getByRole('button', { name: 'Inbox 3', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Inbox 10', exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test('production mailbox navigation yields space to existing narrow folder selectors', async ({ page }) => {
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await page.setViewportSize({ width: 1025, height: 900 })
  await expect(page.getByRole('navigation', { name: 'Accounts and folders' })).toBeInViewport()
  for (const width of [1024, 600]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.getByRole('navigation', { name: 'Accounts and folders' })).not.toBeVisible()
    await page.getByTitle('Switch folder', { exact: true }).click()
    await expect(page.getByRole('menuitemradio', { name: 'Sent', exact: true })).toBeInViewport()
    await page.keyboard.press('Escape')
  }
  expect(errors).toEqual([])
})

test('production mailbox navigation retains selected hidden account and mail search', async ({ page }) => {
  const errors = await prepareStartup(page, true, { navigation: true, hideAccounts: true })
  await page.goto('/')
  const nav = page.getByRole('navigation', { name: 'Accounts and folders' })
  await expect(nav.getByRole('button', { name: /Alex.*alex@example.test/ })).toBeVisible()
  await expect(nav.getByRole('button', { name: /Second account/ })).toHaveCount(0)
  await page.getByPlaceholder('Search messages...').fill('budget')
  await nav.getByRole('button', { name: 'Sent', exact: true }).click()
  await expect(page.getByPlaceholder('Search messages...')).toHaveValue('budget')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).startupProbe.requests.filter((request: any) => request.command === 'mail.threadList').at(-1)
            ?.payload,
      ),
    )
    .toMatchObject({ account_id: 'synthetic-account', folder_id: 'Sent', query: 'budget' })
  expect(errors).toEqual([])
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
  // Nothing is looked up until the person asks.
  await expect(page.getByRole('button', { name: 'Find settings online', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).startupProbe.calls)).not.toContain('account.autodiscover')
  await page.getByRole('button', { name: 'Find settings online', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Server settings found')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password')
  await page.getByRole('button', { name: 'Save Account', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Synthetic credentials rejected')
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('synthetic-password')
  await expect(page.getByLabel('IMAP Host', { exact: true })).toHaveValue('imap.example.test')
  await page.getByRole('button', { name: 'Save Account', exact: true }).click()
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible()
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
    await page.getByRole('button', { name: 'Find settings online', exact: true }).click()
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
  await page.getByRole('button', { name: 'More', exact: true }).click()
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
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible()
  const saves = await page.evaluate(() => (window as any).startupProbe.saves)
  expect(saves).toHaveLength(1)
  expect(saves[0]).toMatchObject({ command: 'account.addOutlookOAuth', payload: { email: 'authorized@example.test' } })
  expect(errors).toEqual([])
})

test('closing Add account invalidates an OAuth poll already in flight', async ({ page }) => {
  const errors = await prepareStartup(page, true, { oauth: 'late' })
  await page.goto('/')
  await page.getByRole('button', { name: 'More', exact: true }).click()
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
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible()
  await page.keyboard.press('Control+,')
  await page
    .getByRole('navigation')
    .filter({ has: page.getByRole('button', { name: 'General', exact: true }) })
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

// ADR-0054: nothing is archived automatically until the preview of what
// would move has been shown and confirmed; the confirmation carries the
// preview's fingerprint to the core.
test('automatic archiving turns on only after its preview is confirmed', async ({ page }) => {
  const errors = await prepareStartup(page, true, { existingEmail: 'alex@intranet' })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const replies = (window as any).startupProbe.replies
    const status = structuredClone(replies['autoArchive.status'])
    replies['autoArchive.preview'] = {
      account: 'x',
      destination: 'server',
      target: 'Archive',
      total: 12,
      fingerprint: 'e2e-print',
      folders: [{ folder: 'INBOX', cutoff: 1_760_000_000, target: 'Archive', count: 12, oldest: 1, newest: 2 }],
    }
    replies['autoArchive.save'] = {
      ...status,
      policy: { ...status.policy, enabled: true },
      confirmed: true,
      next_run: 0,
    }
  })
  await page.keyboard.press('Control+,')
  await page
    .getByRole('navigation')
    .filter({ has: page.getByRole('button', { name: 'General', exact: true }) })
    .getByRole('button', { name: /Alex · Demo/ })
    .click()
  const group = page.locator('[data-settings-section="autoArchive"]')
  await expect(group.getByRole('checkbox', { name: 'Drafts' })).toBeDisabled()
  await group.getByRole('checkbox', { name: 'Archive old messages automatically' }).check()
  await expect(group.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await expect(group.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled()
  await group.getByRole('button', { name: 'Preview…', exact: true }).click()
  await expect(group.getByRole('region', { name: 'What will be archived' })).toContainText('12 messages would be archived now.')
  expect(await page.evaluate(() => (window as any).startupProbe.calls.includes('autoArchive.save'))).toBe(false)
  await group.getByRole('button', { name: 'Confirm and turn on', exact: true }).click()
  await expect(group.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled()
  const saves = await page.evaluate(() =>
    (window as any).startupProbe.requests.filter((r: { command: string }) => r.command === 'autoArchive.save'),
  )
  expect(saves).toHaveLength(1)
  expect(saves[0].payload).toMatchObject({ confirm: 'e2e-print', policy: { enabled: true, folders: [{ name: 'INBOX' }] } })
  expect(await page.evaluate(() => (window as any).startupProbe.calls.includes('autoArchive.runNow'))).toBe(false)
  expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
  expect(errors).toEqual([])
})

test('production shell navigates settings, people, tasks and composer without hook errors', async ({ page }) => {
  const errors = await prepareStartup(page, true)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible()
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

// #105: Harper runs in the page from the shipped WebAssembly, in a worker,
// and nothing typed leaves the machine: every request the page makes is to
// the app itself.
test('grammar suggestions run on this computer and apply as one edit', async ({ page }) => {
  // Before the synthetic bridge reads its preferences.
  await page.addInitScript(() => {
    const prefs = JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}')
    sessionStorage.setItem('synthetic-prefs', JSON.stringify({ ...prefs, grammar_check: 'american' }))
  })
  const errors = await prepareStartup(page, true, { navigation: true })
  const outside: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) && !['data:', 'blob:'].includes(url.protocol)) {
      outside.push(request.url())
    }
  })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Accounts and folders' })).toBeVisible()
  await page.keyboard.press('Control+n')
  const editor = page.locator('.tiptap[contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.fill('Thanks for the notes from the meeting. I has a apple for the team.')
  const issue = page.locator('.oreneta-grammar-issue', { hasText: 'has' })
  await expect(issue).toBeVisible({ timeout: 30_000 })
  await issue.click()
  await page.getByRole('dialog', { name: 'Grammar suggestion' }).getByRole('button', { name: 'have' }).click()
  await expect(editor).toContainText('I have a apple')
  expect(outside).toEqual([])
  expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
  expect(errors).toEqual([])
})

// The real Spanish→English model (scripts/fetch-translation-test-model.mjs),
// handed to the app from where the Go bridge would serve it.
const translationModels = fileURLToPath(new URL('../.translation-models/', import.meta.url))

test('a draft is translated on this computer by the shipped Bergamot, reviewed, and added below', async ({
  page,
}) => {
  test.skip(!existsSync(`${translationModels}esen`), 'no translation model fetched')
  const errors = await prepareStartup(page, true, { navigation: true, installedModels: ['esen'] })
  const served: string[] = []
  await page.route('**/models/esen/*', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!
    served.push(name)
    await route.fulfill({ body: readFileSync(`${translationModels}esen/${name}`), contentType: 'application/octet-stream' })
  })
  const outside: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) && !['data:', 'blob:'].includes(url.protocol)) {
      outside.push(request.url())
    }
  })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Accounts and folders' })).toBeVisible()
  await page.keyboard.press('Control+n')
  const editor = page.locator('.tiptap[contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.fill('Hola Marta, te mando el presupuesto revisado para la cocina esta tarde.')
  await page.getByRole('button', { name: 'Translate this message' }).click()
  const dialog = page.getByRole('dialog', { name: 'Translate this message' })
  await expect(dialog.getByLabel('From')).toHaveValue('es')
  await expect(dialog.getByLabel('into')).toHaveValue('en')
  await dialog.getByRole('button', { name: 'Translate' }).click()
  const preview = dialog.getByRole('region', { name: 'Translation' })
  await expect(preview).toContainText(/budget/i, { timeout: 60_000 })
  // Nothing changed until asked.
  await expect(editor).toHaveText('Hola Marta, te mando el presupuesto revisado para la cocina esta tarde.')
  await dialog.getByRole('button', { name: 'Add below what I wrote' }).click()
  await expect(editor).toContainText('Hola Marta, te mando el presupuesto')
  await expect(editor).toContainText(/budget/i)
  expect(served.sort()).toEqual(['lex.50.50.esen.s2t.bin', 'model.esen.intgemm.alphas.bin', 'vocab.esen.spm'])
  expect(outside).toEqual([])
  expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
  expect(errors).toEqual([])
})

test('the assistant is not offered until it is turned on', async ({ page }) => {
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Accounts and folders' })).toBeVisible()
  await page.keyboard.press('Control+n')
  await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Translate this message' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rewrite with the assistant' })).toHaveCount(0)
  expect(errors).toEqual([])

  await page.evaluate(() => {
    const prefs = JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}')
    sessionStorage.setItem('synthetic-prefs', JSON.stringify({ ...prefs, assistant_enabled: 'on' }))
  })
  await page.reload()
  await expect(page.getByRole('navigation', { name: 'Accounts and folders' })).toBeVisible()
  await page.keyboard.press('Control+n')
  await expect(page.getByRole('button', { name: 'Rewrite with the assistant' })).toBeVisible()
  expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
})

for (const appearance of ['light', 'dark'] as const) {
  test(`fresh profile chooses cobalt ${appearance}, then preserves its choice across reload and OS changes`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme: appearance })
    const errors = await prepareStartup(page, true, { navigation: true, theme: 'default' })
    await page.goto('/')
    await expect(page.getByRole('navigation', { name: 'Accounts and folders' })).toBeVisible()
    await expect(page.locator('html')).toHaveCSS('--me-accent', appearance === 'light' ? '#2056dd' : '#7ea6ff')
    await expect(page.locator('html')).toHaveCSS('color-scheme', appearance)
    for (const width of [1440, 1024, 600]) {
      await page.setViewportSize({ width, height: 1000 })
      await info.attach(`cobalt-${appearance}-${width}`, {
        body: await page.screenshot({ path: info.outputPath(`cobalt-${width}.png`), animations: 'disabled' }),
        contentType: 'image/png',
      })
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: appearance === 'light' ? 'dark' : 'light' })
    await page.reload()
    await expect(page.getByRole('navigation', { name: 'Accounts and folders' })).toBeVisible()
    await expect(page.locator('html')).toHaveCSS('color-scheme', appearance)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('meron-theme-cache')!).themeId)).toBe(
      `oreneta-${appearance}`,
    )
    await page.keyboard.press('Control+n')
    await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible()
    await page.getByPlaceholder('recipient@example.com').fill('morgan@example.test')
    await page.getByPlaceholder('recipient@example.com').press('Enter')
    await page.locator('.tiptap[contenteditable="true"]').fill('Contrast check, not sent')
    const filled = page.getByRole('button', { name: 'Send', exact: true })
    await expect(filled).toBeEnabled()
    await expect(filled).toHaveCSS('color', appearance === 'light' ? 'rgb(255, 255, 255)' : 'rgb(16, 27, 46)')
    expect(errors).toEqual([])
  })
}

test('saved legacy and custom theme palettes remain authoritative over OS appearance', async ({ page }) => {
  const source = defaultCustomInput('light')
  const tokens = { ...deriveThemeTokens(source), bgApp: '#123456', accent: '#654321' } as Record<string, string>
  for (const key of [
    'success',
    'successSoft',
    'warning',
    'warningSoft',
    'danger',
    'dangerSoft',
    'info',
    'infoSoft',
    'accentText',
  ])
    delete tokens[key]
  const custom = { id: 'custom-saved', name: 'Saved custom palette', appearance: 'light', source, tokens }
  await page.emulateMedia({ colorScheme: 'dark' })
  const errors = await prepareStartup(page, true, {
    navigation: true,
    preferences: { theme_id: custom.id, custom_themes: [custom] },
  })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Accounts and folders' })).toBeVisible()
  for (let i = 0; i < 2; i++) {
    await expect(page.locator('html')).toHaveCSS('--me-bg-app', '#123456')
    await expect(page.locator('html')).toHaveCSS('--me-accent', '#654321')
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'light')
    if (i === 0) await page.reload()
  }
  expect(errors).toEqual([])
})

test('a saved theme changes to cobalt only after an explicit picker action', async ({ page }) => {
  const errors = await prepareStartup(page, true, { navigation: true, theme: 'indigo-dark' })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Accounts and folders' })).toBeVisible()
  await expect(page.locator('html')).toHaveCSS('--me-accent', '#6366f1')
  await page.keyboard.press('Control+,')
  await page
    .getByText('Theme', { exact: true })
    .locator('../..')
    .getByRole('button', { name: 'Change', exact: true })
    .click()
  await page.getByRole('button', { name: 'Oreneta Light', exact: true }).click()
  await expect(page.locator('html')).toHaveCSS('--me-accent', '#2056dd')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).startupProbe.requests
            .filter((r: any) => r.command === 'app.prefsSet' && r.payload.key === 'theme_id')
            .at(-1)?.payload.value,
      ),
    )
    .toBe('oreneta-light')
  expect(errors).toEqual([])
})

// SET-18 / ADR-0051: Calendar → General. Under a British locale the week opens
// on Monday; choosing Sunday in Settings persists one flat row and redraws the
// week view from Sunday, with the weekend still shaded as days off.
test.describe('calendar week start', () => {
  test.use({ locale: 'en-GB' })
  test('changing the first day to Sunday reorders the week view and keeps its shading', async ({ page }) => {
    const errors = await prepareStartup(page, true, { navigation: true })
    await page.addInitScript(() => {
      const replies = (window as any).startupProbe.replies
      replies['calendar.events'] = { events: [] }
      replies['calendar.list'] = {
        calendars: [{ id: 'local-test', name: 'Team', is_default: true, enabled: true, kind: 'local', read_only: false, synced_at: 0 }],
      }
    })
    await page.goto('/')
    await expect(page.getByRole('textbox').first()).toBeVisible()
    await page.getByRole('button', { name: 'Calendar', exact: true }).click()
    const week = page.getByRole('button', { name: 'Week', exact: true })
    await week.click()
    await expect(week).toHaveAttribute('aria-pressed', 'true')

    const headingDays = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-day-heading]')).map((el) =>
          new Date(Number(el.dataset.dayHeading)).getDay(),
        ),
      )
    const workdays = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-day-column]')).map((el) => el.dataset.workday),
      )
    const firstHeading = page.locator('[data-day-heading]').first()

    // The locale's week: Monday first, Saturday and Sunday off.
    await expect.poll(headingDays).toEqual([1, 2, 3, 4, 5, 6, 0])
    await expect(firstHeading).toContainText('Mon')
    expect(await workdays()).toEqual(['true', 'true', 'true', 'true', 'true', 'false', 'false'])
    const bands = page.locator('[data-day-column]').first().locator('[data-off-hours]')
    await expect(bands).toHaveCount(2)
    await expect(bands.first()).toHaveAttribute('data-off-hours', '0-9')

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const group = settings.locator('[data-settings-section="calendarGeneral"]')
    await expect(group).toContainText('First day of the week')
    await expect(group.getByRole('combobox', { name: 'First day of the week' })).toHaveValue('locale')
    await expect(group.getByRole('combobox', { name: 'First day of the week' }).locator('option').first()).toHaveText(
      'Regional default (Monday)',
    )
    await group.getByRole('combobox', { name: 'First day of the week' }).selectOption('sunday')
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).startupProbe.requests
              .filter((r: any) => r.command === 'app.prefsSet' && r.payload.key === 'calendar_week_start')
              .at(-1)?.payload.value,
        ),
      )
      .toBe('sunday')
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    await expect.poll(headingDays).toEqual([0, 1, 2, 3, 4, 5, 6])
    await expect(firstHeading).toContainText('Sun')
    // Shading follows the days, not the columns: Sunday and Saturday stay off.
    expect(await workdays()).toEqual(['false', 'true', 'true', 'true', 'true', 'true', 'false'])
    await expect(page.locator('[data-day-column]').first().locator('[data-off-hours]')).toHaveAttribute('data-off-hours', '0-24')

    // The work-week toggle hides the days off.
    await page.getByRole('button', { name: 'Work week', exact: true }).click()
    await expect.poll(headingDays).toEqual([1, 2, 3, 4, 5])
    expect(await page.evaluate(() => (window as any).startupProbe.calls.some((c: string) => c.startsWith('calendar.') && !['calendar.list', 'calendar.events'].includes(c)))).toBe(false)
    expect(errors).toEqual([])
  })
})

// #266 and #267: events moved and resized by dragging them on the week grid,
// dropped on the mini calendar, refused on a read-only calendar, asked about
// when they repeat, and given up with Escape; a conflict with a newer server
// change is said. Events are created by dragging a range, from the menu of an
// empty slot and from the keyboard slot. Real pointer drags, so they run here
// where there is a layout; the unit suite drives the same moves by keyboard.
test.describe('calendar drag, drop and create', () => {
  const KEY = 'synthetic-account'
  const centre = async (locator: ReturnType<Page['locator']>) => {
    const box = (await locator.boundingBox())!
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  const drag = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x, from.y + 6, { steps: 2 })
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
  }
  /** Local wall-clock instant, `days` from today. */
  const at = (page: Page, days: number, hour: number, minute = 0) =>
    page.evaluate(
      ([d, h, m]) => {
        const now = new Date()
        return new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, h, m).getTime() / 1000
      },
      [days, hour, minute],
    )
  const updates = (page: Page) =>
    page.evaluate(() =>
      (window as any).startupProbe.requests
        .filter((request: any) => request.command === 'calendar.update')
        .map((request: any) => request.payload),
    )

  const open = async (page: Page) => {
    const errors = await prepareStartup(page, true, { navigation: true })
    await page.addInitScript(() => {
      const probe = (window as any).startupProbe
      const now = new Date()
      const at = (h: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h).getTime() / 1000
      const base = { all_day: false, is_cancelled: false, free_busy: 'busy', my_response: '', organizer: null, attendees: [] }
      probe.replies['calendar.list'] = {
        calendars: [
          { id: 'local-team', name: 'Team', is_default: true, enabled: true, kind: 'local', read_only: false, synced_at: 0 },
          { id: 'holidays', name: 'Holidays', is_default: false, enabled: true, kind: 'subscribed', read_only: true, synced_at: 0 },
        ],
      }
      probe.replies['calendar.events'] = {
        events: [
          { ...base, id: 'ev-1', calendar_id: 'local-team', change_key: 'v1', subject: 'Planning', start: at(10), end: at(11), is_recurring: false },
          { ...base, id: 'ev-rec', calendar_id: 'local-team', change_key: 'v2', subject: 'Stand-up', start: at(12), end: at(13), is_recurring: true, series_id: 'series-1' },
          { ...base, id: 'ev-ro', calendar_id: 'holidays', change_key: 'v3', subject: 'Published', start: at(8), end: at(9), is_recurring: false },
        ],
      }
      probe.replies['calendar.update'] = { ok: true }
      // A conflict, when a test asks for one: the core refuses the write.
      const answer = (window as any).go.main.App.Invoke
      ;(window as any).go.main.App.Invoke = async (command: string, payload: Record<string, unknown>) => {
        if (command === 'calendar.update' && probe.updateError) {
          probe.requests.push({ command, payload: structuredClone(payload) })
          throw new Error(probe.updateError)
        }
        return answer(command, payload)
      }
    })
    await page.goto('/')
    await expect(page.getByRole('textbox').first()).toBeVisible()
    await page.getByRole('button', { name: 'Calendar', exact: true }).click()
    await page.getByRole('button', { name: 'Week', exact: true }).click()
    await expect(page.locator(`[data-calendar-event="${KEY}:ev-1"]`)).toBeVisible()
    // 06:00 at the top, so every event held here sits well inside the grid,
    // away from the bands where a held event scrolls it.
    await page.locator('[data-hour-grid]').evaluate((grid) => {
      grid.scrollTop = 6 * 52
    })
    return errors
  }

  test('moves, resizes, cancels, refuses, asks and says a conflict', async ({ page }) => {
    const errors = await open(page)
    const planning = page.locator(`[data-calendar-event="${KEY}:ev-1"]`)

    // Move an hour and a little down: it lands on the nearest quarter, keeps
    // its hour of length, and is written with the version it was read at.
    let from = await centre(planning)
    await drag(page, from, { x: from.x, y: from.y + 60 })
    await expect.poll(async () => (await updates(page)).length).toBe(1)
    let sent = (await updates(page))[0]
    expect(sent.event.start).toBe(await at(page, 0, 11, 15))
    expect(sent.event.end - sent.event.start).toBe(3600)
    expect(sent.event.change_key).toBe('v1')
    expect(sent.scope).toBe('occurrence')

    // Resize by the bottom edge, half an hour.
    await expect(planning).toBeVisible()
    from = await centre(planning.locator('[data-resize-edge="end"]'))
    await drag(page, from, { x: from.x, y: from.y + 26 })
    await expect.poll(async () => (await updates(page)).length).toBe(2)
    sent = (await updates(page))[1]
    expect(sent.event.start).toBe(await at(page, 0, 10))
    expect(sent.event.end).toBe(await at(page, 0, 11, 30))

    // And by the top edge, a quarter earlier.
    from = await centre(planning.locator('[data-resize-edge="start"]'))
    await drag(page, from, { x: from.x, y: from.y - 13 })
    await expect.poll(async () => (await updates(page)).length).toBe(3)
    sent = (await updates(page))[2]
    expect(sent.event.start).toBe(await at(page, 0, 9, 45))
    expect(sent.event.end).toBe(await at(page, 0, 11))

    // Escape while held: nothing is written and nothing stays drawn.
    from = await centre(planning)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x, from.y + 52, { steps: 8 })
    await expect(page.locator('[data-move-ghost]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await page.mouse.move(from.x, from.y + 70, { steps: 2 })
    await page.mouse.up()
    await expect(page.locator('[data-move-ghost]')).toHaveCount(0)

    // Dropped on a day of the mini calendar: that day, at its own time.
    const target = await page.evaluate(() => {
      const now = new Date()
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).getTime()
    })
    // At 1440 px the month at a glance is the folder pane's footer (#323).
    await expect(page.getByRole('navigation', { name: 'Calendars', exact: true }).locator(`[data-mini-day="${target}"]`)).toBeVisible()
    await drag(page, await centre(planning), await centre(page.locator(`[data-mini-day="${target}"]`)))
    await expect.poll(async () => (await updates(page)).length).toBe(4)
    sent = (await updates(page))[3]
    expect(sent.event.start).toBe(await at(page, 2, 10))
    expect(sent.event.end).toBe(await at(page, 2, 11))

    // A read-only calendar refuses, and says why.
    from = await centre(page.locator(`[data-calendar-event="${KEY}:ev-ro"]`))
    await drag(page, from, { x: from.x, y: from.y + 52 })
    await expect(page.getByText('The calendar Holidays is read-only: its events cannot be moved or changed here.')).toBeVisible()
    expect(await updates(page)).toHaveLength(4)

    // A repeating event asks which occurrences, and writes the answer.
    from = await centre(page.locator(`[data-calendar-event="${KEY}:ev-rec"]`))
    await drag(page, from, { x: from.x, y: from.y + 52 })
    await page.getByRole('button', { name: 'This event only', exact: true }).click()
    await expect.poll(async () => (await updates(page)).length).toBe(5)
    sent = (await updates(page))[4]
    expect(sent.scope).toBe('occurrence')
    expect(sent.event.start).toBe(await at(page, 0, 13))

    // A newer change on the server: refused, said, and the window read again.
    await page.evaluate(() => {
      ;(window as any).startupProbe.updateError = 'this event was changed or removed on the server; refresh it and try again'
    })
    const rereads = () =>
      page.evaluate(
        () =>
          (window as any).startupProbe.requests.filter(
            (request: any) => request.command === 'calendar.events' && request.payload.refresh === true,
          ).length,
      )
    const before = await rereads()
    from = await centre(planning)
    await drag(page, from, { x: from.x, y: from.y + 52 })
    await expect(page.getByText(/^The event was not moved: this event was changed or removed on the server/)).toBeVisible()
    await expect.poll(rereads).toBeGreaterThan(before)
    expect(await updates(page)).toHaveLength(6)
    expect(errors).toEqual([])
  })

  test('creates events from a dragged range, the slot menu and the keyboard', async ({ page }) => {
    const errors = await open(page)
    const today = await page.evaluate(() => {
      const now = new Date()
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    })
    const column = page.locator(`[data-day-column="${today}"]`)
    const box = (await column.boundingBox())!
    const y = (hour: number, minute = 0) => box.y + (hour + minute / 60) * 52
    const x = box.x + box.width / 2
    const clockIs = async (hh: string[], mm: string[]) => {
      await expect(page.getByLabel('hh')).toHaveCount(hh.length)
      for (const [i, hour] of hh.entries()) await expect(page.getByLabel('hh').nth(i)).toHaveValue(hour)
      for (const [i, minute] of mm.entries()) await expect(page.getByLabel('mm').nth(i)).toHaveValue(minute)
    }
    const cancel = () => page.getByRole('button', { name: 'Cancel', exact: true }).click()

    // A range dragged across the column, from line to line.
    await drag(page, { x, y: y(14, 5) }, { x, y: y(15, 20) })
    await expect(page.getByRole('heading', { name: 'New event' })).toBeVisible()
    await clockIs(['14', '15'], ['0', '30'])
    await cancel()

    // The menu of an empty slot: a timed event at its quarter, or an all-day one.
    await page.mouse.click(x, y(14, 20), { button: 'right' })
    await page.getByRole('menuitem', { name: 'New event', exact: true }).click()
    await clockIs(['14', '15'], ['15', '15'])
    await cancel()
    await page.mouse.click(x, y(14, 20), { button: 'right' })
    await page.getByRole('menuitem', { name: 'New all-day event', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'New event' })).toBeVisible()
    await clockIs([], [])
    await cancel()

    // The keyboard slot: a quarter later, a quarter longer, then Enter.
    const slot = page.locator('[data-time-slot]')
    await slot.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Enter')
    await clockIs(['9', '10'], ['15', '30'])
    await cancel()

    // And the keyboard alternative to dragging: Alt+Down twice, then Enter.
    const planning = page.locator(`[data-calendar-event="${KEY}:ev-1"]`)
    await planning.focus()
    await page.keyboard.press('Alt+ArrowDown')
    await page.keyboard.press('Alt+ArrowDown')
    await expect(page.locator('[data-move-status]')).toContainText('Press Enter to save the change')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await updates(page)).length).toBe(1)
    expect((await updates(page))[0].event.start).toBe(await at(page, 0, 10, 30))
    expect(errors).toEqual([])
  })
})

// Folder favorites, colors and moves (ADR-0050, SET-07): a folder made a
// favorite and colored from its menu, then moved with the keyboard path, all
// under the production CSP; the favorite and its color survive a reload.
test('folder favorites, colors and a keyboard move', async ({ page }) => {
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.addInitScript(() => {
    const app = (window as any).go.main.App
    const invoke = app.Invoke
    const extra = [
      { id: 'Clients', account_id: 'synthetic-account', name: 'Clients', role: 'folder', delimiter: '/', unread: 1 },
      { id: 'Team', account_id: 'synthetic-account', name: 'Team', role: 'folder', delimiter: '/', unread: 0 },
    ]
    app.Invoke = async (command: string, payload: Record<string, unknown>) => {
      const result = await invoke(command, payload)
      if (command === 'mail.folderList' && payload.account_id === 'synthetic-account') {
        return { folders: [...result.folders, ...extra] }
      }
      if (command === 'mail.folderMove') {
        const base = (window as any).startupProbe.replies['mail.folderList'].folders
        return {
          ok: true,
          folder: 'Clients/Team',
          renames: [{ from: 'Team', to: 'Clients/Team' }],
          folders: [...base, extra[0], { ...extra[1], id: 'Clients/Team', name: 'Clients/Team' }],
        }
      }
      return result
    }
  })
  await page.goto('/')
  const nav = page.getByRole('navigation', { name: 'Accounts and folders' })
  const tree = nav.locator('ul.mail-folder-tree').last()
  await tree.getByRole('button', { name: 'Clients 1', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add to favorites' }).click()
  const favorites = nav.getByRole('region', { name: 'Favorites' })
  await expect(favorites.getByRole('button', { name: 'Clients 1', exact: true })).toBeVisible()

  await tree.getByRole('button', { name: 'Clients 1', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Teal', exact: true }).click()
  const colored = nav.getByRole('button', { name: 'Clients Color: Teal 1', exact: true })
  await expect(colored).toHaveCount(2)
  // The palette's CSS applies under the production CSP: the light-theme teal.
  expect(await colored.first().locator('.mail-folder-dot').evaluate((dot) => getComputedStyle(dot).backgroundColor)).toBe(
    'rgb(0, 121, 107)',
  )

  // Keyboard path: Shift+F10 on the folder, "Move folder to…", the picker, confirm.
  await tree.getByRole('button', { name: 'Team', exact: true }).focus()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menuitem', { name: 'Add to favorites' })).toBeFocused()
  await page.getByRole('menuitem', { name: 'Move folder to…' }).click()
  const picker = page.getByRole('dialog', { name: 'Move Team to…' })
  await picker.getByRole('radio', { name: 'Clients' }).check()
  await picker.getByRole('button', { name: 'Move here' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('“Team” into “Clients”')
  await confirm.getByRole('button', { name: 'Move folder' }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).startupProbe.requests.find((r: any) => r.command === 'mail.folderMove')?.payload),
    )
    .toEqual({ account_id: 'synthetic-account', folder_id: 'Team', parent_id: 'Clients' })
  await expect(tree.getByRole('button', { name: 'Collapse Clients' })).toBeVisible()
  await expect(tree.locator('.mail-folder-children').getByRole('button', { name: 'Team', exact: true })).toBeVisible()

  await page.reload()
  await expect(
    nav.getByRole('region', { name: 'Favorites' }).getByRole('button', { name: 'Clients Color: Teal 1', exact: true }),
  ).toBeVisible()
  expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
  expect(errors).toEqual([])
})

// SET-19 (ADR-0052): the reader's name order in the address book, a group as a
// filter and as a list to change, and a group expanded in the composer — all
// under the production CSP.
test('contact names and groups in the address book and the composer', async ({ page }) => {
  await page.addInitScript(() => {
    const prefs = JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}')
    sessionStorage.setItem(
      'synthetic-prefs',
      JSON.stringify({ ...prefs, contact_name_display: 'last_comma_first', contact_name_sort: 'last' }),
    )
  })
  const errors = await prepareStartup(page, true)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const replies = (window as any).startupProbe.replies
    const person = (id: string, given: string, family: string, addr: string) => ({
      id, source: 'local', account: '', book: 'local', name: `${given} ${family}`, given, family,
      organisation: '', note: '', photo: '', emails: [{ addr, label: '' }], phones: [], version: '1', editable: true,
    })
    replies['people.list'] = {
      people: [
        person('local::local:c', 'Charles', 'Babbage', 'charles@example.test'),
        person('local::local:a', 'Ada', 'Lovelace', 'ada@example.test'),
        person('local::local:z', 'Zed', 'Abbot', 'zed@example.test'),
      ],
    }
    replies['people.groups'] = {
      groups: [
        {
          id: 'group:local::local:g', source: 'local', account: '', book: 'local', name: 'Engines', version: '3',
          editable: true,
          members: [
            { id: 'local::local:a', name: 'Ada Lovelace', given: 'Ada', family: 'Lovelace', addr: 'ada@example.test' },
            { id: 'local::local:c', name: 'Charles Babbage', given: 'Charles', family: 'Babbage', addr: 'charles@example.test' },
          ],
        },
      ],
    }
    replies['people.groupSave'] = { ok: true, id: 'group:local::local:g', version: '4' }
  })
  await page.getByTitle('People', { exact: true }).click()
  const list = page.getByRole('listbox', { name: 'People' })
  await expect(list.getByRole('option')).toHaveText([/Abbot, Zed/, /Babbage, Charles/, /Lovelace, Ada/])
  // At 1440 px the groups are the folder pane's body (#326): a button, not a select.
  await page
    .getByRole('navigation', { name: 'Contact groups', exact: true })
    .getByRole('button', { name: 'Engines (2)', exact: true })
    .click()
  await expect(list.getByRole('option')).toHaveCount(2)
  await list.getByRole('option', { name: /Lovelace, Ada/ }).click()
  await expect(page.getByRole('heading', { name: 'Lovelace, Ada' })).toBeVisible()
  await page.getByRole('button', { name: 'Remove from Engines' }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).startupProbe.requests.find((r: any) => r.command === 'people.groupSave')?.payload),
    )
    .toEqual({ id: 'group:local::local:g', version: '3', name: 'Engines', members: ['local::local:c'] })

  // Back to the mail, then a new message.
  await page.getByTitle('People', { exact: true }).click()
  await page.keyboard.press('Control+n')
  await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible()
  const to = page.getByPlaceholder('recipient@example.com')
  await to.fill('engi')
  await expect(page.getByText('group, 2 people')).toBeVisible()
  await to.press('Enter')
  await expect(page.getByText('Lovelace, Ada', { exact: true })).toBeVisible()
  await expect(page.getByText('Babbage, Charles', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
  expect(errors).toEqual([])
})

// The details sidebar (#212, ADR-0059): an agenda of the coming week, a width
// that can be changed with the pointer or the keyboard within safe limits, and
// the section last used, all kept across a restart.
async function agendaSidebarStartup(page: Page, options: SetupOptions) {
  const errors = await prepareStartup(page, true, { navigation: true, ...options })
  await page.addInitScript(() => {
    const probe = (window as any).startupProbe
    const app = (window as any).go.main.App
    const at = (offset: number, hour: number) => {
      const date = new Date()
      date.setHours(0, 0, 0, 0)
      date.setDate(date.getDate() + offset)
      date.setHours(hour)
      return Math.floor(date.getTime() / 1000)
    }
    probe.replies['tasks.list'] = {
      tasks: [
        {
          id: 7, thread_id: '', account_id: '', folder_id: '', note: '', due_at: at(-1, 0), completed_at: null,
          created_at: 0, subject: '', from_name: '', from_addr: '', linked: false, list_id: 'list:home',
          title: 'Overdue synthetic task', priority: 2, reminder_at: null, revision: 1,
        },
      ],
    }
    probe.replies['tasks.get'] = {
      title: 'Overdue synthetic task', note: '', due_at: at(-1, 0), list_id: 'list:home', priority: 2,
      reminder_at: null, revision: 1, linked: false, recurrence: null,
    }
    // An all-day event is a date stored at midnight UTC: today's local date.
    const today = new Date()
    const holiday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 1000
    const invoke = app.Invoke
    app.Invoke = async (command: string, payload: Record<string, unknown>) => {
      if (command !== 'calendar.events') return invoke(command, payload)
      probe.calls.push(command)
      probe.requests.push({ command, payload: structuredClone(payload) })
      // One account's calendar has the meeting; the other has none.
      const events =
        payload.account_id === 'synthetic-account'
          ? [
              {
                id: 'planning', calendar_id: 'primary', subject: 'Synthetic planning meeting', start: at(1, 9),
                end: at(1, 10), all_day: false, is_recurring: false, is_cancelled: false, free_busy: 'busy',
                my_response: '', attendees: [],
              },
              {
                id: 'holiday', calendar_id: 'primary', subject: 'Synthetic holiday', start: holiday,
                end: holiday + 86_400, all_day: true, is_recurring: false, is_cancelled: false, free_busy: 'free',
                my_response: '', attendees: [],
              },
            ]
          : []
      return { events }
    }
  })
  return errors
}

async function openAgendaSidebar(page: Page) {
  await page.getByRole('table').getByRole('button', { name: /Pilot checklist/ }).click()
  await page.getByRole('button', { name: 'Conversation details', exact: true }).first().click()
  const panel = page.locator('[data-details-panel]')
  await expect(panel).toBeVisible()
  // Measured once it has slid in.
  await panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
  return panel
}

async function expectInsideWindow(page: Page, panel: ReturnType<Page['locator']>, width: number, where: string) {
  const box = (await panel.boundingBox())!
  expect(box.x, where).toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width, where).toBeLessThanOrEqual(width + 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), where).toBe(true)
}

for (const theme of ['oreneta-light', 'oreneta-dark']) {
  for (const width of [600, 1024, 1440]) {
    test(`details sidebar agenda, resizing and remembered section: ${theme}, ${width}px (#212)`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors = await agendaSidebarStartup(page, { theme })
      await page.goto('/')
      let panel = await openAgendaSidebar(page)
      await panel.getByRole('button', { name: 'Agenda', exact: true }).click()
      await expect(panel.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
      await expect(panel.getByRole('region', { name: 'Overdue' }).getByText('Overdue synthetic task')).toBeVisible()
      await expect(panel.getByRole('region', { name: 'Tomorrow' }).getByText('Synthetic planning meeting')).toBeVisible()
      await expect(panel.getByRole('region', { name: 'Today' }).getByText('Synthetic holiday')).toBeVisible()
      await expectInsideWindow(page, panel, width, 'agenda')
      // From the keyboard: Enter on a task opens its editor; closing it comes back here.
      await panel.getByRole('button', { name: /Overdue synthetic task/ }).focus()
      await page.keyboard.press('Enter')
      const editor = page.getByRole('dialog')
      await expect(editor).toBeVisible()
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(editor).toBeHidden()
      await expect(panel.getByText('Overdue synthetic task')).toBeVisible()
      // Its own header is on top and usable at every width: back to the overview and in again.
      await panel.getByRole('button', { name: 'Back', exact: true }).click()
      await expect(panel.getByRole('heading', { name: 'Agenda', exact: true })).toBeHidden()
      await panel.getByRole('button', { name: 'Agenda', exact: true }).click()
      await expect(panel.getByText('Synthetic planning meeting')).toBeVisible()

      const handle = panel.getByRole('separator', { name: 'Resize details panel' })
      const reader = page.locator('[data-message-pane] section').first()
      let kept = '340'
      if (width >= 1100) {
        // Beside the reader: the keyboard and the pointer both resize it.
        // With the rail and the 260 px folder pane (#317) the reader's row
        // is 760 px at 1440, so the widest beside the reader is 400 px.
        await handle.focus()
        await page.keyboard.press('ArrowLeft')
        await page.keyboard.press('ArrowLeft')
        await expect(handle).toHaveAttribute('aria-valuenow', '372')
        expect(Math.round((await panel.boundingBox())!.width)).toBe(372)
        const grip = (await handle.boundingBox())!
        await page.mouse.move(grip.x + grip.width / 2, grip.y + 200)
        await page.mouse.down()
        await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + 200, { steps: 4 })
        await page.mouse.up()
        const dragged = Number(await handle.getAttribute('aria-valuenow'))
        expect(Math.abs(dragged - 312)).toBeLessThanOrEqual(2)
        expect(Math.abs((await panel.boundingBox())!.width - dragged)).toBeLessThanOrEqual(1)
        // The widest it goes still leaves the reader its room; the narrowest is 280.
        await page.keyboard.press('End')
        const widest = Number(await handle.getAttribute('aria-valuemax'))
        await expect(handle).toHaveAttribute('aria-valuenow', String(widest))
        expect(Math.abs((await panel.boundingBox())!.width - widest)).toBeLessThanOrEqual(1)
        expect((await reader.boundingBox())!.width).toBeGreaterThanOrEqual(360 - 1)
        await expectInsideWindow(page, panel, width, 'widest')
        await page.keyboard.press('Home')
        await expect(handle).toHaveAttribute('aria-valuenow', '280')
        await page.keyboard.press('Shift+ArrowLeft')
        kept = '344'
        await expect(handle).toHaveAttribute('aria-valuenow', kept)
        await expect
          .poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}').details_panel_width))
          .toBe(344)
      } else {
        // An overlay over the reader at this width, capped to the window: no separator.
        await expect(panel).toHaveAttribute('data-layout', 'overlay')
        await expect(handle).toBeHidden()
        expect(Math.round((await panel.boundingBox())!.width)).toBe(Math.min(340, Math.floor(width * 0.85)))
      }

      // 200 % text size: the sidebar and its agenda stay on screen.
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
      for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px')
      await expect(panel.getByRole('heading', { name: 'Agenda', exact: true })).toBeInViewport()
      await expect(panel.getByText('Synthetic planning meeting')).toBeInViewport()
      await expectInsideWindow(page, panel, width, 'zoom 200%')
      await info.attach(`details-agenda-${theme}-${width}`, {
        body: await page.screenshot({ path: info.outputPath('details-agenda.png'), animations: 'disabled' }),
        contentType: 'image/png',
      })
      await page.keyboard.press(`${mod}+Digit0`)

      const audit = await new AxeBuilder({ page }).include('[data-details-panel]').withTags(AXE_TAGS).analyze()
      expect(
        audit.violations
          .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
          .map((violation) => violation.id),
      ).toEqual([])

      // After a restart the sidebar opens on the agenda, at the width it had.
      await expect
        .poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}').session_sidebar_section_main))
        .toBe('agenda')
      await page.reload()
      panel = await openAgendaSidebar(page)
      await expect(panel.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
      await expect(panel.getByText('Synthetic planning meeting')).toBeVisible()
      if (width >= 1100) await expect(handle).toHaveAttribute('aria-valuenow', kept)
      expect(errors).toEqual([])
    })
  }
}

// Just above the push-aside breakpoint the widest sidebar is what leaves the
// reader 360 px, and below it a remembered 560 px overlay is held to 85 %.
for (const width of [1100, 1180, 600]) {
  test(`details sidebar width limits with a remembered 560 px at ${width}px (#212)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors = await agendaSidebarStartup(page, { preferences: { details_panel_width: 560 } })
    await page.goto('/')
    const panel = await openAgendaSidebar(page)
    const drawn = (await panel.boundingBox())!.width
    if (width < 1100) {
      await expect(panel).toHaveAttribute('data-layout', 'overlay')
      expect(Math.round(drawn)).toBe(Math.floor(width * 0.85))
    } else {
      const handle = panel.getByRole('separator', { name: 'Resize details panel' })
      const reader = (await page.locator('[data-message-pane] section').first().boundingBox())!.width
      if ((await panel.getAttribute('data-layout')) === 'beside') {
        const max = Number(await handle.getAttribute('aria-valuemax'))
        expect(max).toBeLessThan(560)
        await expect(handle).toHaveAttribute('aria-valuenow', String(max))
        expect(Math.abs(drawn - max)).toBeLessThanOrEqual(1)
        expect(reader).toBeGreaterThanOrEqual(360 - 1)
      } else {
        // No room beside the reader at all: an overlay, without a separator.
        await expect(handle).toBeHidden()
      }
    }
    await expectInsideWindow(page, panel, width, `${width}`)
    expect(errors).toEqual([])
  })
}

test('details sidebar agenda at 200-percent desktop zoom equivalent (1440 physical / 720 CSS pixels) (#212)', async ({ browser }) => {
  // West and east of Greenwich: today's all-day event stays on today.
  for (const [theme, timezoneId] of [
    ['oreneta-light', 'America/Sao_Paulo'],
    ['oreneta-dark', 'Australia/Sydney'],
  ]) {
    const context = await browser.newContext({
      viewport: { width: 720, height: 900 },
      deviceScaleFactor: 2,
      locale: 'en-US',
      timezoneId,
    })
    try {
      const page = await context.newPage()
      const errors = await agendaSidebarStartup(page, { theme, preferences: { session_sidebar_section_main: 'agenda' } })
      await page.goto('http://127.0.0.1:4182/')
      const panel = await openAgendaSidebar(page)
      // The remembered section, straight away.
      await expect(panel.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
      await expect(panel.getByText('Synthetic planning meeting')).toBeInViewport()
      await expect(panel.getByRole('region', { name: 'Today' }).getByText('Synthetic holiday')).toBeVisible()
      await expectInsideWindow(page, panel, 720, `${theme} 720`)
      expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await context.close()
    }
  }
})

// Catalan, the language a fresh profile starts in (#231, ADR-0062). The
// labels come from the shipped catalog, so the checks follow its wording.
const caCatalog = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../locales/ca.json', import.meta.url)), 'utf8'),
) as Record<string, string>
const enCatalog = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../locales/en.json', import.meta.url)), 'utf8'),
) as Record<string, string>
const esCatalog = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../locales/es.json', import.meta.url)), 'utf8'),
) as Record<string, string>

for (const systemLocale of ['en-US', 'es-ES', 'ja-JP']) {
  test(`a fresh profile starts in Catalan on a ${systemLocale} system; a saved choice wins (#231)`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: systemLocale })
    try {
      const fresh = await context.newPage()
      const errors = await prepareStartup(fresh, true, { navigation: true, language: null })
      await fresh.goto('http://127.0.0.1:4182/')
      await expect(fresh.locator('html')).toHaveAttribute('lang', 'ca')
      await expect(fresh.getByTitle(caCatalog['people.title'], { exact: true })).toBeVisible()
      // Nothing was chosen, so nothing is written as a choice.
      const writes = await fresh.evaluate(() =>
        (window as any).startupProbe.requests.filter(
          (request: any) => request.command === 'app.prefsSet' && request.payload.key === 'language',
        ),
      )
      expect(writes).toEqual([])
      expect(errors).toEqual([])

      const saved = await context.newPage()
      const savedErrors = await prepareStartup(saved, true, { navigation: true, language: 'en' })
      await saved.goto('http://127.0.0.1:4182/')
      await expect(saved.locator('html')).toHaveAttribute('lang', 'en')
      await expect(saved.getByTitle('People', { exact: true })).toBeVisible()
      expect(savedErrors).toEqual([])
    } finally {
      await context.close()
    }
  })
}

// Until the stored choice is read, the interface is in the language the last
// run showed, Catalan on a fresh profile: from the first paint, not English
// until an effect runs (#231, ADR-0062).
for (const [cache, language] of [
  [null, 'ca'],
  ['es', 'es'],
] as const) {
  test(`before the stored choice is read the interface is already in ${language} (#231)`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const errors = await prepareStartup(page, true, { navigation: true, language: cache })
    await page.addInitScript(
      ({ cache }) => {
        if (cache) localStorage.setItem('meron-language-cache', cache)
        const probe = (window as any).startupProbe
        const app = (window as any).go.main.App
        const invoke = app.Invoke
        let release = () => {}
        const held = new Promise<void>((resolve) => (release = resolve))
        probe.releasePrefs = () => release()
        app.Invoke = async (command: string, payload: Record<string, unknown>) => {
          if (command === 'app.prefsGet') await held
          return invoke(command, payload)
        }
      },
      { cache },
    )
    const catalog = language === 'ca' ? caCatalog : esCatalog
    const unread = page.getByRole('button', { name: catalog['filters.unread'], exact: true })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', language)
    await expect(unread).toBeVisible()
    await expect(page.getByRole('button', { name: 'Unread', exact: true })).toHaveCount(0)
    await page.evaluate(() => (window as any).startupProbe.releasePrefs())
    await expect(page.locator('[data-thread-list]')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', language)
    await expect(unread).toBeVisible()
    expect(errors).toEqual([])
  })
}

test('a failed read of the stored choice keeps the language the profile last showed (#231)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, language: 'es' })
  await page.addInitScript(() => {
    localStorage.setItem('meron-language-cache', 'es')
    const app = (window as any).go.main.App
    const invoke = app.Invoke
    app.Invoke = async (command: string, payload: Record<string, unknown>) => {
      if (command === 'app.prefsGet') throw new Error('Synthetic core outage')
      return invoke(command, payload)
    }
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await expect(page.getByRole('button', { name: esCatalog['filters.unread'], exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('meron-language-cache'))).toBe('es')
  expect(errors).toEqual([])
})

test('switching from Catalan to English and back is saved and shown without a reload (#231)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, language: null })
  await page.goto('/')
  const html = page.locator('html')
  await expect(html).toHaveAttribute('lang', 'ca')
  const navigations: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url())
  })
  await page.getByRole('textbox').first().focus()
  await page.keyboard.press('Control+Comma')
  const language = page.locator('select').filter({ has: page.locator('option[value="ca"]') })
  // Nobody chose yet: the picker shows the language in use.
  await expect(language).toHaveValue('ca')
  await expect(language.locator('option[value="ca"]')).toHaveText('Català')
  await language.selectOption('en')
  await expect(html).toHaveAttribute('lang', 'en')
  await language.selectOption('system')
  await expect(html).toHaveAttribute('lang', 'en')
  await language.selectOption('ca')
  await expect(html).toHaveAttribute('lang', 'ca')
  const writes = await page.evaluate(() =>
    (window as any).startupProbe.requests
      .filter((request: any) => request.command === 'app.prefsSet' && request.payload.key === 'language')
      .map((request: any) => request.payload.value),
  )
  expect(writes).toEqual(['en', 'system', 'ca'])
  // Go's tray and notification labels follow the switch.
  const labels = await page.evaluate(() =>
    (window as any).startupProbe.requests
      .filter((request: any) => request.command === 'i18n.setNativeLabels')
      .map((request: any) => request.payload.trayQuit),
  )
  expect(labels.at(-1)).toBe(caCatalog['tray.quitOreneta'])
  expect(labels).toContain('Quit Oreneta')
  await page.keyboard.press('Escape')
  expect(navigations).toEqual([])
  expect(errors).toEqual([])
})

// What a check of "nothing leaves the window" reads in left to right: no
// horizontal scroll, and no control or heading past either edge.
async function ltrInView(page: Page, where: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), where).toBe(true)
  const outside = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'button, [role=button], [role=tab], [role=option], a[href], input, select, textarea, h1, h2, h3',
      ),
    ]
      .filter((element) => {
        const box = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') return false
        return box.left < -1 || box.right > innerWidth + 1
      })
      .map(
        (element) =>
          // An unnamed field is reported by its tag and placeholder rather than as "".
          (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim().slice(0, 40)) ||
          `${element.tagName.toLowerCase()} "${element.getAttribute('placeholder') ?? ''}"`,
      ),
  )
  expect(outside, where).toEqual([])
}

// Waits until no CSS transition or finite animation is still running, so an
// audit reads the screen at rest and not one frame of a transition (#243).
// Infinite animations (spinners) never end and are left out.
async function settled(page: Page) {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.playState !== 'running' || animation.effect?.getComputedTiming().endTime === Infinity,
        ),
    undefined,
    { timeout: 5_000 },
  )
}

// Where the keyboard focus is: inside a hidden region (aria-hidden, inert or
// not visible) or not, and a short name for the report.
async function focusStop(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null
    const start = (window as any).__focusWalkStart as Element | undefined
    if (!element || element === document.body) return { name: 'body', hidden: false, atStart: false }
    const hidden =
      element.closest('[aria-hidden="true"], [inert]') !== null || getComputedStyle(element).visibility !== 'visible'
    const name =
      element.getAttribute('aria-label') ??
      element.getAttribute('title') ??
      element.getAttribute('placeholder') ??
      element.textContent?.trim().slice(0, 40) ??
      ''
    return { name: `${element.tagName.toLowerCase()} ${name}`, hidden, atStart: element === start }
  })
}

// The conversation under an open compose tab stays mounted, hidden (#243).
// axe once caught it at 1024 px holding focusable controls: a child with
// `transition-all` (the quick-reply box) stays visible, and focusable, until
// its transition ends. The app's own transitions are stretched to 30 s here so
// that moment holds still, and the hidden region must still be out of reach:
// inert, nothing in it takes focus, and Tab and Shift+Tab never stop in it.
// Only elements that declare a transition are stretched: an element without
// one has `transition-property: all` by default and would start new ones.
const SLOW_TRANSITIONS =
  "[class*='transition'] { transition-duration: 30s !important; transition-delay: 0s !important; }"

for (const language of ['en', 'ca']) {
  for (const theme of ['oreneta-light', 'oreneta-dark']) {
    test(`the conversation hidden under the composer has no keyboard stop: ${language}, ${theme}, 1024px (#243)`, async ({
      page,
    }, info) => {
      // Two walks of up to 150 key presses each, on top of two audits.
      test.setTimeout(60_000)
      await page.setViewportSize({ width: 1024, height: 1000 })
      const errors = await prepareStartup(page, true, { navigation: true, language, theme })
      const catalog = language === 'ca' ? caCatalog : enCatalog
      await page.goto('/')
      await expect(page.locator('html')).toHaveAttribute('lang', language)
      await page.getByRole('table').getByRole('button', { name: /Pilot checklist/ }).click()
      await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
      const quickReply = page.getByPlaceholder(catalog['composer.placeholders.quickMessage'], { exact: true })
      await expect(quickReply).toBeVisible()
      await expect(page.locator('[inert]', { has: quickReply })).toHaveCount(0)

      const slow = await page.addStyleTag({ content: SLOW_TRANSITIONS })
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
      await page.keyboard.press(`${mod}+KeyN`)
      const editor = page.locator('.tiptap[contenteditable="true"]')
      await expect(editor).toBeVisible()
      const region = page.locator('[aria-hidden="true"]', { has: quickReply })
      await expect(region).toHaveCount(1)
      await expect(region).toHaveAttribute('inert', '')

      // The transition is still running: controls in the hidden region are
      // visible to the layout, which is the state axe caught. None of them
      // may take the focus.
      const insideRegion = await region.evaluate((element) => {
        const selector = 'button, a[href], input, select, textarea, [tabindex]'
        const controls = [...element.querySelectorAll<HTMLElement>(selector)]
        const visible = controls.filter((control) => getComputedStyle(control).visibility === 'visible')
        const focused = visible.filter((control) => {
          control.focus()
          return document.activeElement === control
        })
        return { visible: visible.length, focused: focused.map((control) => control.outerHTML.slice(0, 80)) }
      })
      expect(insideRegion.visible, 'the hidden region is still mid-transition').toBeGreaterThan(0)
      expect(insideRegion.focused).toEqual([])
      const frozen = await new AxeBuilder({ page }).withRules(['aria-hidden-focus']).analyze()
      expect(frozen.violations.map((violation) => violation.nodes.map((node) => node.target.join(' ')))).toEqual([])

      // Tab and Shift+Tab from the message body, round the page each way.
      // Shift+Tab meets the hidden region first (it sits just before the
      // composer in the document), and must pass it on to the tab strip.
      const current = `button ${catalog['chat.currentConversation']}`
      const walks: Record<string, string[]> = {}
      const hiddenStops: string[] = []
      for (const key of ['Tab', 'Shift+Tab']) {
        await editor.focus()
        await page.evaluate(() => {
          ;(window as any).__focusWalkStart = document.activeElement
        })
        const stops: string[] = []
        for (let step = 0; step < 150; step++) {
          await page.keyboard.press(key)
          const stop = await focusStop(page)
          if (stop.atStart) break
          stops.push(stop.name)
          if (stop.hidden) hiddenStops.push(`${key}: ${stop.name}`)
        }
        walks[key] = stops
        expect(new Set(stops).size, `${key} moves the focus`).toBeGreaterThan(3)
      }
      expect(walks['Shift+Tab'], 'Shift+Tab passes the hidden region').toContain(current)
      await info.attach(`focus-walk-${language}-${theme}`, {
        body: JSON.stringify({ insideRegion, walks }, null, 2),
        contentType: 'application/json',
      })
      expect(hiddenStops).toEqual([])
      // The walks ran with the composer open and the conversation hidden.
      await expect(region).toHaveAttribute('inert', '')

      // At rest, the composer passes axe as a whole.
      await slow.evaluate((element) => (element as Element).remove())
      await page.evaluate(() => {
        for (const animation of document.getAnimations()) {
          const finite = animation.effect?.getComputedTiming().endTime !== Infinity
          if (finite && animation.playbackRate !== 0) animation.finish()
        }
      })
      await settled(page)
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
      const body = JSON.stringify({ screen: 'composer', language, theme, violations: results.violations }, null, 2)
      await info.attach(`axe-composer-${language}-${theme}-1024`, { body, contentType: 'application/json' })
      const blocking = results.violations
        .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
        .map((violation) => {
          const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ')
          return `${violation.id} (${violation.impact}) on ${targets}`
        })
      expect(blocking).toEqual([])

      // Back on the conversation, its quick reply is reachable again. Going
      // back, the quick reply's `transition-all` carries the inherited
      // `visibility` from hidden to visible, and a transition stays on its
      // start value (hidden) until its first tick; a hidden control ignores
      // focus(), which does not wait. A slow runner stretches that gap, so the
      // gap is held open here, with the animation timeline stopped, so every
      // run meets it: the quick reply is proved hidden before time resumes.
      const animations = await page.context().newCDPSession(page)
      await animations.send('Animation.setPlaybackRate', { playbackRate: 0 })
      try {
        await page.getByTitle(catalog['chat.currentConversation'], { exact: true }).click()
        await expect(page.locator('[inert]', { has: quickReply })).toHaveCount(0)
        await expect(page.locator('[aria-hidden="true"]', { has: quickReply })).toHaveCount(0)
        await expect(quickReply).toBeHidden()
      } finally {
        await animations.send('Animation.setPlaybackRate', { playbackRate: 1 })
      }
      // toBeVisible reads the computed `visibility`, so it waits for the tick.
      await expect(quickReply).toBeVisible()
      await quickReply.focus()
      await expect(quickReply).toBeFocused()
      expect(errors).toEqual([])
    })
  }
}

// The production entry in Catalan, whose strings run longer than English:
// every main screen stays inside the window at 100% and 200%, and axe finds
// nothing critical or serious (#231).
for (const theme of ['oreneta-light', 'oreneta-dark']) {
  for (const width of [600, 1024, 1440]) {
    test(`Catalan interface stays inside the window and passes axe: ${theme}, ${width}px (#231)`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors = await prepareStartup(page, true, { navigation: true, language: 'ca', theme })
      await page.goto('/')
      await expect(page.locator('html')).toHaveAttribute('lang', 'ca')
      await expect(page.locator('[data-thread-list]')).toBeVisible()
      await page.evaluate(() => {
        const replies = (window as any).startupProbe.replies
        replies['people.list'] = {
          people: [
            {
              id: 'local::montserrat', source: 'local', account: '', book: 'local',
              name: 'Montserrat Puigdomènech i Vilaseca — Coordinació internacional de projectes',
              organisation: 'Departament de recerca i atenció a la ciutadania', note: 'Contacte sintètic', photo: '',
              emails: [{ addr: 'coordinacio.internacional.projectes@example.test', label: '' }], phones: [],
              version: '1', editable: true,
            },
          ],
        }
        replies['tasks.lists'] = { lists: [{ id: 'mail', name: '', position: 0, open: 1 }] }
        replies['tasks.list'] = {
          tasks: [
            {
              id: 1, thread_id: '', account_id: '', folder_id: '', note: 'Revisió pendent', due_at: null,
              completed_at: null, created_at: 0, subject: '', from_name: '', from_addr: '', linked: false,
              list_id: 'mail', title: 'Revisar la proposta de coordinació internacional abans de la reunió',
              priority: 2, reminder_at: null, revision: 1,
            },
          ],
        }
        const note = {
          id: 'note:ca', title: 'Notes de la reunió', html: '<p>Text de la nota</p>', text: 'Text de la nota',
          tags: [], pinned: false, revision: 1, created_at: 0, updated_at: 1760000000, deleted_at: null,
        }
        replies['notes.list'] = { notes: [{ ...note, preview: note.text }], tags: [] }
        replies['notes.get'] = { note }
        replies['calendar.list'] = {
          calendars: [
            {
              id: 'local-ca', name: 'Planificació de l’equip internacional', is_default: true, enabled: true,
              kind: 'local', read_only: false, synced_at: 0,
            },
          ],
        }
        replies['calendar.events'] = { events: [] }
        replies['chat.accounts'] = [{ id: 'c1', jid: 'anna@chat.test', host: '', port: 5222 }]
        replies['chat.status'] = { c1: { account: 'c1', state: 'online' } }
        replies['chat.conversations'] = [
          { conversation: 'pau@chat.test', last_body: 'Bon dia', last_stamp: 1760000120, last_direction: 'in', unread: 1 },
        ]
        replies['chat.history'] = [
          {
            account: 'c1', conversation: 'pau@chat.test', id: 'm1', stanza_id: 'a1', direction: 'in',
            sender: 'pau@chat.test', body: 'Bon dia, Anna', stamp: 1760000000, state: 'received',
          },
        ]
      })

      const blocking: string[] = []
      const check = async (screen: string) => {
        await settled(page)
        await ltrInView(page, screen)
        const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
        const body = JSON.stringify({ screen, theme, width, violations: results.violations }, null, 2)
        await info.attach(`axe-ca-${screen}-${theme}-${width}`, { body, contentType: 'application/json' })
        writeFileSync(info.outputPath(`axe-ca-${screen}.json`), body)
        for (const violation of results.violations) {
          if (violation.impact === 'critical' || violation.impact === 'serious') {
            const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ')
            blocking.push(`${screen}: ${violation.id} (${violation.impact}) on ${targets}`)
          }
        }
        await info.attach(`ca-${screen}`, {
          body: await page.screenshot({ path: info.outputPath(`ca-${screen}.png`), animations: 'disabled' }),
          contentType: 'image/png',
        })
      }
      // The rail on a wide window; the "More" menu on a narrow one.
      const openArea = async (key: string) => {
        if (width < 769) {
          await page.getByRole('button', { name: caCatalog['common.more'], exact: true }).first().click()
          await page.getByRole('menuitem', { name: caCatalog[key], exact: true }).last().click()
        } else {
          await page.getByTitle(caCatalog[key], { exact: true }).click()
        }
      }
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
      // 200%: the app's own zoom (#181), six steps up.
      const at200 = async (screen: string) => {
        for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px')
        await ltrInView(page, `${screen} at 200%`)
        await page.keyboard.press(`${mod}+Digit0`)
      }

      await check('mailbox')
      await at200('mailbox')

      await openArea('people.title')
      await page.getByRole('option', { name: /Montserrat Puigdomènech/ }).click()
      await expect(page.getByRole('heading', { name: /Montserrat Puigdomènech/ })).toBeVisible()
      await check('people')
      await at200('people')
      if (width < 769) await page.getByRole('button', { name: caCatalog['buttons.back'], exact: true }).click()

      await openArea('tasks.title')
      await expect(page.getByText('Revisar la proposta de coordinació internacional abans de la reunió')).toBeVisible()
      await check('tasks')
      await at200('tasks')

      await openArea('notes.title')
      await page.getByRole('button', { name: /Notes de la reunió/ }).click()
      await expect(page.getByLabel(caCatalog['notes.titleLabel'])).toHaveValue('Notes de la reunió')
      await check('notes')

      await openArea('calendar.title')
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await check('calendar')
      await at200('calendar')
      // Dates in Catalan: the month view names the month as Catalan does.
      // (Its days of the adjacent months fail axe's contrast rule in every
      // language, so the audit above runs on the default view.)
      const month = page.getByRole('button', { name: caCatalog['calendar.viewMonth'], exact: true })
      await month.click()
      await expect(month).toHaveAttribute('aria-pressed', 'true')
      const monthName = await page.evaluate(() => new Date().toLocaleDateString('ca', { month: 'long' }))
      await expect(page.getByRole('heading', { level: 1 })).toContainText(new RegExp(monthName, 'i'))
      await ltrInView(page, 'calendar month')

      await openArea('messaging.title')
      await page.getByRole('button', { name: /pau@chat.test/ }).click()
      await expect(page.getByText('Bon dia, Anna')).toBeVisible()
      await check('chat')

      // Settings at 100%: at 200% some of its selects run past a 1024 px
      // window in every language, English included (not a translation issue).
      await page.keyboard.press('Control+Comma')
      await expect(page.getByRole('dialog').first()).toBeVisible()
      await check('settings')
      await page.keyboard.press('Escape')

      // The mail workspace again, fresh: a conversation and the composer.
      await page.goto('/')
      await expect(page.locator('[data-thread-list]')).toBeVisible()
      await page.getByRole('table').getByRole('button', { name: /Pilot checklist/ }).click()
      await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
      await check('conversation')
      await at200('conversation')
      await page.keyboard.press(`${mod}+KeyN`)
      await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible()
      await check('composer')
      await at200('composer')

      expect(blocking).toEqual([])
      expect(errors).toEqual([])
    })
  }
}

// Application regions and F6 (#306, ADR-0068 step 1). The regions of today's
// shell carry `data-region`; F6 and Shift+F6 go round the ones on screen in
// the frame's order (the top band since #343, folders, modules, list, reader,
// sidebar), which is the same in right to left. Within a region the focus goes
// back to where it was.
const arCatalog = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../locales/ar.json', import.meta.url)), 'utf8'),
) as Record<string, string>
const regionCatalogs: Record<string, Record<string, string>> = { en: enCatalog, ca: caCatalog, ar: arCatalog }

// The kind of region the keyboard focus is in, or "none" outside every region.
async function regionAtFocus(page: Page): Promise<string> {
  return page.evaluate(
    () => (document.activeElement?.closest('[data-region]') as HTMLElement | null)?.dataset.region ?? 'none',
  )
}

// Presses a key a number of times and reads the region after each press.
async function regionWalk(page: Page, key: string, presses: number): Promise<string[]> {
  const kinds: string[] = []
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(key)
    kinds.push(await regionAtFocus(page))
  }
  return kinds
}

// Marks the focused element, then says whether the focus is back on it.
async function markFocus(page: Page, mark: string) {
  await page.evaluate((name) => document.activeElement?.setAttribute(name, ''), mark)
}
async function focusIsMarked(page: Page, mark: string): Promise<boolean> {
  return page.evaluate((name) => !!document.activeElement?.hasAttribute(name), mark)
}

// The axe rules about regions, which the WCAG tags the other audits use leave out.
const REGION_RULES = ['region', 'landmark-unique', 'landmark-one-main']

for (const language of ['en', 'ca', 'ar']) {
  test(`F6 and Shift+F6 go round the regions in one order in every direction of writing: ${language}, 1440px (#306)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const errors = await prepareStartup(page, true, { navigation: true, language })
    const catalog = regionCatalogs[language]
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', language)
    await expect(page.locator('[data-thread-list]')).toBeVisible()
    // One <main>, named after the module, and the rail named as what it is.
    await expect(page.getByRole('main')).toHaveCount(1)
    await expect(page.getByRole('main', { name: catalog['shell.region.mail'], exact: true })).toBeVisible()
    await expect(
      page.getByRole('complementary', { name: catalog['shell.region.modules'], exact: true }),
    ).toBeVisible()

    // A conversation open, with the details sidebar beside it, so every kind
    // of region the shell has today is on screen.
    const row = page.getByRole('table').getByRole('button', { name: /Pilot checklist/ })
    await row.click()
    await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
    await row.focus()
    await page.keyboard.press('i')
    await expect(page.locator('[data-details-panel]')).toBeVisible()
    await row.focus()
    await markFocus(page, 'data-test-f6-start')
    expect(await regionAtFocus(page)).toBe('content')

    // The top band (#343) is the first region: after the sidebar, before the folders.
    expect(await regionWalk(page, 'F6', 6)).toEqual(['reader', 'sidebar', 'search', 'folders', 'modules', 'content'])
    // Round once and back in the list, on the row it left.
    expect(await focusIsMarked(page, 'data-test-f6-start')).toBe(true)
    expect(await regionWalk(page, 'Shift+F6', 6)).toEqual([
      'modules',
      'folders',
      'search',
      'sidebar',
      'reader',
      'content',
    ])
    expect(await focusIsMarked(page, 'data-test-f6-start')).toBe(true)
    expect(errors).toEqual([])
  })
}

test('F6 leaves a text field and the HTML message, and a modal dialog keeps the focus (#306)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, readerStress: true })
  await page.goto('/')
  await page.getByRole('table').getByRole('button', { name: /Pilot checklist/ }).click()
  const frame = page.frameLocator('iframe[title="Message HTML"]').first()
  await expect(frame.getByText('Wide synthetic invoice')).toBeVisible()

  // While typing in the band's search field (#344): F6 types nothing and
  // moves on, to the folders.
  const search = page.getByRole('search').getByRole('textbox')
  await search.click()
  await search.fill('Pilot')
  // The conversation is still open, so the reader has somewhere to land.
  await expect(frame.getByText('Wide synthetic invoice')).toBeVisible()
  expect(await regionAtFocus(page)).toBe('search')
  await page.keyboard.press('F6')
  await expect(search).not.toBeFocused()
  await expect(search).toHaveValue('Pilot')
  expect(await regionAtFocus(page)).toBe('folders')

  // From inside the message's own frame, which forwards F1–F12.
  await frame.getByText('Wide synthetic invoice').click()
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME')
  await page.keyboard.press('F6')
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME')
  // No sidebar is open, so after the reader comes the first region again:
  // the top band (#343).
  expect(await regionAtFocus(page)).toBe('search')
  await frame.getByText('Wide synthetic invoice').click()
  await page.keyboard.press('Shift+F6')
  expect(await regionAtFocus(page)).toBe('content')

  // A toast is not part of the module in <main>.
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${mod}+Equal`)
  await expect(page.getByRole('status').filter({ hasText: 'Size 110%' })).toBeVisible()
  await expect(page.locator('main').getByRole('status').filter({ hasText: 'Size 110%' })).toHaveCount(0)
  await page.keyboard.press(`${mod}+Digit0`)

  // A modal dialog keeps the focus, and is not inside <main> either.
  await page.keyboard.press('Control+Comma')
  await expect(page.getByRole('dialog').first()).toBeVisible()
  await expect(page.locator('main [aria-modal="true"]')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[aria-modal="true"]'))).toBe(true)
  await markFocus(page, 'data-test-modal-focus')
  await page.keyboard.press('F6')
  await page.keyboard.press('Shift+F6')
  expect(await focusIsMarked(page, 'data-test-modal-focus')).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('rebound to a letter, the next-region shortcut stands down while typing (#306)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, {
    navigation: true,
    preferences: { shortcut_overrides: { 'pane.next': { key: 'g' } } },
  })
  await page.goto('/')
  const row = page.getByRole('table').getByRole('button', { name: /Pilot checklist/ })
  await row.click()
  await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
  // Outside a text field the letter moves on, and Shift+F6 keeps its default.
  await row.focus()
  await page.keyboard.press('g')
  expect(await regionAtFocus(page)).toBe('reader')
  await page.keyboard.press('Shift+F6')
  expect(await regionAtFocus(page)).toBe('content')
  // F6 itself no longer moves.
  await page.keyboard.press('F6')
  expect(await regionAtFocus(page)).toBe('content')
  // In a text field (the band's search, #344) the letter is typed, and the focus stays.
  const search = page.getByRole('search').getByRole('textbox')
  await search.click()
  await page.keyboard.type('g')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('g')
  expect(errors).toEqual([])
})

test('F6 skips the regions a narrow window hides, and keeps working at 200 percent (#306)', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const row = page.getByRole('table').getByRole('button', { name: /Pilot checklist/ })
  // One pane at a time: the rail, the mail navigation and the reader are not
  // shown. The top band is, with its menu (#343).
  await row.focus()
  expect(await regionWalk(page, 'F6', 3)).toEqual(['search', 'content', 'search'])
  expect(await regionWalk(page, 'Shift+F6', 2)).toEqual(['content', 'search'])
  await row.click()
  await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
  // From the row the list hid, F6 starts again at the first region.
  expect(await regionWalk(page, 'F6', 3)).toEqual(['search', 'reader', 'search'])

  // 1440 px at the app's own 200 %: the same frame, everything twice the size.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px')
  await row.focus()
  const zoomed: string[] = []
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('F6')
    zoomed.push(await regionAtFocus(page))
    await expect(page.locator(':focus')).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  expect(zoomed).toEqual(['reader', 'search', 'folders', 'modules', 'content'])
  await page.keyboard.press(`${mod}+Digit0`)
  expect(errors).toEqual([])
})

// The region rules of axe on the mailbox and every module, in English,
// Catalan and Arabic: one <main>, named after the module; no two regions of
// one role with one name; nothing outside a region.
for (const language of ['en', 'ca', 'ar']) {
  test(`every screen keeps its content in named, unique regions: ${language}, 1440px (#306)`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const errors = await prepareStartup(page, true, { navigation: true, language })
    const catalog = regionCatalogs[language]
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', language)
    await expect(page.locator('[data-thread-list]')).toBeVisible()
    await page.evaluate(() => {
      const replies = (window as any).startupProbe.replies
      replies['people.list'] = {
        people: [
          {
            id: 'local::morgan', source: 'local', account: '', book: 'local', name: 'Morgan Rivera',
            organisation: 'Example Org', note: '', photo: '',
            emails: [{ addr: 'morgan@example.test', label: '' }], phones: [], version: '1', editable: true,
          },
        ],
      }
      replies['tasks.lists'] = { lists: [{ id: 'mail', name: '', position: 0, open: 1 }] }
      replies['tasks.list'] = {
        tasks: [
          {
            id: 1, thread_id: '', account_id: '', folder_id: '', note: '', due_at: null, completed_at: null,
            created_at: 0, subject: '', from_name: '', from_addr: '', linked: false, list_id: 'mail',
            title: 'Review the figures', priority: 2, reminder_at: null, revision: 1,
          },
        ],
      }
      const note = {
        id: 'note:regions', title: 'Meeting notes', html: '<p>Kept here.</p>', text: 'Kept here.', tags: [],
        pinned: false, revision: 1, created_at: 0, updated_at: 1760000000, deleted_at: null,
      }
      replies['notes.list'] = { notes: [{ ...note, preview: note.text }], tags: [] }
      replies['notes.get'] = { note }
      replies['calendar.list'] = {
        calendars: [{ id: 'local-team', name: 'Team', is_default: true, enabled: true, kind: 'local', read_only: false, synced_at: 0 }],
      }
      replies['calendar.events'] = { events: [] }
      replies['chat.accounts'] = [{ id: 'c1', jid: 'ana@chat.test', host: '', port: 5222 }]
      replies['chat.status'] = { c1: { account: 'c1', state: 'online' } }
      replies['chat.conversations'] = [
        { conversation: 'pau@chat.test', last_body: 'Hello', last_stamp: 1760000120, last_direction: 'in', unread: 1 },
      ]
      replies['chat.history'] = [
        { account: 'c1', conversation: 'pau@chat.test', id: 'm1', stanza_id: 'a1', direction: 'in', sender: 'pau@chat.test', body: 'Hello Ana', stamp: 1760000000, state: 'received' },
      ]
    })

    const found: string[] = []
    const audit = async (screen: string, moduleName: string) => {
      await expect(page.getByRole('main')).toHaveCount(1)
      await expect(page.getByRole('main', { name: moduleName, exact: true })).toBeVisible()
      await settled(page)
      const results = await new AxeBuilder({ page }).withRules(REGION_RULES).analyze()
      const body = JSON.stringify({ screen, language, violations: results.violations }, null, 2)
      await info.attach(`axe-regions-${screen}-${language}`, { body, contentType: 'application/json' })
      for (const violation of results.violations) {
        const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ')
        found.push(`${screen}: ${violation.id} (${violation.impact}) on ${targets}`)
      }
      // F6 lands inside a region of the screen.
      await page.keyboard.press('F6')
      expect(await regionAtFocus(page), `${screen}: F6`).not.toBe('none')
    }

    await audit('mailbox', catalog['shell.region.mail'])
    const row = page.getByRole('table').getByRole('button', { name: /Pilot checklist/ })
    await row.click()
    await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
    await row.focus()
    await page.keyboard.press('i')
    await expect(page.locator('[data-details-panel]')).toBeVisible()
    await audit('conversation', catalog['shell.region.mail'])

    const peopleButton = page.getByTitle(catalog['people.title'], { exact: true })
    await peopleButton.click()
    await page.getByRole('option', { name: /Morgan Rivera/ }).click()
    await expect(page.getByRole('heading', { name: 'Morgan Rivera' })).toBeVisible()
    // The groups are the folder pane (#326), beside the module: from the rail,
    // F6 goes to the module, the top band (#343), the pane, then back to the rail.
    await peopleButton.focus()
    expect(await regionWalk(page, 'F6', 4)).toEqual(['content', 'search', 'folders', 'modules'])
    await audit('people', catalog['people.title'])

    const tasksButton = page.getByTitle(catalog['tasks.title'], { exact: true })
    await tasksButton.click()
    await expect(page.getByText('Review the figures')).toBeVisible()
    // The lists are the folder pane (#329), beside the module: from the rail,
    // F6 goes to the module, the top band (#343), the pane, then back to the rail.
    await tasksButton.focus()
    expect(await regionWalk(page, 'F6', 4)).toEqual(['content', 'search', 'folders', 'modules'])
    await audit('tasks', catalog['tasks.title'])

    const notesButton = page.getByTitle(catalog['notes.title'], { exact: true })
    await notesButton.click()
    await page.getByRole('button', { name: /Meeting notes/ }).click()
    // The tags are the folder pane (#335), beside the module: from the rail,
    // F6 goes to the module, the top band (#343), the pane, then back to the rail.
    await notesButton.focus()
    expect(await regionWalk(page, 'F6', 4)).toEqual(['content', 'search', 'folders', 'modules'])
    await audit('notes', catalog['notes.title'])

    const calendarButton = page.getByTitle(catalog['calendar.title'], { exact: true })
    await calendarButton.click()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // Calendar's calendars are the folder pane (#323), beside the module:
    // from the rail, F6 goes to the module, the top band (#343), the pane, then
    // back to the rail.
    await calendarButton.focus()
    expect(await regionWalk(page, 'F6', 4)).toEqual(['content', 'search', 'folders', 'modules'])
    await audit('calendar', catalog['calendar.title'])

    await page.getByTitle(catalog['messaging.title'], { exact: true }).click()
    await page.getByRole('button', { name: /pau@chat.test/ }).click()
    await expect(page.getByText('Hello Ana')).toBeVisible()
    await audit('chat', catalog['messaging.title'])
    // The conversations are the folder pane (#337), beside the module: from
    // the rail, F6 goes to the module, the top band (#343), the pane, then back
    // to the rail.
    await page.getByTitle(catalog['messaging.title'], { exact: true }).focus()
    expect(await regionWalk(page, 'F6', 4)).toEqual(['content', 'search', 'folders', 'modules'])

    // A file in the list: its "open the message" button is what F6 reaches in
    // the content, now that the filters have moved to the pane.
    await page.evaluate(() => {
      ;(window as any).startupProbe.replies['attachments.list'] = {
        items: [
          {
            account: 'synthetic-account', folder: 'INBOX', uid: 2, thread_key: 'k', thread_id: 'synthetic-account#INBOX#2',
            subject: 'Quarterly numbers', from_name: 'Synthetic Sender', from_addr: 'sender@example.test', date: 1760000000,
            index: 0, filename: 'report.pdf', mime: 'application/pdf', size: 90000, key: null, kind: 'pdf', unavailable: '',
          },
        ],
        total: 1,
        coverage: { messages: 10, downloaded: 7 },
      }
    })
    const attachmentsButton = page.getByTitle(catalog['attachmentsView.title'], { exact: true })
    await attachmentsButton.click()
    await expect(page.getByText('report.pdf')).toBeVisible()
    // The filters are the folder pane (#339), beside the module: from the
    // rail, F6 goes to the module, the top band (#343), the pane, then back to
    // the rail.
    await attachmentsButton.focus()
    expect(await regionWalk(page, 'F6', 4)).toEqual(['content', 'search', 'folders', 'modules'])
    await audit('attachments', catalog['attachmentsView.title'])

    expect(found).toEqual([])
    expect(errors).toEqual([])
  })
}

// #343: the top band and the app menu (ADR-0068 §1 and §2, piece 13a). The
// band is the first row of the <header> «Oreneta» (banner), between the title
// bar and the notices, 2.25 rem tall in the frame's tone, and the first region
// F6 reaches. Its «App menu» button opens a menu with every palette command,
// grouped by area, and what the rail's More menu offers; the rail keeps its own
// until piece 14.
const APP_MENU_GROUPS = ['Modules', 'Mail', 'Accounts', 'Folders', 'Boards', 'Theme', 'Notifications', 'Settings', 'Application']
// The rail's More menu, reachable from the app menu too (once each).
const MORE_MENU_ITEMS = [
  'Go to: Mail',
  'Go to: Calendar',
  'Go to: People',
  'Go to: Tasks',
  'Go to: Notes',
  'Go to: Chat',
  'Go to: Attachments',
  'Command palette',
  'Add account',
  'Create kanban board',
  'Sync mailbox',
  'Do not disturb for 1 hour',
  'Do not disturb until tomorrow',
  'Do not disturb until turned off',
  'Open settings',
  'About Oreneta',
]

async function appMenuParts(page: Page, catalog: Record<string, string> = enCatalog) {
  const banner = page.getByRole('banner', { name: catalog['shell.region.banner'], exact: true })
  const band = banner.locator('[data-top-band]')
  const button = banner.getByRole('button', { name: catalog['appMenu.label'], exact: true })
  const menu = page.getByRole('menu', { name: catalog['appMenu.label'], exact: true })
  return { banner, band, button, menu }
}

for (const width of [1440, 1025, 1024, 768]) {
  test(`the top band holds the app menu, above the notices and the module, at ${width}px (#343)`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors = await prepareStartup(page, true, { navigation: true })
    await page.goto('/')
    await expect(page.locator('[data-thread-list]')).toBeVisible()
    const { banner, band, button, menu } = await appMenuParts(page)

    // One banner, named after the app, whose first row is the band: the
    // region F6 calls `search`, 2.25 rem (36 px) tall, across the window.
    await expect(page.getByRole('banner')).toHaveCount(1)
    await expect(banner).toBeVisible()
    await expect(band).toHaveAttribute('data-region', 'search')
    const bandBox = await boxOf(band)
    expect(Math.round(bandBox.height)).toBe(36)
    expect(Math.round(bandBox.x)).toBe(0)
    expect(Math.round(bandBox.width)).toBe(width)
    // Title bar, header, notices, then the module (ADR-0068 §1): the band is
    // outside <main>. With nothing prominent, the account sync status is the
    // band's (#345): no bar under it, and the module starts under the band.
    await expect(page.locator('main [data-top-band]')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Account sync', exact: true })).toHaveCount(0)
    await expect(band.locator('[data-band-end] [data-sync-status-button]')).toBeVisible()
    expect((await boxOf(page.getByRole('main'))).y).toBeGreaterThanOrEqual(bandBox.y + bandBox.height - 1)
    // The menu button at its start, on every width; the centre holds the
    // search (13b) and the end the sync status (13c).
    await expect(button).toBeVisible()
    await expect(button).toHaveAttribute('aria-haspopup', 'menu')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    expect((await boxOf(button)).x).toBeLessThan(16)
    await expect(band.locator('[data-band-centre]')).toHaveCount(1)
    await expect(band.locator('[data-band-end]')).toHaveCount(1)
    // The rail keeps its own More menu, and the two buttons are told apart.
    await expect(page.getByRole('button', { name: 'More', exact: true }).first()).toBeAttached()

    // The pointer opens it under the button, from its start edge, inside the window.
    await button.click()
    await expect(menu).toBeVisible()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    const items = menu.locator('[role^="menuitem"]')
    await expect(items.first()).toBeFocused()
    expect(Math.round((await items.first().boundingBox())!.height)).toBe(28)
    const menuBox = await boxOf(menu)
    const buttonBox = await boxOf(button)
    expect(menuBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height - 1)
    expect(menuBox.x).toBeGreaterThanOrEqual(0)
    expect(menuBox.x).toBeLessThanOrEqual(buttonBox.x + 8)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width)
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(1000)
    // Grouped by area, each group with its title.
    const groups = await menu.getByRole('group').evaluateAll((elements) =>
      elements.map((element) => document.getElementById(element.getAttribute('aria-labelledby')!)?.textContent),
    )
    expect(groups).toEqual(APP_MENU_GROUPS)
    // What the rail's More menu offers is there, once.
    for (const name of MORE_MENU_ITEMS)
      await expect(menu.getByRole(name.startsWith('Go to:') ? 'menuitemradio' : 'menuitem', { name, exact: true })).toHaveCount(1)
    await expect(menu.getByRole('menuitemradio', { name: 'Go to: Mail', exact: true })).toHaveAttribute('aria-checked', 'true')
    // Long as it is, its last item scrolls into view inside the window.
    await page.keyboard.press('End')
    const last = menu.getByRole('menuitem', { name: 'About Oreneta', exact: true })
    await expect(last).toBeFocused()
    await expect(last).toBeInViewport({ ratio: 1 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await info.attach(`app-menu-${width}`, {
      body: await page.screenshot({ path: info.outputPath(`app-menu-${width}.png`), animations: 'disabled' }),
      contentType: 'image/png',
    })
    // Escape closes it and gives the focus back to the button.
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(button).toBeFocused()
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    // A second click on the button closes it too.
    await button.click()
    await expect(menu).toBeVisible()
    await button.click()
    await expect(menu).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test('the app menu opens from the keyboard, moves, finds by typing and runs a command (#343)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { button, menu } = await appMenuParts(page)
  const items = menu.locator('[role^="menuitem"]')
  // A conversation open: the arrows that open and move the menu must not also
  // step the list behind it, which the app's arrows do elsewhere.
  const row = page.getByRole('table').getByRole('button', { name: /Pilot checklist/ })
  const reply = page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })
  await row.click()
  await expect(reply).toBeVisible()
  await expect(row).toHaveAttribute('aria-current', 'true')
  const selectionKept = async (key: string) => {
    await expect(row, key).toHaveAttribute('aria-current', 'true')
    await expect(reply, key).toBeVisible()
  }

  // From outside every region, F6 goes to the first one: the band, on its button.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('F6')
  await expect(button).toBeFocused()
  expect(await regionAtFocus(page)).toBe('search')

  // Enter opens it on its first item; the arrows wrap; Home and End.
  await page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(items.last()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toBeFocused()
  await page.keyboard.press('End')
  await expect(items.last()).toBeFocused()
  await page.keyboard.press('Home')
  await expect(items.first()).toBeFocused()
  // Typing a name goes to it; keys typed in the menu do not reach the app.
  await page.keyboard.type('open s')
  await expect(menu.getByRole('menuitem', { name: 'Open settings', exact: true })).toBeFocused()
  // Enter runs it, as the palette would: Settings opens, the menu is gone.
  await page.keyboard.press('Enter')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  await expect(menu).toHaveCount(0)
  // Closing Settings gives the focus back to the app menu button.
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(button).toBeFocused()

  // Space and Down open it too, and Up on its last item; Escape gives the
  // focus back each time. None of them, nor the arrows in the menu, moves the
  // conversation list.
  for (const [key, edge] of [
    ['Space', 'first'],
    ['ArrowDown', 'first'],
    ['ArrowUp', 'last'],
  ] as const) {
    await page.keyboard.press(key)
    await expect(menu, key).toBeVisible()
    await expect(edge === 'first' ? items.first() : items.last(), key).toBeFocused()
    await selectionKept(key)
    for (const inside of ['ArrowDown', 'ArrowDown', 'ArrowUp']) await page.keyboard.press(inside)
    await expect(menu, key).toBeVisible()
    await selectionKept(`${key}, then the arrows in the menu`)
    await page.keyboard.press('Escape')
    await expect(menu, key).toHaveCount(0)
    await expect(button, key).toBeFocused()
  }
  // Ctrl/⌘+K from inside the menu: the menu closes first, so the palette gives
  // the focus back to the button, not to an item that is gone.
  await page.keyboard.press('Enter')
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toBeFocused()
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true })
  await expect(palette).toBeVisible()
  await expect(menu).toHaveCount(0)
  await expect(palette.getByRole('combobox')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await expect(button).toBeFocused()
  await selectionKept('Ctrl/⌘+K')
  // Tab closes it and moves on from the button, not from the removed menu.
  await page.keyboard.press('Enter')
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(menu).toHaveCount(0)
  await expect(button).not.toBeFocused()
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true)
  // F6 from inside the menu moves to the next region and closes it.
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('F6')
  await expect(menu).toHaveCount(0)
  expect(await regionAtFocus(page)).toBe('folders')
  expect(errors).toEqual([])
})

test('Delete and Backspace in an open menu leave the selected conversation alone, in the Outlook scheme (#348)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, {
    navigation: true,
    preferences: { shortcut_overrides: SHORTCUT_SCHEMES.outlook },
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { button, menu } = await appMenuParts(page)
  const row = page.getByRole('table').getByRole('button', { name: /Pilot checklist/ })
  const reply = page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })
  await row.click()
  await expect(reply).toBeVisible()
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[role^="menuitem"]').first()).toBeFocused()
  for (const key of ['Delete', 'Backspace', 'e']) await page.keyboard.press(key)
  // The menu is still open and nothing was deleted or archived.
  await expect(menu).toBeVisible()
  await expect(row).toHaveAttribute('aria-current', 'true')
  await expect(reply).toBeVisible()
  const sent = await page.evaluate(() =>
    (window as any).startupProbe.requests
      .map((request: { command: string }) => request.command)
      .filter((command: string) => command === 'mail.delete' || command === 'mail.archive'),
  )
  expect(sent).toEqual([])
  expect(errors).toEqual([])
})

test('the app menu runs what the palette and the rail\'s More menu run (#343)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  await page.evaluate(() => {
    const replies = (window as any).startupProbe.replies
    replies['calendar.list'] = {
      calendars: [{ id: 'local-team', name: 'Team', is_default: true, enabled: true, kind: 'local', read_only: false, synced_at: 0 }],
    }
    replies['calendar.events'] = { events: [] }
  })
  const { button, menu } = await appMenuParts(page)
  const choose = async (role: 'menuitem' | 'menuitemradio', name: string) => {
    await button.click()
    await menu.getByRole(role, { name, exact: true }).click()
    await expect(menu).toHaveCount(0)
  }

  // A module, then mail again.
  await choose('menuitemradio', 'Go to: Calendar')
  await expect(page.getByRole('main', { name: 'Calendar', exact: true })).toBeVisible()
  await button.click()
  await expect(menu.getByRole('menuitemradio', { name: 'Go to: Calendar', exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  // An account from another module goes back to mail, as the rail does.
  await choose('menuitemradio', 'Go to: Second account')
  await expect(page.getByRole('main', { name: 'Mail', exact: true })).toBeVisible()
  await choose('menuitemradio', 'Go to: Calendar')
  await choose('menuitemradio', 'Go to: Mail')
  await expect(page.getByRole('main', { name: 'Mail', exact: true })).toBeVisible()

  // Do not disturb: the rail's indicator says so, and the menu now offers to resume.
  await choose('menuitem', 'Do not disturb until turned off')
  const resume = page.locator('aside').getByRole('button', { name: 'Resume notifications', exact: true })
  await expect(resume).toBeVisible()
  await choose('menuitem', 'Resume notifications')
  await expect(resume).toHaveCount(0)

  // About, and the palette, each from the menu.
  await choose('menuitem', 'About Oreneta')
  await expect(page.getByRole('dialog', { name: 'About Oreneta' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(button).toBeFocused()
  await choose('menuitem', 'Command palette')
  await expect(page.getByRole('dialog', { name: 'Command palette', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(button).toBeFocused()

  // The rail's own More menu is unchanged (owner decision 1 on #342).
  await page.locator('aside').getByTitle('More', { exact: true }).first().click()
  await expect(page.getByRole('menu', { name: 'More', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

// In Arabic the menu opens from the button's right edge, leftwards, stays in
// the window and passes axe, menu open, at a wide and a narrow width.
for (const width of [1440, 768]) {
  test(`in Arabic the app menu opens towards the reading direction and passes axe: ${width}px (#343)`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors = await prepareStartup(page, true, { navigation: true, language: 'ar' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(page.locator('[data-thread-list]')).toBeVisible()
    const { banner, button, menu } = await appMenuParts(page, arCatalog)
    await expect(banner).toBeVisible()
    // The button at the start of the band: its right in Arabic.
    const buttonBox = await boxOf(button)
    expect(buttonBox.x + buttonBox.width).toBeGreaterThan(width - 16)
    await button.focus()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    const menuBox = await boxOf(menu)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width)
    expect(menuBox.x + menuBox.width).toBeGreaterThanOrEqual(buttonBox.x - 8)
    expect(menuBox.x).toBeGreaterThanOrEqual(0)
    await rtlInView(page, 'app menu')
    await settled(page)
    const inMenu = await new AxeBuilder({ page }).include('[role="menu"]').withTags(AXE_TAGS).analyze()
    expect(inMenu.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([])
    const whole = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
    const regions = await new AxeBuilder({ page }).withRules(REGION_RULES).analyze()
    await info.attach(`axe-app-menu-ar-${width}`, {
      body: JSON.stringify({ menu: inMenu.violations, page: whole.violations, regions: regions.violations }, null, 2),
      contentType: 'application/json',
    })
    expect(
      whole.violations
        .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
        .map((violation) => `${violation.id} on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`),
    ).toEqual([])
    expect(regions.violations.map((violation) => violation.id)).toEqual([])
    await info.attach(`app-menu-ar-${width}`, {
      body: await page.screenshot({ path: info.outputPath(`app-menu-ar-${width}.png`), animations: 'disabled' }),
      contentType: 'image/png',
    })
    await page.keyboard.press('Escape')
    await expect(button).toBeFocused()
    expect(errors).toEqual([])
  })
}

// At the app's 200 %, the band is 4.5 rem (72 px). Its height comes out of the
// panes under it: the page does not scroll, and mail's boundary controls stay
// inside the window's height at 1025 px, the narrowest window with folders.
// (At this size the conversation header already ran past the window's end
// before the band, which moves nothing sideways; ADR-0068 §3's toolbar is what
// changes that header.)
test("at the app's 200 percent the band's height leaves mail's boundary controls on screen at 1025px (#343)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1025, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px')
  const { band, button } = await appMenuParts(page)
  expect(Math.round((await boxOf(band)).height)).toBe(72)
  await expect(button).toBeInViewport({ ratio: 1 })
  const pageFits = () =>
    page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth,
    )
  const withinHeight = async (locator: ReturnType<Page['locator']>, name: string) => {
    const box = await boxOf(locator)
    expect(box.y, name).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height, name).toBeLessThanOrEqual(1000)
  }
  expect(await pageFits()).toBe(true)
  const list = page.locator('[data-thread-list]')
  await expect(list).toBeInViewport({ ratio: 0.95 })
  const sent = page.getByRole('navigation', { name: 'Accounts and folders' }).getByRole('button', { name: 'Sent', exact: true })
  await expect(sent).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'New message', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByTitle('Switch folder', { exact: true })).toBeInViewport({ ratio: 1 })

  await page.getByRole('table').getByRole('button', { name: /Pilot checklist/ }).click()
  const reply = page.getByPlaceholder('Write a message...')
  await expect(reply).toBeInViewport({ ratio: 1 })
  await withinHeight(page.getByRole('button', { name: 'More actions', exact: true }), 'More actions')
  expect(await pageFits()).toBe(true)
  await sent.click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).startupProbe.requests.filter((r: any) => r.command === 'mail.threadList').at(-1)?.payload,
      ),
    )
    .toMatchObject({ account_id: 'synthetic-account', folder_id: 'Sent' })
  expect(await pageFits()).toBe(true)
  await page.keyboard.press(`${mod}+Digit0`)
  expect(errors).toEqual([])
})

// A command that cannot run says why: in the tooltip, and as the item's
// accessible description, which reaches the keyboard and a screen reader (#343).
test('the app menu says why a command cannot run, as the description of its item (#343)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, graphAccount: true })
  await page.goto('/')
  const { button, menu } = await appMenuParts(page)
  await button.click()
  const compose = menu.getByRole('menuitem', { name: 'Compose new message', exact: true })
  await expect(compose).toHaveAttribute('aria-disabled', 'true')
  await expect(compose).toHaveAttribute('title', 'No account available for sending')
  // Its own element says it, not only the tooltip (which Chromium also reads
  // as a description, but not every screen reader does); it is not drawn and
  // not part of the name.
  await expect(compose).toHaveAttribute('aria-describedby', /.+/)
  const reason = page.locator(`[id="${await compose.getAttribute('aria-describedby')}"]`)
  await expect(reason).toHaveText('No account available for sending')
  await expect(reason).toHaveClass('sr-only')
  expect(await reason.evaluate((element) => element.getBoundingClientRect().width <= 1)).toBe(true)
  await expect(compose).toHaveAccessibleDescription('No account available for sending')
  await expect(menu.getByRole('menuitem', { name: 'Open settings', exact: true })).toHaveAccessibleDescription('')
  // Clicked anyway, it does nothing and the menu stays.
  await compose.click({ force: true })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  expect(
    await page.evaluate(() =>
      (window as any).startupProbe.calls.filter((command: string) => ['mail.send', 'mail.saveDraft'].includes(command)),
    ),
  ).toEqual([])
  expect(errors).toEqual([])
})

// The first-account setup screen shows the band too, with the same app menu
// (owner decision 2 on #343): the header «Oreneta», then the setup in <main>,
// the `content` region. The menu holds what needs no account; F6 goes from the
// band to the setup and back.
const SETUP_MENU_GROUPS = ['appMenu.area.theme', 'appMenu.area.settings', 'appMenu.area.app']

async function setupBandParts(page: Page, catalog: Record<string, string>) {
  const parts = await appMenuParts(page, catalog)
  const main = page.getByRole('main')
  const email = main.getByRole('textbox', { name: catalog['accounts.fields.emailAddress'], exact: true })
  return { ...parts, main, email }
}

test('the first-account setup screen has the top band, its app menu and F6 between the two (#343)', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Connect a Mail Account' })).toBeVisible()
  const { banner, band, button, menu, main, email } = await setupBandParts(page, enCatalog)
  // The focus still starts on the address.
  await expect(email).toBeFocused()
  // One banner and one <main>: the band on top, outside it, 2.25 rem tall.
  await expect(page.getByRole('banner')).toHaveCount(1)
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(banner).toBeVisible()
  await expect(band).toHaveAttribute('data-region', 'search')
  await expect(main).toHaveAttribute('data-region', 'content')
  await expect(page.locator('main [data-top-band]')).toHaveCount(0)
  const bandBox = await boxOf(band)
  expect(Math.round(bandBox.height)).toBe(36)
  expect(Math.round(bandBox.width)).toBe(1440)
  expect((await boxOf(main)).y).toBeGreaterThanOrEqual(bandBox.y + bandBox.height - 1)
  expect((await boxOf(button)).x).toBeLessThan(16)

  // F6 and Shift+F6: the band, then the setup, where the focus was.
  await page.keyboard.press('F6')
  await expect(button).toBeFocused()
  expect(await regionAtFocus(page)).toBe('search')
  await page.keyboard.press('F6')
  await expect(email).toBeFocused()
  expect(await regionAtFocus(page)).toBe('content')
  await page.keyboard.press('Shift+F6')
  await expect(button).toBeFocused()
  await page.keyboard.press('Shift+F6')
  await expect(email).toBeFocused()

  // The app's zoom works there too.
  const rootSize = () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)
  expect(await rootSize()).toBe('16px')
  await page.keyboard.press('Control+Equal')
  await expect.poll(rootSize).not.toBe('16px')
  await page.keyboard.press('Control+Digit0')
  await expect.poll(rootSize).toBe('16px')

  // The menu: what needs no account, grouped as in the window.
  await button.click()
  await expect(menu).toBeVisible()
  const groups = await menu
    .getByRole('group')
    .evaluateAll((elements) =>
      elements.map((element) => document.getElementById(element.getAttribute('aria-labelledby')!)?.textContent),
    )
  expect(groups).toEqual(SETUP_MENU_GROUPS.map((key) => enCatalog[key]))
  for (const name of ['Open settings', 'Command palette', 'Keyboard shortcuts', 'About Oreneta'])
    await expect(menu.getByRole('menuitem', { name, exact: true }), name).toHaveCount(1)
  for (const name of [
    'Add account',
    'Go to: Mail',
    'Go to: Calendar',
    'Sync mailbox',
    'Create kanban board',
    'Do not disturb for 1 hour',
  ])
    await expect(
      menu.getByRole('menuitem', { name, exact: true }).or(menu.getByRole('menuitemradio', { name, exact: true })),
      name,
    ).toHaveCount(0)
  await expect(menu.locator('[aria-disabled="true"]')).toHaveCount(0)
  await info.attach('setup-band-menu', {
    body: await page.screenshot({ path: info.outputPath('setup-band-menu.png'), animations: 'disabled' }),
    contentType: 'image/png',
  })
  // A theme, Settings and the palette work from it, and give the focus back.
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await menu.getByRole('menuitemradio', { name: 'Theme: Oreneta Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await button.click()
  await menu.getByRole('menuitem', { name: 'Open settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(button).toBeFocused()
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true })
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('option', { name: /^Add account/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(button).toBeFocused()
  expect(await page.evaluate(() => (window as any).startupProbe.unexpected)).toEqual([])
  expect(errors).toEqual([])
})

// In Arabic: the button at the start of the band (its right), the menu opening
// towards the reading direction, nothing outside the window, and axe clean with
// the menu closed and open, with the region rules too.
for (const width of [1440, 390]) {
  test(`the setup screen's band in Arabic stays in the window and passes axe: ${width}px (#343)`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 })
    const errors = await prepareStartup(page, false, { language: 'ar' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    const { banner, button, menu, email } = await setupBandParts(page, arCatalog)
    await expect(email).toBeFocused()
    await expect(banner).toBeVisible()
    const buttonBox = await boxOf(button)
    expect(buttonBox.x + buttonBox.width).toBeGreaterThan(width - 16)
    await rtlInView(page, 'setup screen')
    await settled(page)
    const audit = async (name: string) => {
      const whole = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
      const regions = await new AxeBuilder({ page }).withRules(REGION_RULES).analyze()
      await info.attach(`axe-setup-band-ar-${width}-${name}`, {
        body: JSON.stringify({ page: whole.violations, regions: regions.violations }, null, 2),
        contentType: 'application/json',
      })
      expect(
        whole.violations
          .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
          .map((violation) => `${violation.id} on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`),
        name,
      ).toEqual([])
      expect(
        regions.violations.map((violation) => violation.id),
        name,
      ).toEqual([])
    }
    await audit('closed')
    // F6 to the band, Enter on the button: the menu opens leftwards, inside.
    await page.keyboard.press('F6')
    await expect(button).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(menu.locator('[role^="menuitem"]').first()).toBeFocused()
    const menuBox = await boxOf(menu)
    expect(menuBox.x).toBeGreaterThanOrEqual(0)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width)
    expect(menuBox.x + menuBox.width).toBeGreaterThanOrEqual(buttonBox.x - 8)
    const groups = await menu
      .getByRole('group')
      .evaluateAll((elements) =>
        elements.map((element) => document.getElementById(element.getAttribute('aria-labelledby')!)?.textContent),
      )
    expect(groups).toEqual(SETUP_MENU_GROUPS.map((key) => arCatalog[key]))
    await rtlInView(page, 'setup screen, menu open')
    await settled(page)
    const inMenu = await new AxeBuilder({ page }).include('[role="menu"]').withTags(AXE_TAGS).analyze()
    expect(inMenu.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([])
    await audit('menu open')
    await info.attach(`setup-band-ar-${width}`, {
      body: await page.screenshot({ path: info.outputPath(`setup-band-ar-${width}.png`), animations: 'disabled' }),
      contentType: 'image/png',
    })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(button).toBeFocused()
    expect(errors).toEqual([])
  })
}

// On the setup screen, Settings' «Add account» goes back to the setup, which
// is that flow already, instead of opening a second one over it that would
// change its provider (#343).
test("Settings' «Add account» on the setup screen goes back to the setup as it was (#343)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page)
  await page.goto('/')
  const { button, menu, email } = await setupBandParts(page, enCatalog)
  await email.fill('person@gmail.com')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  // The «+» of the mail accounts, then the one of the feeds.
  for (const index of [0, 1]) {
    await button.click()
    await menu.getByRole('menuitem', { name: 'Open settings', exact: true }).click()
    await expect(settings).toBeVisible()
    await settings.getByTitle('Add account', { exact: true }).nth(index).click()
    await expect(settings).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(email).toBeFocused()
    await expect(email).toHaveValue('person@gmail.com')
  }
  // The setup carries on from what was typed.
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible()
  expect(errors).toEqual([])
})

// A backup restored from Settings on the setup screen brings the first
// account: the window replaces the setup behind Settings, which stays the same
// dialog, still open, and gives the focus back to the app menu button when it
// closes (#343).
test('a backup restored from Settings on the setup screen keeps Settings, then gives the focus to the band (#343)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  // No account at first: the restore brings the synthetic one back.
  await page.addInitScript(() => {
    const replies = (window as any).startupProbe.replies
    ;(window as any).restoredAccounts = replies['account.list']
    replies['account.list'] = { accounts: [] }
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Connect a Mail Account' })).toBeVisible()
  const { button, menu } = await appMenuParts(page)
  await button.click()
  await menu.getByRole('menuitem', { name: 'Backup', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  await settings.evaluate((dialog) => dialog.setAttribute('data-test-kept', ''))
  await page.evaluate(() => {
    const replies = (window as any).startupProbe.replies
    replies['backup.import'] = {
      accounts: 1,
      skipped: 0,
      feeds: 0,
      settings: 0,
      secrets: 0,
      pgp_keys: 0,
      smime_identities: 0,
    }
    replies['account.list'] = (window as any).restoredAccounts
  })
  await settings.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByText('Restored 1 account', { exact: true })).toBeVisible()
  await expect(page.locator('[data-thread-list]')).toBeAttached()
  await expect(page.getByRole('heading', { name: 'Connect a Mail Account' })).toHaveCount(0)
  await expect(page.locator('[role="dialog"][data-test-kept]')).toHaveCount(1)
  // (The focus is not kept in Settings: «Restore» disables itself while it
  // works, and the browser drops the focus to the body, as in the window.)
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(button).toBeFocused()
  expect(errors).toEqual([])
})

// #317: the common folder pane (ADR-0068 §4), mail first. One width for every
// module, 260 px by default and 200 to 400, in px so the app's zoom grows the
// text in it and not the pane, and kept across restarts.
test('the folder pane resizes from the keyboard and the pointer, is kept across restarts and does not grow with the zoom (#317)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  const pane = page.getByRole('navigation', { name: 'Accounts and folders' })
  const handle = pane.getByRole('separator', { name: 'Resize folder pane' })
  const list = page.locator('[data-thread-list]')
  const reader = page.locator('[data-message-pane]')
  const drawn = async (locator: ReturnType<Page['locator']>) => Math.round((await locator.boundingBox())!.width)
  const stored = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}'))
  await expect(pane).toHaveAttribute('data-region', 'folders')
  await expect(handle).toHaveAttribute('aria-valuenow', '260')
  await expect(handle).toHaveAttribute('aria-valuemin', '200')
  await expect(handle).toHaveAttribute('aria-valuemax', '400')
  expect(await drawn(pane)).toBe(260)
  // Its 40 px title row names it.
  const title = pane.getByRole('heading', { level: 2, name: 'Accounts and folders' })
  expect(Math.round((await title.locator('..').boundingBox())!.height)).toBe(40)

  // The keyboard: the widest it goes, while the list and the reader keep theirs.
  await handle.focus()
  await page.keyboard.press('End')
  await expect(handle).toHaveAttribute('aria-valuenow', '400')
  expect(await drawn(pane)).toBe(400)
  expect(await drawn(list)).toBe(360)
  expect(await drawn(reader)).toBeGreaterThanOrEqual(360)
  await expect.poll(async () => (await stored()).folder_pane_width).toBe(400)
  await page.reload()
  await expect(handle).toHaveAttribute('aria-valuenow', '400')
  expect(await drawn(pane)).toBe(400)

  // The pointer: 80 px towards the start of the line.
  const grip = (await handle.boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 300)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 - 80, grip.y + 300, { steps: 4 })
  await page.mouse.up()
  const dragged = Number(await handle.getAttribute('aria-valuenow'))
  expect(Math.abs(dragged - 320)).toBeLessThanOrEqual(2)
  expect(Math.abs((await pane.boundingBox())!.width - dragged)).toBeLessThanOrEqual(1)
  await expect.poll(async () => (await stored()).folder_pane_width).toBe(dragged)

  // The narrowest and one step more; then the app's 200 %, which grows the
  // text and leaves the pane as wide as it was.
  await handle.focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '216')
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px')
  expect(await drawn(pane)).toBe(216)
  // A name that does not fit ends in "…", and the tooltip has it whole.
  expect(await title.evaluate((element) => getComputedStyle(element).textOverflow)).toBe('ellipsis')
  expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  await expect(title).toHaveAttribute('title', 'Accounts and folders')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.keyboard.press(`${mod}+Digit0`)
  await page.reload()
  await expect(handle).toHaveAttribute('aria-valuenow', '216')
  expect(errors).toEqual([])
})

// When the row runs short the folders give way first, down to 200 px, then
// the list, and the reader keeps its 360 px (ADR-0068 §7). With a remembered
// 560 px list beside the 60 px rail: at 1200 px the folders are 220 px and the
// list is whole; at 1100 and 1025 px the folders are at their minimum and the
// list gives way.
for (const [width, folders, listWidth] of [
  [1025, 200, 405],
  [1100, 200, 480],
  [1200, 220, 560],
  [1440, 260, 560],
] as const) {
  test(`the folders give way before the list, and the list before the reader, at ${width}px (#317)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors = await prepareStartup(page, true, { navigation: true, preferences: { thread_list_width: 560 } })
    await page.goto('/')
    const pane = page.getByRole('navigation', { name: 'Accounts and folders' })
    const reader = page.locator('[data-message-pane]')
    await expect(pane).toBeVisible()
    await expect(reader).toBeVisible()
    const paneBox = (await pane.boundingBox())!
    const listBox = (await page.locator('[data-thread-list]').boundingBox())!
    const readerBox = (await reader.boundingBox())!
    expect(Math.abs(paneBox.width - folders)).toBeLessThanOrEqual(1)
    expect(Math.abs(listBox.width - listWidth)).toBeLessThanOrEqual(1)
    expect(readerBox.width).toBeGreaterThanOrEqual(360 - 1)
    expect(readerBox.x + readerBox.width).toBeLessThanOrEqual(width + 1)
    // The separator states the width on screen, and that it goes no wider there.
    const handle = pane.getByRole('separator', { name: 'Resize folder pane' })
    await expect(handle).toHaveAttribute('aria-valuenow', String(folders))
    await expect(handle).toHaveAttribute('aria-valuemax', String(folders < 260 ? folders : 400))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  })
}

test('in Arabic the folder pane sits between the rail and the list, and its separator follows the reading (#317)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, language: 'ar' })
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  const pane = page.getByRole('navigation', { name: arCatalog['mailNavigation.title'], exact: true })
  await expect(pane).toBeVisible()
  const railBox = (await page.locator('main > aside').first().boundingBox())!
  const paneBox = (await pane.boundingBox())!
  const listBox = (await page.locator('[data-thread-list]').boundingBox())!
  expect(paneBox.x + paneBox.width).toBeLessThanOrEqual(railBox.x + 1)
  expect(listBox.x + listBox.width).toBeLessThanOrEqual(paneBox.x + 1)
  // The separator is on the pane's end edge, on the left: ArrowLeft widens it,
  // and the pane grows to the left with its start edge against the rail.
  const handle = pane.getByRole('separator', { name: arCatalog['layout.resizeFolderPane'], exact: true })
  const handleBox = (await handle.boundingBox())!
  expect(Math.abs(handleBox.x + handleBox.width / 2 - paneBox.x)).toBeLessThanOrEqual(1)
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', '276')
  const grown = (await pane.boundingBox())!
  expect(Math.round(grown.width)).toBe(276)
  expect(Math.round(grown.x + grown.width)).toBe(Math.round(paneBox.x + paneBox.width))
  await page.keyboard.press('Shift+ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '212')
  expect(errors).toEqual([])
})

// #323: Calendar's calendars in the common folder pane (ADR-0068 §4): the
// list is its body and the month at a glance its footer, at the one width
// every module shares. At 1024 px and below the pane is not drawn, and they
// keep their column beside the views.
async function openCalendarPane(page: Page, options: SetupOptions = {}, catalog = enCatalog) {
  const errors = await prepareStartup(page, true, { navigation: true, ...options })
  await page.addInitScript(() => {
    const replies = (window as any).startupProbe.replies
    replies['calendar.list'] = {
      calendars: [
        { id: 'local-team', name: 'Team', is_default: true, enabled: true, kind: 'local', read_only: false, synced_at: 0 },
        { id: 'holidays', name: 'Holidays', is_default: false, enabled: true, kind: 'subscribed', read_only: true, synced_at: 0 },
      ],
    }
    replies['calendar.events'] = { events: [] }
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  await page.getByTitle(catalog['calendar.title'], { exact: true }).click()
  await expect(page.getByRole('main', { name: catalog['calendar.title'], exact: true })).toBeVisible()
  return errors
}

const boxOf = async (locator: ReturnType<Page['locator']>) => (await locator.boundingBox())!

// Every day of the month at a glance, and every calendar row, inside the pane.
async function insidePane(page: Page, pane: ReturnType<Page['locator']>) {
  const box = await boxOf(pane)
  const outside = await page.evaluate(
    ({ left, right }) =>
      [...document.querySelectorAll<HTMLElement>('[data-folder-pane] button')]
        .map((element) => ({ label: element.getAttribute('aria-label') ?? element.textContent, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && (box.left < left - 1 || box.right > right + 1))
        .map(({ label }) => label),
    { left: box.x, right: box.x + box.width },
  )
  expect(outside).toEqual([])
}

for (const [width, paneWidth] of [
  [1025, 200],
  [1025, 260],
  [1025, 400],
  [1100, 200],
  [1100, 260],
  [1440, 200],
  [1440, 260],
] as const) {
  test(`Calendar's folder pane leaves the agenda, day, week and month whole at ${width}px, ${paneWidth}px wide (#323)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors = await openCalendarPane(page, { preferences: { folder_pane_width: paneWidth } })
    const pane = page.getByRole('navigation', { name: 'Calendars', exact: true })
    const content = page.locator('main > [data-region="content"]')
    await expect(pane).toHaveAttribute('data-region', 'folders')
    await expect(pane.getByRole('heading', { level: 2, name: 'Calendars' })).toBeVisible()
    // The list is its body and the month at a glance its footer.
    await expect(pane.getByRole('button', { name: 'Team', exact: true }).first()).toBeVisible()
    const month = pane.getByRole('navigation', { name: 'Month at a glance' })
    await expect(month).toBeVisible()
    expect((await boxOf(month)).y).toBeGreaterThan((await boxOf(pane.getByRole('button', { name: 'Holidays', exact: true }).first())).y)
    // Right after the rail, at the shared width, and the module right after it.
    const rail = await boxOf(page.locator('main > aside').first())
    const paneBox = await boxOf(pane)
    expect(Math.abs(paneBox.x - (rail.x + rail.width))).toBeLessThanOrEqual(1)
    expect(Math.abs(paneBox.width - paneWidth)).toBeLessThanOrEqual(1)
    await expect(pane.getByRole('separator', { name: 'Resize folder pane' })).toHaveAttribute('aria-valuenow', String(paneWidth))
    const contentBox = await boxOf(content)
    expect(Math.abs(contentBox.x - (paneBox.x + paneBox.width))).toBeLessThanOrEqual(1)
    expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(width + 1)
    // Today's column is gone from beside the views.
    await expect(content.locator('[data-region="folders"]')).toHaveCount(0)

    for (const view of ['Agenda', 'Day', 'Week', 'Month']) {
      await page.getByRole('button', { name: view, exact: true }).click()
      await expect(page.getByRole('button', { name: view, exact: true })).toHaveAttribute('aria-pressed', 'true')
      await settled(page)
      await ltrInView(page, `${view.toLowerCase()} at ${width}px, folders ${paneWidth}px`)
      // Every control and day of the view inside the module, none under the pane.
      const outside = await content.evaluate((region) => {
        const { left, right } = region.getBoundingClientRect()
        return [...region.querySelectorAll<HTMLElement>('button, [data-day-column]')]
          .map((element) => ({ element, box: element.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 0 && (box.left < left - 1 || box.right > right + 1))
          .map(({ element }) => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40))
      })
      expect(outside, view).toEqual([])
      const columns = ({ Agenda: 0, Day: 1, Week: 7 } as Record<string, number>)[view]
      if (columns !== undefined) await expect(page.locator('[data-day-column]')).toHaveCount(columns)
      await insidePane(page, pane)
    }
    expect(errors).toEqual([])
  })
}

test('at 1024px Calendar keeps its column beside the views, and draws no folder pane (#323)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  const errors = await openCalendarPane(page)
  await expect(page.locator('[data-folder-pane]')).toHaveCount(0)
  await expect(page.getByRole('separator', { name: 'Resize folder pane' })).toHaveCount(0)
  const column = page.getByRole('navigation', { name: 'Calendars', exact: true })
  await expect(column).toHaveAttribute('data-region', 'folders')
  // Inside the module, under its header, and 12 rem wide as before.
  await expect(page.locator('main > [data-region="content"] [data-region="folders"]')).toHaveCount(1)
  expect(Math.round((await boxOf(column)).width)).toBe(192)
  const month = column.getByRole('navigation', { name: 'Month at a glance' })
  await expect(month).toBeVisible()
  expect((await boxOf(month)).y).toBeLessThan((await boxOf(column.getByRole('button', { name: 'Team', exact: true }).first())).y)
  await ltrInView(page, 'calendar at 1024px')
  expect(errors).toEqual([])
})

test('the folder pane resized in Calendar is the width mail draws, and the reverse (#323)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await openCalendarPane(page)
  const calendars = page.getByRole('navigation', { name: 'Calendars', exact: true })
  const mail = page.getByRole('navigation', { name: 'Accounts and folders', exact: true })
  const handleIn = (pane: ReturnType<Page['locator']>) => pane.getByRole('separator', { name: 'Resize folder pane' })
  const drawn = async (pane: ReturnType<Page['locator']>) => Math.round((await boxOf(pane)).width)
  const stored = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}').folder_pane_width)
  const calendarButton = page.getByTitle('Calendar', { exact: true })
  await expect(handleIn(calendars)).toHaveAttribute('aria-valuenow', '260')

  // The keyboard in Calendar: the widest it goes, kept for mail.
  await handleIn(calendars).focus()
  await page.keyboard.press('End')
  await expect(handleIn(calendars)).toHaveAttribute('aria-valuenow', '400')
  expect(await drawn(calendars)).toBe(400)
  await expect.poll(stored).toBe(400)
  await calendarButton.click()
  await expect(mail).toBeVisible()
  await expect(handleIn(mail)).toHaveAttribute('aria-valuenow', '400')
  expect(await drawn(mail)).toBe(400)

  // Narrowed in mail, Calendar's is as narrow.
  await handleIn(mail).focus()
  await page.keyboard.press('Home')
  await expect.poll(stored).toBe(200)
  await calendarButton.click()
  await expect(handleIn(calendars)).toHaveAttribute('aria-valuenow', '200')
  expect(await drawn(calendars)).toBe(200)

  // The pointer in Calendar: 60 px towards the end of the line.
  const grip = await boxOf(handleIn(calendars))
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 300)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + 300, { steps: 4 })
  await page.mouse.up()
  const dragged = Number(await handleIn(calendars).getAttribute('aria-valuenow'))
  expect(Math.abs(dragged - 260)).toBeLessThanOrEqual(2)
  expect(Math.abs((await boxOf(calendars)).width - dragged)).toBeLessThanOrEqual(1)
  await expect.poll(stored).toBe(dragged)

  // Kept across a restart, in both modules.
  await page.reload()
  await expect(handleIn(mail)).toHaveAttribute('aria-valuenow', String(dragged))
  await calendarButton.click()
  await expect(handleIn(calendars)).toHaveAttribute('aria-valuenow', String(dragged))
  expect(errors).toEqual([])
})

test('in Arabic Calendar\'s folder pane sits between the rail and the views, and its separator follows the reading (#323)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await openCalendarPane(page, { language: 'ar' }, arCatalog)
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  const pane = page.getByRole('navigation', { name: arCatalog['calendar.calendars'], exact: true })
  await expect(pane).toBeVisible()
  await expect(pane.getByRole('navigation', { name: arCatalog['calendar.miniCalendar'], exact: true })).toBeVisible()
  const railBox = await boxOf(page.locator('main > aside').first())
  const paneBox = await boxOf(pane)
  const contentBox = await boxOf(page.locator('main > [data-region="content"]'))
  expect(Math.abs(paneBox.x + paneBox.width - railBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(contentBox.x + contentBox.width - paneBox.x)).toBeLessThanOrEqual(1)
  expect(contentBox.x).toBeGreaterThanOrEqual(-1)
  // The separator is on the pane's end edge, on the left: ArrowLeft widens it,
  // and the pane grows to the left with its start edge against the rail.
  const handle = pane.getByRole('separator', { name: arCatalog['layout.resizeFolderPane'], exact: true })
  const handleBox = await boxOf(handle)
  expect(Math.abs(handleBox.x + handleBox.width / 2 - paneBox.x)).toBeLessThanOrEqual(1)
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', '276')
  const grown = await boxOf(pane)
  expect(Math.round(grown.width)).toBe(276)
  expect(Math.round(grown.x + grown.width)).toBe(Math.round(paneBox.x + paneBox.width))
  await page.keyboard.press('Shift+ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '212')
  await insidePane(page, pane)
  await rtlInView(page, 'calendar folder pane')
  // The #226 audits in Arabic run at 600 and 1024 px, where the pane is not
  // drawn: this one reads it, with nothing critical or serious.
  await settled(page)
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  const blocking = results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => `${violation.id} (${violation.impact}) on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)
  expect(blocking).toEqual([])
  expect(errors).toEqual([])
})

// At the app's 200 % the pane keeps its px width (ADR-0068 §7): its text
// grows, and the month at a glance shrinks its days to fit it.
for (const width of [1440, 1025]) {
  test(`Calendar's folder pane stays in px at the app's 200 %, everything in it inside it: ${width}px (#323)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors = await openCalendarPane(page)
    const pane = page.getByRole('navigation', { name: 'Calendars', exact: true })
    await expect(pane).toBeVisible()
    const before = Math.round((await boxOf(pane)).width)
    expect(before).toBe(260)
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px')
    await expect(pane.getByRole('heading', { level: 2, name: 'Calendars' })).toBeVisible()
    expect(Math.round((await boxOf(pane)).width)).toBe(before)
    for (const view of ['Day', 'Week', 'Month']) {
      await page.getByRole('button', { name: view, exact: true }).click()
      await settled(page)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      // At 1025 px the week's seven days at 200 % need more than the module's
      // 645 px, as they needed more than the 521 px the 12 rem column left
      // them on c62e11ca: its last days are clipped, not scrolled, there and
      // then. That is the week view's own, not the pane's.
      if (width === 1440 || view !== 'Week') await ltrInView(page, `${view.toLowerCase()} at 200 %, ${width}px`)
      await insidePane(page, pane)
    }
    // Each day of the month at a glance is a whole circle, no wider than its seventh.
    const days = await pane.locator('[data-mini-day]').evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect()
        return Math.abs(box.width - box.height) <= 1
      }),
    )
    expect(days.length).toBe(42)
    expect(days.every(Boolean)).toBe(true)
    await page.keyboard.press(`${mod}+Digit0`)
    expect(Math.round((await boxOf(pane)).width)).toBe(before)
    expect(errors).toEqual([])
  })
}

// What the column did, the pane does: a tick shows or hides a calendar, and
// its name opens the colours. In the pane, the colour menu of the last
// calendar opens whole, over the list's room, without scrolling it. At
// 1024 px the column is as before, where the menu runs a few px past the
// 12 rem column and its last swatch is cut, as on c62e11ca.
for (const width of [1440, 1024]) {
  test(`Calendar's calendars show, hide and change colour in ${width > 1024 ? 'the folder pane' : 'the column'} (#323)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors = await openCalendarPane(page)
    await page.evaluate(() => {
      const replies = (window as any).startupProbe.replies
      replies['calendar.setEnabled'] = { ok: true }
      replies['calendar.setColor'] = { ok: true }
    })
    const region = page.getByRole('navigation', { name: 'Calendars', exact: true })
    await expect(page.locator('[data-folder-pane]')).toHaveCount(width > 1024 ? 1 : 0)
    const requests = (command: string) =>
      page.evaluate(
        (name) => (window as any).startupProbe.requests.filter((request: any) => request.command === name).map((request: any) => request.payload),
        command,
      )
    // The last calendar of the last account: its tick hides it. (The days of
    // the month at a glance are pressed buttons too, not in the list.)
    const ticks = region.locator('li button[aria-pressed]')
    const last = ticks.last()
    await expect(last).toHaveAttribute('aria-pressed', 'true')
    await last.click()
    await expect(last).toHaveAttribute('aria-pressed', 'false')
    expect((await requests('calendar.setEnabled')).at(-1)).toMatchObject({ calendar_id: 'holidays', enabled: false })

    // Its name opens the colours.
    await region.getByTitle('Holidays — Colour', { exact: true }).last().click()
    const menu = region.getByRole('menu', { name: 'Colour' })
    await expect(menu).toBeVisible()
    if (width > 1024) {
      // Whole and inside the pane, and the list does not scroll.
      const menuBox = await boxOf(menu)
      const regionBox = await boxOf(region)
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(regionBox.y + regionBox.height + 1)
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(regionBox.x + regionBox.width + 1)
      const scrolled = await menu.evaluate((element) => {
        const list = element.closest('ul')!.parentElement!.parentElement!
        return { top: list.scrollTop, overflows: list.scrollHeight > list.clientHeight + 1 }
      })
      expect(scrolled).toEqual({ top: 0, overflows: false })
      for (const item of await menu.getByRole('menuitemradio').all()) await expect(item).toBeInViewport({ ratio: 1 })
    }
    const swatch = menu.locator('[role="menuitemradio"][aria-checked="false"]').first()
    const colour = await swatch.getAttribute('aria-label')
    await swatch.click()
    await expect(menu).toHaveCount(0)
    expect((await requests('calendar.setColor')).at(-1)).toMatchObject({ calendar_id: 'holidays', color: colour })
    expect(errors).toEqual([])
  })
}

// #326: People's groups in the common folder pane (ADR-0068 §4), at the one
// width every module shares. The list and the person stay beside it. At
// 1024 px and below the pane is not drawn, and the groups keep their filter
// under the list's header.
async function openPeoplePane(page: Page, options: SetupOptions = {}, catalog = enCatalog) {
  const errors = await prepareStartup(page, true, { navigation: true, ...options })
  await page.addInitScript(() => {
    const replies = (window as any).startupProbe.replies
    const person = (id: string, given: string, family: string, addr: string) => ({
      id, source: 'local', account: '', book: 'local', name: `${given} ${family}`, given, family,
      organisation: '', note: '', photo: '', emails: [{ addr, label: 'work' }], phones: [{ number: '+34 600 000 000', label: 'cell' }],
      version: '1', editable: true,
    })
    replies['people.list'] = {
      people: [
        person('local::local:a', 'Ada', 'Lovelace', 'ada.lovelace.with.a.long.address@example.test'),
        person('local::local:c', 'Charles', 'Babbage', 'charles@example.test'),
      ],
    }
    replies['people.groups'] = {
      groups: [
        {
          id: 'group:local::local:g', source: 'local', account: '', book: 'local', name: 'Engines', version: '3', editable: true,
          members: [
            { id: 'local::local:a', name: 'Ada Lovelace', given: 'Ada', family: 'Lovelace', addr: 'ada.lovelace.with.a.long.address@example.test' },
            { id: 'local::local:c', name: 'Charles Babbage', given: 'Charles', family: 'Babbage', addr: 'charles@example.test' },
          ],
        },
        {
          id: 'group:carddav::src:s', source: 'carddav', account: '', book: 'src', name: 'A shared group on a server with a very long name', version: '1', editable: false,
          members: [{ id: 'local::local:c', name: 'Charles Babbage', given: 'Charles', family: 'Babbage', addr: 'charles@example.test' }],
        },
      ],
    }
    replies['people.groupSave'] = { ok: true, id: 'group:local::local:g', version: '4' }
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  await page.getByTitle(catalog['people.title'], { exact: true }).click()
  await expect(page.getByRole('main', { name: catalog['people.title'], exact: true })).toBeVisible()
  return errors
}

for (const [width, paneWidth] of [
  [1025, 200],
  [1025, 260],
  [1025, 400],
  [1100, 200],
  [1100, 260],
  [1440, 200],
  [1440, 260],
] as const) {
  test(`People's folder pane leaves the list and a person whole at ${width}px, ${paneWidth}px wide (#326)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors = await openPeoplePane(page, { preferences: { folder_pane_width: paneWidth } })
    const pane = page.getByRole('navigation', { name: 'Contact groups', exact: true })
    const content = page.locator('main > [data-region="content"]')
    await expect(pane).toHaveAttribute('data-region', 'folders')
    await expect(pane.getByRole('heading', { level: 2, name: 'Contact groups' })).toBeVisible()
    await expect(pane.getByRole('button', { name: 'All contacts', exact: true })).toBeVisible()
    await expect(pane.getByRole('button', { name: 'Engines (2)', exact: true })).toBeVisible()
    await expect(pane.getByRole('button', { name: 'New group', exact: true })).toBeVisible()
    // Right after the rail, at the shared width, and the module right after it.
    const rail = await boxOf(page.locator('main > aside').first())
    const paneBox = await boxOf(pane)
    expect(Math.abs(paneBox.x - (rail.x + rail.width))).toBeLessThanOrEqual(1)
    // The person keeps the reader's 360 px (ADR-0068 §7): where the pane and
    // the list leave less, the pane gives way first, down to 200 px.
    const drawnPane = Math.max(200, Math.min(paneWidth, width - 60 - 288 - 360))
    expect(Math.abs(paneBox.width - drawnPane)).toBeLessThanOrEqual(1)
    // The separator reports the width that is drawn, squeezed or not.
    const valueNow = await pane.getByRole('separator', { name: 'Resize folder pane' }).getAttribute('aria-valuenow')
    expect(Math.abs(Number(valueNow) - drawnPane)).toBeLessThanOrEqual(1)
    const contentBox = await boxOf(content)
    expect(Math.abs(contentBox.x - (paneBox.x + paneBox.width))).toBeLessThanOrEqual(1)
    expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(width + 1)
    // The group row is not in the list's header as well.
    await expect(content.locator('[data-region="folders"]')).toHaveCount(0)
    await expect(content.getByLabel('Show group')).toHaveCount(0)

    // A person opens in the details beside the list, whole.
    const list = page.getByRole('listbox', { name: 'People' })
    await expect(list.getByRole('option')).toHaveCount(2)
    await list.getByRole('option', { name: /Lovelace/ }).click()
    await expect(page.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible()
    await settled(page)
    await ltrInView(page, `people at ${width}px, folders ${paneWidth}px`)
    const outside = await content.evaluate((region) => {
      const { left, right } = region.getBoundingClientRect()
      return [...region.querySelectorAll<HTMLElement>('button, input, select, h1, h2')]
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && (box.left < left - 1 || box.right > right + 1))
        .map(({ element }) => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40))
    })
    expect(outside).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const detail = await boxOf(page.getByRole('region', { name: 'Ada Lovelace' }))
    // The person takes all the room the rail, the pane and the list leave: at
    // 1025 px, 477 and 417 px for a pane of 200 and 260, and 360 px for 400,
    // when the pane is drawn 317 px wide instead.
    expect(detail.width).toBeGreaterThanOrEqual(width - 60 - drawnPane - 288 - 2)
    await insidePane(page, pane)
    expect(errors).toEqual([])
  })
}

test('at 1024px People keeps its groups as a filter in the list, and draws no folder pane (#326)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  const errors = await openPeoplePane(page)
  await expect(page.locator('[data-folder-pane]')).toHaveCount(0)
  await expect(page.getByRole('separator', { name: 'Resize folder pane' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Contact groups' })).toHaveCount(0)
  const column = page.locator('main > [data-region="content"] [data-region="folders"]')
  await expect(column).toHaveCount(1)
  // 18 rem wide, as before.
  expect(Math.round((await boxOf(column)).width)).toBe(288)
  await column.getByLabel('Show group').selectOption({ label: 'Engines (2)' })
  await expect(page.getByRole('listbox', { name: 'People' }).getByRole('option')).toHaveCount(2)
  await expect(column.getByRole('button', { name: 'Rename group', exact: true })).toBeVisible()
  await expect(column.getByRole('button', { name: 'Delete group', exact: true })).toBeVisible()
  await ltrInView(page, 'people at 1024px')
  expect(errors).toEqual([])
})

test("People's groups choose, create and rename from the folder pane (#326)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors = await openPeoplePane(page)
  const pane = page.getByRole('navigation', { name: 'Contact groups', exact: true })
  const list = page.getByRole('listbox', { name: 'People' })
  const requests = (command: string) =>
    page.evaluate(
      (name) => (window as any).startupProbe.requests.filter((request: any) => request.command === name).map((request: any) => request.payload),
      command,
    )
  // The long name is cut with "…" and whole in its tooltip.
  const long = pane.getByTitle('A shared group on a server with a very long name (1)')
  await expect(long).toBeVisible()
  await long.click()
  await expect(long).toHaveAttribute('aria-current', 'true')
  await expect(list.getByRole('option')).toHaveCount(1)
  // A group a book cannot write offers neither a rename nor a delete.
  await expect(pane.getByRole('button', { name: /^(Rename|Delete) /, })).toHaveCount(0)

  await pane.getByRole('button', { name: 'Engines (2)', exact: true }).click()
  await expect(list.getByRole('option')).toHaveCount(2)
  await pane.getByRole('button', { name: 'Rename Engines', exact: true }).click()
  const name = page.getByLabel('Group name')
  await expect(name).toHaveValue('Engines')
  await name.fill('Analytical Engines')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(async () => (await requests('people.groupSave')).at(-1))
    .toEqual({ id: 'group:local::local:g', version: '3', name: 'Analytical Engines', members: ['local::local:a', 'local::local:c'] })

  await pane.getByRole('button', { name: 'New group', exact: true }).click()
  await page.getByLabel('Group name').fill('Book club')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await requests('people.groupSave')).at(-1)).toEqual({ name: 'Book club', members: [] })

  await pane.getByRole('button', { name: 'All contacts', exact: true }).click()
  await expect(pane.getByRole('button', { name: 'All contacts', exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(list.getByRole('option')).toHaveCount(2)
  expect(errors).toEqual([])
})

test('the folder pane resized in People is the width mail draws, and the reverse (#326)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await openPeoplePane(page)
  const people = page.getByRole('navigation', { name: 'Contact groups', exact: true })
  const mail = page.getByRole('navigation', { name: 'Accounts and folders', exact: true })
  const handleIn = (pane: ReturnType<Page['locator']>) => pane.getByRole('separator', { name: 'Resize folder pane' })
  const drawn = async (pane: ReturnType<Page['locator']>) => Math.round((await boxOf(pane)).width)
  const stored = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}').folder_pane_width)
  const peopleButton = page.getByTitle('People', { exact: true })
  await expect(handleIn(people)).toHaveAttribute('aria-valuenow', '260')

  // The keyboard in People: the widest it goes, kept for mail.
  await handleIn(people).focus()
  await page.keyboard.press('End')
  await expect(handleIn(people)).toHaveAttribute('aria-valuenow', '400')
  expect(await drawn(people)).toBe(400)
  await expect.poll(stored).toBe(400)
  await peopleButton.click()
  await expect(mail).toBeVisible()
  await expect(handleIn(mail)).toHaveAttribute('aria-valuenow', '400')
  expect(await drawn(mail)).toBe(400)

  // Narrowed in mail, People's is as narrow.
  await handleIn(mail).focus()
  await page.keyboard.press('Home')
  await expect.poll(stored).toBe(200)
  await peopleButton.click()
  await expect(handleIn(people)).toHaveAttribute('aria-valuenow', '200')
  expect(await drawn(people)).toBe(200)

  // The pointer in People: 60 px towards the end of the line.
  const grip = await boxOf(handleIn(people))
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 300)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + 300, { steps: 4 })
  await page.mouse.up()
  const dragged = Number(await handleIn(people).getAttribute('aria-valuenow'))
  expect(Math.abs(dragged - 260)).toBeLessThanOrEqual(2)
  expect(Math.abs((await boxOf(people)).width - dragged)).toBeLessThanOrEqual(1)
  await expect.poll(stored).toBe(dragged)

  // Kept across a restart, in both modules.
  await page.reload()
  await expect(handleIn(mail)).toHaveAttribute('aria-valuenow', String(dragged))
  await peopleButton.click()
  await expect(handleIn(people)).toHaveAttribute('aria-valuenow', String(dragged))
  expect(errors).toEqual([])
})

test("in Arabic People's folder pane sits between the rail and the list, and its separator follows the reading (#326)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await openPeoplePane(page, { language: 'ar' }, arCatalog)
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  const pane = page.getByRole('navigation', { name: arCatalog['people.contactGroups'], exact: true })
  await expect(pane).toBeVisible()
  const railBox = await boxOf(page.locator('main > aside').first())
  const paneBox = await boxOf(pane)
  const contentBox = await boxOf(page.locator('main > [data-region="content"]'))
  expect(Math.abs(paneBox.x + paneBox.width - railBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(contentBox.x + contentBox.width - paneBox.x)).toBeLessThanOrEqual(1)
  expect(contentBox.x).toBeGreaterThanOrEqual(-1)
  const handle = pane.getByRole('separator', { name: arCatalog['layout.resizeFolderPane'], exact: true })
  const handleBox = await boxOf(handle)
  expect(Math.abs(handleBox.x + handleBox.width / 2 - paneBox.x)).toBeLessThanOrEqual(1)
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', '276')
  const grown = await boxOf(pane)
  expect(Math.round(grown.width)).toBe(276)
  expect(Math.round(grown.x + grown.width)).toBe(Math.round(paneBox.x + paneBox.width))
  await page.keyboard.press('Shift+ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '212')
  await page.getByRole('option', { name: /Lovelace/ }).click()
  await insidePane(page, pane)
  await rtlInView(page, 'people folder pane')
  await settled(page)
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  const blocking = results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => `${violation.id} (${violation.impact}) on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)
  expect(blocking).toEqual([])
  expect(errors).toEqual([])
})

// At the app's 200 % the pane keeps its px width (ADR-0068 §7): its text grows.
for (const width of [1440, 1025]) {
  test(`People's folder pane stays in px at the app's 200 %, everything in it inside it: ${width}px (#326)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors = await openPeoplePane(page)
    const pane = page.getByRole('navigation', { name: 'Contact groups', exact: true })
    await expect(pane).toBeVisible()
    const before = Math.round((await boxOf(pane)).width)
    expect(before).toBe(260)
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px')
    await expect(pane.getByRole('heading', { level: 2, name: 'Contact groups' })).toBeVisible()
    // It does not grow with the zoom. At 1025 px the rail's rem width grows and
    // the pane, which gives way before the person's 360 px, loses a few px.
    const zoomed = Math.round((await boxOf(pane)).width)
    if (width === 1440) expect(zoomed).toBe(before)
    else expect(zoomed).toBeGreaterThanOrEqual(before - 10)
    expect(zoomed).toBeLessThanOrEqual(before)
    await settled(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await ltrInView(page, `people at 200 %, ${width}px`)
    // And a person opens beside the list, whole.
    await page.getByRole('option', { name: /Lovelace/ }).click()
    await expect(page.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible()
    await settled(page)
    await ltrInView(page, `a person at 200 %, ${width}px`)
    await insidePane(page, pane)
    await page.keyboard.press(`${mod}+Digit0`)
    expect(Math.round((await boxOf(pane)).width)).toBe(before)
    expect(errors).toEqual([])
  })
}

// #329: the task lists in the common folder pane (ADR-0068 §4), at the one
// width every module shares. The tasks stay beside it and take all the room it
// leaves. At 1024 px and below the pane is not drawn, and the lists keep their
// tabs in the row under the header.
async function openTasksPane(page: Page, options: SetupOptions = {}, catalog = enCatalog) {
  const errors = await prepareStartup(page, true, { navigation: true, ...options })
  await page.addInitScript(() => {
    const replies = (window as any).startupProbe.replies
    const task = (id: number, title: string, list: string) => ({
      id, thread_id: '', account_id: '', folder_id: '', note: 'A note that is long enough to wrap in a narrow window', due_at: null,
      completed_at: null, created_at: 0, subject: '', from_name: '', from_addr: '', linked: false, list_id: list,
      title, priority: 1, reminder_at: null, revision: 1,
    })
    replies['tasks.lists'] = {
      lists: [
        { id: 'mail', name: '', position: 0, open: 1 },
        { id: 'list:home', name: 'Home', position: 1, open: 2 },
        { id: 'list:dav', name: 'A CalDAV list on a server with a very long name', position: 2, open: 1, remote_url: 'https://dav.example.test/ana/tasks/', synced_at: 1760000000, last_error: '', conflicts: 0 },
      ],
      account_lists: [
        { account: 'synthetic-account', source: 'ews', state: 'declined', list_id: '', adopted: false, notified: true, last_error: '', kind: 'ews', url: '' },
      ],
    }
    replies['tasks.list'] = {
      tasks: [task(1, 'Renew the contract', 'mail'), task(2, 'Fix the tap', 'list:home'), task(3, 'Water the plants', 'list:home'), task(4, 'Sync the phone', 'list:dav')],
    }
    // As the core answers (meron-core/src/main.rs).
    replies['tasks.createList'] = { ok: true, id: 'list:new' }
    replies['tasks.renameList'] = { ok: true }
    replies['tasks.deleteList'] = { ok: true }
    // A list kept on a server is synced when Tasks opens.
    replies['tasks.sync'] = { lists: [], accounts: [] }
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  await page.getByTitle(catalog['tasks.title'], { exact: true }).click()
  await expect(page.getByRole('main', { name: catalog['tasks.title'], exact: true })).toBeVisible()
  return errors
}

for (const [width, paneWidth] of [
  [1025, 200],
  [1025, 260],
  [1025, 400],
  [1100, 200],
  [1100, 260],
  [1440, 200],
  [1440, 260],
] as const) {
  test(`Tasks's folder pane leaves the tasks whole at ${width}px, ${paneWidth}px wide (#329)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors = await openTasksPane(page, { preferences: { folder_pane_width: paneWidth } })
    const pane = page.getByRole('navigation', { name: 'Task lists', exact: true })
    const content = page.locator('main > [data-region="content"]')
    await expect(pane).toHaveAttribute('data-region', 'folders')
    await expect(pane.getByRole('heading', { level: 2, name: 'Task lists' })).toBeVisible()
    await expect(pane.getByRole('button', { name: 'All', exact: true })).toBeVisible()
    await expect(pane.getByRole('button', { name: 'Mail follow-up (1)', exact: true })).toBeVisible()
    await expect(pane.getByRole('button', { name: 'Home (2)', exact: true })).toBeVisible()
    await expect(pane.getByRole('button', { name: 'New list', exact: true })).toBeVisible()
    await expect(pane.getByRole('button', { name: /Add a list/ })).toBeVisible()
    // Right after the rail, at the shared width, and the module right after it.
    const rail = await boxOf(page.locator('main > aside').first())
    const paneBox = await boxOf(pane)
    expect(Math.abs(paneBox.x - (rail.x + rail.width))).toBeLessThanOrEqual(1)
    expect(Math.abs(paneBox.width - paneWidth)).toBeLessThanOrEqual(1)
    await expect(pane.getByRole('separator', { name: 'Resize folder pane' })).toHaveAttribute('aria-valuenow', String(paneWidth))
    const contentBox = await boxOf(content)
    expect(Math.abs(contentBox.x - (paneBox.x + paneBox.width))).toBeLessThanOrEqual(1)
    expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(width + 1)
    // The tasks take all the room the rail and the pane leave.
    expect(contentBox.width).toBeGreaterThanOrEqual(width - 60 - paneWidth - 2)
    // The tabs are gone from beside the tasks.
    await expect(content.locator('[data-region="folders"]')).toHaveCount(0)
    await expect(page.getByRole('tablist')).toHaveCount(0)

    await expect(content.getByText('Renew the contract')).toBeVisible()
    await pane.getByRole('button', { name: 'Home (2)', exact: true }).click()
    await expect(content.getByText('Fix the tap')).toBeVisible()
    await expect(content.getByText('Renew the contract')).toHaveCount(0)
    await settled(page)
    await ltrInView(page, `tasks at ${width}px, folders ${paneWidth}px`)
    const outside = await content.evaluate((region) => {
      const { left, right } = region.getBoundingClientRect()
      return [...region.querySelectorAll<HTMLElement>('button, input, h1')]
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && (box.left < left - 1 || box.right > right + 1))
        .map(({ element }) => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40))
    })
    expect(outside).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await insidePane(page, pane)
    expect(errors).toEqual([])
  })
}

test('at 1024px Tasks keeps its lists as tabs under the header, and draws no folder pane (#329)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  const errors = await openTasksPane(page)
  await expect(page.locator('[data-folder-pane]')).toHaveCount(0)
  await expect(page.getByRole('separator', { name: 'Resize folder pane' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Task lists' })).toHaveCount(0)
  const tabs = page.getByRole('tablist', { name: 'Lists' })
  await expect(tabs.getByRole('tab')).toHaveCount(4)
  await tabs.getByRole('tab', { name: /Home/ }).click()
  await expect(tabs.getByRole('tab', { name: /Home/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Fix the tap')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rename list', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete list', exact: true })).toBeVisible()
  await ltrInView(page, 'tasks at 1024px')
  expect(errors).toEqual([])
})

test("Tasks's lists choose, create, rename and delete from the folder pane (#329)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors = await openTasksPane(page)
  const pane = page.getByRole('navigation', { name: 'Task lists', exact: true })
  const requests = (command: string) =>
    page.evaluate(
      (name) => (window as any).startupProbe.requests.filter((request: any) => request.command === name).map((request: any) => request.payload),
      command,
    )
  // The long name is cut with "…" and whole in its tooltip, with its count.
  const long = pane.getByTitle('A CalDAV list on a server with a very long name (1)')
  await expect(long).toBeVisible()
  await long.click()
  await expect(long).toHaveAttribute('aria-current', 'true')
  await expect(page.getByText('Sync the phone')).toBeVisible()
  // A list kept on a server says where, above the tasks.
  await expect(page.getByText(/Kept on dav\.example\.test/)).toBeVisible()

  await pane.getByRole('button', { name: 'Home (2)', exact: true }).click()
  await expect(pane.getByRole('button', { name: 'Home (2)', exact: true })).toHaveAttribute('aria-current', 'true')
  page.once('dialog', (dialog) => void dialog.accept('Household'))
  await pane.getByRole('button', { name: 'Rename Home', exact: true }).click()
  await expect.poll(async () => (await requests('tasks.renameList')).at(-1)).toEqual({ id: 'list:home', name: 'Household' })

  // Deleting asks first, naming the list, and leaves "All" on show.
  await pane.getByRole('button', { name: 'Delete Home', exact: true }).click()
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'))
  await expect(confirm.getByText('Home and every task in it will be deleted.')).toBeVisible()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(async () => (await requests('tasks.deleteList')).at(-1)).toEqual({ id: 'list:home' })
  await expect(pane.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-current', 'true')

  await pane.getByRole('button', { name: 'New list', exact: true }).click()
  await pane.getByLabel('New list name').fill('Errands')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await requests('tasks.createList')).at(-1)).toEqual({ name: 'Errands' })

  await pane.getByRole('button', { name: 'All', exact: true }).click()
  await expect(pane.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(pane.getByRole('button', { name: /^(Rename|Delete) / })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a click on a list or on “Add a list” lands while the empty “New list” field is open (#329)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors = await openTasksPane(page)
  const pane = page.getByRole('navigation', { name: 'Task lists', exact: true })
  await pane.getByRole('button', { name: 'New list', exact: true }).click()
  const field = pane.getByLabel('New list name')
  await expect(field).toBeFocused()
  // One click, with the field empty: the press blurs it, and nothing may move
  // under the pointer before the click ends.
  await pane.getByRole('button', { name: 'Home (2)', exact: true }).click()
  await expect(pane.getByRole('button', { name: 'Home (2)', exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(page.getByText('Fix the tap')).toBeVisible()
  await expect(field).toBeVisible()
  // The same for “Add a list”, below the lists.
  await pane.getByRole('button', { name: /Add a list/ }).click()
  await expect(pane.getByRole('button', { name: /Add a list/ })).toHaveAttribute('aria-expanded', 'true')
  await expect(pane.getByRole('button', { name: /Exchange tasks of/ })).toBeVisible()
  // Escape cancels the field and the focus goes back to the button.
  await field.focus()
  await page.keyboard.press('Escape')
  await expect(field).toHaveCount(0)
  await expect(pane.getByRole('button', { name: 'New list', exact: true })).toBeFocused()
  // Down moves to the next list and chooses it, as the tabs' arrows did.
  await pane.getByRole('button', { name: 'Home (2)', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(pane.getByTitle('A CalDAV list on a server with a very long name (1)')).toHaveAttribute('aria-current', 'true')
  expect(errors).toEqual([])
})

test('the folder pane resized in Tasks is the width mail draws, and the reverse (#329)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await openTasksPane(page)
  const tasks = page.getByRole('navigation', { name: 'Task lists', exact: true })
  const mail = page.getByRole('navigation', { name: 'Accounts and folders', exact: true })
  const handleIn = (pane: ReturnType<Page['locator']>) => pane.getByRole('separator', { name: 'Resize folder pane' })
  const drawn = async (pane: ReturnType<Page['locator']>) => Math.round((await boxOf(pane)).width)
  const stored = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}').folder_pane_width)
  const tasksButton = page.getByTitle('Tasks', { exact: true })
  await expect(handleIn(tasks)).toHaveAttribute('aria-valuenow', '260')

  // The keyboard in Tasks: the widest it goes, kept for mail.
  await handleIn(tasks).focus()
  await page.keyboard.press('End')
  await expect(handleIn(tasks)).toHaveAttribute('aria-valuenow', '400')
  expect(await drawn(tasks)).toBe(400)
  await expect.poll(stored).toBe(400)
  await tasksButton.click()
  await expect(mail).toBeVisible()
  await expect(handleIn(mail)).toHaveAttribute('aria-valuenow', '400')
  expect(await drawn(mail)).toBe(400)

  // Narrowed in mail, Tasks's is as narrow.
  await handleIn(mail).focus()
  await page.keyboard.press('Home')
  await expect.poll(stored).toBe(200)
  await tasksButton.click()
  await expect(handleIn(tasks)).toHaveAttribute('aria-valuenow', '200')
  expect(await drawn(tasks)).toBe(200)

  // The pointer in Tasks: 60 px towards the end of the line.
  const grip = await boxOf(handleIn(tasks))
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 300)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + 300, { steps: 4 })
  await page.mouse.up()
  const dragged = Number(await handleIn(tasks).getAttribute('aria-valuenow'))
  expect(Math.abs(dragged - 260)).toBeLessThanOrEqual(2)
  expect(Math.abs((await boxOf(tasks)).width - dragged)).toBeLessThanOrEqual(1)
  await expect.poll(stored).toBe(dragged)

  // Kept across a restart, in both modules.
  await page.reload()
  await expect(handleIn(mail)).toHaveAttribute('aria-valuenow', String(dragged))
  await tasksButton.click()
  await expect(handleIn(tasks)).toHaveAttribute('aria-valuenow', String(dragged))
  expect(errors).toEqual([])
})

test("in Arabic Tasks's folder pane sits between the rail and the tasks, and its separator follows the reading (#329)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await openTasksPane(page, { language: 'ar' }, arCatalog)
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  const pane = page.getByRole('navigation', { name: arCatalog['tasks.taskLists'], exact: true })
  await expect(pane).toBeVisible()
  const railBox = await boxOf(page.locator('main > aside').first())
  const paneBox = await boxOf(pane)
  const contentBox = await boxOf(page.locator('main > [data-region="content"]'))
  expect(Math.abs(paneBox.x + paneBox.width - railBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(contentBox.x + contentBox.width - paneBox.x)).toBeLessThanOrEqual(1)
  expect(contentBox.x).toBeGreaterThanOrEqual(-1)
  const handle = pane.getByRole('separator', { name: arCatalog['layout.resizeFolderPane'], exact: true })
  const handleBox = await boxOf(handle)
  expect(Math.abs(handleBox.x + handleBox.width / 2 - paneBox.x)).toBeLessThanOrEqual(1)
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', '276')
  const grown = await boxOf(pane)
  expect(Math.round(grown.width)).toBe(276)
  expect(Math.round(grown.x + grown.width)).toBe(Math.round(paneBox.x + paneBox.width))
  await page.keyboard.press('Shift+ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '212')
  await insidePane(page, pane)
  await rtlInView(page, 'tasks folder pane')
  await settled(page)
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  const blocking = results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => `${violation.id} (${violation.impact}) on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)
  expect(blocking).toEqual([])
  expect(errors).toEqual([])
})

// At the app's 200 % the pane keeps its px width (ADR-0068 §7): its text grows.
for (const [width, paneWidth] of [
  [1440, 260],
  [1025, 260],
  [1025, 400],
] as const) {
  test(`Tasks's folder pane stays in px at the app's 200 %, everything in it inside it: ${width}px, ${paneWidth}px wide (#329)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors = await openTasksPane(page, { preferences: { folder_pane_width: paneWidth } })
    const pane = page.getByRole('navigation', { name: 'Task lists', exact: true })
    await expect(pane).toBeVisible()
    const before = Math.round((await boxOf(pane)).width)
    expect(before).toBe(paneWidth)
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px')
    await expect(pane.getByRole('heading', { level: 2, name: 'Task lists' })).toBeVisible()
    // It does not grow with the zoom. At 1025 px the rail's rem width grows and
    // the pane, which gives way first, may lose a few px.
    const zoomed = Math.round((await boxOf(pane)).width)
    if (width === 1440) expect(zoomed).toBe(before)
    else expect(zoomed).toBeGreaterThanOrEqual(before - 10)
    expect(zoomed).toBeLessThanOrEqual(before)
    await settled(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await ltrInView(page, `tasks at 200 %, ${width}px, folders ${paneWidth}px`)
    await insidePane(page, pane)
    await page.keyboard.press(`${mod}+Digit0`)
    expect(Math.round((await boxOf(pane)).width)).toBe(before)
    expect(errors).toEqual([])
  })
}

// #335: the notes' tags in the common folder pane (ADR-0068 §4), at the one
// width every module shares. The list and the open note stay beside it. At
// 1024 px and below the pane is not drawn, and the tags keep their chips above
// the list.
async function openNotesPane(page: Page, options: SetupOptions = {}, catalog = enCatalog) {
  const errors = await prepareStartup(page, true, { navigation: true, ...options })
  await page.addInitScript(() => {
    const replies = (window as any).startupProbe.replies
    const note = (id: string, title: string, tags: string[], deleted_at: number | null = null) => ({
      id,
      title,
      html: `<p>${title} body</p>`,
      text: `${title} body`,
      preview: `${title} body`,
      tags,
      pinned: false,
      revision: 1,
      created_at: 0,
      updated_at: 1760000000,
      deleted_at,
    })
    const all = [
      note('note:1', 'Plan the trip', ['travel', 'ideas']),
      note('note:2', 'Packing list', ['travel']),
      note('note:3', 'Pasta', ['cooking']),
      note('note:4', 'Old receipt', [], 5),
    ]
    const tags = [
      { tag: 'travel', count: 2 },
      { tag: 'cooking', count: 1 },
      { tag: 'a-tag-with-a-name-far-too-long-for-the-pane', count: 1 },
      { tag: 'ideas', count: 1 },
    ]
    // As the core answers: the tags of the live notes, the list by filter.
    const app = (window as any).go.main.App
    const inner = app.Invoke
    app.Invoke = async (command: string, payload: any) => {
      if (command === 'notes.list')
        return {
          notes: all.filter(
            (n) => (n.deleted_at !== null) === !!payload?.trash && (!payload?.tag || n.tags.includes(payload.tag)),
          ),
          tags,
        }
      if (command === 'notes.get') return { note: all.find((n) => n.id === payload?.id) ?? null }
      return inner(command, payload)
    }
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  await page.getByTitle(catalog['notes.title'], { exact: true }).click()
  await expect(page.getByRole('main', { name: catalog['notes.title'], exact: true })).toBeVisible()
  return errors
}

for (const [width, paneWidth] of [
  [1025, 200],
  [1025, 260],
  [1025, 400],
  [1100, 200],
  [1100, 260],
  [1440, 200],
  [1440, 260],
] as const) {
  test(`Notes's folder pane leaves the list and a note whole at ${width}px, ${paneWidth}px wide (#335)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors = await openNotesPane(page, { preferences: { folder_pane_width: paneWidth } })
    const pane = page.getByRole('navigation', { name: 'Note tags', exact: true })
    const content = page.locator('main > [data-region="content"]')
    await expect(pane).toHaveAttribute('data-region', 'folders')
    await expect(pane.getByRole('heading', { level: 2, name: 'Note tags' })).toBeVisible()
    await expect(pane.getByRole('button', { name: 'All notes', exact: true })).toBeVisible()
    await expect(pane.getByRole('button', { name: '#travel (2)', exact: true })).toBeVisible()
    // Right after the rail, at the shared width, and the module right after it.
    const rail = await boxOf(page.locator('main > aside').first())
    const paneBox = await boxOf(pane)
    expect(Math.abs(paneBox.x - (rail.x + rail.width))).toBeLessThanOrEqual(1)
    expect(Math.abs(paneBox.width - Math.min(paneWidth, width - 60 - 680))).toBeLessThanOrEqual(1)
    const contentBox = await boxOf(content)
    expect(Math.abs(contentBox.x - (paneBox.x + paneBox.width))).toBeLessThanOrEqual(1)
    expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(width + 1)
    // The chips are gone from the list, and the list no longer claims the region.
    await expect(content.locator('[data-region="folders"]')).toHaveCount(0)
    await expect(content.getByLabel('Tags', { exact: true })).toHaveCount(0)

    await expect(content.getByText('Pasta', { exact: true })).toBeVisible()
    await pane.getByRole('button', { name: '#travel (2)', exact: true }).click()
    await expect(content.getByText('Packing list', { exact: true })).toBeVisible()
    await expect(content.getByText('Pasta', { exact: true })).toHaveCount(0)
    await content.getByRole('button', { name: /Plan the trip/ }).click()
    await expect(content.getByLabel('Title', { exact: true })).toHaveValue('Plan the trip')
    await settled(page)
    await ltrInView(page, `notes at ${width}px, folders ${paneWidth}px`)
    const outside = await content.evaluate((region) => {
      const { left, right } = region.getBoundingClientRect()
      return [...region.querySelectorAll<HTMLElement>('button, input, h1')]
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && (box.left < left - 1 || box.right > right + 1))
        .map(({ element }) => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40))
    })
    expect(outside).toEqual([])
    // The note keeps its minimum (360 px, ADR-0068 §7) beside the list.
    const editor = await boxOf(content.locator('section[aria-label="Note"]'))
    expect(editor.width).toBeGreaterThanOrEqual(359)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await insidePane(page, pane)
    expect(errors).toEqual([])
  })
}

test('at 1024px Notes keeps its tags as chips above the list, and draws no folder pane (#335)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  const errors = await openNotesPane(page)
  await expect(page.locator('[data-folder-pane]')).toHaveCount(0)
  await expect(page.getByRole('separator', { name: 'Resize folder pane' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Note tags' })).toHaveCount(0)
  const chips = page.getByLabel('Tags', { exact: true })
  await expect(chips.getByRole('button')).toHaveCount(4)
  await chips.getByRole('button', { name: /^#cooking/ }).click()
  await expect(chips.getByRole('button', { name: /^#cooking/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-region="folders"]').getByText('Pasta', { exact: true })).toBeVisible()
  await ltrInView(page, 'notes at 1024px')
  expect(errors).toEqual([])
})

test("Notes's tags choose, clear, and give way to a line in the Trash from the folder pane (#335)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors = await openNotesPane(page)
  const pane = page.getByRole('navigation', { name: 'Note tags', exact: true })
  const content = page.locator('main > [data-region="content"]')
  const long = pane.getByTitle('#a-tag-with-a-name-far-too-long-for-the-pane (1)')
  await expect(long).toBeVisible()
  await expect(pane.getByRole('button', { name: 'All notes', exact: true })).toHaveAttribute('aria-current', 'true')
  await pane.getByRole('button', { name: '#cooking (1)', exact: true }).click()
  await expect(pane.getByRole('button', { name: '#cooking (1)', exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(content.getByText('Pasta', { exact: true })).toBeVisible()
  await expect(content.getByText('Packing list', { exact: true })).toHaveCount(0)
  // The chosen tag again clears the filter.
  await pane.getByRole('button', { name: '#cooking (1)', exact: true }).click()
  await expect(pane.getByRole('button', { name: 'All notes', exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(content.getByText('Packing list', { exact: true })).toBeVisible()
  // Down moves to the next row and chooses it.
  await pane.getByRole('button', { name: 'All notes', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(pane.getByRole('button', { name: '#travel (2)', exact: true })).toHaveAttribute('aria-current', 'true')

  // In the Trash the tags are not offered, and the pane says so.
  await content.getByRole('button', { name: 'Trash', exact: true }).click()
  await expect(content.getByText('Old receipt', { exact: true })).toBeVisible()
  await expect(pane.getByRole('button')).toHaveCount(0)
  await expect(pane.getByText('The trash is not filtered by tag.')).toBeVisible()
  await content.getByRole('button', { name: 'Trash', exact: true }).click()
  await expect(pane.getByRole('button', { name: '#travel (2)', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('the folder pane resized in Notes is the width mail draws, and the reverse (#335)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await openNotesPane(page)
  const notes = page.getByRole('navigation', { name: 'Note tags', exact: true })
  const mail = page.getByRole('navigation', { name: 'Accounts and folders', exact: true })
  const handleIn = (pane: ReturnType<Page['locator']>) => pane.getByRole('separator', { name: 'Resize folder pane' })
  const drawn = async (pane: ReturnType<Page['locator']>) => Math.round((await boxOf(pane)).width)
  const stored = () =>
    page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}').folder_pane_width)
  const notesButton = page.getByTitle('Notes', { exact: true })
  await expect(handleIn(notes)).toHaveAttribute('aria-valuenow', '260')
  await handleIn(notes).focus()
  await page.keyboard.press('End')
  await expect(handleIn(notes)).toHaveAttribute('aria-valuenow', '400')
  expect(await drawn(notes)).toBe(400)
  await expect.poll(stored).toBe(400)
  await notesButton.click()
  await expect(handleIn(mail)).toHaveAttribute('aria-valuenow', '400')
  await handleIn(mail).focus()
  await page.keyboard.press('Home')
  await expect.poll(stored).toBe(200)
  await notesButton.click()
  await expect(handleIn(notes)).toHaveAttribute('aria-valuenow', '200')
  expect(await drawn(notes)).toBe(200)
  expect(errors).toEqual([])
})

test("in Arabic Notes's folder pane sits between the rail and the list, and its separator follows the reading (#335)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await openNotesPane(page, { language: 'ar' }, arCatalog)
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  const pane = page.getByRole('navigation', { name: arCatalog['notes.tagsPane'], exact: true })
  await expect(pane).toBeVisible()
  const railBox = await boxOf(page.locator('main > aside').first())
  const paneBox = await boxOf(pane)
  const contentBox = await boxOf(page.locator('main > [data-region="content"]'))
  expect(Math.abs(paneBox.x + paneBox.width - railBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(contentBox.x + contentBox.width - paneBox.x)).toBeLessThanOrEqual(1)
  expect(contentBox.x).toBeGreaterThanOrEqual(-1)
  await insidePane(page, pane)
  await rtlInView(page, 'notes folder pane')
  await settled(page)
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  const blocking = results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}) on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
    )
  expect(blocking).toEqual([])
  expect(errors).toEqual([])
})

// #337: the chat conversations in the common folder pane (ADR-0068 §4), at the
// one width every module shares. The open conversation stays beside it and
// keeps 360 px. At 1024 px and below the pane is not drawn, and the column
// keeps its w-72 width with its own header.
async function openChatPane(page: Page, options: SetupOptions = {}, catalog = enCatalog) {
  const errors = await prepareStartup(page, true, { navigation: true, ...options })
  await page.addInitScript(() => {
    const replies = (window as any).startupProbe.replies
    replies['chat.accounts'] = [
      { id: 'c1', jid: 'ana@chat.test', host: '', port: 5222 },
      // Long enough to push the account row past a 200 px pane, were it free to.
      { id: 'c2', jid: 'ana.with-a-longer-name@work.example.test', host: '', port: 5222 },
    ]
    replies['chat.status'] = { c1: { account: 'c1', state: 'online' }, c2: { account: 'c2', state: 'offline' } }
    replies['chat.conversations'] = [
      { conversation: 'pau@chat.test', last_body: 'Hello', last_stamp: 1760000120, last_direction: 'in', unread: 1 },
      { conversation: 'a-contact-with-a-very-long-address-for-the-pane@chat.test', last_body: 'A long preview of the last message', last_stamp: 1760000100, last_direction: 'in', unread: 0 },
    ]
    replies['chat.rooms'] = [
      { account: 'c1', room: 'team@rooms.chat.test', nick: 'ana', has_password: false, last_body: 'Hi team', last_stamp: 1760000200, unread: 0, state: 'joined', detail: null },
    ]
    replies['chat.invitations'] = [
      { account: 'c1', room: 'club@rooms.chat.test', inviter: 'marta@chat.test', reason: 'Join the club', has_password: false, received_at: 1 },
    ]
    replies['chat.history'] = [
      { account: 'c1', conversation: 'pau@chat.test', id: 'm1', stanza_id: 'a1', direction: 'in', sender: 'pau@chat.test', body: 'Hello Ana', stamp: 1760000000, state: 'received' },
    ]
    replies['chat.markRead'] = { ok: true }
    replies['chat.presence'] = { own: { show: 'available', status: '' }, contacts: {}, requests: [] }
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  await page.getByTitle(catalog['messaging.title'], { exact: true }).click()
  await expect(page.getByRole('main', { name: catalog['messaging.title'], exact: true })).toBeVisible()
  return errors
}

for (const [width, paneWidth] of [
  [1025, 200],
  [1025, 260],
  [1025, 400],
  [1100, 200],
  [1100, 260],
  [1440, 200],
  [1440, 260],
] as const) {
  test(`Chat's folder pane leaves the conversation whole at ${width}px, ${paneWidth}px wide (#337)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors = await openChatPane(page, { preferences: { folder_pane_width: paneWidth } })
    const pane = page.getByRole('navigation', { name: 'Conversations', exact: true })
    const content = page.locator('main > [data-region="content"]')
    await expect(pane).toHaveAttribute('data-region', 'folders')
    await expect(pane.getByRole('heading', { level: 2, name: 'Conversations' })).toBeVisible()
    await expect(pane.getByRole('combobox', { name: 'Chat account' })).toBeVisible()
    await expect(pane.getByRole('list', { name: 'Invitations' })).toBeVisible()
    await expect(pane.getByRole('list', { name: 'Groups' })).toBeVisible()
    await expect(pane.getByRole('button', { name: 'Remove this chat account' })).toBeVisible()
    // Right after the rail, at the shared width, and the conversation right after it.
    const rail = await boxOf(page.locator('main > aside').first())
    const paneBox = await boxOf(pane)
    expect(Math.abs(paneBox.x - (rail.x + rail.width))).toBeLessThanOrEqual(1)
    expect(Math.abs(paneBox.width - Math.min(paneWidth, width - 60 - 360))).toBeLessThanOrEqual(1)
    const contentBox = await boxOf(content)
    expect(Math.abs(contentBox.x - (paneBox.x + paneBox.width))).toBeLessThanOrEqual(1)
    expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(width + 1)
    expect(contentBox.width).toBeGreaterThanOrEqual(359)
    // The column is gone from the module, and the pane is the only region.
    await expect(page.locator('[data-region="folders"]')).toHaveCount(1)
    await expect(content.locator('[data-region="folders"]')).toHaveCount(0)

    await pane.getByRole('button', { name: /pau@chat.test/ }).click()
    await expect(content.getByText('Hello Ana', { exact: true })).toBeVisible()
    await settled(page)
    await ltrInView(page, `chat at ${width}px, folders ${paneWidth}px`)
    const outside = await content.evaluate((region) => {
      const { left, right } = region.getBoundingClientRect()
      return [...region.querySelectorAll<HTMLElement>('button, textarea, input')]
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && (box.left < left - 1 || box.right > right + 1))
        .map(({ element }) => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40))
    })
    expect(outside).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await insidePane(page, pane)
    // Nothing in the pane's body scrolls sideways: the account selector gives
    // way and the connection status stays whole inside the pane.
    const body = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-folder-pane] > div:nth-child(2)')!
      return { scroll: scroller.scrollWidth, client: scroller.clientWidth }
    })
    expect(body.scroll).toBeLessThanOrEqual(body.client + 1)
    const drawn = await boxOf(pane)
    for (const control of [pane.getByRole('combobox', { name: 'Chat account' }), pane.getByRole('status').first()]) {
      const box = await boxOf(control)
      expect(box.x).toBeGreaterThanOrEqual(drawn.x - 1)
      expect(box.x + box.width).toBeLessThanOrEqual(drawn.x + drawn.width + 1)
    }
    expect(errors).toEqual([])
  })
}

test('at 1024px Chat keeps its w-72 column with its header, and draws no folder pane (#337)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  const errors = await openChatPane(page)
  await expect(page.locator('[data-folder-pane]')).toHaveCount(0)
  await expect(page.getByRole('separator', { name: 'Resize folder pane' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toHaveCount(0)
  const column = page.locator('main [data-region="folders"]')
  await expect(column).toHaveCount(1)
  await expect(column.getByRole('combobox', { name: 'Chat account' })).toBeVisible()
  await expect(column.getByRole('button', { name: /pau@chat.test/ })).toBeVisible()
  expect(Math.round((await boxOf(column)).width)).toBe(288)
  // The long address gives way in the 18 rem column too: its header holds the
  // selector and the status inside it.
  const drawn = await boxOf(column)
  for (const control of [column.getByRole('combobox', { name: 'Chat account' }), column.getByRole('status').first()]) {
    const box = await boxOf(control)
    expect(box.x).toBeGreaterThanOrEqual(drawn.x - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(drawn.x + drawn.width + 1)
  }
  await ltrInView(page, 'chat at 1024px')
  expect(errors).toEqual([])
})

test('the folder pane resized in Chat is the width mail draws, and the reverse (#337)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await openChatPane(page)
  const chat = page.getByRole('navigation', { name: 'Conversations', exact: true })
  const mail = page.getByRole('navigation', { name: 'Accounts and folders', exact: true })
  const handleIn = (pane: ReturnType<Page['locator']>) => pane.getByRole('separator', { name: 'Resize folder pane' })
  const drawn = async (pane: ReturnType<Page['locator']>) => Math.round((await boxOf(pane)).width)
  const stored = () =>
    page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}').folder_pane_width)
  const chatButton = page.getByTitle('Chat', { exact: true })
  await expect(handleIn(chat)).toHaveAttribute('aria-valuenow', '260')
  await handleIn(chat).focus()
  await page.keyboard.press('End')
  await expect(handleIn(chat)).toHaveAttribute('aria-valuenow', '400')
  expect(await drawn(chat)).toBe(400)
  await expect.poll(stored).toBe(400)
  await chatButton.click()
  await expect(handleIn(mail)).toHaveAttribute('aria-valuenow', '400')
  await handleIn(mail).focus()
  await page.keyboard.press('Home')
  await expect.poll(stored).toBe(200)
  await chatButton.click()
  await expect(handleIn(chat)).toHaveAttribute('aria-valuenow', '200')
  expect(await drawn(chat)).toBe(200)
  expect(errors).toEqual([])
})

test("in Arabic Chat's folder pane sits between the rail and the conversation, and its separator follows the reading (#337)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await openChatPane(page, { language: 'ar' }, arCatalog)
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  const pane = page.getByRole('navigation', { name: arCatalog['messaging.conversations'], exact: true })
  await expect(pane).toBeVisible()
  const railBox = await boxOf(page.locator('main > aside').first())
  const paneBox = await boxOf(pane)
  const contentBox = await boxOf(page.locator('main > [data-region="content"]'))
  expect(Math.abs(paneBox.x + paneBox.width - railBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(contentBox.x + contentBox.width - paneBox.x)).toBeLessThanOrEqual(1)
  expect(contentBox.x).toBeGreaterThanOrEqual(-1)
  await pane.getByRole('button', { name: /pau@chat.test/ }).click()
  await expect(page.getByText('Hello Ana')).toBeVisible()
  await insidePane(page, pane)
  await rtlInView(page, 'chat folder pane')
  await settled(page)
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  const blocking = results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}) on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
    )
  expect(blocking).toEqual([])
  expect(errors).toEqual([])
})

// #339: the attachment filters in the common folder pane (ADR-0068 §4), at the
// one width every module shares. The list stays beside it and keeps 360 px.
// At 1024 px and below the pane is not drawn, and the filter bar stays under
// the header.
async function openAttachmentsPane(page: Page, options: SetupOptions = {}, catalog = enCatalog) {
  const errors = await prepareStartup(page, true, {
    navigation: true,
    // Long enough to push the account filter past a 200 px pane, were it free to.
    existingEmail: 'an-account-with-a-very-long-address-for-the-pane@example.test',
    ...options,
  })
  await page.addInitScript(() => {
    ;(window as any).startupProbe.replies['attachments.list'] = {
      items: [
        {
          account: 'synthetic-account', folder: 'INBOX', uid: 2, thread_key: 'k', thread_id: 'synthetic-account#INBOX#2',
          subject: 'Quarterly numbers', from_name: 'Synthetic Sender', from_addr: 'sender@example.test', date: 1760000000,
          index: 0, filename: 'report.pdf', mime: 'application/pdf', size: 90000, key: null, kind: 'pdf', unavailable: '',
        },
      ],
      total: 1,
      coverage: { messages: 10, downloaded: 7 },
    }
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  await page.getByTitle(catalog['attachmentsView.title'], { exact: true }).click()
  await expect(page.getByRole('main', { name: catalog['attachmentsView.title'], exact: true })).toBeVisible()
  await expect(page.getByText('report.pdf')).toBeVisible()
  return errors
}

for (const [width, paneWidth] of [
  [1025, 200],
  [1025, 260],
  [1025, 400],
  [1100, 200],
  [1100, 260],
  [1440, 200],
  [1440, 260],
] as const) {
  test(`Attachments's folder pane leaves the list whole at ${width}px, ${paneWidth}px wide (#339)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors = await openAttachmentsPane(page, { preferences: { folder_pane_width: paneWidth } })
    const pane = page.getByRole('navigation', { name: 'Attachment filters', exact: true })
    const content = page.locator('main > [data-region="content"]')
    await expect(pane).toHaveAttribute('data-region', 'folders')
    await expect(pane.getByRole('heading', { level: 2, name: 'Attachment filters' })).toBeVisible()
    // The file name is searched from the top band (#344); the other four
    // filters are the pane's.
    const controls = [
      pane.getByRole('textbox', { name: 'From' }),
      pane.getByRole('combobox', { name: 'Type' }),
      pane.getByRole('combobox', { name: 'When' }),
      pane.getByRole('combobox', { name: 'Account' }),
    ]
    for (const control of controls) await expect(control).toBeVisible()
    for (const label of ['From', 'Type', 'When', 'Account'])
      await expect(pane.locator('label', { hasText: new RegExp(`^${label}$`) })).toBeVisible()
    await expect(pane.getByRole('textbox')).toHaveCount(1)
    await expect(page.getByRole('search').getByRole('textbox', { name: 'Search attachments by file name' })).toBeVisible()
    // Right after the rail, at the shared width, and the list right after it.
    const rail = await boxOf(page.locator('main > aside').first())
    const paneBox = await boxOf(pane)
    expect(Math.abs(paneBox.x - (rail.x + rail.width))).toBeLessThanOrEqual(1)
    expect(Math.abs(paneBox.width - Math.min(paneWidth, width - 60 - 360))).toBeLessThanOrEqual(1)
    const contentBox = await boxOf(content)
    expect(Math.abs(contentBox.x - (paneBox.x + paneBox.width))).toBeLessThanOrEqual(1)
    expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(width + 1)
    expect(contentBox.width).toBeGreaterThanOrEqual(359)
    // The bar is gone from the module, and the pane is the only region.
    await expect(page.locator('[data-region="folders"]')).toHaveCount(1)
    await expect(content.locator('[data-region="folders"]')).toHaveCount(0)
    await expect(content.getByLabel('From')).toHaveCount(0)
    await settled(page)
    await ltrInView(page, `attachments at ${width}px, folders ${paneWidth}px`)
    const outside = await content.evaluate((region) => {
      const { left, right } = region.getBoundingClientRect()
      return [...region.querySelectorAll<HTMLElement>('button, input, select')]
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && (box.left < left - 1 || box.right > right + 1))
        .map(({ element }) => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40))
    })
    expect(outside).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    // Nothing in the pane's body scrolls sideways, and every control lies
    // inside the pane: the long account address gives way.
    const body = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-folder-pane] > div:nth-child(2)')!
      return { scroll: scroller.scrollWidth, client: scroller.clientWidth }
    })
    expect(body.scroll).toBeLessThanOrEqual(body.client + 1)
    const drawn = await boxOf(pane)
    for (const control of controls) {
      const box = await boxOf(control)
      expect(box.x).toBeGreaterThanOrEqual(drawn.x - 1)
      expect(box.x + box.width).toBeLessThanOrEqual(drawn.x + drawn.width + 1)
    }
    expect(errors).toEqual([])
  })
}

test('at 1024px Attachments keeps its filter bar under the header, and draws no folder pane (#339)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  const errors = await openAttachmentsPane(page)
  await expect(page.locator('[data-folder-pane]')).toHaveCount(0)
  await expect(page.getByRole('separator', { name: 'Resize folder pane' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Attachment filters' })).toHaveCount(0)
  await expect(page.locator('[data-region="folders"]')).toHaveCount(0)
  const content = page.locator('main > [data-region="content"]')
  // The file name is the top band's (#344); the bar keeps the other four.
  await expect(page.getByRole('search').getByRole('textbox', { name: 'Search attachments by file name' })).toBeVisible()
  await expect(content.getByRole('textbox')).toHaveCount(1)
  await expect(content.getByRole('textbox', { name: 'From' })).toBeVisible()
  await expect(content.getByRole('combobox', { name: 'Type' })).toBeVisible()
  await expect(content.getByRole('combobox', { name: 'When' })).toBeVisible()
  await expect(content.getByRole('combobox', { name: 'Account' })).toBeVisible()
  // No visible labels: the bar names its controls with aria-label only.
  await expect(content.locator('label')).toHaveCount(0)
  // The bar sits under the header and over the list, and it holds its controls.
  const bar = await boxOf(content.getByRole('textbox', { name: 'From' }).locator('..'))
  const header = await boxOf(content.locator('header'))
  expect(bar.y).toBeGreaterThanOrEqual(header.y + header.height - 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await ltrInView(page, 'attachments at 1024px')
  expect(errors).toEqual([])
})

test('Attachments filters from the pane and keeps the values and the list across 1025px (#339)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors = await openAttachmentsPane(page)
  const pane = page.getByRole('navigation', { name: 'Attachment filters', exact: true })
  const asked = () =>
    page.evaluate(() =>
      (window as any).startupProbe.requests
        .filter((item: any) => item.command === 'attachments.list')
        .map((item: any) => item.payload),
    )
  // The file name from the top band (#344), the rest from the pane.
  const name = page.getByRole('search').getByRole('textbox', { name: 'Search attachments by file name' })
  await pane.getByRole('combobox', { name: 'Type' }).selectOption('pdf')
  await name.fill('report')
  await pane.getByRole('textbox', { name: 'From' }).fill('sender')
  await expect.poll(async () => (await asked()).at(-1)).toMatchObject({ kind: 'pdf', name: 'report', sender: 'sender' })
  await pane.getByRole('combobox', { name: 'Account' }).selectOption('second-account')
  await expect.poll(async () => (await asked()).at(-1)).toMatchObject({ account: 'second-account', kind: 'pdf' })
  // Mark the list's row: a rebuilt list would lose the mark.
  await page.getByText('report.pdf').evaluate((element) => ((element as any).keptAcross = true))
  const requests = (await asked()).length

  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(page.locator('[data-folder-pane]')).toHaveCount(0)
  const content = page.locator('main > [data-region="content"]')
  await expect(content.getByRole('combobox', { name: 'Type' })).toHaveValue('pdf')
  await expect(name).toHaveValue('report')
  await expect(content.getByRole('textbox', { name: 'From' })).toHaveValue('sender')
  await expect(content.getByRole('combobox', { name: 'Account' })).toHaveValue('second-account')
  expect(await page.getByText('report.pdf').evaluate((element) => (element as any).keptAcross)).toBe(true)

  await page.setViewportSize({ width: 1025, height: 900 })
  await expect(pane.getByRole('combobox', { name: 'Type' })).toHaveValue('pdf')
  await expect(name).toHaveValue('report')
  await expect(pane.getByRole('textbox', { name: 'From' })).toHaveValue('sender')
  await expect(pane.getByRole('combobox', { name: 'Account' })).toHaveValue('second-account')
  expect(await page.getByText('report.pdf').evaluate((element) => (element as any).keptAcross)).toBe(true)
  // Crossing the width asked the core for nothing.
  await settled(page)
  expect((await asked()).length).toBe(requests)
  expect(errors).toEqual([])
})

test('the folder pane resized in Attachments is the width mail draws, and the reverse (#339)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await openAttachmentsPane(page)
  const attachments = page.getByRole('navigation', { name: 'Attachment filters', exact: true })
  const mail = page.getByRole('navigation', { name: 'Accounts and folders', exact: true })
  const handleIn = (pane: ReturnType<Page['locator']>) => pane.getByRole('separator', { name: 'Resize folder pane' })
  const drawn = async (pane: ReturnType<Page['locator']>) => Math.round((await boxOf(pane)).width)
  const stored = () =>
    page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-prefs') ?? '{}').folder_pane_width)
  const attachmentsButton = page.getByTitle('Attachments', { exact: true })
  await expect(handleIn(attachments)).toHaveAttribute('aria-valuenow', '260')
  await handleIn(attachments).focus()
  await page.keyboard.press('End')
  await expect(handleIn(attachments)).toHaveAttribute('aria-valuenow', '400')
  expect(await drawn(attachments)).toBe(400)
  await expect.poll(stored).toBe(400)
  await attachmentsButton.click()
  await expect(handleIn(mail)).toHaveAttribute('aria-valuenow', '400')
  await handleIn(mail).focus()
  await page.keyboard.press('Home')
  await expect.poll(stored).toBe(200)
  await attachmentsButton.click()
  await expect(handleIn(attachments)).toHaveAttribute('aria-valuenow', '200')
  expect(await drawn(attachments)).toBe(200)
  expect(errors).toEqual([])
})

test("in Arabic Attachments's folder pane sits between the rail and the list, and its separator follows the reading (#339)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await openAttachmentsPane(page, { language: 'ar' }, arCatalog)
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  const pane = page.getByRole('navigation', { name: arCatalog['attachmentsView.filters'], exact: true })
  await expect(pane).toBeVisible()
  const railBox = await boxOf(page.locator('main > aside').first())
  const paneBox = await boxOf(pane)
  const contentBox = await boxOf(page.locator('main > [data-region="content"]'))
  expect(Math.abs(paneBox.x + paneBox.width - railBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(contentBox.x + contentBox.width - paneBox.x)).toBeLessThanOrEqual(1)
  expect(contentBox.x).toBeGreaterThanOrEqual(-1)
  await expect(pane.getByRole('textbox', { name: arCatalog['attachmentsView.sender'], exact: true })).toBeVisible()
  // The file name is searched from the top band (#344).
  await expect(
    page.getByRole('search').getByRole('textbox', { name: arCatalog['attachmentsView.search'], exact: true }),
  ).toBeVisible()
  await rtlInView(page, 'attachments folder pane')
  await settled(page)
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  const blocking = results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}) on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
    )
  expect(blocking).toEqual([])
  expect(errors).toEqual([])
})

// #341: crossing 1025 px swaps the pane's controls for their narrow twins (or
// the reverse), and the focus goes with the control instead of falling to <body>.
// The file name is searched from the top band since #344, so the text field
// that crosses is the sender's.
test('focus in the Attachments "From" field follows it across 1025px, both ways (#341)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors = await openAttachmentsPane(page)
  const pane = page.getByRole('navigation', { name: 'Attachment filters', exact: true })
  const content = page.locator('main > [data-region="content"]')
  await pane.getByRole('textbox', { name: 'From' }).fill('sender')
  await expect(pane.getByRole('textbox', { name: 'From' })).toBeFocused()

  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(page.locator('[data-folder-pane]')).toHaveCount(0)
  await expect(content.getByRole('textbox', { name: 'From' })).toBeFocused()
  await expect(content.getByRole('textbox', { name: 'From' })).toHaveValue('sender')

  await page.setViewportSize({ width: 1025, height: 900 })
  await expect(pane.getByRole('textbox', { name: 'From' })).toBeFocused()
  // What was typed goes on from where the focus is.
  await page.keyboard.type('s')
  await expect(pane.getByRole('textbox', { name: 'From' })).toHaveValue('senders')

  // Focus that was not in the filters stays where it was: the same element,
  // once the narrow layout is drawn.
  await content.getByRole('button').first().focus()
  await page.evaluate(() => {
    ;(window as any).keptFocus = document.activeElement
  })
  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(page.locator('[data-folder-pane]')).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement === (window as any).keptFocus)).toBe(true)
  expect(errors).toEqual([])
})

test('focus on a Tasks list row follows it to the list tab across 1025px, both ways (#341)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors = await openTasksPane(page)
  const pane = page.getByRole('navigation', { name: 'Task lists', exact: true })
  await pane.getByRole('button', { name: 'Home (2)', exact: true }).click()
  await expect(pane.getByRole('button', { name: 'Home (2)', exact: true })).toBeFocused()

  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(page.locator('[data-folder-pane]')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: /^Home/ })).toBeFocused()
  await expect(page.getByRole('tab', { name: /^Home/ })).toHaveAttribute('aria-selected', 'true')

  await page.setViewportSize({ width: 1025, height: 900 })
  await expect(pane.getByRole('button', { name: 'Home (2)', exact: true })).toBeFocused()
  expect(errors).toEqual([])
})

// #344: the search in the top band, scoped to the module on screen (ADR-0068
// §2, piece 13b). The band's centre holds the `search` landmark; each module's
// own field is gone, and the band's reads and writes that module's state.
// Calendar and Chat show it disabled with the reason (owner decision 3 on
// #342). Below 769 px a button in the band opens it over the band.
async function bandSearch(page: Page, catalog: Record<string, string> = enCatalog) {
  const band = page
    .getByRole('banner', { name: catalog['shell.region.banner'], exact: true })
    .locator('[data-top-band]')
  const search = band.getByRole('search', { name: catalog['shell.region.search'], exact: true })
  return { band, search, field: search.getByRole('textbox') }
}

const lastRequest = (page: Page, command: string) =>
  page.evaluate(
    (name) =>
      (window as any).startupProbe.requests.filter((request: any) => request.command === name).at(-1)?.payload,
    command,
  )

// Opens a module from its rail button, which goes back to mail when the module
// is already open: call it for another module than the one on screen.
async function openModule(page: Page, title: string) {
  await page.getByTitle(title, { exact: true }).click()
  await expect(page.getByRole('main', { name: title, exact: true })).toBeVisible()
}

test('mail is searched from the band: the query, Escape, the builder and the saved searches (#344)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.addInitScript(() => {
    const replies = (window as any).startupProbe.replies
    replies['search.parse'] = {
      query: { text: 'budget', from: [], to: [], subject: [], flags: [], label: null, after: null, before: null },
    }
    replies['search.compose'] = { text: 'budget is:unread' }
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { band, search, field } = await bandSearch(page)
  // In the band's centre, after the app menu: one field, named after mail.
  await expect(band.locator('[data-band-centre]').getByRole('search')).toHaveCount(1)
  await expect(search).toHaveAttribute('data-search-scope', 'mail')
  await expect(field).toHaveAccessibleName('Search messages...')
  await expect(field).toHaveAttribute('placeholder', 'Search messages...')
  await expect(field).toHaveAttribute('title', enCatalog['search.operatorsHint'])
  // The thread list has no field of its own any more: one place to type.
  await expect(page.locator('[data-thread-list]').getByRole('textbox')).toHaveCount(0)
  await expect(page.locator('main').getByRole('textbox')).toHaveCount(0)

  await field.fill('budget')
  await expect
    .poll(() => lastRequest(page, 'mail.threadList'))
    .toMatchObject({ account_id: 'synthetic-account', folder_id: 'INBOX', query: 'budget' })
  // Escape clears it and leaves it, as the thread list's did.
  await field.press('Escape')
  await expect(field).toHaveValue('')
  await expect(field).not.toBeFocused()
  await expect.poll(() => lastRequest(page, 'mail.threadList')).toMatchObject({ query: '' })

  // The builder, from a button at the end of the field.
  await field.fill('budget')
  const builder = search.getByRole('button', { name: 'Search options', exact: true })
  const fieldBox = await boxOf(field)
  expect((await boxOf(builder)).x).toBeGreaterThanOrEqual(fieldBox.x + fieldBox.width - 1)
  await builder.click()
  const dialog = page.getByRole('dialog', { name: 'Search options' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Words')).toHaveValue('budget')
  await dialog.getByLabel('Read or unread').selectOption('unread')
  await dialog.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(builder).toBeFocused()
  await expect(field).toHaveValue('budget is:unread')
  await expect.poll(() => lastRequest(page, 'mail.threadList')).toMatchObject({ query: 'budget is:unread' })

  // Saved, and opened again from the band.
  await search.getByRole('button', { name: 'Save this search', exact: true }).click()
  await field.fill('')
  await search.getByRole('button', { name: 'Saved searches', exact: true }).click()
  await page.getByRole('menuitem', { name: /budget is:unread/ }).first().click()
  await expect(field).toHaveValue('budget is:unread')
  await expect.poll(() => lastRequest(page, 'mail.threadList')).toMatchObject({ query: 'budget is:unread' })
  expect(errors).toEqual([])
})

test('a board open in mail is searched from the band, and a column scopes it from its menu (#344)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { search, field } = await bandSearch(page)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  // The first board, which every profile has.
  await page.keyboard.press(`${mod}+Shift+V`)
  const boardTitle = page.locator('main').getByRole('heading', { level: 2, name: 'Kanban board', exact: true })
  await expect(boardTitle).toBeVisible()
  await expect(search).toHaveAttribute('data-search-scope', 'board')
  await expect(field).toHaveAccessibleName('Search board...')
  // The board's header has neither a field nor a search button of its own.
  await expect(page.locator('main').getByRole('textbox')).toHaveCount(0)
  await expect(page.locator('main').getByRole('button', { name: 'Search board', exact: true })).toHaveCount(0)
  await field.fill('pilot')
  await expect.poll(() => lastRequest(page, 'mail.threadList')).toMatchObject({ query: 'pilot' })
  // The scope, at the end of the field: every column, to start with.
  const scope = search.getByTitle('Search scope', { exact: true })
  await scope.click()
  const choices = page.getByRole('menuitemradio')
  await expect(choices.first()).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  // A column's «Search» scopes the board to it and focuses the band.
  await page.locator('main').getByRole('button', { name: 'Thread actions', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Search', exact: true }).click()
  await expect(field).toBeFocused()
  await scope.click()
  await expect(choices.first()).toHaveAttribute('aria-checked', 'false')
  await expect(choices.nth(1)).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  // Escape in the field clears it, then leaves it, as the board's did.
  await field.focus()
  await page.keyboard.press('Escape')
  await expect(field).toHaveValue('')
  await expect(field).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(field).not.toBeFocused()
  // Back to mail: mail's own search, untouched.
  await page.keyboard.press(`${mod}+Shift+V`)
  await expect(boardTitle).toHaveCount(0)
  await expect(search).toHaveAttribute('data-search-scope', 'mail')
  await expect(field).toHaveValue('')
  expect(errors).toEqual([])
})

test('Notes, People, Tasks and Attachments are searched from the band, each with its own query (#344)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.addInitScript(() => {
    const replies = (window as any).startupProbe.replies
    const task = (id: number, title: string) => ({
      id, thread_id: '', account_id: '', folder_id: '', note: '', due_at: null, completed_at: null, created_at: 0,
      subject: '', from_name: '', from_addr: '', linked: false, list_id: 'mail', title, priority: 1,
      reminder_at: null, revision: 1,
    })
    replies['tasks.lists'] = { lists: [{ id: 'mail', name: '', position: 0, open: 2 }] }
    replies['tasks.list'] = { tasks: [task(1, 'Renew the contract'), task(2, 'Fix the tap')] }
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { search, field } = await bandSearch(page)
  const main = page.getByRole('main')

  await openModule(page, 'Notes')
  await expect(search).toHaveAttribute('data-search-scope', 'notes')
  await expect(field).toHaveAccessibleName('Search notes')
  await expect(main.getByRole('textbox', { name: 'Search notes' })).toHaveCount(0)
  await field.fill('pasta')
  await expect.poll(() => lastRequest(page, 'notes.list')).toMatchObject({ search: 'pasta' })
  await expect(main.getByText('No notes match')).toBeVisible()

  await openModule(page, 'People')
  await expect(field).toHaveAccessibleName('Search people')
  await expect(field).toHaveValue('')
  await expect(main.getByRole('textbox', { name: 'Search people' })).toHaveCount(0)
  await field.fill('ada')
  await expect.poll(() => lastRequest(page, 'people.list')).toMatchObject({ query: 'ada' })
  await expect(main.getByText('Nobody by that name')).toBeVisible()

  await openModule(page, 'Tasks')
  await expect(field).toHaveAccessibleName('Search tasks')
  await expect(main.getByText('Fix the tap')).toBeVisible()
  await expect(main.getByRole('textbox', { name: 'Search tasks' })).toHaveCount(0)
  await field.fill('renew')
  await expect(main.getByText('Fix the tap')).toHaveCount(0)
  await expect(main.getByText('Renew the contract')).toBeVisible()

  await openModule(page, 'Attachments')
  await expect(field).toHaveAccessibleName('Search attachments by file name')
  await field.fill('report')
  await expect.poll(() => lastRequest(page, 'attachments.list')).toMatchObject({ name: 'report' })

  // Each module kept its own query, and the field shows it again.
  for (const [title, query] of [
    ['Notes', 'pasta'],
    ['People', 'ada'],
    ['Tasks', 'renew'],
    ['Attachments', 'report'],
  ]) {
    await openModule(page, title)
    await expect(field, title).toHaveValue(query)
  }
  // Mail's was never touched.
  const { button, menu } = await appMenuParts(page)
  await button.click()
  await menu.getByRole('menuitemradio', { name: 'Go to: Mail', exact: true }).click()
  await expect(search).toHaveAttribute('data-search-scope', 'mail')
  await expect(field).toHaveValue('')
  expect(errors).toEqual([])
})

test('in Attachments the band field keeps its focus and its text across 1025px, where the filters move (#344)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors = await openAttachmentsPane(page)
  const { field } = await bandSearch(page)
  await field.fill('report')
  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(page.locator('[data-folder-pane]')).toHaveCount(0)
  await expect(field).toBeFocused()
  await page.keyboard.type('s')
  await expect(field).toHaveValue('reports')
  await expect.poll(() => lastRequest(page, 'attachments.list')).toMatchObject({ name: 'reports' })
  expect(errors).toEqual([])
})

test('Calendar and Chat show the band field disabled, with the reason, and axe accepts it (#344)', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.addInitScript(() => {
    ;(window as any).startupProbe.replies['calendar.events'] = { events: [] }
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { search, field } = await bandSearch(page)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  for (const [title, scope, reason] of [
    ['Calendar', 'calendar', 'Calendar has no search yet'],
    ['Chat', 'chat', 'Chat has no search yet'],
  ]) {
    await openModule(page, title)
    await expect(search, title).toHaveAttribute('data-search-scope', scope)
    // Disabled, and it says why: what it shows, its tooltip and its description.
    await expect(field, title).toBeDisabled()
    await expect(field, title).toHaveAttribute('placeholder', reason)
    await expect(field, title).toHaveAttribute('title', reason)
    await expect(field, title).toHaveAccessibleName('Search')
    await expect(field, title).toHaveAccessibleDescription(reason)
    // Nothing there that would do nothing.
    await expect(search.getByRole('button'), title).toHaveCount(0)
    // The shortcut has nothing to focus.
    await page.keyboard.press(`${mod}+Shift+F`)
    await expect(field, title).not.toBeFocused()
    await settled(page)
    const inBand = await new AxeBuilder({ page }).include('[data-top-band]').withTags(AXE_TAGS).analyze()
    const whole = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
    const regions = await new AxeBuilder({ page }).withRules(REGION_RULES).analyze()
    await info.attach(`axe-band-search-${scope}`, {
      body: JSON.stringify({ band: inBand.violations, page: whole.violations, regions: regions.violations }, null, 2),
      contentType: 'application/json',
    })
    expect(inBand.violations.map((violation) => `${violation.id}: ${violation.help}`), title).toEqual([])
    expect(
      whole.violations
        .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
        .map((violation) => `${violation.id} on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`),
      title,
    ).toEqual([])
    expect(regions.violations.map((violation) => violation.id), title).toEqual([])
  }
  await info.attach('band-search-chat', {
    body: await page.screenshot({ path: info.outputPath('band-search-chat.png'), animations: 'disabled' }),
    contentType: 'image/png',
  })
  expect(errors).toEqual([])
})

test('Ctrl/⌘+Shift+F and Ctrl/⌘+F reach the band field, and Ctrl/⌘+F still searches an open conversation (#344)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { field } = await bandSearch(page)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const row = page.getByRole('table').getByRole('button', { name: /Pilot checklist/ })
  // The conversation's own search (its wide and narrow fields: the one drawn).
  const conversationSearch = page.getByPlaceholder('Search thread', { exact: true }).filter({ visible: true })

  // From the list, with no conversation open: the band's field, selected.
  await row.focus()
  await page.keyboard.press(`${mod}+Shift+F`)
  await expect(field).toBeFocused()
  expect(await regionAtFocus(page)).toBe('search')
  await page.keyboard.type('pilot')
  await row.focus()
  await page.keyboard.press(`${mod}+Shift+F`)
  await expect(field).toBeFocused()
  expect(await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 5])
  await page.keyboard.press('Escape')
  await expect(field).toHaveValue('')
  await row.focus()
  await page.keyboard.press(`${mod}+KeyF`)
  await expect(field).toBeFocused()
  await expect(conversationSearch).toHaveCount(0)

  // A conversation on screen: Ctrl/⌘+F searches it, as before.
  await row.click()
  await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
  await page.keyboard.press(`${mod}+KeyF`)
  await expect(conversationSearch).toBeFocused()
  await expect(field).not.toBeFocused()
  await page.keyboard.press('Escape')
  await expect(conversationSearch).toHaveCount(0)

  // In another module mail's conversation is not on screen: the band's
  // field, scoped to that module.
  await openModule(page, 'Notes')
  await page.getByTitle('Notes', { exact: true }).focus()
  await page.keyboard.press(`${mod}+KeyF`)
  await expect(field).toBeFocused()
  await expect(field).toHaveAccessibleName('Search notes')
  await page.getByTitle('Notes', { exact: true }).focus()
  await page.keyboard.press(`${mod}+Shift+F`)
  await expect(field).toBeFocused()
  expect(errors).toEqual([])
})

test('/ focuses the band field in the scheme that binds it, and types nothing (#344)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, {
    navigation: true,
    preferences: { shortcut_overrides: { 'search.global': { key: '/' } } },
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { field } = await bandSearch(page)
  await page.getByRole('table').getByRole('button', { name: /Pilot checklist/ }).focus()
  await page.keyboard.press('/')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('')
  // In the field, it is a slash.
  await page.keyboard.type('a/b')
  await expect(field).toHaveValue('a/b')
  expect(errors).toEqual([])
})

test('below 769px a band button opens the search over the band; Escape closes it and gives the focus back (#344)', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 768, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { band, search, field } = await bandSearch(page)
  const { button: menuButton } = await appMenuParts(page)
  const button = band.getByRole('button', { name: 'Search messages...', exact: true })
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  // The menu at the band's start, the search button after it, both inside.
  await expect(search).toHaveCount(0)
  await expect(button).toBeVisible()
  const bandBox = await boxOf(band)
  const buttonBox = await boxOf(button)
  expect((await boxOf(menuButton)).x).toBeLessThan(16)
  expect(buttonBox.x).toBeGreaterThan((await boxOf(menuButton)).x)
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(768)

  await button.click()
  await expect(search).toBeVisible()
  await expect(field).toBeFocused()
  // Over the whole band, and what it covers takes no focus.
  const overlay = await boxOf(search)
  expect(Math.round(overlay.x)).toBe(Math.round(bandBox.x))
  expect(Math.round(overlay.width)).toBe(Math.round(bandBox.width))
  expect(overlay.height).toBeLessThanOrEqual(bandBox.height)
  await expect(band.locator('[data-band-start]')).toHaveAttribute('inert', '')
  await page.keyboard.press('Shift+Tab')
  await expect(menuButton).not.toBeFocused()
  await field.focus()
  await field.fill('budget')
  await expect.poll(() => lastRequest(page, 'mail.threadList')).toMatchObject({ query: 'budget' })
  await ltrInView(page, 'band search open at 768px')
  await settled(page)
  const whole = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  const regions = await new AxeBuilder({ page }).withRules(REGION_RULES).analyze()
  expect(
    whole.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map((violation) => `${violation.id} on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`),
  ).toEqual([])
  expect(regions.violations.map((violation) => violation.id)).toEqual([])
  await info.attach('band-search-768', {
    body: await page.screenshot({ path: info.outputPath('band-search-768.png'), animations: 'disabled' }),
    contentType: 'image/png',
  })

  // Escape closes it and gives the focus back to the button; the query stays.
  await page.keyboard.press('Escape')
  await expect(search).toHaveCount(0)
  await expect(button).toBeFocused()
  await expect(band.locator('[data-band-start]')).not.toHaveAttribute('inert', '')
  await expect.poll(() => lastRequest(page, 'mail.threadList')).toMatchObject({ query: 'budget' })
  await page.keyboard.press('Enter')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('budget')
  // Its close button does the same.
  await search.getByRole('button', { name: 'Close search', exact: true }).click()
  await expect(search).toHaveCount(0)
  await expect(button).toBeFocused()
  // Ctrl/⌘+Shift+F opens it too.
  await page.getByRole('table').getByRole('button', { name: /Pilot checklist/ }).focus()
  await page.keyboard.press(`${mod}+Shift+F`)
  await expect(field).toBeFocused()
  // F6 goes on from it, and Shift+F6 comes back to it.
  await page.keyboard.press('F6')
  expect(await regionAtFocus(page)).toBe('content')
  await page.keyboard.press('Shift+F6')
  await expect(field).toBeFocused()
  expect(errors).toEqual([])
})

test('below 769px the field over the band closes when the palette goes to a module with no search (#344)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.addInitScript(() => {
    ;(window as any).startupProbe.replies['calendar.events'] = { events: [] }
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { band, search, field } = await bandSearch(page)
  const { button: menuButton, menu } = await appMenuParts(page)
  const button = band.locator('[data-band-search-button]')
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await button.click()
  await expect(field).toBeFocused()
  await field.fill('budget')
  // From the field, the palette goes to Calendar, which has no search.
  await page.keyboard.press(`${mod}+k`)
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true })
  await palette.getByRole('combobox').fill('Go to: Calendar')
  await expect(palette.getByRole('option').first()).toContainText('Go to: Calendar')
  await page.keyboard.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('main', { name: 'Calendar', exact: true })).toBeVisible()
  // No disabled field is left over the band: it is closed, the band takes the
  // focus and the pointer again, and the focus is on the button, which says why.
  await expect(search).toHaveCount(0)
  await expect(band.locator('[data-band-start]')).not.toHaveAttribute('inert', '')
  await expect(button).toHaveAttribute('aria-disabled', 'true')
  await expect(button).toHaveAccessibleDescription('Calendar has no search yet')
  await expect(button).toBeFocused()
  // Pressing it opens nothing.
  await page.keyboard.press('Enter')
  await expect(search).toHaveCount(0)
  // The menu works again, and back in mail the field is closed with its query.
  await menuButton.click()
  await menu.getByRole('menuitemradio', { name: 'Go to: Mail', exact: true }).click()
  await expect(page.getByRole('main', { name: 'Mail', exact: true })).toBeVisible()
  await expect(search).toHaveCount(0)
  await expect(button).toHaveAccessibleName('Search messages...')
  await button.click()
  await expect(field).toHaveValue('budget')
  await expect(field).toBeFocused()
  expect(errors).toEqual([])
})

// Owner decision on #344: «Search all messages» and «Search current thread»,
// in the palette and in the app menu, go to mail first and search there.
test("the palette's and the menu's search commands go to mail first, from Calendar and from Notes (#344)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.addInitScript(() => {
    ;(window as any).startupProbe.replies['calendar.events'] = { events: [] }
  })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { search, field } = await bandSearch(page)
  const { button, menu } = await appMenuParts(page)
  const mail = page.getByRole('main', { name: 'Mail', exact: true })
  const conversationSearch = page.getByPlaceholder('Search thread', { exact: true }).filter({ visible: true })
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true })
  const fromPalette = async (name: string) => {
    await page.keyboard.press(`${mod}+k`)
    await palette.getByRole('combobox').fill(name)
    await expect(palette.getByRole('option').first()).toContainText(name)
    await page.keyboard.press('Enter')
    await expect(palette).toHaveCount(0)
  }

  // From Calendar, the menu's «Search all messages»: mail, and mail's field.
  await openModule(page, 'Calendar')
  await button.click()
  await menu.getByRole('menuitem', { name: 'Search all messages', exact: true }).click()
  await expect(mail).toBeVisible()
  await expect(search).toHaveAttribute('data-search-scope', 'mail')
  await expect(field).toBeFocused()
  // From Notes, the palette's, the same.
  await openModule(page, 'Notes')
  await fromPalette('Search all messages')
  await expect(mail).toBeVisible()
  await expect(field).toBeFocused()
  await expect(field).toHaveAccessibleName('Search messages...')

  // With no conversation open, «Search current thread» from Calendar ends in mail's field too.
  await openModule(page, 'Calendar')
  await fromPalette('Search current thread')
  await expect(mail).toBeVisible()
  await expect(field).toBeFocused()
  await expect(conversationSearch).toHaveCount(0)
  // With one open in mail, from Notes (palette) and from Calendar (menu): its own search.
  await page.getByRole('table').getByRole('button', { name: /Pilot checklist/ }).click()
  await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
  await openModule(page, 'Notes')
  await fromPalette('Search current thread')
  await expect(mail).toBeVisible()
  await expect(conversationSearch).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(conversationSearch).toHaveCount(0)
  await openModule(page, 'Calendar')
  await button.click()
  await menu.getByRole('menuitem', { name: 'Search current thread', exact: true }).click()
  await expect(mail).toBeVisible()
  await expect(conversationSearch).toBeFocused()
  await page.keyboard.press('Escape')

  // The shortcuts are unchanged: in Notes, Ctrl/⌘+Shift+F searches Notes.
  await openModule(page, 'Notes')
  await page.getByTitle('Notes', { exact: true }).focus()
  await page.keyboard.press(`${mod}+Shift+F`)
  await expect(field).toBeFocused()
  await expect(field).toHaveAccessibleName('Search notes')
  expect(errors).toEqual([])
})

for (const width of [1440, 768]) {
  test(`in Arabic the band search follows the reading direction and passes axe: ${width}px (#344)`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors = await prepareStartup(page, true, { navigation: true, language: 'ar' })
    await page.addInitScript(() => {
      ;(window as any).startupProbe.replies['calendar.events'] = { events: [] }
    })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(page.locator('[data-thread-list]')).toBeVisible()
    const { band, search, field } = await bandSearch(page, arCatalog)
    const { button: menuButton } = await appMenuParts(page, arCatalog)
    const menuBox = await boxOf(menuButton)
    // The menu at the start of the band: its right in Arabic.
    expect(menuBox.x + menuBox.width).toBeGreaterThan(width - 16)
    if (width < 769) {
      const button = band.getByRole('button', { name: arCatalog['threads.searchMessages'], exact: true })
      expect((await boxOf(button)).x + (await boxOf(button)).width).toBeLessThanOrEqual(menuBox.x)
      await button.click()
    }
    await expect(field).toBeVisible()
    await expect(field).toHaveAccessibleName(arCatalog['threads.searchMessages'])
    if (width >= 769) {
      // After the menu in the reading order: to its left.
      const fieldBox = await boxOf(field)
      expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(menuBox.x)
      expect(fieldBox.x).toBeGreaterThanOrEqual(0)
    }
    await field.fill('ميزانية')
    await expect.poll(() => lastRequest(page, 'mail.threadList')).toMatchObject({ query: 'ميزانية' })
    await rtlInView(page, `band search, ${width}px`)
    const audit = async (name: string) => {
      await settled(page)
      const whole = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
      const regions = await new AxeBuilder({ page }).withRules(REGION_RULES).analyze()
      await info.attach(`axe-band-search-ar-${width}-${name}`, {
        body: JSON.stringify({ page: whole.violations, regions: regions.violations }, null, 2),
        contentType: 'application/json',
      })
      expect(
        whole.violations
          .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
          .map((violation) => `${violation.id} on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`),
        name,
      ).toEqual([])
      expect(
        regions.violations.map((violation) => violation.id),
        name,
      ).toEqual([])
    }
    await audit('mail')
    await info.attach(`band-search-ar-${width}`, {
      body: await page.screenshot({ path: info.outputPath(`band-search-ar-${width}.png`), animations: 'disabled' }),
      contentType: 'image/png',
    })
    if (width >= 769) {
      // Calendar: the field disabled, with the reason in Arabic.
      await page.getByTitle(arCatalog['calendar.title'], { exact: true }).click()
      await expect(field).toBeDisabled()
      await expect(field).toHaveAccessibleDescription(arCatalog['search.band.calendar'])
      await rtlInView(page, 'band search in Calendar')
      await audit('calendar')
    }
    expect(errors).toEqual([])
  })
}

// At the app's 200 % the band is 72 px tall and the field shrinks between the
// menu and the end of the band, inside the window, at 1025 px; at 100 % it
// does the same between 769 and 1024 px.
test("the band field shrinks inside the window at the app's 200 percent at 1025px, and from 769 to 1024px (#344)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1025, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { band, search, field } = await bandSearch(page)
  const { button: menuButton } = await appMenuParts(page)
  const fits = async (where: string, width: number) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), where).toBe(true)
    const menuBox = await boxOf(menuButton)
    const fieldBox = await boxOf(field)
    const searchBox = await boxOf(search)
    // The menu keeps its room; the field starts after it and ends inside.
    await expect(menuButton, where).toBeInViewport({ ratio: 1 })
    expect(fieldBox.x, where).toBeGreaterThanOrEqual(menuBox.x + menuBox.width)
    expect(searchBox.x + searchBox.width, where).toBeLessThanOrEqual(width)
    expect(fieldBox.width, where).toBeGreaterThan(100)
    for (const control of await search.getByRole('button').all()) await expect(control, where).toBeInViewport({ ratio: 1 })
    await ltrInView(page, where)
  }
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px')
  expect(Math.round((await boxOf(band)).height)).toBe(72)
  await field.fill('budget')
  await expect(search.getByRole('button', { name: 'Clear search', exact: true })).toBeVisible()
  await fits('200 % at 1025px', 1025)
  await page.keyboard.press(`${mod}+Digit0`)
  for (const width of [1024, 900, 769]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect(field).toBeVisible()
    await fits(`${width}px`, width)
  }
  expect(errors).toEqual([])
})

// #345: the sync status and do-not-disturb at the end of the top band
// (ADR-0068 §2, piece 13c). The sync status is a button with an icon and the
// summary today's region showed («{count} need attention» or «Complete sync
// status unknown», never «Synced»), the icon alone below 1025 px, and one
// visually hidden live region. It opens today's detail in a popover anchored
// under it. The full-width bar under the header stays only while something is
// prominent (an account must sign in again, or a failure is not dismissed).
// Do not disturb shows at the end of the band too, before the sync status,
// and in the rail until piece 14 (owner decision 1 on #342).
const SYNC_UNKNOWN = 'Complete sync status unknown'

function bandEnd(page: Page, catalog: Record<string, string> = enCatalog) {
  const banner = page.getByRole('banner', { name: catalog['shell.region.banner'], exact: true })
  const end = banner.locator('[data-top-band] [data-band-end]')
  return {
    end,
    sync: end.locator('[data-sync-status-button]'),
    status: end.locator('[data-sync-status]').getByRole('status'),
    popover: page.getByRole('dialog', { name: catalog['connectivity.health.title'], exact: true }),
    bar: page.getByRole('region', { name: catalog['connectivity.health.title'], exact: true }),
  }
}

for (const width of [1440, 1025, 1024, 768]) {
  test(`the band ends with the sync status, its words from 1025px, and its popover stays in the window at ${width}px (#345)`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors = await prepareStartup(page, true, { navigation: true })
    await page.goto('/')
    await expect(page.locator('[data-thread-list]')).toBeVisible()
    const { end, sync, status, popover, bar } = bandEnd(page)

    // Nothing prominent: no bar under the header, the band says it.
    await expect(bar).toHaveCount(0)
    await expect(sync).toBeVisible()
    await expect(end.getByRole('button', { name: SYNC_UNKNOWN, exact: true })).toHaveCount(1)
    await expect(sync).toHaveAttribute('title', SYNC_UNKNOWN)
    await expect(sync).toHaveAttribute('aria-haspopup', 'dialog')
    await expect(sync).toHaveAttribute('aria-expanded', 'false')
    // One live region says it, polite and visually hidden.
    await expect(page.getByRole('status').filter({ hasText: SYNC_UNKNOWN })).toHaveCount(1)
    await expect(status).toHaveText(SYNC_UNKNOWN)
    await expect(status).toHaveAttribute('aria-live', 'polite')
    expect(Math.round((await boxOf(status)).width)).toBeLessThanOrEqual(1)

    // At the end of the band, inside the window.
    await expect(sync).toBeInViewport({ ratio: 1 })
    const box = await boxOf(sync)
    expect(box.x + box.width).toBeGreaterThan(width - 16)
    expect(Math.round(box.height)).toBe(32)
    const words = sync.locator('span')
    if (width >= 1025) {
      await expect(words).toBeVisible()
      await expect(words).toHaveText(SYNC_UNKNOWN)
      expect(box.width).toBeGreaterThan(100)
    } else {
      // The icon alone; the words stay its name and its tooltip.
      expect(Math.round(box.width)).toBe(32)
      expect(Math.round((await boxOf(words)).width)).toBeLessThanOrEqual(1)
    }
    await ltrInView(page, `band end at ${width}px`)

    // The pointer opens the detail under the button, its end edge by the
    // button's, inside the window.
    await sync.click()
    await expect(popover).toBeVisible()
    await expect(popover).toBeFocused()
    await expect(sync).toHaveAttribute('aria-expanded', 'true')
    const popoverBox = await boxOf(popover)
    expect(popoverBox.y).toBeGreaterThanOrEqual(box.y + box.height - 1)
    expect(popoverBox.x).toBeGreaterThanOrEqual(0)
    expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(width)
    expect(Math.abs(popoverBox.x + popoverBox.width - (box.x + box.width))).toBeLessThanOrEqual(8)
    expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(1000)
    await expect(popover.getByRole('listitem', { name: 'Alex · Demo', exact: true })).toBeVisible()
    await expect(popover.getByRole('listitem', { name: 'Second account', exact: true })).toBeVisible()
    await expect(popover.getByRole('button', { name: 'Account settings', exact: true })).toHaveCount(2)
    await ltrInView(page, `popover at ${width}px`)
    await info.attach(`sync-status-${width}`, {
      body: await page.screenshot({ path: info.outputPath(`sync-status-${width}.png`), animations: 'disabled' }),
      contentType: 'image/png',
    })
    // Escape closes it and gives the focus back to the button.
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
    await expect(sync).toBeFocused()
    await expect(sync).toHaveAttribute('aria-expanded', 'false')
    // A second click closes it, and so does a click outside.
    await sync.click()
    await expect(popover).toBeVisible()
    await sync.click()
    await expect(popover).toHaveCount(0)
    await sync.click()
    await page.locator('[data-thread-list]').click({ position: { x: 5, y: 5 } })
    await expect(popover).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test('the sync status is reached by Tab in the band and opens from the keyboard; Escape and F6 close it (#345)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { sync, popover } = bandEnd(page)
  const { button: menuButton } = await appMenuParts(page)

  // From outside every region F6 goes to the band, on its menu button, and Tab
  // goes through the band, still in its region, to the end.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('F6')
  await expect(menuButton).toBeFocused()
  for (let presses = 0; presses < 8; presses++) {
    if (await sync.evaluate((element) => element === document.activeElement)) break
    await page.keyboard.press('Tab')
    expect(await regionAtFocus(page)).toBe('search')
  }
  await expect(sync).toBeFocused()

  // Enter opens it with the focus in it, still the band's region; Tab goes
  // through its actions.
  await page.keyboard.press('Enter')
  await expect(popover).toBeVisible()
  await expect(popover).toBeFocused()
  expect(await regionAtFocus(page)).toBe('search')
  await page.keyboard.press('Tab')
  await expect(popover.getByRole('button', { name: 'Account settings', exact: true }).first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(sync).toBeFocused()

  // Space opens it too. F6 from inside closes it and goes on to the next
  // region; Shift+F6 comes back to the button.
  await page.keyboard.press(' ')
  await expect(popover).toBeFocused()
  await page.keyboard.press('F6')
  await expect(popover).toHaveCount(0)
  expect(await regionAtFocus(page)).toBe('folders')
  await page.keyboard.press('Shift+F6')
  await expect(sync).toBeFocused()

  // An account's settings, from the popover: Settings gives the focus back
  // to the button.
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  await expect(popover).toHaveCount(0)
  await expect(settings.locator('[data-settings-section="account"]')).toContainText('alex@example.test')
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(sync).toBeFocused()
  expect(errors).toEqual([])
})

for (const width of [1440, 768]) {
  test(`a failure brings the bar back under the header until it is dismissed, and a sign-in cannot be: ${width}px (#345)`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors = await prepareStartup(page, true, { navigation: true, syncHealth: true })
    await page.goto('/')
    await expect(page.locator('[data-thread-list]')).toBeVisible()
    const { sync, status, popover, bar } = bandEnd(page)
    const { band } = await appMenuParts(page)
    await expect(bar).toHaveCount(0)
    await expect(status).toHaveText(SYNC_UNKNOWN)

    await sync.focus()
    await page.evaluate(() =>
      (window as any).startupProbe.emit('mail.syncError', {
        account: 'synthetic-account',
        message: 'synthetic-private-diagnostic',
      }),
    )
    // The band's words change where they are, with the focus left alone; the
    // bar comes back, across the window, under the header and above the module.
    await expect(status).toHaveText('1 need attention')
    await expect(sync).toHaveAttribute('title', '1 need attention')
    await expect(sync).toBeFocused()
    await expect(bar).toBeVisible()
    const bandBox = await boxOf(band)
    const barBox = await boxOf(bar)
    expect(barBox.y).toBeGreaterThanOrEqual(bandBox.y + bandBox.height - 1)
    expect(Math.round(barBox.width)).toBe(width)
    expect((await boxOf(page.getByRole('main'))).y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1)
    await expect(bar).toContainText('1 need attention')
    // Said once: the bar's summary is not a second live region.
    await expect(page.getByRole('status').filter({ hasText: '1 need attention' })).toHaveCount(1)
    await expect(bar.getByRole('status')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('synthetic-private-diagnostic')
    await info.attach(`sync-status-prominent-${width}`, {
      body: await page.screenshot({ path: info.outputPath(`sync-status-prominent-${width}.png`), animations: 'disabled' }),
      contentType: 'image/png',
    })

    // The bar keeps its own detail; the popover folds it, so it is shown once.
    const toggle = bar.getByRole('button', { name: 'Account sync', exact: true })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await sync.click()
    await expect(popover).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('listitem', { name: 'Alex · Demo', exact: true })).toHaveCount(1)
    // Dismissed in the popover: nothing is prominent any more and the bar goes;
    // the band still counts the failure.
    const entry = popover.getByRole('listitem', { name: 'Alex · Demo', exact: true })
    await entry.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(entry).toBeFocused()
    await expect(bar).toHaveCount(0)
    await expect(status).toHaveText('1 need attention')
    await page.keyboard.press('Escape')
    await expect(sync).toBeFocused()

    // An account that must sign in again: the bar, with nothing to dismiss in
    // it or in the popover.
    await page.addInitScript(() => {
      ;(window as any).startupProbe.replies['account.list'].accounts[1].needs_reconnect = true
    })
    await page.reload()
    await expect(bar).toBeVisible()
    await expect(status).toHaveText('1 need attention')
    await bar.getByRole('button', { name: 'Account sync', exact: true }).click()
    await expect(bar.getByRole('listitem', { name: 'Second account', exact: true })).toContainText(
      'Sign in again in account settings',
    )
    await expect(bar.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0)
    await sync.click()
    await expect(popover.getByRole('listitem', { name: 'Second account', exact: true })).toBeVisible()
    await expect(popover.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0)
    await settled(page)
    const regions = await new AxeBuilder({ page }).withRules(REGION_RULES).analyze()
    expect(regions.violations.map((violation) => violation.id)).toEqual([])
    await page.keyboard.press('Escape')
    await expect(bar).toBeVisible()
    expect(errors).toEqual([])
  })
}

// In Arabic the button is at the band's left end and the popover opens from
// there towards the start of the line, rightwards, inside the window; axe
// passes with it open.
for (const width of [1440, 768]) {
  test(`in Arabic the sync status opens its popover towards the reading direction and passes axe: ${width}px (#345)`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors = await prepareStartup(page, true, { navigation: true, language: 'ar' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(page.locator('[data-thread-list]')).toBeVisible()
    const { sync, status, popover } = bandEnd(page, arCatalog)
    const unknown = arCatalog['connectivity.health.unknown']
    await expect(status).toHaveText(unknown)
    await expect(page.getByRole('button', { name: unknown, exact: true })).toHaveCount(1)
    const box = await boxOf(sync)
    expect(box.x).toBeLessThan(16)
    await sync.focus()
    await page.keyboard.press('Enter')
    await expect(popover).toBeFocused()
    const popoverBox = await boxOf(popover)
    expect(popoverBox.x).toBeGreaterThanOrEqual(0)
    expect(Math.abs(popoverBox.x - box.x)).toBeLessThanOrEqual(8)
    expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(width)
    expect(popoverBox.y).toBeGreaterThanOrEqual(box.y + box.height - 1)
    await rtlInView(page, 'sync popover')
    await settled(page)
    const inPopover = await new AxeBuilder({ page }).include('[data-sync-popover]').withTags(AXE_TAGS).analyze()
    expect(inPopover.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([])
    const whole = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
    const regions = await new AxeBuilder({ page }).withRules(REGION_RULES).analyze()
    await info.attach(`axe-sync-status-ar-${width}`, {
      body: JSON.stringify({ popover: inPopover.violations, page: whole.violations, regions: regions.violations }, null, 2),
      contentType: 'application/json',
    })
    expect(
      whole.violations
        .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
        .map((violation) => `${violation.id} on ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`),
    ).toEqual([])
    expect(regions.violations.map((violation) => violation.id)).toEqual([])
    await info.attach(`sync-status-ar-${width}`, {
      body: await page.screenshot({ path: info.outputPath(`sync-status-ar-${width}.png`), animations: 'disabled' }),
      contentType: 'image/png',
    })
    await page.keyboard.press('Escape')
    await expect(sync).toBeFocused()
    expect(errors).toEqual([])
  })
}

test("at the app's 200 percent the band's end leaves the search its room, at 1025px and from 769 to 1024px, and the popover stays in the window (#345)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1025, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { end, sync, popover } = bandEnd(page)
  const { band, field } = await bandSearch(page)
  const { button: menuButton, menu } = await appMenuParts(page)
  // Do not disturb on, so both of the end's items are there.
  await menuButton.click()
  await menu.getByRole('menuitem', { name: 'Do not disturb until turned off', exact: true }).click()
  const quiet = end.getByRole('button', { name: 'Resume notifications', exact: true })
  await expect(quiet).toBeVisible()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px')
  expect(Math.round((await boxOf(band)).height)).toBe(72)
  for (const width of [1025, 1024, 900, 769]) {
    const where = `200 % at ${width}px`
    await page.setViewportSize({ width, height: 1000 })
    await expect(field, where).toBeVisible()
    // The end takes at most 35 % of the band; the summary is cut short there,
    // and stays whole in the name and the tooltip.
    expect((await boxOf(end)).width, where).toBeLessThanOrEqual((await boxOf(band)).width * 0.35 + 1)
    await expect(menuButton, where).toBeInViewport({ ratio: 1 })
    await expect(quiet, where).toBeInViewport({ ratio: 1 })
    await expect(sync, where).toBeInViewport({ ratio: 1 })
    await expect(end.getByRole('button', { name: SYNC_UNKNOWN, exact: true }), where).toHaveCount(1)
    await expect(sync, where).toHaveAttribute('title', SYNC_UNKNOWN)
    expect((await boxOf(field)).width, where).toBeGreaterThan(100)
    expect((await boxOf(field)).x, where).toBeGreaterThanOrEqual((await boxOf(menuButton)).x + (await boxOf(menuButton)).width)
    expect((await boxOf(field)).x + (await boxOf(field)).width, where).toBeLessThanOrEqual((await boxOf(quiet)).x)
    await ltrInView(page, where)
    if (width !== 1025 && width !== 769) continue
    await sync.click()
    await expect(popover, where).toBeVisible()
    const popoverBox = await boxOf(popover)
    expect(popoverBox.x, where).toBeGreaterThanOrEqual(0)
    expect(popoverBox.x + popoverBox.width, where).toBeLessThanOrEqual(width)
    expect(popoverBox.y + popoverBox.height, where).toBeLessThanOrEqual(1000)
    await expect(popover.getByRole('button', { name: 'Account settings', exact: true }).first(), where).toBeInViewport()
    await ltrInView(page, `popover, ${where}`)
    await page.keyboard.press('Escape')
    await expect(sync, where).toBeFocused()
  }
  await page.keyboard.press(`${mod}+Digit0`)
  expect(errors).toEqual([])
})

for (const width of [1440, 768]) {
  test(`do not disturb shows at the end of the band, with the rail's, and resumes from there: ${width}px (#345)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors = await prepareStartup(page, true, { navigation: true })
    await page.goto('/')
    await expect(page.locator('[data-thread-list]')).toBeVisible()
    const quietPushes = () =>
      page.evaluate(() =>
        (window as any).startupProbe.requests
          .filter((r: { command: string }) => r.command === 'notify.setQuiet')
          .map((r: { payload: unknown }) => r.payload),
      )
    const { end, sync } = bandEnd(page)
    const { button, menu } = await appMenuParts(page)
    const text = 'Do not disturb is on until you turn it off'
    const indicator = end.getByRole('status', { name: text, exact: true })
    const rail = page.locator('aside [data-quiet-indicator="rail"]')
    await expect(indicator).toHaveCount(0)

    await button.click()
    await menu.getByRole('menuitem', { name: 'Do not disturb until turned off', exact: true }).click()
    await expect(indicator).toBeVisible()
    await expect.poll(async () => (await quietPushes()).at(-1)).toMatchObject({ indefinite: true, quiet: true })
    // The band's is the one status; the rail shows its button while it is there.
    await expect(page.getByRole('status', { name: text, exact: true })).toHaveCount(1)
    if (width >= 769) await expect(rail).toBeVisible()
    else await expect(rail).toBeHidden()
    const resume = indicator.getByRole('button', { name: 'Resume notifications', exact: true })
    await expect(resume).toHaveAttribute('title', `${text} — Resume notifications`)
    await expect(resume).toBeInViewport({ ratio: 1 })
    // Before the sync status, at the end of the band.
    expect((await boxOf(resume)).x).toBeLessThan((await boxOf(sync)).x)
    await ltrInView(page, `do not disturb at ${width}px`)

    // Resumed from the band: both go, and the bridge is told.
    await resume.click()
    await expect(indicator).toHaveCount(0)
    await expect(page.locator('[data-quiet-indicator]')).toHaveCount(0)
    await expect.poll(async () => (await quietPushes()).at(-1)).toMatchObject({ indefinite: false, quiet: false })
    expect(errors).toEqual([])
  })
}

// Whether Chromium leaves an element out of its accessibility tree (an inert
// subtree is): what a screen reader would not hear, a live region included.
async function ignoredByAccessibility(page: Page, selector: string): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Accessibility.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    expect(nodeId, selector).toBeGreaterThan(0)
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })
    // No node at all would make "ignored" pass without checking anything.
    expect(nodes.length, selector).toBeGreaterThan(0)
    expect(typeof nodes[0].ignored, selector).toBe('boolean')
    return nodes[0].ignored
  } finally {
    await cdp.detach()
  }
}

// Below 769 px the band's search covers the band, and its controls go inert;
// the live regions at its end must not, or a failure that arrives while the
// person types is never announced.
test('below 769px the live regions at the end of the band keep announcing while the search covers it (#345)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, syncHealth: true })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { end, sync, status } = bandEnd(page)
  const { button: menuButton, menu } = await appMenuParts(page)
  await menuButton.click()
  await menu.getByRole('menuitem', { name: 'Do not disturb until turned off', exact: true }).click()
  const quietText = 'Do not disturb is on until you turn it off'
  await expect(end.getByRole('status', { name: quietText, exact: true })).toBeVisible()
  const syncStatus = '[data-band-end] [data-sync-status] [role="status"]'
  const quietStatus = '[data-band-end] [data-quiet-indicator="band"]'

  // The search over the band, with something typed in it.
  await page.locator('[data-band-search-button]').click()
  const { field } = await bandSearch(page)
  await field.fill('Pilot')
  await expect(field).toBeFocused()
  await page.evaluate(() =>
    (window as any).startupProbe.emit('mail.syncError', { account: 'synthetic-account', message: 'synthetic' }),
  )
  await expect(status).toHaveText('1 need attention')
  await expect(field).toBeFocused()
  // Both statuses are in the accessibility tree; the controls under the
  // search are not.
  expect(await page.locator(syncStatus).evaluate((element) => element.closest('[inert]') === null)).toBe(true)
  expect(await page.locator(quietStatus).evaluate((element) => element.closest('[inert]') === null)).toBe(true)
  expect(await ignoredByAccessibility(page, syncStatus)).toBe(false)
  expect(await ignoredByAccessibility(page, quietStatus)).toBe(false)
  expect(await ignoredByAccessibility(page, '[data-sync-status-button]')).toBe(true)
  expect(await ignoredByAccessibility(page, '[data-band-start] button')).toBe(true)
  // Closed, the controls are back.
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-band-search-overlay]')).toHaveCount(0)
  expect(await ignoredByAccessibility(page, '[data-sync-status-button]')).toBe(false)
  await expect(sync).toBeVisible()
  expect(errors).toEqual([])
})

// Retry turns disabled while its request is pending. With the focus on it, the
// focus fell to the page, where a bare key acts on the open conversation.
test('Retry keeps the focus in its entry, in the popover and in the bar, and in the popover a bare key acts on nothing behind (#345)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = await prepareStartup(page, true, { navigation: true, syncHealth: true })
  await page.goto('/')
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const { sync, popover, bar } = bandEnd(page)
  const row = page.getByRole('table').getByRole('button', { name: /Pilot checklist/ })
  const reply = page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })
  await row.click()
  await expect(reply).toBeVisible()
  await expect(row).toHaveAttribute('aria-current', 'true')
  const before = await page.evaluate(() => (window as any).startupProbe.requests.length)

  await sync.click()
  const entry = popover.getByRole('listitem', { name: 'Alex · Demo', exact: true })
  await entry.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(entry).toBeFocused()
  await expect(entry).toContainText('Request not confirmed')
  expect(
    await page.evaluate(
      (start) =>
        (window as any).startupProbe.requests.slice(start).filter((item: any) => item.command === 'mail.sync').length,
      before,
    ),
  ).toBe(1)
  // A bare key stays in the popover: the conversation does not move.
  await page.keyboard.press('j')
  await expect(popover).toBeVisible()
  await expect(row).toHaveAttribute('aria-current', 'true')
  await expect(reply).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sync).toBeFocused()

  // The bar's copy of the detail keeps it too.
  await page.evaluate(() =>
    (window as any).startupProbe.emit('mail.syncError', { account: 'second-account', message: 'synthetic' }),
  )
  await bar.getByRole('button', { name: 'Account sync', exact: true }).click()
  const second = bar.getByRole('listitem', { name: 'Second account', exact: true })
  await second.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(second).toBeFocused()
  await expect(second).toContainText('Request not confirmed')
  expect(errors).toEqual([])
})
