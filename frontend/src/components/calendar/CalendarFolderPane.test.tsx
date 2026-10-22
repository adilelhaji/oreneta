import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import i18n from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import { calendar$, startOfDay } from '../../states/calendar'
import { settings$ } from '../../states/settings'
import { DEFAULT_CALENDAR_PREFS } from '../../lib/calendarWeek'
import { FolderPane } from '../shell/FolderPane'
import { messages, supportedI18nLanguages } from '../../generated/locales'
import type { Account } from '../../types'
import { CalendarView } from './CalendarView'

// #323: Calendar's calendars in the common folder pane (ADR-0068 §4), the
// list as its body and the month at a glance as its footer, at the width
// every module shares. At 1024 px and below the pane is not drawn, and they
// keep their column beside the views.

const account = (id: string, email: string) =>
  ({ id, email, display_name: id, provider: 'imap', auth_type: 'password', paused: false }) as Account

const calendars = {
  a1: [
    { id: 'home', name: 'Home', kind: 'local', enabled: true, is_default: true, read_only: false },
    { id: 'holidays', name: 'Holidays', kind: 'subscribed', enabled: false, is_default: false, read_only: true },
  ],
  a2: [{ id: 'work', name: 'Work', kind: 'account', enabled: true, is_default: true, read_only: false }],
} as Record<string, unknown[]>

let calls: { command: string; payload: any }[] = []

const setWidth = (width: number) => (window as any).happyDOM.setViewport({ width, height: 900 })

beforeEach(async () => {
  calls = []
  await i18n.changeLanguage('en')
  accounts$.set([account('a1', 'ana@example.test'), account('a2', 'ana@work.example.test')])
  calendar$.calendars.set([])
  calendar$.events.set([])
  calendar$.syncErrors.set({})
  calendar$.view.set('week')
  calendar$.anchor.set(new Date(2026, 9, 13).getTime())
  settings$.calendarWeekStart.set('monday')
  settings$.calendar.set(DEFAULT_CALENDAR_PREFS)
  settings$.folderPaneWidth.set(260)
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'calendar.list') return { calendars: calendars[payload.account_id] ?? [] }
          return { ok: true, events: [] }
        },
      },
    },
  }
  setWidth(1440)
})

afterEach(async () => {
  cleanup()
  // happy-dom's own window: 1024 px wide.
  ;(window as any).happyDOM.setViewport({ width: 1024, height: 768 })
  accounts$.set([])
  // The view read a window: put the calendar back as it starts, so a later
  // file's save does not read that window again.
  calendar$.calendars.set([])
  calendar$.events.set([])
  calendar$.from.set(0)
  calendar$.to.set(0)
  calendar$.loading.set(false)
  calendar$.view.set('agenda')
  calendar$.anchor.set(startOfDay(new Date()).getTime())
  settings$.calendarWeekStart.set('locale')
  settings$.calendar.set(DEFAULT_CALENDAR_PREFS)
  settings$.folderPaneWidth.set(260)
  delete (window as any).go
})

const written = (key: string) =>
  calls.filter((call) => call.command === 'app.prefsSet' && call.payload.key === key).map((call) => call.payload.value)

async function open() {
  const screen = render(<CalendarView />)
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Work' }).length).toBeGreaterThan(0))
  return screen
}

// Each calendar has two buttons with its name: the tick that shows or hides
// it (pressed or not) and the name that opens its colours.
const tick = (root: HTMLElement, name: string) =>
  within(root)
    .getAllByRole('button', { name })
    .find((button) => button.hasAttribute('aria-pressed'))!

const pane = (screen: ReturnType<typeof render>) => screen.getByRole('navigation', { name: 'Calendars' })
const content = (screen: ReturnType<typeof render>) =>
  screen.container.querySelector<HTMLElement>('[data-region="content"]')!

describe('Calendar in the common folder pane (ADR-0068 §4, #323)', () => {
  it('is the "folders" region beside the whole module, named by its title row', async () => {
    const screen = await open()
    const nav = pane(screen)
    expect(nav.dataset.region).toBe('folders')
    expect(nav.hasAttribute('data-folder-pane')).toBe(true)
    expect(within(nav).getByRole('heading', { level: 2, name: 'Calendars' }).getAttribute('title')).toBe('Calendars')
    // Beside the module, not inside it: the pane comes first, then the views.
    expect(content(screen).contains(nav)).toBe(false)
    expect(nav.compareDocumentPosition(content(screen)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // One "folders" region in the module, and it holds no other.
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
    expect(nav.querySelectorAll('[data-region]')).toHaveLength(0)
    // The list is the pane's body, not a landmark of its own (it was the
    // "Calendar" <aside>, named like <main>, ADR-0068 §1).
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('keeps the list as it was: by account, shown or hidden, with its colours and read-only marks', async () => {
    const screen = await open()
    const nav = within(pane(screen))
    const ticks = (name: string) => tick(pane(screen), name)
    // Grouped by account, whose address can end in "…" and is whole in its tooltip.
    for (const email of ['ana@example.test', 'ana@work.example.test']) {
      expect(nav.getByText(email).getAttribute('title')).toBe(email)
    }
    const home = ticks('Home')
    const holidays = ticks('Holidays')
    expect(home.getAttribute('aria-pressed')).toBe('true')
    expect(holidays.getAttribute('aria-pressed')).toBe('false')
    // A subscription is read-only, and says so with its lock.
    expect(holidays.closest('li')!.querySelector('.lucide-lock')).not.toBeNull()
    expect(home.closest('li')!.querySelector('.lucide-lock')).toBeNull()

    // The tick shows or hides the calendar.
    await act(async () => {
      fireEvent.click(holidays)
    })
    expect(calls.find((call) => call.command === 'calendar.setEnabled')?.payload).toEqual({
      account_id: 'a1',
      calendar_id: 'holidays',
      enabled: true,
    })
    await waitFor(() => expect(ticks('Holidays').getAttribute('aria-pressed')).toBe('true'))

    // Its name opens the colour menu; its tooltip has the whole name and what
    // it does, and the button is still named by the calendar alone.
    const name = nav.getByTitle('Home — Colour')
    expect(name.getAttribute('aria-haspopup')).toBe('menu')
    expect(nav.getAllByRole('button', { name: 'Home' })).toContain(name)
    expect(nav.getByTitle('Holidays — Colour').textContent).toBe('Holidays')
    // A swatch sets the colour and closes the menu.
    await act(async () => {
      fireEvent.click(name)
    })
    const menu = nav.getByRole('menu', { name: 'Colour' })
    const swatches = within(menu).getAllByRole('menuitemradio')
    expect(swatches.length).toBeGreaterThan(1)
    const swatch = swatches.find((item) => item.getAttribute('aria-checked') === 'false')!
    await act(async () => {
      fireEvent.click(swatch)
    })
    expect(calls.find((call) => call.command === 'calendar.setColor')?.payload).toEqual({
      account_id: 'a1',
      calendar_id: 'home',
      color: swatch.getAttribute('aria-label'),
    })
    expect(nav.queryByRole('menu')).toBeNull()
  })

  it('puts the month at a glance in the footer, under the list, where a day still opens', async () => {
    const screen = await open()
    const nav = pane(screen)
    const month = within(nav).getByRole('navigation', { name: 'Month at a glance' })
    // Under every calendar, outside the pane's body, and just before the separator.
    const body = within(nav).getByRole('heading', { level: 2 }).parentElement!.nextElementSibling!
    expect(body.contains(tick(nav, 'Work'))).toBe(true)
    expect(body.contains(month)).toBe(false)
    for (const row of within(nav).getAllByRole('button', { name: /^(Home|Holidays|Work)$/ })) {
      expect(row.compareDocumentPosition(month) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    const separator = within(nav).getByRole('separator', { name: 'Resize folder pane' })
    expect(separator.previousElementSibling!.contains(month)).toBe(true)
    // Only one month at a glance, and no column beside the views.
    expect(screen.getAllByRole('navigation', { name: 'Month at a glance' })).toHaveLength(1)
    expect(content(screen).querySelector('[data-region="folders"]')).toBeNull()

    // Its days are drop targets for the views' events (#266), and open their day.
    const day = within(month).getByRole('button', { name: 'Tuesday, October 20, 2026' })
    expect(day.hasAttribute('data-mini-day')).toBe(true)
    await act(async () => {
      fireEvent.click(day)
    })
    expect(calendar$.anchor.peek()).toBe(new Date(2026, 9, 20).getTime())
    await act(async () => {
      fireEvent.click(within(month).getByRole('button', { name: 'Next month' }))
    })
    expect(within(month).getByText('November 2026')).toBeTruthy()
  })

  it('shares one width with mail: resized here, it is the width mail draws, and the reverse', async () => {
    const screen = await open()
    const handle = within(pane(screen)).getByRole('separator', { name: 'Resize folder pane' })
    expect(pane(screen).style.width).toBe('260px')
    expect(handle.getAttribute('aria-valuenow')).toBe('260')
    fireEvent.keyDown(handle, { key: 'End' })
    expect(pane(screen).style.width).toBe('400px')
    expect(written('folder_pane_width')).toEqual([400])
    cleanup()

    // Mail's pane, drawn next, is as wide; narrowed there, so is Calendar's.
    const mail = render(
      <FolderPane title="Accounts and folders">
        <button type="button">Inbox</button>
      </FolderPane>,
    )
    const mailPane = mail.getByRole('navigation', { name: 'Accounts and folders' })
    expect(mailPane.style.width).toBe('400px')
    fireEvent.keyDown(mail.getByRole('separator', { name: 'Resize folder pane' }), { key: 'Home' })
    expect(written('folder_pane_width')).toEqual([400, 200])
    cleanup()

    const again = await open()
    expect(pane(again).style.width).toBe('200px')
    expect(within(pane(again)).getByRole('separator').getAttribute('aria-valuenow')).toBe('200')
  })
})

describe('the name of Calendar\'s "folders" region (ADR-0068 §1, #323)', () => {
  it('is never the name of <main> or of the month at a glance, in any language', () => {
    // In German, Japanese, Korean, Vietnamese and Chinese the plural of
    // "calendar" is the word itself, so the pane has a name of its own there.
    // A screen reader reads two names that differ only in case or spacing
    // the same, so compare them as it would hear them.
    const clashes = supportedI18nLanguages.flatMap((language) => {
      const catalog = messages[language]
      const heard = (s: string | undefined) =>
        (s ?? '').trim().normalize('NFC').toLocaleLowerCase(language.replace('_', '-'))
      const name = catalog['calendar.calendars']
      if (!name?.trim()) return [`${language}: missing`]
      return [
        ...(heard(name) === heard(catalog['calendar.title']) ? [`${language}: same as <main>, "${name}"`] : []),
        ...(heard(name) === heard(catalog['calendar.miniCalendar'])
          ? [`${language}: same as the month, "${name}"`]
          : []),
      ]
    })
    expect(supportedI18nLanguages.length).toBe(20)
    expect(clashes).toEqual([])
  })
})

describe('Calendar at 1024 px and below (#323)', () => {
  it('keeps its column beside the views, the month above the list, as before', async () => {
    setWidth(1024)
    const screen = await open()
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize folder pane' })).toBeNull()
    const column = screen.getByRole('navigation', { name: 'Calendars' })
    expect(column.dataset.region).toBe('folders')
    // Inside the module, under its header, as before (its width is the e2e's).
    expect(content(screen).contains(column)).toBe(true)
    const month = within(column).getByRole('navigation', { name: 'Month at a glance' })
    expect(month.compareDocumentPosition(tick(column, 'Home')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('follows the window across 1025 px, one place at a time', async () => {
    // From narrow: happy-dom only reports a query that stops matching once it
    // has reported it matching.
    setWidth(1024)
    const screen = await open()
    const inColumn = () => content(screen).contains(screen.getByRole('navigation', { name: 'Calendars' }))
    expect(inColumn()).toBe(true)
    await act(async () => setWidth(1025))
    expect(pane(screen).hasAttribute('data-folder-pane')).toBe(true)
    expect(inColumn()).toBe(false)
    await act(async () => setWidth(1024))
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect(inColumn()).toBe(true)
    // Never in both places: one month at a glance, and one set of drop targets.
    expect(screen.getAllByRole('navigation', { name: 'Month at a glance' })).toHaveLength(1)
    expect(screen.container.querySelectorAll('[data-mini-calendar]')).toHaveLength(1)
  })
})
