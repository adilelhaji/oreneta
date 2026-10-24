import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { MailNavigation } from './MailNavigation'
import { SideNav } from './SideNav'
import { AppHotkeys } from '../dialog/AppHotkeys'
import { accounts$, shownAccountOrder } from '../../states/accounts'
import { accountGroups$ } from '../../states/accountGroups'
import { beginFeedDrag, endFeedDrag, feedDragSourceAccount, RSS_FEED_DRAG_TYPE } from '../../states/feeds'
import { folderPrefs$ } from '../../states/folderPrefs'
import { kanban$ } from '../../states/kanban'
import { mail$ } from '../../states/mail'
import { settings$, type KanbanBoard } from '../../states/settings'
import { settleConfirm, ui$ } from '../../states/ui'
import type { Account, Folder } from '../../types'

// What «Comptes i carpetes» took over from the vertical rail (ADR-0068 §5,
// piece 14a, #353): accounts that reorder, open their menu, count their
// unread mail, say their state and take a dropped feed; the «Taulers»
// section; the unified inbox's menu. The rail is still there and shares all of
// it: one order, one menu, one shortcut sequence.

const account = (id: string, name: string, extra: Partial<Account> = {}): Account => ({
  id,
  email: `${id}@example.test`,
  display_name: name,
  provider: 'imap',
  auth_type: 'password',
  imap_host: 'imap.example.test',
  imap_port: 993,
  smtp_host: 'smtp.example.test',
  smtp_port: 465,
  tls: true,
  ...extra,
})
const alex = account('alex', 'Alex')
const blai = account('blai', 'Blai')
const carla = account('carla', 'Carla')
const inbox = (accountId: string, unread: number): Folder[] => [
  { id: 'INBOX', account_id: accountId, name: 'Inbox', role: 'inbox', unread },
  { id: 'Sent', account_id: accountId, name: 'Sent', role: 'sent', unread: 0 },
]
const board = (id: string, name: string, avatarUrl?: string): KanbanBoard => ({
  id,
  name,
  columns: [{ accountId: 'unified', folderId: 'inbox' }],
  ...(avatarUrl ? { avatarUrl } : {}),
})

let calls: Array<{ command: string; payload: any }> = []

beforeEach(() => {
  calls = []
  ;(window as any).go = {
    main: { App: { Invoke: async (command: string, payload: any) => (calls.push({ command, payload }), {}) } },
  }
  accounts$.set([alex, blai, carla])
  mail$.foldersByAccount.set({ alex: inbox('alex', 3), blai: inbox('blai', 0), carla: inbox('carla', 12) })
  ui$.module.set('mail')
  ui$.selectedAccount.set('alex')
  ui$.selectedFolder.set('INBOX')
  kanban$.activeBoardId.set('')
  settings$.kanbanBoards.set([])
  settings$.hiddenSideNavAccounts.set([])
  settings$.showUnifiedInboxInSideNav.set(true)
  settings$.showUnreadAccountBadge.set(true)
  accountGroups$.groups.set([])
  accountGroups$.active.set(null)
  folderPrefs$.favorites.set([])
  folderPrefs$.hidden.set([])
  folderPrefs$.dropped.set(0)
})

afterEach(() => {
  cleanup()
  delete (window as any).go
  settings$.kanbanBoards.set([])
  settings$.showUnreadAccountBadge.set(false)
  kanban$.activeBoardId.set('')
})

function pane() {
  const view = render(<MailNavigation />)
  const row = (key: string) => view.container.querySelector<HTMLElement>(`[data-nav-row="${key}"]`)!
  const rows = () =>
    [...view.container.querySelectorAll<HTMLElement>('[data-nav-row]')].map((element) =>
      element.getAttribute('data-nav-row'),
    )
  const announced = () => view.container.querySelector('p[aria-live="polite"]')?.textContent ?? ''
  return { view, row, rows, announced }
}

const order = () => accounts$.peek().map((item) => item.id)

describe('accounts in «Comptes i carpetes» (#353)', () => {
  it('reorder with Alt+↓ and Alt+↑ through the saved order, keeping the focus and saying where they went', () => {
    const { row, rows, announced } = pane()
    expect(rows().filter((key) => key!.startsWith('account:'))).toEqual([
      'account:alex',
      'account:blai',
      'account:carla',
    ])
    expect(row('account:alex').getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown')
    row('account:alex').focus()
    fireEvent.keyDown(row('account:alex'), { key: 'ArrowDown', altKey: true })
    expect(order()).toEqual(['blai', 'alex', 'carla'])
    expect(calls.find((call) => call.command === 'account.reorder')?.payload).toEqual({
      accounts: ['blai', 'alex', 'carla'],
    })
    expect(rows().filter((key) => key!.startsWith('account:'))).toEqual([
      'account:blai',
      'account:alex',
      'account:carla',
    ])
    expect(document.activeElement).toBe(row('account:alex'))
    expect(announced()).toBe('Alex moved to position 2 of 3')
    fireEvent.keyDown(row('account:carla'), { key: 'ArrowUp', altKey: true })
    expect(order()).toEqual(['blai', 'carla', 'alex'])
    expect(announced()).toBe('Carla moved to position 2 of 3')
    // The first one goes no higher, and a plain arrow moves nothing.
    fireEvent.keyDown(row('account:blai'), { key: 'ArrowUp', altKey: true })
    fireEvent.keyDown(row('account:blai'), { key: 'ArrowDown' })
    expect(order()).toEqual(['blai', 'carla', 'alex'])
  })

  it('share their order with the rail, and hidden accounts keep their places in it', () => {
    settings$.hiddenSideNavAccounts.set(['blai'])
    const view = render(
      <>
        <SideNav />
        <MailNavigation />
      </>,
    )
    const rail = view.getByRole('complementary', { name: 'Modules' })
    const railOrder = () =>
      within(rail)
        .getAllByRole('button')
        .flatMap((element) => (element.getAttribute('aria-roledescription') === 'sortable' ? [element.title] : []))
    const paneRow = (id: string) => view.container.querySelector<HTMLElement>(`[data-nav-row="account:${id}"]`)!
    const paneOrder = () =>
      [...view.container.querySelectorAll('[data-nav-row^="account:"]')].map((element) =>
        element.getAttribute('data-nav-row')!.slice('account:'.length),
      )
    expect(railOrder()).toEqual(['Alex (alex@example.test)', 'Carla (carla@example.test)'])
    expect(paneOrder()).toEqual(['alex', 'carla'])
    fireEvent.keyDown(paneRow('alex'), { key: 'ArrowDown', altKey: true })
    // Blai, hidden, stays second in the saved order.
    expect(order()).toEqual(['carla', 'blai', 'alex'])
    expect(paneOrder()).toEqual(['carla', 'alex'])
    expect(railOrder()).toEqual(['Carla (carla@example.test)', 'Alex (alex@example.test)'])
  })

  it('compute one order for the rail and the pane, moving only among the accounts shown', () => {
    const all = ['a', 'b', 'c', 'd']
    expect(shownAccountOrder(all, all, 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(shownAccountOrder(all, ['a', 'c', 'd'], 'd', 'a')).toEqual(['d', 'b', 'a', 'c'])
    expect(shownAccountOrder(all, ['a', 'c'], 'a', 'b')).toBeNull()
  })

  it('open their menu with the mouse, Shift+F10 and the context menu key, and give the focus back', () => {
    const { view, row } = pane()
    fireEvent.contextMenu(row('account:blai'))
    const menu = view.getByRole('menu', { name: 'Blai' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Account settings...', 'Mark all as read', 'Mute notifications', 'Pause account', 'Hide account'])
    // Nothing unread in Blai's inbox.
    expect(within(menu).getByRole('menuitem', { name: 'Mark all as read' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('menu')).toBeNull()

    row('account:carla').focus()
    fireEvent.keyDown(row('account:carla'), { key: 'F10', shiftKey: true })
    expect(view.getByRole('menu', { name: 'Carla' })).toBeTruthy()
    expect((document.activeElement as HTMLElement).textContent).toBe('Account settings...')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(view.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(row('account:carla'))

    fireEvent.keyDown(row('account:carla'), { key: 'ContextMenu' })
    fireEvent.click(view.getByRole('menuitem', { name: 'Mute notifications' }))
    expect(calls.filter((call) => call.command === 'account.setMuted').map((call) => call.payload)).toEqual([
      { id: 'carla', enabled: true },
    ])
    expect(document.activeElement).toBe(row('account:carla'))
  })

  it('hide from their menu, which no longer speaks of the side navigation, and keep the focus in the list', () => {
    const { view, row, announced } = pane()
    // The account open stays in the pane, as before, and keeps the focus:
    // nothing went, so nothing is said.
    row('account:alex').focus()
    fireEvent.keyDown(row('account:alex'), { key: 'ContextMenu' })
    fireEvent.click(view.getByRole('menuitem', { name: 'Hide account' }))
    expect(settings$.hiddenSideNavAccounts.peek()).toEqual(['alex'])
    expect(document.activeElement).toBe(row('account:alex'))
    expect(announced()).toBe('')
    row('account:blai').focus()
    fireEvent.keyDown(row('account:blai'), { key: 'ContextMenu' })
    expect(view.queryByRole('menuitem', { name: 'Hide from side navigation' })).toBeNull()
    fireEvent.click(view.getByRole('menuitem', { name: 'Hide account' }))
    expect(settings$.hiddenSideNavAccounts.peek()).toEqual(['alex', 'blai'])
    expect(view.container.querySelector('[data-nav-row="account:blai"]')).toBeNull()
    // The row that took its place has the focus, and the hiding is said.
    expect(document.activeElement).toBe(row('account:carla'))
    expect(announced()).toBe('Blai hidden. It can be shown again from Settings.')
  })

  it('show the inbox unread count only while the unread badges are on', () => {
    const { view, row } = pane()
    expect(view.getByRole('button', { name: 'Alex alex@example.test 3' })).toBe(row('account:alex'))
    expect(view.getByRole('button', { name: 'Carla carla@example.test 12' })).toBe(row('account:carla'))
    expect(view.getByRole('button', { name: 'Blai blai@example.test' })).toBe(row('account:blai'))
    act(() => settings$.showUnreadAccountBadge.set(false))
    expect(view.getByRole('button', { name: 'Alex alex@example.test' })).toBe(row('account:alex'))
    expect(row('account:carla').querySelector('.mail-account-unread')).toBeNull()
  })

  it('say their state in words, not only with an icon, the most pressing first', () => {
    accounts$.set([
      { ...alex, needs_reconnect: true, paused: true },
      { ...blai, paused: true, muted: true },
      { ...carla, muted: true },
    ])
    settings$.showUnreadAccountBadge.set(false)
    const { view, row } = pane()
    expect(view.getByRole('button', { name: 'Alex alex@example.test Needs to sign in again' })).toBe(
      row('account:alex'),
    )
    expect(view.getByRole('button', { name: 'Blai blai@example.test Mail checks paused' })).toBe(row('account:blai'))
    expect(view.getByRole('button', { name: 'Carla carla@example.test Notifications muted' })).toBe(
      row('account:carla'),
    )
    expect(row('account:alex').title).toBe('Alex — alex@example.test — Needs to sign in again')
    // The icon is drawn for the eye; the words are for the screen reader.
    expect(row('account:blai').querySelector('svg.mail-account-status')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('take a feed dropped from the list on an RSS account, as on the rail', async () => {
    const feeds = account('rss-news', 'News', { provider: 'rss', auth_type: 'rss' })
    const other = account('rss-blogs', 'Blogs', { provider: 'rss', auth_type: 'rss' })
    accounts$.set([alex, feeds, other])
    const { row } = pane()
    const feed = { threadId: 'rss-blogs#rss#https://blog.example.test/feed', accountId: 'rss-blogs' }
    // While it is held, a browser shows only the type of what is dragged.
    const held = { types: [RSS_FEED_DRAG_TYPE], getData: () => '' }
    expect(fireEvent.dragOver(row('account:rss-news'), { dataTransfer: held })).toBe(false)
    expect(row('account:rss-news').getAttribute('data-drop-target')).toBe('ok')
    // Not a mail account, and not the account it comes from.
    expect(fireEvent.dragOver(row('account:alex'), { dataTransfer: held })).toBe(true)
    const dropped = { types: [RSS_FEED_DRAG_TYPE], getData: () => JSON.stringify(feed) }
    fireEvent.drop(row('account:rss-blogs'), { dataTransfer: dropped })
    expect(calls.filter((call) => call.command === 'rss.moveFeed')).toEqual([])
    // The move reloads the lists it changed: wait for it.
    await act(async () => {
      fireEvent.drop(row('account:rss-news'), { dataTransfer: dropped })
    })
    expect(row('account:rss-news').hasAttribute('data-drop-target')).toBe(false)
    expect(calls.filter((call) => call.command === 'rss.moveFeed')).toEqual([
      { command: 'rss.moveFeed', payload: { thread_id: feed.threadId, target_account_id: 'rss-news' } },
    ])
    // Any other drag is not a feed.
    expect(
      fireEvent.dragOver(row('account:rss-news'), { dataTransfer: { types: ['text/plain'], getData: () => '' } }),
    ).toBe(true)
  })

  it('refuse a feed held over the account it comes from, which the list noted when the drag began', () => {
    const feeds = account('rss-news', 'News', { provider: 'rss', auth_type: 'rss' })
    const other = account('rss-blogs', 'Blogs', { provider: 'rss', auth_type: 'rss' })
    accounts$.set([alex, feeds, other])
    const { row } = pane()
    const held = { types: [RSS_FEED_DRAG_TYPE], getData: () => '' }
    beginFeedDrag('rss-news')
    try {
      // Its own account: no drop, and no mark.
      expect(fireEvent.dragOver(row('account:rss-news'), { dataTransfer: held })).toBe(true)
      expect(row('account:rss-news').hasAttribute('data-drop-target')).toBe(false)
      // Another RSS account takes it.
      expect(fireEvent.dragOver(row('account:rss-blogs'), { dataTransfer: held })).toBe(false)
      expect(row('account:rss-blogs').getAttribute('data-drop-target')).toBe('ok')
    } finally {
      endFeedDrag()
    }
    expect(feedDragSourceAccount()).toBeNull()
  })
})

describe('«Taulers» in «Comptes i carpetes» (#353)', () => {
  beforeEach(() => {
    settings$.kanbanBoards.set([board('b1', 'Launch', 'data:image/png;base64,iVBORw0KGgo='), board('b2', 'Hiring')])
  })

  it('lists the boards in their order, between the unified inbox and the accounts, with their picture', () => {
    const { view, rows } = pane()
    // A group named «Taulers» under «Comptes», not a heading or a landmark of its own.
    const section = view.getByRole('group', { name: 'Boards' })
    expect(view.queryByRole('heading', { name: 'Boards' })).toBeNull()
    expect(view.queryByRole('region', { name: 'Boards' })).toBeNull()
    const headings = view.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(headings).toEqual(['Accounts', 'Folders'])
    const accountsHeading = view.getByRole('heading', { level: 3, name: 'Accounts' })
    expect(accountsHeading.compareDocumentPosition(view.container.querySelector('[data-nav-row="unified"]')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(
      within(section)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Launch', 'Hiring'])
    // The picture says nothing the name does not.
    expect(
      within(section).getByRole('button', { name: 'Launch' }).querySelector('[aria-hidden="true"] img'),
    ).toBeTruthy()
    expect(rows()).toEqual(['unified', 'board:b1', 'board:b2', 'account:alex', 'account:blai', 'account:carla'])
  })

  it('is not there without boards', () => {
    settings$.kanbanBoards.set([])
    const { view } = pane()
    expect(view.queryByRole('group', { name: 'Boards' })).toBeNull()
    expect(view.queryByText('Boards')).toBeNull()
  })

  it('opens a board as the rail does, and marks it, not mail, while it is open', () => {
    ui$.module.set('mail')
    const { view, row } = pane()
    fireEvent.click(row('board:b2'))
    expect(kanban$.activeBoardId.peek()).toBe('b2')
    expect(ui$.module.peek()).toBe('mail')
    expect(row('board:b2').getAttribute('aria-current')).toBe('true')
    expect(row('board:b1').hasAttribute('aria-current')).toBe(false)
    expect(row('account:alex').hasAttribute('aria-current')).toBe(false)
    expect(view.getByRole('button', { name: 'Inbox 3' }).hasAttribute('aria-current')).toBe(false)
    // An account, or one of its folders, goes back to mail.
    fireEvent.click(row('account:alex'))
    expect(kanban$.activeBoardId.peek()).toBe('')
    expect(ui$.selectedAccount.peek()).toBe('alex')
    expect(row('account:alex').getAttribute('aria-current')).toBe('true')
    fireEvent.click(row('board:b1'))
    fireEvent.click(view.getByRole('button', { name: 'Sent' }))
    expect(kanban$.activeBoardId.peek()).toBe('')
    expect(ui$.selectedFolder.peek()).toBe('Sent')
  })

  it('reorders the boards with Alt+↓ and Alt+↑, keeping the focus and saying where they went', () => {
    const { row, announced } = pane()
    row('board:b1').focus()
    fireEvent.keyDown(row('board:b1'), { key: 'ArrowDown', altKey: true })
    expect(settings$.kanbanBoards.peek().map((item) => item.id)).toEqual(['b2', 'b1'])
    expect(document.activeElement).toBe(row('board:b1'))
    expect(announced()).toBe('Launch moved to position 2 of 2')
    fireEvent.keyDown(row('board:b1'), { key: 'ArrowUp', altKey: true })
    expect(settings$.kanbanBoards.peek().map((item) => item.id)).toEqual(['b1', 'b2'])
  })

  it('gives each board its menu with the mouse, Shift+F10 and the context menu key', () => {
    const { view, row } = pane()
    fireEvent.contextMenu(row('board:b1'))
    expect(
      within(view.getByRole('menu', { name: 'Launch' }))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Board settings...', 'Delete board'])
    fireEvent.keyDown(document, { key: 'Escape' })
    row('board:b2').focus()
    fireEvent.keyDown(row('board:b2'), { key: 'F10', shiftKey: true })
    expect(view.getByRole('menu', { name: 'Hiring' })).toBeTruthy()
    fireEvent.click(view.getByRole('menuitem', { name: 'Board settings...' }))
    expect(ui$.accountSettingsId.peek()).toBe('b2')
    expect(ui$.settingsOpen.peek()).toBe(true)
    ui$.settingsOpen.set(false)
    fireEvent.keyDown(row('board:b2'), { key: 'ContextMenu' })
    expect(view.getByRole('menu', { name: 'Hiring' })).toBeTruthy()
  })

  it('moves the focus on from a board deleted from its menu, to a new one when it was the last', async () => {
    settings$.kanbanBoards.set([board('b1', 'Launch'), board('b2', 'Hiring'), board('b3', 'Support')])
    const { view, row } = pane()
    const remove = async (key: string) => {
      row(key).focus()
      fireEvent.keyDown(row(key), { key: 'ContextMenu' })
      fireEvent.click(view.getByRole('menuitem', { name: 'Delete board' }))
      expect(ui$.confirm.peek()).not.toBeNull()
      await act(async () => settleConfirm(true))
    }
    // The next board, else the one before.
    await remove('board:b2')
    expect(settings$.kanbanBoards.peek().map((item) => item.id)).toEqual(['b1', 'b3'])
    expect(document.activeElement).toBe(row('board:b3'))
    await remove('board:b3')
    expect(document.activeElement).toBe(row('board:b1'))
    // The last one: the new, empty board that takes its place.
    await remove('board:b1')
    const [fresh] = settings$.kanbanBoards.peek()
    expect(fresh.id).not.toBe('b1')
    expect(document.activeElement).toBe(row(`board:${fresh.id}`))
    // A deletion declined moves nothing.
    fireEvent.keyDown(row(`board:${fresh.id}`), { key: 'ContextMenu' })
    fireEvent.click(view.getByRole('menuitem', { name: 'Delete board' }))
    await act(async () => settleConfirm(false))
    expect(document.activeElement).toBe(row(`board:${fresh.id}`))
  })
})

describe('the unified inbox row in «Comptes i carpetes» (#353)', () => {
  beforeEach(() => {
    accountGroups$.groups.set([{ id: 'group:work', name: 'Work', accounts: ['alex', 'carla'] }])
  })

  it('has the rail menu: each group shown together, and hiding it, from the mouse and the keyboard', () => {
    const { view, row, announced } = pane()
    fireEvent.contextMenu(row('unified'))
    expect(
      within(view.getByRole('menu', { name: 'Unified inbox' }))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Show Work together', 'Hide unified inbox'])
    fireEvent.click(view.getByRole('menuitem', { name: 'Show Work together' }))
    expect(ui$.selectedAccount.peek()).toBe('unified')
    expect(accountGroups$.active.peek()).toBe('group:work')

    act(() => {
      ui$.selectedAccount.set('alex')
      accountGroups$.active.set(null)
    })
    row('unified').focus()
    fireEvent.keyDown(row('unified'), { key: 'F10', shiftKey: true })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(document.activeElement).toBe(row('unified'))
    fireEvent.keyDown(row('unified'), { key: 'ContextMenu' })
    fireEvent.click(view.getByRole('menuitem', { name: 'Hide unified inbox' }))
    expect(settings$.showUnifiedInboxInSideNav.peek()).toBe(false)
    expect(view.container.querySelector('[data-nav-row="unified"]')).toBeNull()
    expect(document.activeElement?.getAttribute('data-nav-row')).toBe('account:alex')
    expect(announced()).toBe('Unified inbox hidden. It can be shown again from Settings.')
  })

  it('stays, and says nothing went, when it is hidden while it is open', () => {
    ui$.selectedAccount.set('unified')
    const { view, row, announced } = pane()
    row('unified').focus()
    fireEvent.keyDown(row('unified'), { key: 'ContextMenu' })
    fireEvent.click(view.getByRole('menuitem', { name: 'Hide unified inbox' }))
    expect(settings$.showUnifiedInboxInSideNav.peek()).toBe(false)
    expect(document.activeElement).toBe(row('unified'))
    expect(announced()).toBe('')
  })
})

describe('Ctrl/⌘+1…9 open the same places as before (ADR-0068 §5, #353)', () => {
  const press = (digit: number) =>
    fireEvent.keyDown(window, { key: String(digit), code: `Digit${digit}`, ctrlKey: true })

  it('the unified inbox, then the boards, then the accounts shown, in the order the pane draws them', () => {
    settings$.kanbanBoards.set([board('b1', 'Launch'), board('b2', 'Hiring')])
    settings$.hiddenSideNavAccounts.set(['blai'])
    ui$.selectedAccount.set('carla')
    const { rows } = pane()
    render(<AppHotkeys />)
    expect(rows()).toEqual(['unified', 'board:b1', 'board:b2', 'account:alex', 'account:carla'])
    const opened: string[] = []
    const where = () =>
      kanban$.activeBoardId.peek() ? `board:${kanban$.activeBoardId.peek()}` : ui$.selectedAccount.peek()
    for (const digit of [1, 2, 3, 4, 5]) {
      act(() => {
        press(digit)
      })
      opened.push(where())
    }
    expect(opened).toEqual(['unified', 'board:b1', 'board:b2', 'alex', 'carla'])
    // Nothing in the sixth place.
    act(() => {
      press(6)
    })
    expect(where()).toBe('carla')

    // Without the unified inbox, the boards come first.
    act(() => settings$.showUnifiedInboxInSideNav.set(false))
    act(() => {
      press(1)
    })
    expect(where()).toBe('board:b1')
  })
})
