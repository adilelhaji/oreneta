import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import i18n from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import { settings$ } from '../../states/settings'
import { tasks$, type AccountTaskList, type Task, type TaskList } from '../../states/tasks'
import { AppHotkeys } from '../dialog/AppHotkeys'
import { mail$ } from '../../states/mail'
import { settleConfirm, ui$ } from '../../states/ui'
import { FolderPane } from '../shell/FolderPane'
import { messages, supportedI18nLanguages } from '../../generated/locales'
import type { Account } from '../../types'
import { TasksView } from './TasksView'

// #329: the task lists in the common folder pane (ADR-0068 §4), at the width
// every module shares. At 1024 px and below the pane is not drawn, and the
// lists keep their tabs in the row under the header.

const mail: TaskList = { id: 'mail', name: '', position: 0, open: 1 }
const home: TaskList = { id: 'list:home', name: 'Home', position: 1, open: 2 }
const done: TaskList = { id: 'list:done', name: 'Nothing open', position: 2, open: 0 }
const dav: TaskList = {
  id: 'list:dav',
  name: 'A CalDAV list with a name too long for the pane',
  position: 3,
  open: 1,
  remote_url: 'https://dav.example/ana/tasks/',
  synced_at: 1_700_000_000,
  last_error: '',
  conflicts: 0,
}
const lists = [mail, home, done, dav]

const entry = (over: Partial<AccountTaskList>): AccountTaskList => ({
  account: 'acc',
  source: 'ews',
  state: 'pending',
  list_id: '',
  adopted: false,
  notified: true,
  last_error: '',
  kind: 'ews',
  url: '',
  ...over,
})

const task = (id: number, title: string, list: string): Task => ({
  id,
  thread_id: '',
  account_id: '',
  folder_id: '',
  note: '',
  due_at: null,
  completed_at: null,
  created_at: 0,
  subject: '',
  from_name: '',
  from_addr: '',
  linked: false,
  list_id: list,
  title,
  priority: 1,
  revision: 1,
})
const tasks = [
  task(1, 'Renew the contract', 'mail'),
  task(2, 'Fix the tap', 'list:home'),
  task(3, 'Water the plants', 'list:home'),
  task(4, 'Sync the phone', 'list:dav'),
]

const empty = {
  items: [],
  loaded: false,
  loading: false,
  includeCompleted: false,
  lists: [],
  accountLists: [],
  selectedList: 'all',
  search: '',
  syncing: false,
}

let calls: { command: string; payload: any }[] = []
let accountLists: AccountTaskList[] = []
let items = tasks

const setWidth = (width: number) => (window as any).happyDOM.setViewport({ width, height: 900 })

beforeEach(async () => {
  calls = []
  accountLists = []
  items = tasks
  await i18n.changeLanguage('en')
  accounts$.set([{ id: 'acc', email: 'me@corp.example', provider: 'exchange' }] as unknown as Account[])
  settings$.folderPaneWidth.set(260)
  tasks$.set({ ...empty })
  ui$.taskEditor.set(null)
  ui$.module.set('tasks')
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'tasks.lists') return { lists, account_lists: accountLists }
          if (command === 'tasks.list') return { tasks: items }
          return { ok: true }
        },
      },
    },
  }
  setWidth(1440)
})

afterEach(() => {
  cleanup()
  // happy-dom's own window: 1024 px wide.
  ;(window as any).happyDOM.setViewport({ width: 1024, height: 768 })
  accounts$.set([])
  tasks$.set({ ...empty })
  settings$.folderPaneWidth.set(260)
  ui$.confirm.set(null)
  ui$.taskEditor.set(null)
  ui$.module.set('mail')
  delete (window as any).go
  delete (window as any).prompt
})

const written = (key: string) =>
  calls.filter((call) => call.command === 'app.prefsSet' && call.payload.key === key).map((call) => call.payload.value)
const sent = (command: string) => calls.filter((call) => call.command === command).map((call) => call.payload)

const pane = (screen: ReturnType<typeof render>) => screen.getByRole('navigation', { name: 'Task lists' })
const content = (screen: ReturnType<typeof render>) =>
  screen.container.querySelector<HTMLElement>('[data-region="content"]')!
const shown = (screen: ReturnType<typeof render>) =>
  [...content(screen).querySelectorAll('li .wrap-anywhere bdi')].map((node) => node.textContent)
const ready = async (screen: ReturnType<typeof render>) => {
  await waitFor(() => expect(screen.container.textContent).toContain('Renew the contract'))
  await waitFor(() => expect(tasks$.lists.peek()).toHaveLength(4))
}

describe('Tasks in the common folder pane (ADR-0068 §4, #329)', () => {
  it('is the "folders" region beside the whole module, named by its title row', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    const nav = pane(screen)
    expect(nav.dataset.region).toBe('folders')
    expect(nav.hasAttribute('data-folder-pane')).toBe(true)
    expect(within(nav).getByRole('heading', { level: 2, name: 'Task lists' }).getAttribute('title')).toBe('Task lists')
    // Beside the module, not inside it: the pane comes first, then the tasks.
    expect(content(screen).contains(nav)).toBe(false)
    expect(nav.compareDocumentPosition(content(screen)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
    expect(nav.querySelectorAll('[data-region]')).toHaveLength(0)
    // The tabs are not drawn in the header as well.
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(within(content(screen)).queryByRole('button', { name: /New list/ })).toBeNull()
    // The header keeps the title, the new task, the completed filter and the search.
    expect(within(content(screen)).getByRole('heading', { level: 1, name: 'Tasks' })).toBeTruthy()
    expect(within(content(screen)).getByRole('button', { name: 'New task' })).toBeTruthy()
    expect(within(content(screen)).getByRole('textbox', { name: 'Search tasks' })).toBeTruthy()
  })

  it('lists every list the tabs showed, in the same order, with the same counts, and chooses one', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    const nav = within(pane(screen))
    const names = [...pane(screen).querySelectorAll('ul > li > button')].map((button) =>
      button.getAttribute('aria-label'),
    )
    // "All" has no count; a list with nothing open has none either.
    expect(names).toEqual([
      'All',
      'Mail follow-up (1)',
      'Home (2)',
      'Nothing open',
      'A CalDAV list with a name too long for the pane (1)',
    ])
    const all = nav.getByRole('button', { name: 'All' })
    const list = nav.getByRole('button', { name: 'Home (2)' })
    expect(all.getAttribute('aria-current')).toBe('true')
    expect(list.getAttribute('aria-current')).toBeNull()
    // A name that can end in "…" is whole in its tooltip, with its count.
    expect(list.getAttribute('title')).toBe('Home (2)')
    const long = nav.getByTitle(`${dav.name} (1)`)
    expect(long.textContent).toContain(dav.name)
    expect(shown(screen)).toHaveLength(4)

    fireEvent.click(list)
    expect(tasks$.selectedList.peek()).toBe('list:home')
    expect(list.getAttribute('aria-current')).toBe('true')
    expect(all.getAttribute('aria-current')).toBeNull()
    expect(shown(screen)).toEqual(['Fix the tap', 'Water the plants'])
    fireEvent.click(long)
    expect(shown(screen)).toEqual(['Sync the phone'])
    // A list with a server is said to be kept there, above the tasks.
    expect(within(content(screen)).getByText(/Kept on dav\.example/)).toBeTruthy()
    fireEvent.click(all)
    expect(shown(screen)).toHaveLength(4)
  })

  it('creates a list from the pane, as the tabs row did', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    const nav = within(pane(screen))
    fireEvent.click(nav.getByRole('button', { name: 'New list' }))
    const name = nav.getByLabelText('New list name')
    fireEvent.change(name, { target: { value: ' Errands ' } })
    fireEvent.submit(name.closest('form')!)
    await waitFor(() => expect(sent('tasks.createList')).toEqual([{ name: ' Errands ' }]))
    expect(nav.queryByLabelText('New list name')).toBeNull()
    // The focus goes back to the button that opened the field.
    expect(document.activeElement).toBe(nav.getByRole('button', { name: 'New list' }))
  })

  it('cancels a new list on Escape, back on the button, and keeps the field open on blur', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    const nav = within(pane(screen))
    fireEvent.click(nav.getByRole('button', { name: 'New list' }))
    const name = nav.getByLabelText('New list name')
    // The field comes after the lists, so opening or closing it moves none of them,
    // and an empty field does not close on blur: that would move the rows under
    // the pointer before a click on one of them ended.
    const firstRow = pane(screen).querySelector('[data-list-row="all"]')!
    const order = [...pane(screen).querySelectorAll('*')]
    expect(order.indexOf(name)).toBeGreaterThan(order.indexOf(firstRow))
    fireEvent.blur(name)
    expect(nav.getByLabelText('New list name')).toBeTruthy()
    fireEvent.change(name, { target: { value: 'Errands' } })
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(nav.queryByLabelText('New list name')).toBeNull()
    expect(document.activeElement).toBe(nav.getByRole('button', { name: 'New list' }))
    expect(sent('tasks.createList')).toEqual([])
  })

  it('moves between the lists with Up, Down, Home and End, choosing as it goes, as the tabs did', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    const nav = within(pane(screen))
    const all = nav.getByRole('button', { name: 'All' })
    all.focus()
    fireEvent.keyDown(all, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(nav.getByRole('button', { name: 'Mail follow-up (1)' }))
    expect(tasks$.selectedList.peek()).toBe('mail')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(tasks$.selectedList.peek()).toBe('list:home')
    expect(shown(screen)).toEqual(['Fix the tap', 'Water the plants'])
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(tasks$.selectedList.peek()).toBe('list:dav')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(tasks$.selectedList.peek()).toBe('list:done')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(tasks$.selectedList.peek()).toBe('all')
    expect(document.activeElement).toBe(all)
    // Left and Right are not the lists' keys here.
    fireEvent.keyDown(all, { key: 'ArrowRight' })
    expect(tasks$.selectedList.peek()).toBe('all')
  })

  it('takes the arrow keys: the mail thread list behind does not step with them', async () => {
    const thread = (id: string) => ({ thread_id: id, id }) as never
    mail$.threads.set([thread('t1'), thread('t2')])
    ui$.selectedThread.set('t1')
    try {
      const screen = render(
        <>
          <AppHotkeys />
          <TasksView />
        </>,
      )
      await ready(screen)
      const all = within(pane(screen)).getByRole('button', { name: 'All' })
      all.focus()
      fireEvent.keyDown(all, { key: 'ArrowDown' })
      expect(tasks$.selectedList.peek()).toBe('mail')
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
      expect(tasks$.selectedList.peek()).toBe('list:home')
      expect(ui$.selectedThread.peek()).toBe('t1')
    } finally {
      mail$.threads.set([])
      ui$.selectedThread.set('')
    }
  })

  it('keeps what was typed when New list is pressed again, and says the field is open', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    const nav = within(pane(screen))
    const button = nav.getByRole('button', { name: 'New list' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    const name = nav.getByLabelText('New list name')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(name.id)
    fireEvent.change(name, { target: { value: 'Errands' } })
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.click(button)
    expect((nav.getByLabelText('New list name') as HTMLInputElement).value).toBe('Errands')
    expect(document.activeElement).toBe(name)
  })

  it('ignores Esc and Enter while an IME composition is active', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    const nav = within(pane(screen))
    fireEvent.click(nav.getByRole('button', { name: 'New list' }))
    const name = nav.getByLabelText('New list name')
    fireEvent.change(name, { target: { value: '買い物' } })
    fireEvent.keyDown(name, { key: 'Escape', isComposing: true })
    expect(nav.queryByLabelText('New list name')).toBe(name)
    // Enter that commits a candidate does not submit the name: false means
    // its default, the form's submission, was prevented. WebKit sends it
    // after compositionend, with isComposing false and keyCode 229.
    expect(fireEvent.keyDown(name, { key: 'Enter', isComposing: true })).toBe(false)
    expect(fireEvent.keyDown(name, { key: 'Enter', keyCode: 229 })).toBe(false)
    fireEvent.keyDown(name, { key: 'Escape', keyCode: 229 })
    expect((nav.getByLabelText('New list name') as HTMLInputElement).value).toBe('買い物')
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(nav.queryByLabelText('New list name')).toBeNull()
  })

  it('moves the same way in right-to-left', async () => {
    document.documentElement.dir = 'rtl'
    try {
      const screen = render(<TasksView />)
      await ready(screen)
      const all = within(pane(screen)).getByRole('button', { name: 'All' })
      all.focus()
      fireEvent.keyDown(all, { key: 'ArrowDown' })
      expect(tasks$.selectedList.peek()).toBe('mail')
    } finally {
      document.documentElement.removeAttribute('dir')
    }
  })

  it('opens the CalDAV task list dialog from the pane', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    fireEvent.click(within(pane(screen)).getByRole('button', { name: 'CalDAV task list…' }))
    expect(screen.getByText('Add a CalDAV task list')).toBeTruthy()
  })

  it('renames and deletes the list on show, each saying which, and not the mail list', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    const nav = within(pane(screen))
    // With "All" or the mail list on show there is nothing to rename or delete.
    expect(nav.queryByRole('button', { name: /^(Rename|Delete) / })).toBeNull()
    fireEvent.click(nav.getByRole('button', { name: 'Mail follow-up (1)' }))
    expect(nav.queryByRole('button', { name: /^(Rename|Delete) / })).toBeNull()

    fireEvent.click(nav.getByRole('button', { name: 'Home (2)' }))
    const rename = nav.getByRole('button', { name: 'Rename Home' })
    expect(rename.getAttribute('title')).toBe('Rename Home')
    const asked: unknown[][] = []
    ;(window as any).prompt = (...args: unknown[]) => {
      asked.push(args)
      return ' Household '
    }
    fireEvent.click(rename)
    expect(asked).toEqual([['Rename list', 'Home']])
    await waitFor(() => expect(sent('tasks.renameList')).toEqual([{ id: 'list:home', name: ' Household ' }]))

    const remove = nav.getByRole('button', { name: 'Delete Home' })
    expect(remove.getAttribute('title')).toBe('Delete Home')
    fireEvent.click(remove)
    await waitFor(() => expect(ui$.confirm.peek()).not.toBeNull())
    expect(ui$.confirm.peek()!.message).toBe('Home and every task in it will be deleted.')
    settleConfirm(false)
    await waitFor(() => expect(ui$.confirm.peek()).toBeNull())
    expect(sent('tasks.deleteList')).toEqual([])
    fireEvent.click(remove)
    await waitFor(() => expect(ui$.confirm.peek()).not.toBeNull())
    settleConfirm(true)
    await waitFor(() => expect(sent('tasks.deleteList')).toEqual([{ id: 'list:home' }]))
    await waitFor(() => expect(tasks$.selectedList.peek()).toBe('all'))
    // The row that held the focus is gone: it goes to "All".
    await waitFor(() => expect(document.activeElement).toBe(nav.getByRole('button', { name: 'All' })))
  })

  it('leaves the focus where it was when the delete is declined', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    const nav = within(pane(screen))
    fireEvent.click(nav.getByRole('button', { name: 'Home (2)' }))
    const remove = nav.getByRole('button', { name: 'Delete Home' })
    remove.focus()
    fireEvent.click(remove)
    await waitFor(() => expect(ui$.confirm.peek()).not.toBeNull())
    settleConfirm(false)
    await waitFor(() => expect(ui$.confirm.peek()).toBeNull())
    expect(document.activeElement).toBe(remove)
    expect(tasks$.selectedList.peek()).toBe('list:home')
  })

  it('says a list of an account is not deleted on its server (ADR-0070), from the pane too', async () => {
    accountLists = [
      entry({ source: 'caldav:https://dav.example/ana/tasks/', kind: 'caldav', list_id: 'list:dav', state: 'linked' }),
    ]
    const screen = render(<TasksView />)
    await ready(screen)
    const nav = within(pane(screen))
    fireEvent.click(nav.getByTitle(`${dav.name} (1)`))
    fireEvent.click(nav.getByRole('button', { name: `Delete ${dav.name}` }))
    await waitFor(() => expect(ui$.confirm.peek()).not.toBeNull())
    expect(ui$.confirm.peek()!.message).toContain('Nothing is deleted on the server.')
    expect(ui$.confirm.peek()!.message).toContain('add it again from “Add a list”')
    settleConfirm(false)
  })

  it('offers the declined account lists in the pane, and keeps the notices above the tasks', async () => {
    accountLists = [
      entry({ state: 'declined' }),
      entry({
        source: 'caldav:https://dav.example/ana/tasks/',
        kind: 'caldav',
        list_id: 'list:dav',
        state: 'linked',
        notified: false,
        url: 'https://dav.example/ana/tasks/',
      }),
    ]
    const screen = render(<TasksView />)
    await ready(screen)
    // The notice of a list the upgrade added is not a list: it stays where it was.
    await waitFor(() =>
      expect(within(content(screen)).getByText(/was added on its own when Oreneta was updated/)).toBeTruthy(),
    )
    expect(within(pane(screen)).queryByText(/was added on its own/)).toBeNull()
    const add = within(pane(screen)).getByRole('button', { name: /Add a list/ })
    expect(content(screen).contains(add)).toBe(false)
    expect(add.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(add)
    // It opens in the pane's flow, where the pane's edge cannot cut it.
    const exchange = within(pane(screen)).getByRole('button', { name: /Exchange tasks of me@corp\.example/ })
    fireEvent.click(exchange)
    await waitFor(() => expect(sent('tasks.exchangeAdd')).toEqual([{ account: 'acc' }]))
  })

  it('shows the accounts whose lists wait above the tasks, and never calls them “no tasks”', async () => {
    accountLists = [entry({ last_error: 'ErrorAccessDenied' })]
    const screen = render(<TasksView />)
    await ready(screen)
    await waitFor(() =>
      expect(within(content(screen)).getByRole('alert').textContent).toContain('could not be read: ErrorAccessDenied'),
    )
    expect(within(pane(screen)).queryByRole('alert')).toBeNull()
  })

  it('says “not read yet” on “All”, with nothing to show and an account list waiting', async () => {
    accountLists = [entry({})]
    items = []
    const screen = render(<TasksView />)
    await waitFor(() => expect(tasks$.lists.peek()).toHaveLength(4))
    await waitFor(() =>
      expect(content(screen).textContent).toContain('The tasks of some accounts have not been read yet'),
    )
    expect(within(pane(screen)).getByRole('button', { name: 'All' }).getAttribute('aria-current')).toBe('true')
    // On a list of its own, nothing is waiting for it: it is just empty.
    fireEvent.click(within(pane(screen)).getByRole('button', { name: 'Home (2)' }))
    expect(content(screen).textContent).not.toContain('have not been read yet')
  })

  it('shares one width with mail: resized here, it is the width mail draws, and the reverse', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    const handle = within(pane(screen)).getByRole('separator', { name: 'Resize folder pane' })
    expect(pane(screen).style.width).toBe('260px')
    expect(handle.getAttribute('aria-valuenow')).toBe('260')
    fireEvent.keyDown(handle, { key: 'End' })
    expect(pane(screen).style.width).toBe('400px')
    expect(written('folder_pane_width')).toEqual([400])
    cleanup()

    const mailPane = render(
      <FolderPane title="Accounts and folders">
        <button type="button">Inbox</button>
      </FolderPane>,
    )
    expect(mailPane.getByRole('navigation', { name: 'Accounts and folders' }).style.width).toBe('400px')
    fireEvent.keyDown(mailPane.getByRole('separator', { name: 'Resize folder pane' }), { key: 'Home' })
    expect(written('folder_pane_width')).toEqual([400, 200])
    cleanup()

    const again = render(<TasksView />)
    expect(pane(again).style.width).toBe('200px')
    expect(within(pane(again)).getByRole('separator').getAttribute('aria-valuenow')).toBe('200')
  })
})

describe('the name of Tasks\'s "folders" region (ADR-0068 §1, #329)', () => {
  it('is never the name of <main>, in any language', () => {
    // A screen reader reads two names that differ only in case or spacing the
    // same, so compare them as it would hear them.
    const clashes = supportedI18nLanguages.flatMap((language) => {
      const catalog = messages[language]
      const heard = (s: string | undefined) =>
        (s ?? '').trim().normalize('NFC').toLocaleLowerCase(language.replace('_', '-'))
      const name = catalog['tasks.taskLists']
      if (!name?.trim()) return [`${language}: missing`]
      return heard(name) === heard(catalog['tasks.title']) ? [`${language}: same as <main>, "${name}"`] : []
    })
    expect(supportedI18nLanguages.length).toBe(20)
    expect(clashes).toEqual([])
  })
})

describe('Tasks at 1024 px and below (#329)', () => {
  it('keeps the lists as tabs in the row under the header, as before', async () => {
    setWidth(1024)
    const screen = render(<TasksView />)
    await ready(screen)
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize folder pane' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Task lists' })).toBeNull()
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(0)
    const tabs = within(screen.getByRole('tablist', { name: 'Lists' })).getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'All',
      'Mail follow-up1',
      'Home2',
      'Nothing open',
      `${dav.name}1`,
    ])
    fireEvent.click(screen.getByRole('tab', { name: /Home/ }))
    expect(shown(screen)).toEqual(['Fix the tap', 'Water the plants'])
    expect(screen.getByRole('button', { name: /New list/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /CalDAV task list/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Rename list' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete list' })).toBeTruthy()
  })

  it('follows the window across 1025 px, one place at a time, keeping the chosen list', async () => {
    setWidth(1024)
    const screen = render(<TasksView />)
    await ready(screen)
    fireEvent.click(screen.getByRole('tab', { name: /Home/ }))
    expect(screen.getAllByRole('tablist')).toHaveLength(1)
    await act(async () => setWidth(1025))
    expect(pane(screen).hasAttribute('data-folder-pane')).toBe(true)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
    expect(within(pane(screen)).getByRole('button', { name: 'Home (2)' }).getAttribute('aria-current')).toBe('true')
    expect(shown(screen)).toEqual(['Fix the tap', 'Water the plants'])
    await act(async () => setWidth(1024))
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect(screen.getByRole('tab', { name: /Home/ }).getAttribute('aria-selected')).toBe('true')
  })
})

// #341: the focus follows the control across 1025 px.
// happy-dom tells a media query's listeners about a change only once the query
// has matched, so a window that starts wide is resized wide once (1500 px)
// before it narrows to 1024 px, as a browser's would have been.
const narrowWindow = async () => {
  await act(async () => setWidth(1500))
  await act(async () => setWidth(1024))
}

describe('Tasks keep the focus across 1025 px (#341)', () => {
  it("moves it from a list row to the same list's tab and back", async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    const row = within(pane(screen)).getByRole('button', { name: 'Home (2)' })
    row.focus()
    expect(document.activeElement).toBe(row)
    await narrowWindow()
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Home/ }))
    await act(async () => setWidth(1025))
    expect(document.activeElement).toBe(within(pane(screen)).getByRole('button', { name: 'Home (2)' }))
  })

  it('moves the "New list" and "Rename" buttons the same way', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    fireEvent.click(within(pane(screen)).getByRole('button', { name: 'Home (2)' }))
    const rename = within(pane(screen)).getByRole('button', { name: 'Rename Home' })
    rename.focus()
    await narrowWindow()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename list' }))
    await act(async () => setWidth(1025))
    expect(document.activeElement).toBe(within(pane(screen)).getByRole('button', { name: 'Rename Home' }))
  })

  it('falls back to the first control of the tabs row when the field it was in has no twin', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    fireEvent.click(within(pane(screen)).getByRole('button', { name: 'New list' }))
    // The field of the pane's "New list" is its own: the tabs' row has not opened one.
    expect(document.activeElement).toBe(within(pane(screen)).getByRole('textbox', { name: 'New list name' }))
    await narrowWindow()
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'All' }))
  })

  it("falls back to the pane's first control going the other way", async () => {
    setWidth(1024)
    const screen = render(<TasksView />)
    await ready(screen)
    fireEvent.click(screen.getByRole('button', { name: /New list/ }))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'New list name' }))
    await act(async () => setWidth(1025))
    expect(document.activeElement).toBe(within(pane(screen)).getByRole('button', { name: 'New list' }))
  })

  it('leaves the focus alone when it was not on a list control, and on the first render', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    expect(document.activeElement).toBe(document.body)
    const search = screen.getByRole('textbox', { name: 'Search tasks' })
    search.focus()
    await narrowWindow()
    expect(document.activeElement).toBe(search)
    await act(async () => setWidth(1025))
    expect(document.activeElement).toBe(search)
  })

  it('does nothing when the window crosses with no focus at all', async () => {
    const screen = render(<TasksView />)
    await ready(screen)
    await narrowWindow()
    expect(document.activeElement).toBe(document.body)
    expect(screen.getAllByRole('tab').length).toBeGreaterThan(0)
  })
})
