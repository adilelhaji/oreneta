import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook, within } from '@testing-library/react'
import i18n, { t } from '../../lib/i18n'
import { messages, supportedI18nLanguages } from '../../generated/locales'
import { DEFAULT_NOTIFICATION_PREFS } from '../../lib/quietHours'
import { isMac } from '../../lib/shortcuts'
import { accounts$ } from '../../states/accounts'
import { compose$ } from '../../states/compose'
import { kanban$ } from '../../states/kanban'
import { mail$ } from '../../states/mail'
import { notificationClock } from '../../states/notifications'
import { settings$, type KanbanBoard } from '../../states/settings'
import { ui$ } from '../../states/ui'
import type { Account, Message } from '../../types'
import { AppHotkeys } from '../dialog/AppHotkeys'
import { CommandPalette } from '../palette/CommandPalette'
import { COMMAND_AREAS, groupCommandsByArea } from '../palette/paletteCommands'
import { useCommandList } from '../palette/useCommandList'
import { AppHeader } from './AppHeader'

// The top band and its app menu (ADR-0068 §1 and §2, #343).

// Two IMAP accounts, as the production-entry tests have (src never imports the baseline).
const account: Account = {
  id: 'synthetic-account',
  email: 'alex@example.test',
  display_name: 'Alex · Demo',
  provider: 'imap',
  auth_type: 'password',
  imap_host: 'imap.example.test',
  imap_port: 993,
  smtp_host: 'smtp.example.test',
  smtp_port: 465,
  tls: true,
  paused: true,
  conversation_html: false,
  load_remote_images: false,
}
const second: Account = {
  ...account,
  id: 'second-account',
  display_name: 'Second account',
  email: 'second@example.test',
}
const realNow = notificationClock.now

let rootFontSize = ''

beforeEach(async () => {
  await i18n.changeLanguage('en')
  ;(window as any).happyDOM.setViewport({ width: 1440, height: 900 })
  // The app's text size at 100 %, whatever an earlier file left.
  rootFontSize = document.documentElement.style.fontSize
  document.documentElement.style.fontSize = '16px'
  ;(window as any).go = { main: { App: { Invoke: async () => ({ ok: true }) } } }
  notificationClock.now = () => new Date(2026, 9, 22, 12)
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  accounts$.set([account, second])
  ui$.selectedAccount.set(account.id)
  ui$.selectedThread.set('')
  ui$.module.set('mail')
  ui$.settingsOpen.set(false)
  ui$.aboutOpen.set(false)
  ui$.paletteOpen.set(false)
  compose$.tabs.set([])
  compose$.activeTab.set('')
})

afterEach(async () => {
  cleanup()
  document.documentElement.dir = ''
  document.documentElement.style.fontSize = rootFontSize
  notificationClock.now = realNow
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  ui$.module.set('mail')
  ui$.settingsOpen.set(false)
  ui$.aboutOpen.set(false)
  ui$.paletteOpen.set(false)
  delete (window as any).go
  await i18n.changeLanguage('en')
})

// Focus goes back in a microtask after the menu is gone.
const settle = () => act(async () => await Promise.resolve())

/** What assistive technology reads: the text, without what is hidden from it (the shortcut, the check). */
function spoken(element: Element): string {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove())
  return copy.textContent?.trim() ?? ''
}

const itemsOf = (root: Element) => [...root.querySelectorAll<HTMLElement>('[role^="menuitem"]')]

function openMenu() {
  const view = render(<AppHeader />)
  const button = view.getByRole('button', { name: 'App menu' })
  fireEvent.click(button)
  return { view, button, menu: view.getByRole('menu', { name: 'App menu' }) }
}

describe('the top band (#343)', () => {
  it('is the first row of a banner named after the app, the "search" region, 2.25 rem tall', () => {
    const view = render(<AppHeader />)
    const banner = view.getByRole('banner', { name: 'Oreneta' })
    expect(banner.tagName).toBe('HEADER')
    const band = banner.firstElementChild as HTMLElement
    expect(band.dataset.region).toBe('search')
    expect(band.hasAttribute('data-top-band')).toBe(true)
    // 2.25 rem (h-9), so it grows with the app's zoom; today's frame tone.
    expect(band.className.split(' ')).toContain('h-9')
    expect(band.className.split(' ')).toContain('bg-header')
    // Start, centre and end: the centre holds the search (#344), the end is
    // laid out for 13c.
    expect([...band.children].map((area) => Object.keys((area as HTMLElement).dataset))).toEqual([
      ['bandStart'],
      ['bandCentre'],
      ['bandEnd'],
    ])
    expect((band.children[1] as HTMLElement).className).toContain('flex-1')
    expect(within(band.children[1] as HTMLElement).getByRole('search', { name: 'Search' })).toBeTruthy()
    // The app menu button at its start.
    const button = within(band.children[0] as HTMLElement).getByRole('button', { name: 'App menu' })
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByRole('menu')).toBeNull()
  })

  it('names the banner the same in every language: the app is called Oreneta', async () => {
    await act(async () => {
      await i18n.changeLanguage('ar')
    })
    const view = render(<AppHeader />)
    expect(view.getByRole('banner', { name: 'Oreneta' })).toBeTruthy()
    expect(view.getByRole('button', { name: messages.ar['appMenu.label'] })).toBeTruthy()
  })
})

describe('the app menu (#343)', () => {
  it("holds every command of the palette, once, grouped by area in the areas' order", () => {
    const commands = renderHook(useCommandList).result.current
    const { menu } = openMenu()
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length)
    const groups = within(menu).getAllByRole('group')
    const expected = groupCommandsByArea(commands)
    expect(expected.map((group) => group.area)).toEqual(
      COMMAND_AREAS.filter((area) => commands.some((command) => command.area === area)),
    )
    // Each group says its area, and holds that area's commands, in order.
    expect(groups.map((group) => document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent)).toEqual(
      expected.map((group) => t(`appMenu.area.${group.area}`)),
    )
    expect(groups.map((group) => itemsOf(group).map(spoken))).toEqual(
      expected.map((group) => group.commands.map((command) => command.label)),
    )
    // Nothing else: as many items as commands.
    expect(itemsOf(menu)).toHaveLength(commands.length)
  })

  it("takes in the rail's More menu, each item once", () => {
    const { menu } = openMenu()
    const names = itemsOf(menu).map(spoken)
    for (const name of [
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
    ])
      expect(
        names.filter((item) => item === name),
        name,
      ).toHaveLength(1)
    expect(new Set(names).size).toBe(names.length)
    // "Open settings" leads its group, before the sections it can open.
    const settings = within(menu)
      .getAllByRole('group')
      .find((group) => group.textContent?.startsWith('Settings'))!
    expect(spoken(itemsOf(settings)[0])).toBe('Open settings')
  })

  it('shows the state of what it switches as radio items: the module, the theme, a filter', () => {
    ui$.module.set('calendar')
    const { menu } = openMenu()
    const calendar = within(menu).getByRole('menuitemradio', { name: 'Go to: Calendar' })
    expect(calendar.getAttribute('aria-checked')).toBe('true')
    expect(within(menu).getByRole('menuitemradio', { name: 'Go to: Mail' }).getAttribute('aria-checked')).toBe('false')
    expect(within(menu).getAllByRole('menuitemradio', { checked: true }).length).toBeGreaterThan(1)
    // Actions are plain items.
    expect(within(menu).getByRole('menuitem', { name: 'Open settings' })).toBeTruthy()
  })

  it('runs the command of an item, as the palette does, and closes', async () => {
    const { view, button, menu } = openMenu()
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Go to: Calendar' }))
    expect(ui$.module.peek()).toBe('calendar')
    expect(view.queryByRole('menu')).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
    // Back to mail from another module.
    fireEvent.click(button)
    fireEvent.click(view.getByRole('menuitemradio', { name: 'Go to: Mail' }))
    expect(ui$.module.peek()).toBe('mail')
    fireEvent.click(button)
    fireEvent.click(view.getByRole('menuitem', { name: 'Open settings' }))
    expect(ui$.settingsOpen.peek()).toBe(true)
    // The button has the focus, so the dialog the command opened gives it back there.
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    fireEvent.click(view.getByRole('menuitem', { name: 'About Oreneta' }))
    expect(ui$.aboutOpen.peek()).toBe(true)
    fireEvent.click(button)
    fireEvent.click(view.getByRole('menuitem', { name: 'Command palette' }))
    expect(ui$.paletteOpen.peek()).toBe(true)
    fireEvent.click(button)
    await act(async () => fireEvent.click(view.getByRole('menuitem', { name: 'Do not disturb until turned off' })))
    expect(settings$.notifications.peek().pause).toEqual({ until: null })
    fireEvent.click(button)
    expect(view.getByRole('menuitem', { name: 'Resume notifications' })).toBeTruthy()
    expect(view.queryByRole('menuitem', { name: 'Do not disturb for 1 hour' })).toBeNull()
  })

  it('leaves an unavailable command inert and says why', () => {
    accounts$.set([{ ...account, auth_type: 'graph_oauth' }])
    const { view } = openMenu()
    const compose = view.getByRole('menuitem', { name: 'Compose new message' })
    expect(compose.getAttribute('aria-disabled')).toBe('true')
    expect(compose.getAttribute('title')).toBe('No account available for sending')
    // The reason is also its accessible description, which reaches the
    // keyboard and a screen reader as a tooltip does not; the name stays its own.
    const reason = document.getElementById(compose.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toBe('No account available for sending')
    expect(reason?.className).toBe('sr-only')
    expect(compose.contains(reason)).toBe(false)
    expect(spoken(compose)).toBe('Compose new message')
    // An item that can run has none.
    expect(view.getByRole('menuitem', { name: 'Open settings' }).hasAttribute('aria-describedby')).toBe(false)
    fireEvent.click(compose)
    expect(compose$.tabs.peek()).toHaveLength(0)
    expect(view.getByRole('menu', { name: 'App menu' })).toBeTruthy()
  })

  it('opens with Down on its first item, moves with the arrows, finds by typing, and Escape gives the focus back', async () => {
    const view = render(<AppHeader />)
    const button = view.getByRole('button', { name: 'App menu' })
    button.focus()
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    const menu = view.getByRole('menu', { name: 'App menu' })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(menu.id)
    const items = itemsOf(menu)
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[items.length - 1])
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(items[items.length - 1])
    // Typeahead: "a" goes to the next item that starts with it.
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    fireEvent.keyDown(document.activeElement!, { key: 'a' })
    expect(spoken(document.activeElement!)).toBe('Add account')
    // The menu itself is a Tab stop, so its scrolling list is reachable as such.
    expect(menu.tabIndex).toBe(0)
    fireEvent.keyDown(window, { key: 'Escape' })
    await settle()
    expect(view.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    // Up opens it on its last item.
    fireEvent.keyDown(button, { key: 'ArrowUp' })
    const last = itemsOf(view.getByRole('menu', { name: 'App menu' })).at(-1)!
    // Identity as a boolean: a failed toBe between two elements hangs Bun's diff.
    expect(document.activeElement === last).toBe(true)
    expect(spoken(last)).toBe('About Oreneta')
  })

  it('closes on a second click of the button, a click outside, and the focus leaving it', async () => {
    const view = render(
      <>
        <AppHeader />
        <button type="button" id="outside">
          Outside
        </button>
      </>,
    )
    const button = view.getByRole('button', { name: 'App menu' })
    const outside = document.getElementById('outside')!
    // Read straight from the DOM: role queries over the long menu are slow.
    const menu = () => view.container.querySelector('[role="menu"]')
    fireEvent.click(button)
    expect(menu()).not.toBeNull()
    fireEvent.click(button)
    expect(menu()).toBeNull()
    fireEvent.click(button)
    fireEvent.pointerDown(outside)
    expect(menu()).toBeNull()
    // F6 or a click moves the focus elsewhere: the menu goes.
    fireEvent.click(button)
    expect(menu()).not.toBeNull()
    await act(async () => outside.focus())
    expect(document.activeElement).toBe(outside)
    expect(menu()).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  for (const direction of ['ltr', 'rtl'] as const) {
    it(`opens under the button from its start edge, towards the end of the line: ${direction}`, () => {
      document.documentElement.dir = direction
      const view = render(<AppHeader />)
      const button = view.getByRole('button', { name: 'App menu' })
      const rect = direction === 'ltr' ? { left: 100, right: 132 } : { left: 1300, right: 1332 }
      button.getBoundingClientRect = () => ({
        ...rect,
        top: 2,
        bottom: 33.5,
        width: 32,
        height: 31.5,
        x: rect.left,
        y: 2,
        toJSON: () => ({}),
      })
      fireEvent.click(button)
      const menu = view.getByRole('menu', { name: 'App menu' })
      // 20 rem wide; its start edge at the button's start edge, whole pixels.
      expect(menu.style.width).toBe('320px')
      expect(menu.style.top).toBe('38px')
      expect(menu.style.left).toBe(direction === 'ltr' ? '100px' : `${1332 - 320}px`)
      expect(menu.style.maxHeight).toBe(`${900 - 38 - 8}px`)
    })
  }

  it('never runs past a narrow window: as wide as it can be, inside its edges', () => {
    ;(window as any).happyDOM.setViewport({ width: 320, height: 500 })
    const view = render(<AppHeader />)
    const button = view.getByRole('button', { name: 'App menu' })
    button.getBoundingClientRect = () => ({
      left: 4,
      right: 36,
      top: 2,
      bottom: 34,
      width: 32,
      height: 32,
      x: 4,
      y: 2,
      toJSON: () => ({}),
    })
    fireEvent.click(button)
    const menu = view.getByRole('menu', { name: 'App menu' })
    expect(menu.style.width).toBe(`${320 - 16}px`)
    expect(menu.style.left).toBe('8px')
    expect(menu.style.maxHeight).toBe(`${500 - 38 - 8}px`)
  })
})

describe('the names of the band and the menu (ADR-0068 §1, #343)', () => {
  // A screen reader reads two names that differ only in case or spacing the
  // same, so compare them as it would hear them.
  const regions = [
    'shell.region.mail',
    'shell.region.modules',
    // The band's search landmark (#344).
    'shell.region.search',
    'mailNavigation.title',
    'connectivity.health.title',
    'categories.label',
    'calendar.title',
    'calendar.calendars',
    'calendar.miniCalendar',
    'people.title',
    'people.contactGroups',
    'people.groups',
    'tasks.title',
    'tasks.taskLists',
    'notes.title',
    'notes.listLabel',
    'notes.editorLabel',
    'notes.tags',
    'notes.tagsPane',
    'messaging.title',
    'messaging.conversations',
    'messaging.groups',
    'messaging.direct',
    'messaging.invitations',
    'attachmentsView.title',
    'attachmentsView.filters',
    'settingsSearch.navigation',
  ]
  const clashes = (key: string, others: string[]) =>
    supportedI18nLanguages.flatMap((language) => {
      const catalog = messages[language]
      const heard = (s: string | undefined) =>
        (s ?? '').trim().normalize('NFC').toLocaleLowerCase(language.replace('_', '-'))
      const name = catalog[key]
      if (!name?.trim()) return [`${language}: missing`]
      return others
        .filter((other) => heard(catalog[other]) === heard(name))
        .map((other) => `${language}: same as ${other}, "${name}"`)
    })

  it('names the banner apart from every other region, in all 20 catalogs', () => {
    expect(supportedI18nLanguages.length).toBe(20)
    expect(clashes('shell.region.banner', [...regions, 'appMenu.label'])).toEqual([])
    for (const language of supportedI18nLanguages) expect(messages[language]['shell.region.banner']).toBe('Oreneta')
  })

  it("names the menu button apart from the rail's More, the palette and every region, in all 20 catalogs", () => {
    expect(clashes('appMenu.label', [...regions, 'common.more', 'palette.label', 'threads.actions.title'])).toEqual([])
    expect(messages.ca['appMenu.label']).toBe("Menú de l'aplicació")
    expect(messages.en['appMenu.label']).toBe('App menu')
  })

  it('has every string of the band and the menu in every catalog', () => {
    const keys = [
      'shell.region.banner',
      'appMenu.label',
      ...COMMAND_AREAS.map((area) => `appMenu.area.${area}`),
      'commands.aliases.module',
      'commands.aliases.app.about',
      'commands.aliases.notifications',
    ]
    const missing = supportedI18nLanguages.flatMap((language) =>
      keys.filter((key) => !messages[language][key]?.trim()).map((key) => `${language}: ${key}`),
    )
    expect(missing).toEqual([])
    // Each group title differs from the others, so no two groups sound alike.
    for (const language of supportedI18nLanguages) {
      const titles = COMMAND_AREAS.map((area) => messages[language][`appMenu.area.${area}`].toLocaleLowerCase())
      expect(new Set(titles).size, language).toBe(COMMAND_AREAS.length)
    }
  })
})

describe('the app menu and the keys of the app behind it (#343)', () => {
  const thread = (id: string) =>
    ({ thread_id: id, id, account_id: account.id, folder_id: 'INBOX' }) as unknown as Message
  const board: KanbanBoard = {
    id: 'board-review',
    name: 'Review',
    columns: [{ accountId: account.id, folderId: 'INBOX' }],
  }
  let savedBoards: KanbanBoard[] = []
  beforeEach(() => {
    savedBoards = settings$.kanbanBoards.peek()
    // Nothing modal: AppHotkeys keeps the arrows then.
    ui$.assign({ setupOpen: false, shortcutsOpen: false, addFeedAccount: '', editFeed: null, confirm: null })
    ui$.filters.set([])
    mail$.threads.set([thread('t1'), thread('t2'), thread('t3')])
    ui$.selectedThread.set('t2')
  })
  afterEach(() => {
    kanban$.activeBoardId.set('')
    kanban$.paneThreadId.set('')
    kanban$.paneColumnKey.set('')
    kanban$.threads.set({})
    settings$.kanbanBoards.set(savedBoards)
    mail$.threads.set([])
    ui$.selectedThread.set('')
  })

  // Down and Up on the button, then the arrows in the open menu: none of them
  // may also step the selection behind it, as AppHotkeys does with the arrows.
  // None of the keys the button and the menu answer reaches the window, where
  // AppHotkeys listens.
  const pressArrows = async (selection: () => string) => {
    const view = render(
      <>
        <AppHotkeys />
        <AppHeader />
      </>,
    )
    const button = view.getByRole('button', { name: 'App menu' })
    const header = view.getByRole('banner', { name: 'Oreneta' })
    const reached: string[] = []
    const listen = (event: KeyboardEvent) => {
      if (event.target instanceof Node && header.contains(event.target)) reached.push(event.key)
    }
    window.addEventListener('keydown', listen)
    button.focus()
    const before = selection()
    try {
      for (const key of ['ArrowDown', 'ArrowUp']) {
        fireEvent.keyDown(button, { key })
        const menu = view.getByRole('menu', { name: 'App menu' })
        expect(selection(), key).toBe(before)
        for (const inside of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'Home', 'End']) {
          fireEvent.keyDown(document.activeElement!, { key: inside })
          expect(menu.contains(document.activeElement), inside).toBe(true)
          expect(selection(), `${key}, then ${inside} in the menu`).toBe(before)
        }
        fireEvent.keyDown(window, { key: 'Escape' })
        await settle()
        expect(document.activeElement === button, key).toBe(true)
      }
      // Enter and Space are the button's too.
      fireEvent.keyDown(button, { key: 'Enter' })
      fireEvent.keyDown(button, { key: ' ' })
      expect(selection()).toBe(before)
    } finally {
      window.removeEventListener('keydown', listen)
    }
    expect(reached).toEqual([])
    // Away from the menu, the same key does step it: the app is listening.
    button.blur()
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    expect(selection()).not.toBe(before)
  }

  it('Down on the button opens the menu and leaves the conversation list where it was', async () => {
    await pressArrows(() => ui$.selectedThread.peek())
    expect(ui$.selectedThread.peek()).toBe('t3')
  })

  it('Down on the button opens the menu and leaves the open card of a board where it was', async () => {
    settings$.kanbanBoards.set([board])
    kanban$.threads.set({ [`${account.id}\nINBOX`]: [thread('t1'), thread('t2'), thread('t3')] })
    kanban$.activeBoardId.set(board.id)
    kanban$.paneThreadId.set('t2')
    await pressArrows(() => kanban$.paneThreadId.peek())
    expect(kanban$.paneThreadId.peek()).toBe('t3')
  })

  it('opens the palette from inside the menu and, closing it, gives the focus back to the button', async () => {
    const view = render(
      <>
        <AppHotkeys />
        <AppHeader />
        <CommandPalette />
      </>,
    )
    const button = view.getByRole('button', { name: 'App menu' })
    fireEvent.click(button)
    const item = itemsOf(view.getByRole('menu', { name: 'App menu' }))[2]
    item.focus()
    await act(async () => {
      fireEvent.keyDown(item, { key: 'k', ctrlKey: !isMac, metaKey: isMac })
    })
    expect(ui$.paletteOpen.peek()).toBe(true)
    expect(!!view.container.querySelector('[role="menu"]')).toBe(false)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    // The palette takes the focus once it is drawn.
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
    const field = view.getByRole('combobox', { name: 'Command palette' })
    expect(document.activeElement === field).toBe(true)
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Escape' })
    })
    expect(ui$.paletteOpen.peek()).toBe(false)
    expect(document.activeElement === button).toBe(true)
  })

  it('lists "Command palette" in the menu, and not in the palette', () => {
    ui$.paletteOpen.set(true)
    const view = render(
      <>
        <AppHeader />
        <CommandPalette />
      </>,
    )
    const options = [...view.container.querySelectorAll('[role="option"] .block:first-child')].map(
      (label) => label.textContent,
    )
    expect(options).toContain('Keyboard shortcuts')
    expect(options).not.toContain('Command palette')
    fireEvent.click(view.getByRole('button', { name: 'App menu' }))
    const names = itemsOf(view.getByRole('menu', { name: 'App menu' })).map(spoken)
    expect(names.filter((name) => name === 'Command palette')).toHaveLength(1)
  })
})

describe('the band on the first-account setup screen (#343)', () => {
  it('holds the same app menu, with only what needs no account', () => {
    accounts$.set([])
    const { view, menu } = openMenu()
    expect(view.getByRole('banner', { name: 'Oreneta' })).toBeTruthy()
    const groups = within(menu).getAllByRole('group')
    expect(groups.map((group) => document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent)).toEqual(
      ['Theme', 'Settings', 'Application'],
    )
    const names = itemsOf(menu).map(spoken)
    for (const name of ['Open settings', 'Command palette', 'Keyboard shortcuts', 'About Oreneta'])
      expect(names, name).toContain(name)
    for (const name of [
      'Add account',
      'Go to: Mail',
      'Go to: Calendar',
      'Sync mailbox',
      'Compose new message',
      'Create kanban board',
      'Do not disturb for 1 hour',
    ])
      expect(names, name).not.toContain(name)
    // Nothing in it is inert: what cannot run without an account is not there.
    expect(menu.querySelectorAll('[aria-disabled="true"]')).toHaveLength(0)
  })
})
