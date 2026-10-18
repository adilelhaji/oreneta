import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { createFixture } from '../baseline/fixtures'
import { defaultCustomInput, deriveThemeTokens } from '../src/lib/themes'

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
      await expect(page.getByRole('textbox').first()).toBeVisible()
      const openArea = async (name: string) => {
        if (width < 769) await page.getByRole('button', { name: 'Más', exact: true }).click()
        await page.getByRole('button', { name, exact: true }).click()
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
        const settings = page.getByRole('button', { name: /Ajustes/ })
        await settings.scrollIntoViewIfNeeded()
        await expect(settings).toBeInViewport({ ratio: 1 })
        expect(await settings.evaluate((element) => {
          const box = element.parentElement!.getBoundingClientRect()
          return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
        })).toBe(true)
        const lastItem = page.getByRole('button', { name: 'Acerca de Oreneta', exact: true })
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
      await expect(page.getByRole('region', { name: 'Sincronización de cuentas' })).toBeVisible()
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
      const health = page.getByRole('region', { name: 'Sincronización de cuentas' })
      const toggle = health.getByRole('button', { name: 'Sincronización de cuentas', exact: true })
      await toggle.focus()
      await page.evaluate(() => {
        const probe = (window as any).startupProbe
        probe.emit('mail.syncError', { account: 'synthetic-account', message: 'synthetic-private-diagnostic' })
        probe.emit('mail.syncError', { account: 'second-account', message: 'second diagnostic' })
        probe.emit('mail.synced', { account: 'synthetic-account', folder: 'Sent' })
        probe.emit('calendar.synced', { account: 'second-account' })
      })
      await expect(toggle).toBeFocused()
      await expect(health.getByRole('status')).toContainText('2 requieren atención')
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
      await expect(health.getByRole('status')).toHaveText('Sincronización completa sin verificar')
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
      const opener = page.getByRole('textbox').first()
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
  await page.getByRole('button', { name: 'Do not disturb until turned off', exact: true }).click()
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

      const longMenu = catalogue.getByRole('button', { name: /Archivar los mensajes seleccionados/ })
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
                element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim(),
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
          element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim().slice(0, 40),
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
          await page.getByRole('button', { name, exact: true }).last().click()
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
  await expect(page.getByRole('button', { name: /New message to/ })).toBeDisabled()
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
    await page.getByRole('button', { name: 'Sent', exact: true }).click()
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
  test(`conventional mail defaults support open, reply draft, selection and navigation (${theme})`, async ({
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
    await expect(page.getByRole('button', { name: 'Sent', exact: true })).toBeInViewport()
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
  await page.getByRole('button', { name: 'Add to favorites' }).click()
  const favorites = nav.getByRole('region', { name: 'Favorites' })
  await expect(favorites.getByRole('button', { name: 'Clients 1', exact: true })).toBeVisible()

  await tree.getByRole('button', { name: 'Clients 1', exact: true }).click({ button: 'right' })
  await page.getByRole('button', { name: 'Teal', exact: true }).click()
  const colored = nav.getByRole('button', { name: 'Clients Color: Teal 1', exact: true })
  await expect(colored).toHaveCount(2)
  // The palette's CSS applies under the production CSP: the light-theme teal.
  expect(await colored.first().locator('.mail-folder-dot').evaluate((dot) => getComputedStyle(dot).backgroundColor)).toBe(
    'rgb(0, 121, 107)',
  )

  // Keyboard path: Shift+F10 on the folder, "Move folder to…", the picker, confirm.
  await tree.getByRole('button', { name: 'Team', exact: true }).focus()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('button', { name: 'Add to favorites' })).toBeFocused()
  await page.getByRole('button', { name: 'Move folder to…' }).click()
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
  await page.getByLabel('Show group').selectOption({ label: 'Engines (2)' })
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
        await handle.focus()
        await page.keyboard.press('ArrowLeft')
        await page.keyboard.press('Shift+ArrowLeft')
        await expect(handle).toHaveAttribute('aria-valuenow', '420')
        expect(Math.round((await panel.boundingBox())!.width)).toBe(420)
        const grip = (await handle.boundingBox())!
        await page.mouse.move(grip.x + grip.width / 2, grip.y + 200)
        await page.mouse.down()
        await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + 200, { steps: 4 })
        await page.mouse.up()
        const dragged = Number(await handle.getAttribute('aria-valuenow'))
        expect(Math.abs(dragged - 360)).toBeLessThanOrEqual(2)
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
          element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim().slice(0, 40),
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

      // Back on the conversation, its quick reply is reachable again.
      await page.getByTitle(catalog['chat.currentConversation'], { exact: true }).click()
      await expect(page.locator('[inert]', { has: quickReply })).toHaveCount(0)
      await expect(page.locator('[aria-hidden="true"]', { has: quickReply })).toHaveCount(0)
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
          await page.getByRole('button', { name: caCatalog[key], exact: true }).last().click()
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
// the frame's order (folders, modules, list, reader, sidebar), which is the
// same in right to left. Within a region the focus goes back to where it was.
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

    expect(await regionWalk(page, 'F6', 5)).toEqual(['reader', 'sidebar', 'folders', 'modules', 'content'])
    // Round once and back in the list, on the row it left.
    expect(await focusIsMarked(page, 'data-test-f6-start')).toBe(true)
    expect(await regionWalk(page, 'Shift+F6', 5)).toEqual(['modules', 'folders', 'sidebar', 'reader', 'content'])
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

  // While typing in the list's search field: F6 types nothing and moves on.
  const search = page.locator('[data-thread-list]').getByRole('textbox').first()
  await search.click()
  await search.fill('Pilot')
  // The conversation is still open, so the reader has somewhere to land.
  await expect(frame.getByText('Wide synthetic invoice')).toBeVisible()
  expect(await regionAtFocus(page)).toBe('content')
  await page.keyboard.press('F6')
  await expect(search).not.toBeFocused()
  await expect(search).toHaveValue('Pilot')
  expect(await regionAtFocus(page)).toBe('reader')

  // From inside the message's own frame, which forwards F1–F12.
  await frame.getByText('Wide synthetic invoice').click()
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME')
  await page.keyboard.press('F6')
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME')
  // No sidebar is open, so after the reader comes the first region again.
  expect(await regionAtFocus(page)).toBe('folders')
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
  // In a text field the letter is typed, and the focus stays.
  const search = page.locator('[data-thread-list]').getByRole('textbox').first()
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
  // One pane at a time: the rail, the mail navigation and the reader are not shown.
  await row.focus()
  expect(await regionWalk(page, 'F6', 3)).toEqual(['content', 'content', 'content'])
  expect(await regionWalk(page, 'Shift+F6', 2)).toEqual(['content', 'content'])
  await row.click()
  await expect(page.getByText('Thanks Morgan. I will review the checklist today.', { exact: true })).toBeVisible()
  expect(await regionWalk(page, 'F6', 2)).toEqual(['reader', 'reader'])

  // 1440 px at the app's own 200 %: the same frame, everything twice the size.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.locator('[data-thread-list]')).toBeVisible()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  for (let i = 0; i < 6; i++) await page.keyboard.press(`${mod}+Equal`)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px')
  await row.focus()
  const zoomed: string[] = []
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('F6')
    zoomed.push(await regionAtFocus(page))
    await expect(page.locator(':focus')).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  expect(zoomed).toEqual(['reader', 'folders', 'modules', 'content'])
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

    await page.getByTitle(catalog['people.title'], { exact: true }).click()
    await page.getByRole('option', { name: /Morgan Rivera/ }).click()
    await expect(page.getByRole('heading', { name: 'Morgan Rivera' })).toBeVisible()
    await audit('people', catalog['people.title'])

    await page.getByTitle(catalog['tasks.title'], { exact: true }).click()
    await expect(page.getByText('Review the figures')).toBeVisible()
    await audit('tasks', catalog['tasks.title'])

    await page.getByTitle(catalog['notes.title'], { exact: true }).click()
    await page.getByRole('button', { name: /Meeting notes/ }).click()
    await audit('notes', catalog['notes.title'])

    const calendarButton = page.getByTitle(catalog['calendar.title'], { exact: true })
    await calendarButton.click()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // A module's own left column is a region inside the module: from the
    // rail, F6 goes to the module, then its column, then back to the rail.
    await calendarButton.focus()
    expect(await regionWalk(page, 'F6', 3)).toEqual(['content', 'folders', 'modules'])
    await audit('calendar', catalog['calendar.title'])

    await page.getByTitle(catalog['messaging.title'], { exact: true }).click()
    await page.getByRole('button', { name: /pau@chat.test/ }).click()
    await expect(page.getByText('Hello Ana')).toBeVisible()
    await audit('chat', catalog['messaging.title'])

    await page.getByTitle(catalog['attachmentsView.title'], { exact: true }).click()
    await audit('attachments', catalog['attachmentsView.title'])

    expect(found).toEqual([])
    expect(errors).toEqual([])
  })
}
