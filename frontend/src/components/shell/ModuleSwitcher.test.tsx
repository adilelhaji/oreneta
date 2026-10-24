import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { useValue } from '@legendapp/state/react'
import i18n from '../../lib/i18n'
import { messages, supportedI18nLanguages } from '../../generated/locales'
import { accounts$ } from '../../states/accounts'
import { mail$ } from '../../states/mail'
import { messaging$, type ChatConversation, type ChatRoom } from '../../states/messaging'
import { settings$ } from '../../states/settings'
import { ui$ } from '../../states/ui'
import type { Account, Folder } from '../../types'
import { ModuleSwitcher, type ModuleSwitcherVariant } from './ModuleSwitcher'

// The module switcher (ADR-0068 §5, piece 14b, #354): the strip at the foot of
// the folder pane from 1025 px and the narrow bar from 769 to 1024 px.

const account = (id: string, extra: Partial<Account> = {}): Account => ({
  id,
  email: `${id}@example.test`,
  display_name: id,
  provider: 'imap',
  auth_type: 'password',
  imap_host: 'imap.example.test',
  imap_port: 993,
  smtp_host: 'smtp.example.test',
  smtp_port: 465,
  tls: true,
  ...extra,
})
const inbox = (accountId: string, unread: number): Folder[] => [
  { id: 'INBOX', account_id: accountId, name: 'Inbox', role: 'inbox', unread },
]
const conversation = (name: string, unread: number): ChatConversation => ({
  conversation: name,
  last_body: '',
  last_stamp: 0,
  last_direction: 'in',
  unread,
})
const room = (name: string, unread: number): ChatRoom => ({
  account: 'c1',
  room: name,
  nick: 'ana',
  has_password: false,
  last_body: '',
  last_stamp: 0,
  unread,
  state: 'joined',
})

const NAMES = ['Mail', 'Calendar', 'People', 'Tasks', 'Notes', 'Chat', 'Attachments']

// happy-dom lays nothing out: a test says how long the switcher is and how big
// a place, along the line in the strip and down the column in the bar.
const ownRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
const realRect = HTMLElement.prototype.getBoundingClientRect
const box = (width: number, height: number) =>
  ({ left: 0, right: width, top: 0, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
let layout: { length: number; place: number } | null = null
function lay(length: number, place: number) {
  layout = { length, place }
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const switcher = this.closest<HTMLElement>('[data-module-switcher]')
    if (!layout || !switcher) return realRect.call(this)
    const strip = switcher.dataset.moduleSwitcher === 'strip'
    if (this.tagName === 'UL') return strip ? box(layout.length, 40) : box(48, layout.length)
    if (this.hasAttribute('data-module-slot')) return strip ? box(layout.place, 40) : box(48, layout.place)
    return realRect.call(this)
  }
}

// The ResizeObserver the switcher sets up, so a test can resize it.
const RealResizeObserver = globalThis.ResizeObserver
let resized: (() => void)[] = []
class FakeResizeObserver {
  private notify = () => this.callback([], this as unknown as ResizeObserver)
  constructor(private callback: ResizeObserverCallback) {}
  observe() {
    resized.push(this.notify)
  }
  unobserve() {}
  disconnect() {
    resized = resized.filter((notify) => notify !== this.notify)
  }
}
function resize(length: number, place = layout?.place ?? 32) {
  lay(length, place)
  act(() => {
    for (const notify of resized) notify()
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  ;(globalThis as any).ResizeObserver = FakeResizeObserver
  resized = []
  document.documentElement.dir = ''
  accounts$.set([account('alex'), account('blai'), account('carla', { included_in_unified: false })])
  mail$.foldersByAccount.set({ alex: inbox('alex', 3), blai: inbox('blai', 4), carla: inbox('carla', 12) })
  settings$.showUnreadAccountBadge.set(true)
  messaging$.conversations.set([])
  messaging$.rooms.set([])
  ui$.module.set('mail')
})

afterEach(async () => {
  cleanup()
  layout = null
  if (ownRect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', ownRect)
  else delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect
  ;(globalThis as any).ResizeObserver = RealResizeObserver
  document.documentElement.dir = ''
  accounts$.set([])
  mail$.foldersByAccount.set({})
  settings$.showUnreadAccountBadge.set(false)
  messaging$.conversations.set([])
  messaging$.rooms.set([])
  ui$.module.set('mail')
  await i18n.changeLanguage('en')
  // What a switcher hands to the next one is forgotten after the task.
  await new Promise((resolve) => setTimeout(resolve, 0))
})

function draw(variant: ModuleSwitcherVariant = 'strip') {
  const view = render(<ModuleSwitcher variant={variant} />)
  const nav = () => view.getByRole('navigation', { name: 'Modules' })
  const buttons = () => within(nav()).getAllByRole('button')
  const names = () => buttons().map((button) => button.getAttribute('aria-label'))
  const button = (name: string) => within(nav()).getByRole('button', { name })
  return { view, nav, buttons, names, button }
}

describe('the module switcher (ADR-0068 §5, #354)', () => {
  it('is the «Mòduls» navigation, the F6 region `modules`, with a button for each module in order', () => {
    // Nothing unread, so no count says anything.
    mail$.foldersByAccount.set({})
    const { nav, buttons, names } = draw()
    expect(nav().tagName).toBe('NAV')
    expect(nav().dataset.region).toBe('modules')
    expect(nav().getAttribute('aria-label')).toBe('Modules')
    expect(names()).toEqual(NAMES)
    for (const element of buttons()) {
      // An icon with no text: the name is its tooltip and its accessible name,
      // so getByTitle('People') finds it as it found the rail's.
      expect(element.title).toBe(element.getAttribute('aria-label')!)
      expect(element.textContent).toBe('')
      expect(element.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
      // Each one a Tab stop, as tabs are (ADR-0061).
      expect(element.tabIndex).toBe(0)
    }
    // In a list, so its length is said.
    expect(within(nav()).getAllByRole('listitem')).toHaveLength(7)
  })

  it('names the region and each module in Catalan, and the region apart from the rest in every catalog', async () => {
    await act(async () => {
      await i18n.changeLanguage('ca')
    })
    const view = render(<ModuleSwitcher variant="strip" />)
    const nav = view.getByRole('navigation', { name: 'Mòduls' })
    expect(
      within(nav)
        .getAllByRole('button')
        .map((element) => element.title),
    ).toEqual(['Correu', 'Calendari', 'Persones', 'Tasques', 'Notes', 'Xat', 'Adjunts'])
    for (const language of supportedI18nLanguages) {
      const catalog = messages[language]
      const said = (key: string) => catalog[key].trim().toLocaleLowerCase()
      expect(catalog['shell.region.modules']?.trim(), language).toBeTruthy()
      for (const other of ['shell.region.mail', 'mailNavigation.title', 'appMenu.label', 'common.more'])
        expect(said('shell.region.modules') === said(other), `${language}: ${other}`).toBe(false)
    }
  })

  it('marks the active module: the current page, the selection and an accent bar, on the top edge of the strip', () => {
    ui$.module.set('people')
    const { button, buttons } = draw()
    const people = button('People')
    expect(people.getAttribute('aria-current')).toBe('page')
    expect(buttons().filter((element) => element.hasAttribute('aria-current'))).toEqual([people])
    expect(people.className.split(' ')).toEqual(expect.arrayContaining(['bg-active', 'text-accent-fg']))
    const bar = people.querySelector<HTMLElement>('span[aria-hidden="true"].bg-accent-fg')!
    expect(bar.className.split(' ')).toEqual(expect.arrayContaining(['top-0', 'h-0.5', 'inset-x-1.5']))
    expect(button('Mail').className).not.toContain('bg-active')
    expect(button('Mail').className).toContain('text-secondary')
  })

  it('draws the narrow bar in the module bar colour, the active module marked on its start edge', () => {
    ui$.module.set('tasks')
    const { nav, button } = draw('bar')
    expect(nav().dataset.moduleSwitcher).toBe('bar')
    expect(nav().className.split(' ')).toEqual(expect.arrayContaining(['bg-sidenav', 'flex-col']))
    // 3 rem, the width the app's sidebar counts for it (MODULE_BAR_REM).
    expect(nav().style.width).toBe('3rem')
    const tasks = button('Tasks')
    expect(tasks.getAttribute('aria-current')).toBe('page')
    const bar = tasks.querySelector<HTMLElement>('span[aria-hidden="true"].bg-accent-fg')!
    expect(bar.className.split(' ')).toEqual(expect.arrayContaining(['start-0.5', 'w-0.5']))
    // The others take the bar's light foreground (index.css), not a fixed colour.
    expect(button('Mail').className).toContain('text-(--module-bar-fg)')
    expect(button('Mail').className).not.toMatch(/\b(?:text|bg)-(?:white|black)\b/)
  })

  it('opens a module from its button, and the open one goes back to mail, as the rail did', () => {
    const { button } = draw()
    fireEvent.click(button('Calendar'))
    expect(ui$.module.peek()).toBe('calendar')
    expect(button('Calendar').getAttribute('aria-current')).toBe('page')
    fireEvent.click(button('Notes'))
    expect(ui$.module.peek()).toBe('notes')
    fireEvent.click(button('Notes'))
    expect(ui$.module.peek()).toBe('mail')
    fireEvent.click(button('Mail'))
    expect(ui$.module.peek()).toBe('mail')
  })
})

describe('the Mail and Chat counts (owner decision 2 on #352)', () => {
  const badge = (element: HTMLElement) => element.querySelector('span[aria-hidden="true"].bg-accent')?.textContent
  const description = (element: HTMLElement) =>
    document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent

  it("shows the unified inbox's number on Mail: the inboxes of the accounts it takes in", () => {
    const { button } = draw()
    // Alex's 3 and Blai's 4; Carla is not in the unified inbox.
    expect(badge(button('Mail'))).toBe('7')
    // Said in words as the description; the name stays the module's.
    expect(description(button('Mail'))).toBe('7 unread')
    expect(button('Mail').getAttribute('aria-label')).toBe('Mail')
    act(() => mail$.foldersByAccount.blai.set(inbox('blai', 0)))
    expect(badge(button('Mail'))).toBe('3')
    act(() => mail$.foldersByAccount.alex.set(inbox('alex', 0)))
    expect(badge(button('Mail'))).toBeUndefined()
    expect(button('Mail').hasAttribute('aria-describedby')).toBe(false)
  })

  it('hides the Mail count while the unread badges are off, and caps it at 99+', () => {
    const { button } = draw()
    act(() => settings$.showUnreadAccountBadge.set(false))
    expect(badge(button('Mail'))).toBeUndefined()
    expect(button('Mail').hasAttribute('aria-describedby')).toBe(false)
    act(() => {
      settings$.showUnreadAccountBadge.set(true)
      mail$.foldersByAccount.alex.set(inbox('alex', 150))
    })
    expect(badge(button('Mail'))).toBe('99+')
    expect(description(button('Mail'))).toBe('154 unread')
  })

  it("shows Chat's own unread count, its conversations' and its groups', whatever the badges setting", () => {
    settings$.showUnreadAccountBadge.set(false)
    const { button } = draw('bar')
    expect(badge(button('Chat'))).toBeUndefined()
    act(() => {
      messaging$.conversations.set([conversation('pau@chat.test', 2), conversation('ona@chat.test', 0)])
      messaging$.rooms.set([room('team@rooms.chat.test', 3)])
    })
    expect(badge(button('Chat'))).toBe('5')
    expect(description(button('Chat'))).toBe('5 unread')
    // The other modules count nothing.
    for (const name of ['Calendar', 'People', 'Tasks', 'Notes', 'Attachments'])
      expect(badge(button(name)), name).toBeUndefined()
    // On the bar its ring is the bar's colour; on the strip, the pane's.
    expect(button('Chat').querySelector('span.bg-accent')?.className).toContain('ring-sidenav')
    cleanup()
    const strip = draw()
    expect(strip.button('Chat').querySelector('span.bg-accent')?.className).toContain('ring-app')
  })
})

describe('what does not fit goes into «Més»', () => {
  it('draws the seven in a 260 px pane at 100 %, and two and «Més» at the app’s 200 %', () => {
    // 260 px less the pane's 1 px border and the strip's 2 px each side, in 2 rem places.
    lay(255, 32)
    const { names, nav, button } = draw()
    expect(names()).toEqual(NAMES)
    // The app's 200 %: places of 64 px, and 4 px each side.
    resize(251, 64)
    expect(names()).toEqual(['Mail', 'Calendar', 'More'])
    const more = button('More')
    expect(more.getAttribute('aria-haspopup')).toBe('menu')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(more.title).toBe('More')
    // And back.
    resize(255, 32)
    expect(names()).toEqual(NAMES)
    expect(within(nav()).queryByRole('button', { name: 'More' })).toBeNull()
    // The narrowest pane, 200 px: five and «Més».
    resize(195, 32)
    expect(names()).toEqual(['Mail', 'Calendar', 'People', 'Tasks', 'Notes', 'More'])
  })

  it('lists the others in the order of the strip, never the active module, and opens one from there', () => {
    ui$.module.set('notes')
    lay(251, 64)
    const { names, button, view } = draw()
    expect(names()).toEqual(['Mail', 'Notes', 'More'])
    fireEvent.click(button('More'))
    expect(button('More').getAttribute('aria-expanded')).toBe('true')
    const menu = view.getByRole('menu', { name: 'More' })
    expect(button('More').getAttribute('aria-controls')).toBe(menu.id)
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Calendar', 'People', 'Tasks', 'Chat', 'Attachments'])
    // The menu takes the focus, on its first item.
    expect(document.activeElement).toBe(items[0])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Chat' }))
    expect(ui$.module.peek()).toBe('chat')
    expect(view.queryByRole('menu')).toBeNull()
    // Chat now has the last place; Notes went into «Més».
    expect(names()).toEqual(['Mail', 'Chat', 'More'])
    expect(button('Chat').getAttribute('aria-current')).toBe('page')
    // The focus is on the button of the module just opened.
    expect(document.activeElement).toBe(button('Chat'))
  })

  it('says a count in «Més» too, and Escape gives the focus back to «Més»', () => {
    messaging$.conversations.set([conversation('pau@chat.test', 4)])
    lay(251, 64)
    const { button, view } = draw()
    fireEvent.click(button('More'))
    const menu = view.getByRole('menu', { name: 'More' })
    const chat = within(menu).getByRole('menuitem', { name: 'Chat' })
    expect(document.getElementById(chat.getAttribute('aria-describedby')!)?.textContent).toBe('4 unread')
    expect(chat.querySelector('span[aria-hidden="true"].bg-accent')?.textContent).toBe('4')
    fireEvent.keyDown(chat, { key: 'Escape' })
    expect(view.queryByRole('menu')).toBeNull()
    expect(ui$.module.peek()).toBe('mail')
    return Promise.resolve().then(() => expect(document.activeElement).toBe(button('More')))
  })

  it('moves the focus to «Més» when the button that had it goes there', () => {
    lay(255, 32)
    const { button } = draw()
    button('Attachments').focus()
    resize(251, 64)
    expect(document.activeElement).toBe(button('More'))
    // A button that stays keeps it.
    resize(255, 32)
    button('Calendar').focus()
    resize(251, 64)
    expect(document.activeElement).toBe(button('Calendar'))
  })

  it('gives the focus to the last button when the place grows with «Més» open, rather than to the page', () => {
    lay(251, 64)
    const { button, names, view } = draw()
    fireEvent.click(button('More'))
    const menu = view.getByRole('menu', { name: 'More' })
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[0])
    // The pane widened while the menu was open: the seven fit, and «Més» goes.
    resize(255, 32)
    expect(names()).toEqual(NAMES)
    expect(view.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(button('Attachments'))
    return Promise.resolve().then(() => expect(document.activeElement).toBe(button('Attachments')))
  })

  it('keeps its menu listening once, however often the switcher draws again', () => {
    lay(251, 64)
    const { button } = draw()
    fireEvent.click(button('More'))
    const added: string[] = []
    const add = document.addEventListener
    document.addEventListener = function (this: Document, type: string, ...rest: unknown[]) {
      added.push(type)
      return (add as (...args: unknown[]) => void).call(this, type, ...rest)
    } as typeof document.addEventListener
    try {
      // A count changing draws the switcher, and the menu with it, again.
      act(() => messaging$.conversations.set([conversation('pau@chat.test', 1)]))
      act(() => messaging$.conversations.set([conversation('pau@chat.test', 2)]))
      act(() => mail$.foldersByAccount.alex.set(inbox('alex', 9)))
    } finally {
      document.addEventListener = add
    }
    expect(added).toEqual([])
  })

  it('does the same in the narrow bar, by its height', () => {
    ui$.module.set('attachments')
    // Six 48 px places: five buttons and «Més».
    lay(6 * 48, 48)
    const { names } = draw('bar')
    expect(names()).toEqual(['Mail', 'Calendar', 'People', 'Tasks', 'Attachments', 'More'])
    resize(7 * 48)
    expect(names()).toEqual(NAMES)
  })
})

describe('the keyboard', () => {
  const press = (key: string, extra: Record<string, unknown> = {}) =>
    fireEvent.keyDown(document.activeElement!, { key, ...extra })
  const focused = () => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label')

  it('goes round the strip with the side arrows in reading order, with Home and End, «Més» included', () => {
    lay(251 + 64 * 2, 64)
    const { button } = draw()
    button('Mail').focus()
    press('ArrowRight')
    expect(focused()).toBe('Calendar')
    press('ArrowRight')
    press('ArrowRight')
    expect(focused()).toBe('Tasks')
    press('ArrowRight')
    expect(focused()).toBe('More')
    // Round to the first, and back.
    press('ArrowRight')
    expect(focused()).toBe('Mail')
    press('ArrowLeft')
    expect(focused()).toBe('More')
    press('Home')
    expect(focused()).toBe('Mail')
    press('End')
    expect(focused()).toBe('More')
    // Moving opens nothing.
    expect(ui$.module.peek()).toBe('mail')
  })

  it('follows the reading in right to left: the left arrow goes on', () => {
    document.documentElement.dir = 'rtl'
    const view = render(
      <div dir="rtl" style={{ direction: 'rtl' }}>
        <ModuleSwitcher variant="strip" />
      </div>,
    )
    const nav = view.getByRole('navigation', { name: 'Modules' })
    within(nav).getByRole('button', { name: 'Mail' }).focus()
    press('ArrowLeft')
    expect(focused()).toBe('Calendar')
    press('ArrowRight')
    expect(focused()).toBe('Mail')
    press('ArrowRight')
    expect(focused()).toBe('Attachments')
    press('End')
    expect(focused()).toBe('Attachments')
    press('Home')
    expect(focused()).toBe('Mail')
  })

  it('keeps the keys it answers, and lets the others through to the window', () => {
    const { button } = draw()
    const reached: string[] = []
    const listen = (event: KeyboardEvent) => reached.push(event.key)
    window.addEventListener('keydown', listen)
    try {
      button('Mail').focus()
      for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End', 'ArrowDown', 'j']) press(key)
      // Up and Down mean nothing along the strip: they still step the list, as on the rail.
      expect(reached).toEqual(['ArrowDown', 'j'])
      // A chord is not the switcher's either.
      press('ArrowRight', { altKey: true })
      expect(reached).toEqual(['ArrowDown', 'j', 'ArrowRight'])
    } finally {
      window.removeEventListener('keydown', listen)
    }
  })

  it('goes up and down the narrow bar, and along it with the side arrows too', () => {
    const { button } = draw('bar')
    button('Mail').focus()
    press('ArrowDown')
    expect(focused()).toBe('Calendar')
    press('ArrowUp')
    press('ArrowUp')
    expect(focused()).toBe('Attachments')
    press('ArrowRight')
    expect(focused()).toBe('Mail')
    press('End')
    expect(focused()).toBe('Attachments')
  })

  it('puts the focus on the pressed button in the strip drawn for the module that opens', () => {
    // Each module draws its own folder pane, and with it its own strip.
    function Pane() {
      const module = useValue(ui$.module)
      return <ModuleSwitcher key={module} variant="strip" />
    }
    const view = render(<Pane />)
    const strip = () => view.getByRole('navigation', { name: 'Modules' })
    const calendar = within(strip()).getByRole('button', { name: 'Calendar' })
    calendar.focus()
    fireEvent.click(calendar)
    expect(ui$.module.peek()).toBe('calendar')
    // A new strip, and the focus on its Calendar button rather than the page.
    expect(calendar.isConnected).toBe(false)
    expect(document.activeElement).toBe(within(strip()).getByRole('button', { name: 'Calendar' }))
    // The same from the keyboard: Enter on People.
    const people = within(strip()).getByRole('button', { name: 'People' })
    people.focus()
    fireEvent.click(people)
    expect(document.activeElement).toBe(within(strip()).getByRole('button', { name: 'People' }))
    // A module opened from elsewhere (the app menu) leaves the focus alone.
    const outside = document.createElement('button')
    document.body.append(outside)
    try {
      outside.focus()
      act(() => ui$.module.set('tasks'))
      expect(document.activeElement).toBe(outside)
    } finally {
      outside.remove()
    }
  })

  it('puts the focus on «Més» when the open module, there in the strip, goes back to mail', () => {
    // The app's 200 % in a 260 px pane: Mail, the open module and «Més».
    function Pane() {
      const module = useValue(ui$.module)
      return <ModuleSwitcher key={module} variant="strip" />
    }
    ui$.module.set('notes')
    lay(251, 64)
    const view = render(<Pane />)
    const strip = () => view.getByRole('navigation', { name: 'Modules' })
    const names = () =>
      within(strip())
        .getAllByRole('button')
        .map((element) => element.getAttribute('aria-label'))
    expect(names()).toEqual(['Mail', 'Notes', 'More'])
    const notes = within(strip()).getByRole('button', { name: 'Notes' })
    notes.focus()
    fireEvent.click(notes)
    expect(ui$.module.peek()).toBe('mail')
    // Mail's strip, drawn with all seven before it is measured: Notes is in
    // «Més» once it is, and the focus with it rather than on the page.
    expect(names()).toEqual(['Mail', 'Calendar', 'More'])
    expect(document.activeElement).toBe(within(strip()).getByRole('button', { name: 'More' }))
  })
})

describe('the focus across 1025 px, where the strip and the narrow bar take each other’s place', () => {
  // The strip at the foot of the folder pane, or the bar at the start of the
  // row: different elements, drawn by different parts of the app.
  function Frame({ strip, bar }: { strip: boolean; bar: boolean }) {
    return (
      <>
        {bar && <ModuleSwitcher variant="bar" />}
        <div data-folder-pane="">{strip && <ModuleSwitcher variant="strip" />}</div>
      </>
    )
  }
  const switcher = (variant: ModuleSwitcherVariant) =>
    document.querySelector<HTMLElement>(`nav[data-module-switcher="${variant}"]`)!
  const buttonIn = (variant: ModuleSwitcherVariant, name: string) =>
    within(switcher(variant)).getByRole('button', { name })

  it('keeps the focus on the same module, narrowing and widening, in one go', () => {
    lay(255, 32)
    ui$.module.set('notes')
    const view = render(<Frame strip bar={false} />)
    buttonIn('strip', 'People').focus()
    view.rerender(<Frame strip={false} bar />)
    expect(document.activeElement).toBe(buttonIn('bar', 'People'))
    view.rerender(<Frame strip bar={false} />)
    expect(document.activeElement).toBe(buttonIn('strip', 'People'))
    // Nothing opened on the way.
    expect(ui$.module.peek()).toBe('notes')
  })

  it('keeps it when the browser dropped it first, the folder pane hidden by CSS', () => {
    lay(255, 32)
    const view = render(<Frame strip bar={false} />)
    buttonIn('strip', 'Tasks').focus()
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    view.rerender(<Frame strip={false} bar />)
    expect(document.activeElement).toBe(buttonIn('bar', 'Tasks'))
  })

  it('keeps it whichever is drawn first: the bar before the strip goes, or after, in the same task', () => {
    lay(255, 32)
    const view = render(<Frame strip bar={false} />)
    buttonIn('strip', 'Chat').focus()
    // The bar first, with the strip still there.
    view.rerender(<Frame strip bar />)
    expect(document.activeElement).toBe(buttonIn('bar', 'Chat'))
    view.rerender(<Frame strip={false} bar />)
    expect(document.activeElement).toBe(buttonIn('bar', 'Chat'))
    // The bar gone first, and the strip drawn after it in the same task.
    view.rerender(<Frame strip={false} bar={false} />)
    view.rerender(<Frame strip bar={false} />)
    expect(document.activeElement).toBe(buttonIn('strip', 'Chat'))
  })

  it('leaves the focus where a command put it when the module changes with the focus in the strip', () => {
    // «Search all messages» from Notes: mail opens and the band's search field
    // takes the focus once mail is drawn, before the new strip is measured.
    function Pane() {
      const module = useValue(ui$.module)
      const field = useRef<HTMLInputElement | null>(null)
      useEffect(() => {
        if (module === 'mail') field.current?.focus()
      }, [module])
      return (
        <>
          <input ref={field} aria-label="Search messages" />
          <ModuleSwitcher key={module} variant="strip" />
        </>
      )
    }
    lay(255, 32)
    ui$.module.set('notes')
    const view = render(<Pane />)
    within(view.getByRole('navigation', { name: 'Modules' }))
      .getByRole('button', { name: 'Notes' })
      .focus()
    act(() => ui$.module.set('mail'))
    expect(document.activeElement).toBe(view.getByRole('textbox', { name: 'Search messages' }))
  })

  it('puts it on «Més» when its module is there on the other side, and leaves focus elsewhere alone', async () => {
    // A strip with all seven; a bar with room for four and «Més».
    lay(255, 32)
    const view = render(<Frame strip bar={false} />)
    buttonIn('strip', 'Attachments').focus()
    layout = { length: 5 * 32, place: 32 }
    view.rerender(<Frame strip={false} bar />)
    expect(document.activeElement).toBe(buttonIn('bar', 'More'))
    // The focus somewhere else in the page stays there.
    lay(255, 32)
    const outside = document.createElement('button')
    document.body.append(outside)
    try {
      outside.focus()
      view.rerender(<Frame strip bar={false} />)
      expect(document.activeElement).toBe(outside)
      // And a switcher drawn in a later task never takes it from the page.
      buttonIn('strip', 'Calendar').focus()
      view.rerender(<Frame strip={false} bar={false} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
      view.rerender(<Frame strip={false} bar />)
      expect(document.activeElement).toBe(document.body)
    } finally {
      outside.remove()
    }
  })
})
