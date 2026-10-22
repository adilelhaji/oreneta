import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook, within } from '@testing-library/react'
import i18n, { t } from '../../lib/i18n'
import { messages, supportedI18nLanguages } from '../../generated/locales'
import { DEFAULT_NOTIFICATION_PREFS } from '../../lib/quietHours'
import { accounts$ } from '../../states/accounts'
import { compose$ } from '../../states/compose'
import { notificationClock } from '../../states/notifications'
import { settings$ } from '../../states/settings'
import { ui$ } from '../../states/ui'
import type { Account } from '../../types'
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
    // Start, centre and end, laid out for 13b and 13c.
    expect([...band.children].map((area) => Object.keys((area as HTMLElement).dataset))).toEqual([
      ['bandStart'],
      ['bandCentre'],
      ['bandEnd'],
    ])
    expect((band.children[1] as HTMLElement).className).toContain('flex-1')
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
      'commands.aliases.palette.open',
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
