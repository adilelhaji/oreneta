import { expect, test, type Page } from '@playwright/test'
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
  language?: string
  existingEmail?: string
  navigation?: boolean
  theme?: string
  hideAccounts?: boolean
  preferences?: Record<string, unknown>
  readerStress?: boolean
  updatesSupported?: boolean
  syncHealth?: boolean
  manualRefresh?: boolean
}

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
  await page.addInitScript(
    ({ accounts, folders, template, options, threads, messages }) => {
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
        'app.prefsGet': {
          prefs: {
            auto_update_check: false,
            language: options.language,
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
        'mail.scheduledSends': { messages: [] },
        'tray.setUnread': { ok: true },
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
