import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { MailNavigationView } from './MailNavigation'
import { FolderPane } from '../shell/FolderPane'
import { folderPrefs$ } from '../../states/folderPrefs'
import type { Account, Folder } from '../../types'

afterEach(cleanup)
const account: Account = {
  id: 'test-account',
  email: 'alex@example.test',
  display_name: 'Alex',
  provider: 'imap',
  auth_type: 'password',
  imap_host: 'imap.example.test',
  imap_port: 993,
  smtp_host: 'smtp.example.test',
  smtp_port: 465,
  tls: true,
}
const folders: Folder[] = [
  { id: 'INBOX', account_id: account.id, name: 'Inbox', role: 'inbox', unread: 3 },
  { id: 'Sent', account_id: account.id, name: 'Sent', role: 'sent', unread: 0 },
]
const fixture = { account, folders }
const props = {
  accounts: [fixture.account],
  folders: fixture.folders,
  selectedAccount: fixture.account.id,
  selectedFolder: 'INBOX',
  unifiedVisible: true,
  onAccount: (_id: string) => {},
  onFolder: (_id: string) => {},
}

describe('production mailbox navigation', () => {
  it('uses real IDs, labels the current folder and shows backend unread counts', () => {
    const destinations: string[] = []
    const view = render(<MailNavigationView {...props} onFolder={(id) => destinations.push(id)} />)
    expect(view.getByRole('button', { name: 'Inbox 3' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(view.getByRole('button', { name: 'Sent' }))
    expect(destinations).toEqual(['Sent'])
    view.rerender(
      <MailNavigationView {...props} folders={fixture.folders.map((folder) => ({ ...folder, unread: 9 }))} />,
    )
    expect(view.getByRole('button', { name: 'Inbox 9' })).toBeTruthy()
  })
  it('keeps structural parents non-selectable and navigates custom delimiter children', () => {
    const destinations: string[] = []
    const view = render(
      <MailNavigationView
        {...props}
        folders={[
          {
            id: 'server-id-42',
            account_id: fixture.account.id,
            name: 'Projects.Reviews',
            delimiter: '.',
            role: '',
            unread: 2,
          },
        ]}
        onFolder={(id) => destinations.push(id)}
      />,
    )
    expect(view.queryByRole('button', { name: 'Projects' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Collapse Projects' }))
    expect(view.queryByRole('button', { name: 'Reviews 2' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Expand Projects' }))
    fireEvent.click(view.getByRole('button', { name: 'Reviews 2' }))
    expect(destinations).toEqual(['server-id-42'])
  })
  it('filters folder names without selecting or writing a mail query', () => {
    const destinations: string[] = []
    const view = render(<MailNavigationView {...props} onFolder={(id) => destinations.push(id)} />)
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'zzzz' } })
    expect(view.getByText('No matching folders')).toBeTruthy()
    expect(destinations).toEqual([])
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'sent' } })
    expect(view.getByRole('button', { name: 'Sent' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Inbox 3' })).toBeNull()
  })
  it('exposes account and unified destinations independently of folder selection', () => {
    const destinations: string[] = []
    const view = render(<MailNavigationView {...props} onAccount={(id) => destinations.push(id)} />)
    fireEvent.click(view.getByRole('button', { name: /Alex.*alex@example.test/ }))
    fireEvent.click(view.getByRole('button', { name: 'Unified inbox' }))
    expect(destinations).toEqual([fixture.account.id, 'unified'])
    view.rerender(<MailNavigationView {...props} unifiedVisible={false} />)
    expect(view.queryByRole('button', { name: 'Unified inbox' })).toBeNull()
  })
  it('does not invent folders when the cache is empty or an account is RSS', () => {
    const destinations: string[] = []
    const view = render(<MailNavigationView {...props} folders={[]} />)
    expect(view.getByText('No folders available')).toBeTruthy()
    view.rerender(
      <MailNavigationView
        {...props}
        accounts={[{ ...fixture.account, provider: 'rss', auth_type: 'rss' }]}
        onFolder={(id) => destinations.push(id)}
      />,
    )
    expect(view.queryByRole('searchbox')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'All feeds' }))
    expect(destinations).toEqual(['inbox'])
  })
})

describe('account groups in navigation (#99)', () => {
  const groups = [{ id: 'group:work', name: 'Work', accounts: [account.id] }]

  it('lists each group under the unified inbox and marks only the one shown', () => {
    const chosen: string[] = []
    const view = render(
      <MailNavigationView
        {...props}
        selectedAccount="unified"
        groups={groups}
        activeGroup="group:work"
        onGroup={(id) => chosen.push(id)}
      />,
    )
    const group = view.getByRole('button', { name: 'Work' })
    expect(group.getAttribute('aria-current')).toBe('true')
    expect(view.getByRole('button', { name: 'Unified inbox' }).getAttribute('aria-current')).toBeNull()
    fireEvent.click(group)
    expect(chosen).toEqual(['group:work'])
  })

  it('marks the unified inbox when no group is chosen', () => {
    const view = render(<MailNavigationView {...props} selectedAccount="unified" groups={groups} activeGroup={null} />)
    expect(view.getByRole('button', { name: 'Unified inbox' }).getAttribute('aria-current')).toBe('true')
    expect(view.getByRole('button', { name: 'Work' }).getAttribute('aria-current')).toBeNull()
  })
})

describe('folder favorites, colors and moves (ADR-0050)', () => {
  const tree: Folder[] = [
    { id: 'INBOX', account_id: account.id, name: 'Inbox', role: 'inbox', unread: 3, delimiter: '/' },
    { id: 'Sent', account_id: account.id, name: 'Sent', role: 'sent', unread: 0, delimiter: '/' },
    { id: 'Projects', account_id: account.id, name: 'Projects', role: 'folder', unread: 0, delimiter: '/' },
    { id: 'Work', account_id: account.id, name: 'Work', role: 'folder', unread: 4, delimiter: '/' },
    { id: 'Work/2026', account_id: account.id, name: 'Work/2026', role: 'folder', unread: 0, delimiter: '/' },
  ]
  const other: Account = { ...account, id: 'other-account', display_name: 'Other', email: 'other@example.test' }
  const moves: Array<[string, string, string | null]> = []
  const view = (extra: Record<string, unknown> = {}) =>
    render(
      <MailNavigationView
        {...props}
        folders={tree}
        allAccounts={[account, other]}
        foldersByAccount={{
          [account.id]: tree,
          [other.id]: [{ id: 'Clients', account_id: other.id, name: 'Clients', role: 'folder', unread: 5 }],
        }}
        onMoveFolder={(...args) => moves.push(args)}
        {...extra}
      />,
    )
  const menuFor = (screen: ReturnType<typeof view>, name: string) => {
    fireEvent.contextMenu(screen.getByRole('button', { name }))
  }

  beforeEach(() => {
    moves.length = 0
    folderPrefs$.favorites.set([])
    folderPrefs$.colors.set([])
    folderPrefs$.hidden.set([])
    folderPrefs$.dropped.set(0)
    ;(window as any).go = { main: { App: { Invoke: async () => ({}) } } }
  })

  it('adds a folder to Favorites from its menu, with its unread count, and removes it again', () => {
    const screen = view()
    expect(screen.queryByRole('heading', { name: 'Favorites' })).toBeNull()
    menuFor(screen, 'Work 4')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to favorites' }))
    const favorites = screen.getByRole('region', { name: 'Favorites' })
    expect(within(favorites).getByRole('button', { name: 'Work 4' })).toBeTruthy()
    expect(folderPrefs$.favorites.get()).toEqual([{ accountId: account.id, folderId: 'Work' }])
    fireEvent.contextMenu(within(favorites).getByRole('button', { name: 'Work 4' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from favorites' }))
    expect(screen.queryByRole('region', { name: 'Favorites' })).toBeNull()
  })

  it('lists favorites from other accounts and opens them there', () => {
    folderPrefs$.favorites.set([{ accountId: other.id, folderId: 'Clients' }])
    const opened: string[] = []
    const screen = view({ onOpenFolder: (a: string, f: string) => opened.push(`${a}:${f}`) })
    const favorites = screen.getByRole('region', { name: 'Favorites' })
    fireEvent.click(within(favorites).getByRole('button', { name: 'Clients Other 5' }))
    expect(opened).toEqual(['other-account:Clients'])
  })

  it('reorders favorites with Alt+arrows, the menu and drag and drop, keeping focus and announcing it', () => {
    folderPrefs$.favorites.set([
      { accountId: account.id, folderId: 'Work' },
      { accountId: account.id, folderId: 'Projects' },
      { accountId: account.id, folderId: 'INBOX' },
    ])
    const screen = view()
    const favorites = () => screen.getByRole('region', { name: 'Favorites' })
    const order = () => folderPrefs$.favorites.get().map((ref) => ref.folderId)
    const work = within(favorites()).getByRole('button', { name: 'Work 4' })
    work.focus()
    fireEvent.keyDown(work, { key: 'ArrowDown', altKey: true })
    expect(order()).toEqual(['Projects', 'Work', 'INBOX'])
    expect(document.activeElement?.textContent).toContain('Work')
    expect(screen.getByText('Work moved to position 2 of 3')).toBeTruthy()
    fireEvent.contextMenu(within(favorites()).getByRole('button', { name: 'Inbox 3' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Move up/ }))
    expect(order()).toEqual(['Projects', 'INBOX', 'Work'])
    const rows = within(favorites()).getAllByRole('listitem')
    fireEvent.dragStart(within(rows[2]).getByRole('button'))
    fireEvent.dragOver(rows[0])
    fireEvent.drop(rows[0])
    expect(order()).toEqual(['Work', 'Projects', 'INBOX'])
  })

  it('colors a folder from a named palette, in the tree and in Favorites', () => {
    folderPrefs$.favorites.set([{ accountId: account.id, folderId: 'Work' }])
    const screen = view()
    const tree = () => screen.getAllByRole('list')[1]
    fireEvent.contextMenu(within(tree()).getByRole('button', { name: 'Work 4' }))
    fireEvent.click(screen.getAllByRole('menuitemradio', { name: 'Blue' })[0])
    expect(folderPrefs$.colors.get()).toEqual([{ accountId: account.id, folderId: 'Work', color: 'blue' }])
    const colored = screen.getAllByRole('button', { name: 'Work Color: Blue 4' })
    expect(colored.length).toBe(2)
    expect(colored[0].getAttribute('data-folder-color')).toBe('blue')
    fireEvent.contextMenu(within(tree()).getByRole('button', { name: 'Work Color: Blue 4' }))
    expect(screen.getByRole('menuitemradio', { name: 'Blue' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'No color' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'No color' }))
    expect(folderPrefs$.colors.get()).toEqual([])
  })

  it('drags a folder onto another one of the account, and refuses its own subtree and special folders', () => {
    const screen = view()
    const row = (name: string) => screen.getByRole('button', { name }).parentElement!
    fireEvent.dragStart(screen.getByRole('button', { name: 'Work 4' }))
    fireEvent.dragOver(row('2026'))
    expect(row('2026').getAttribute('data-drop-target')).toBe('blocked')
    expect(row('2026').getAttribute('title')).toContain('itself')
    fireEvent.drop(row('2026'))
    expect(moves).toEqual([])
    fireEvent.dragOver(row('Projects'))
    expect(row('Projects').getAttribute('data-drop-target')).toBe('ok')
    fireEvent.drop(row('Projects'))
    expect(moves).toEqual([[account.id, 'Work', 'Projects']])

    expect(screen.getByRole('button', { name: 'Sent' }).getAttribute('draggable')).toBe('false')
    expect(screen.getByRole('button', { name: 'Inbox 3' }).getAttribute('draggable')).toBe('false')
    fireEvent.dragStart(screen.getByRole('button', { name: 'Sent' }))
    fireEvent.drop(row('Projects'))
    expect(moves.length).toBe(1)
  })

  it('moves a folder from the keyboard with the menu and a folder picker', () => {
    const screen = view()
    const work = screen.getByRole('button', { name: 'Work 4' })
    work.focus()
    fireEvent.keyDown(work, { key: 'F10', shiftKey: true })
    const first = document.activeElement as HTMLElement
    expect(first.textContent).toBe('Add to favorites')
    expect(first.getAttribute('role')).toBe('menuitem')
    expect(screen.getByRole('menu', { name: 'Actions for Work' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move folder to…' }))
    const dialog = screen.getByRole('dialog', { name: 'Move Work to…' })
    const options = within(dialog)
      .getAllByRole('radio')
      .map((radio) => radio.parentElement?.textContent)
    expect(options).toEqual(['Inbox', 'Sent', 'Projects'])
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Projects' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }))
    expect(moves).toEqual([[account.id, 'Work', 'Projects']])
  })

  it('disables moving special folders and folders of accounts that cannot move them, saying why, and allows Exchange', () => {
    const screen = view()
    menuFor(screen, 'Sent')
    const move = screen.getByRole('menuitem', { name: /Move folder to…/ })
    expect(move.getAttribute('aria-disabled')).toBe('true')
    expect(move.getAttribute('title')).toContain('cannot be moved')
    cleanup()
    const graph = { ...account, auth_type: 'graph_oauth' as const }
    const again = view({ accounts: [graph], allAccounts: [graph] })
    menuFor(again, 'Work 4')
    const disabled = again.getByRole('menuitem', { name: /Move folder to…/ })
    expect(disabled.getAttribute('aria-disabled')).toBe('true')
    // A Graph account without changes is told what would allow it (#210).
    expect(disabled.getAttribute('title')).toBe('Allow changes for this account in its settings to move its folders')
    expect(again.getByRole('button', { name: 'Work 4' }).getAttribute('draggable')).toBe('false')
    cleanup()
    // Exchange moves folders like IMAP (ADR-0058).
    const ews = { ...account, provider: 'exchange', ews_url: 'https://ews.example.test/EWS/Exchange.asmx' }
    const exchange = view({ accounts: [ews], allAccounts: [ews] })
    menuFor(exchange, 'Work 4')
    const allowed = exchange.getByRole('menuitem', { name: /Move folder to…/ })
    expect(allowed.hasAttribute('aria-disabled')).toBe(false)
    expect(exchange.getByRole('button', { name: 'Work 4' }).getAttribute('draggable')).toBe('true')
  })

  it('hides a folder and its subfolders from the tree, shows them on request and shows one again (#273)', () => {
    const commands: Array<{ command: string; payload: any }> = []
    ;(window as any).go = {
      main: { App: { Invoke: async (command: string, payload: any) => (commands.push({ command, payload }), {}) } },
    }
    const screen = view()
    expect(screen.queryByRole('button', { name: /Show hidden folders/ })).toBeNull()
    menuFor(screen, 'Work 4')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide folder' }))
    // The folder and its subfolder leave the tree; the rest stays.
    expect(screen.queryByRole('button', { name: 'Work 4' })).toBeNull()
    expect(screen.queryByRole('button', { name: '2026' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Projects' })).toBeTruthy()
    expect(folderPrefs$.hidden.get()).toEqual([{ accountId: account.id, folderId: 'Work' }])
    // Only a local preference is written: nothing goes to a server, sync is untouched.
    expect(commands).toEqual([
      { command: 'app.prefsSet', payload: { key: 'folder_hidden', value: [{ accountId: account.id, folderId: 'Work' }] } },
    ])
    expect(screen.getByText('Work hidden')).toBeTruthy()
    // The focus does not fall out of the page with the row: it lands on the switch.
    const toggle = screen.getByRole('button', { name: 'Show hidden folders (2)' })
    expect(document.activeElement).toBe(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const work = screen.getByRole('button', { name: 'Work Hidden 4' })
    expect(work.hasAttribute('data-folder-hidden')).toBe(true)
    expect(screen.getByRole('button', { name: '2026 Hidden' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Projects' }).hasAttribute('data-folder-hidden')).toBe(false)

    // A subfolder hidden with its parent says so instead of hiding twice.
    menuFor(screen, '2026 Hidden')
    const hideChild = screen.getByRole('menuitem', { name: /Hide folder/ })
    expect(hideChild.getAttribute('aria-disabled')).toBe('true')
    expect(hideChild.getAttribute('title')).toBe('Hidden because the folder that holds it is hidden')
    fireEvent.keyDown(document, { key: 'Escape' })
    cleanup()

    const again = view()
    fireEvent.click(again.getByRole('button', { name: 'Show hidden folders (2)' }))
    menuFor(again, 'Work Hidden 4')
    fireEvent.click(again.getByRole('menuitem', { name: 'Show folder again' }))
    expect(folderPrefs$.hidden.get()).toEqual([])
    expect(again.getByRole('button', { name: 'Work 4' }).hasAttribute('data-folder-hidden')).toBe(false)
    expect(again.getByRole('button', { name: '2026' })).toBeTruthy()
    expect(again.queryByRole('button', { name: /Show hidden folders/ })).toBeNull()
    expect(again.getByText('Work shown again')).toBeTruthy()
    expect(commands.at(-1)).toEqual({ command: 'app.prefsSet', payload: { key: 'folder_hidden', value: [] } })
  })

  it('hides again by default once nothing is hidden, and keeps what was saved across a restart (#273)', () => {
    folderPrefs$.hidden.set([{ accountId: account.id, folderId: 'Projects' }])
    const screen = view()
    // Saved marks apply as soon as the tree draws: nothing is shown until asked.
    expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden folders (1)' }))
    menuFor(screen, 'Projects Hidden')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show folder again' }))
    menuFor(screen, 'Projects')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide folder' }))
    // With nothing left hidden in between, the switch was off again.
    expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Show hidden folders (1)' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps the open folder in the tree when it is hidden, and the focus on it (#273)', () => {
    const screen = view({ selectedFolder: 'Work' })
    const work = screen.getByRole('button', { name: 'Work 4' })
    work.focus()
    fireEvent.keyDown(work, { key: 'F10', shiftKey: true })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide folder' }))
    const open = screen.getByRole('button', { name: 'Work Hidden 4' })
    expect(open.getAttribute('aria-current')).toBe('page')
    expect(document.activeElement).toBe(open)
    // Its subfolder is not open, so it goes.
    expect(screen.queryByRole('button', { name: /^2026/ })).toBeNull()
  })

  it('hides with hidden folders already shown, or from Favorites, without moving the focus away (#273)', () => {
    folderPrefs$.favorites.set([{ accountId: account.id, folderId: 'Work' }])
    folderPrefs$.hidden.set([{ accountId: account.id, folderId: 'Sent' }])
    const screen = view()
    const favorites = () => screen.getByRole('region', { name: 'Favorites' })
    const favorite = within(favorites()).getByRole('button', { name: 'Work 4' })
    fireEvent.contextMenu(favorite)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide folder' }))
    expect(document.activeElement).toBe(favorite)
    expect(within(favorites()).getByRole('button', { name: 'Work 4' })).toBe(favorite)

    fireEvent.click(screen.getByRole('button', { name: 'Show hidden folders (3)' }))
    menuFor(screen, 'Projects')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide folder' }))
    const projects = screen.getByRole('button', { name: 'Projects Hidden' })
    expect(document.activeElement).toBe(projects)
  })

  it('says a folder stays hidden through its parent when its own mark goes (#273)', () => {
    folderPrefs$.hidden.set([
      { accountId: account.id, folderId: 'Work' },
      { accountId: account.id, folderId: 'Work/2026' },
    ])
    const screen = view()
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden folders (2)' }))
    menuFor(screen, '2026 Hidden')
    const show = screen.getByRole('menuitem', { name: /Show folder again/ })
    expect(show.hasAttribute('aria-disabled')).toBe(false)
    expect(show.getAttribute('title')).toBe('Hidden because the folder that holds it is hidden')
    fireEvent.click(show)
    expect(folderPrefs$.hidden.get()).toEqual([{ accountId: account.id, folderId: 'Work' }])
    expect(screen.getByRole('button', { name: '2026 Hidden' })).toBeTruthy()
    expect(screen.queryByText('Work/2026 shown again')).toBeNull()
  })

  it('never hides the inbox, and keeps a hidden favorite in Favorites (#273)', () => {
    folderPrefs$.favorites.set([{ accountId: account.id, folderId: 'Work' }])
    folderPrefs$.hidden.set([{ accountId: account.id, folderId: 'Work' }])
    const screen = view()
    const favorites = screen.getByRole('region', { name: 'Favorites' })
    expect(within(favorites).getByRole('button', { name: 'Work 4' })).toBeTruthy()
    menuFor(screen, 'Inbox 3')
    const hide = screen.getByRole('menuitem', { name: /Hide folder/ })
    expect(hide.getAttribute('aria-disabled')).toBe('true')
    expect(hide.getAttribute('title')).toBe('The inbox cannot be hidden')
  })

  it('says when stale favorites were dropped, and lets the note go', () => {
    folderPrefs$.dropped.set(2)
    const screen = view()
    expect(screen.getByRole('status').textContent).toContain('2 favorite folders no longer exist and were removed.')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('mail in the common folder pane (ADR-0068 §4, #317)', () => {
  beforeEach(() => {
    folderPrefs$.favorites.set([{ accountId: account.id, folderId: 'Sent' }])
    folderPrefs$.hidden.set([])
    folderPrefs$.dropped.set(0)
    ;(window as any).go = { main: { App: { Invoke: async () => ({}) } } }
  })
  afterEach(() => {
    cleanup()
    folderPrefs$.favorites.set([])
  })

  it('is the body of the "folders" region, its sections under the pane title', () => {
    const screen = render(
      <FolderPane title="Accounts and folders">
        <MailNavigationView {...props} />
      </FolderPane>,
    )
    const nav = screen.getByRole('navigation', { name: 'Accounts and folders' })
    expect(nav.dataset.region).toBe('folders')
    // One region: the navigation does not nest a second one of its own.
    expect(nav.querySelectorAll('nav, [data-region]')).toHaveLength(0)
    expect(screen.getByRole('heading', { level: 2, name: 'Accounts and folders' })).toBeTruthy()
    for (const section of ['Favorites', 'Accounts', 'Folders']) {
      expect(within(nav).getByRole('heading', { level: 3, name: section })).toBeTruthy()
    }
    expect(within(nav).getByRole('button', { name: 'Inbox 3' }).getAttribute('aria-current')).toBe('page')
    expect(within(nav).getByRole('searchbox')).toBeTruthy()
  })

  it('gives every name that can end in "…" its whole text in the tooltip', () => {
    const long = { ...account, display_name: 'Alexandra Montserrat Vilaseca i Puigdomènech' }
    const screen = render(<MailNavigationView {...props} accounts={[long]} />)
    expect(screen.getByRole('button', { name: /Alexandra Montserrat/ }).getAttribute('title')).toBe(
      'Alexandra Montserrat Vilaseca i Puigdomènech — alex@example.test',
    )
    expect(screen.getByRole('button', { name: 'Unified inbox' }).getAttribute('title')).toBe('Unified inbox')
    const tree = screen.getAllByRole('list').at(-1)!
    expect(within(tree).getByRole('button', { name: 'Sent' }).getAttribute('title')).toBe('Sent')
    cleanup()
    // An account without a name of its own is named by its address alone.
    const bare = render(<MailNavigationView {...props} accounts={[{ ...account, display_name: '' }]} />)
    expect(bare.getByRole('button', { name: /^alex@example\.test/ }).getAttribute('title')).toBe('alex@example.test')
  })
})
