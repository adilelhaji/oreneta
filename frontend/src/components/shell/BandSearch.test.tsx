import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import i18n from '../../lib/i18n'
import { messages, supportedI18nLanguages } from '../../generated/locales'
import { isMac, setShortcutOverrides } from '../../lib/shortcuts'
import { accounts$ } from '../../states/accounts'
import { attachmentList$ } from '../../states/attachmentList'
import { kanban$ } from '../../states/kanban'
import { notes$ } from '../../states/notes'
import { people$ } from '../../states/people'
import { settings$, type KanbanBoard } from '../../states/settings'
import { tasks$ } from '../../states/tasks'
import { clearThreadSearchRequest, pendingThreadSearch, thread$ } from '../../states/thread'
import { ui$, type AppModule } from '../../states/ui'
import type { Account, Person } from '../../types'
import { AttachmentsView } from '../attachments/AttachmentsView'
import { AppHotkeys } from '../dialog/AppHotkeys'
import { KanbanView } from '../kanban/KanbanView'
import { NotesView } from '../notes/NotesView'
import { useCommandList } from '../palette/useCommandList'
import { PeopleView } from '../people/PeopleView'
import { TasksView } from '../tasks/TasksView'
import { AppHeader } from './AppHeader'

// The search in the top band, scoped to the module on screen (ADR-0068 §2, #344).

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
const feeds: Account = {
  ...account,
  id: 'rss-feeds',
  email: 'feeds',
  display_name: 'Feeds',
  provider: 'rss',
  auth_type: 'rss',
}

const board: KanbanBoard = {
  id: 'kb-search',
  name: 'Triage',
  columns: [
    { accountId: account.id, folderId: 'INBOX' },
    { accountId: account.id, folderId: 'Archive' },
  ],
}

let calls: { command: string; payload: any }[] = []
let answers: Record<string, (payload: any) => unknown> = {}

const setWidth = (width: number) => (window as any).happyDOM.setViewport({ width, height: 900 })
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))
const mod = isMac ? { metaKey: true } : { ctrlKey: true }

beforeEach(async () => {
  await i18n.changeLanguage('en')
  setWidth(1440)
  calls = []
  answers = {}
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          return answers[command]?.(payload) ?? { ok: true }
        },
      },
    },
  }
  accounts$.set([account, feeds])
  ui$.assign({ module: 'mail', selectedAccount: account.id, selectedFolder: 'INBOX', selectedThread: '', query: '' })
  ui$.paletteOpen.set(false)
  kanban$.assign({ activeBoardId: '', searchQuery: '', searchScope: 'all', paneThreadId: '' })
  settings$.kanbanBoards.set([board])
  settings$.savedSearches.set([])
  notes$.assign({ items: [], tags: [], loaded: false, search: '', tag: '', trash: false, selected: null })
  people$.assign({ people: [], loaded: true, loading: false, query: '', selectedId: '' })
  tasks$.assign({
    items: [],
    loaded: false,
    loading: false,
    lists: [],
    accountLists: [],
    selectedList: 'all',
    search: '',
  })
  attachmentList$.filter.assign({ account: '', name: '', sender: '', kind: '', within: 0 })
  thread$.searchOpen.set(false)
})

afterEach(() => {
  cleanup()
  // happy-dom's own window: 1024 px wide.
  ;(window as any).happyDOM.setViewport({ width: 1024, height: 768 })
  setShortcutOverrides({})
  // Back to the defaults, so nothing set here reaches the next file.
  accounts$.set([])
  ui$.assign({ module: 'mail', selectedAccount: '', selectedFolder: 'inbox', selectedThread: '', query: '' })
  kanban$.assign({ activeBoardId: '', searchQuery: '', searchScope: 'all' })
  settings$.kanbanBoards.set([])
  settings$.savedSearches.set([])
  notes$.search.set('')
  people$.query.set('')
  tasks$.search.set('')
  attachmentList$.filter.name.set('')
  thread$.searchOpen.set(false)
  clearThreadSearchRequest()
  delete (window as any).go
})

const band = (view: ReturnType<typeof render>) => view.container.querySelector<HTMLElement>('[data-top-band]')!
const landmark = (view: ReturnType<typeof render>) => within(band(view)).getByRole('search', { name: 'Search' })
const field = (view: ReturnType<typeof render>) => within(landmark(view)).getByRole('textbox') as HTMLInputElement
const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } })
const goTo = (module: AppModule) => act(() => ui$.module.set(module))
// Focus moves in and out of the band's search, which follows it.
const focus = (element: HTMLElement) => act(() => element.focus())

describe('the search field in the top band (#344)', () => {
  it("is the band's search landmark, at its centre, named after what each module searches", () => {
    const view = render(<AppHeader />)
    const search = landmark(view)
    // In the band's centre, inside the `search` region F6 reaches.
    expect(search.closest('[data-band-centre]')).toBeTruthy()
    expect(search.closest('[data-region]')).toBe(band(view))
    const scopes: [AppModule | 'board' | 'feeds', string, string][] = [
      ['mail', 'mail', 'Search messages...'],
      ['feeds', 'feeds', 'Search feeds...'],
      ['board', 'board', 'Search board...'],
      ['notes', 'notes', 'Search notes'],
      ['people', 'people', 'Search people'],
      ['tasks', 'tasks', 'Search tasks'],
      ['attachments', 'attachments', 'Search attachments by file name'],
    ]
    for (const [where, scope, name] of scopes) {
      act(() => {
        ui$.module.set(where === 'board' || where === 'feeds' ? 'mail' : where)
        ui$.selectedAccount.set(where === 'feeds' ? feeds.id : account.id)
        kanban$.activeBoardId.set(where === 'board' ? board.id : '')
      })
      expect(landmark(view).dataset.searchScope, where).toBe(scope)
      const input = within(landmark(view)).getByRole('textbox', { name })
      expect(input.getAttribute('placeholder'), where).toBe(name)
      expect((input as HTMLInputElement).disabled, where).toBe(false)
    }
    // One field, never a second one in the band.
    expect(band(view).querySelectorAll('input')).toHaveLength(1)
  })

  it("writes each module's own state, and shows that module's query again after a switch", () => {
    const view = render(<AppHeader />)
    type(field(view), 'budget')
    expect(ui$.query.peek()).toBe('budget')
    goTo('notes')
    expect(field(view).value).toBe('')
    type(field(view), 'pasta')
    expect(notes$.search.peek()).toBe('pasta')
    goTo('people')
    type(field(view), 'ana')
    expect(people$.query.peek()).toBe('ana')
    goTo('tasks')
    type(field(view), 'renew')
    expect(tasks$.search.peek()).toBe('renew')
    goTo('attachments')
    type(field(view), 'scan')
    expect(attachmentList$.filter.name.peek()).toBe('scan')
    goTo('mail')
    act(() => kanban$.activeBoardId.set(board.id))
    expect(field(view).value).toBe('')
    type(field(view), 'invoice')
    expect(kanban$.searchQuery.peek()).toBe('invoice')
    // Nothing was merged: each module still has its own, and shows it.
    expect(ui$.query.peek()).toBe('budget')
    act(() => kanban$.activeBoardId.set(''))
    expect(field(view).value).toBe('budget')
    for (const [module, query] of [
      ['notes', 'pasta'],
      ['people', 'ana'],
      ['tasks', 'renew'],
      ['attachments', 'scan'],
    ] as const) {
      goTo(module)
      expect(field(view).value, module).toBe(query)
    }
  })

  it('clears with its button, which gives the focus back to the field', () => {
    const view = render(<AppHeader />)
    expect(within(landmark(view)).queryByRole('button', { name: 'Clear search' })).toBeNull()
    type(field(view), 'budget')
    fireEvent.click(within(landmark(view)).getByRole('button', { name: 'Clear search' }))
    expect(ui$.query.peek()).toBe('')
    expect(document.activeElement).toBe(field(view))
    goTo('notes')
    type(field(view), 'pasta')
    fireEvent.click(within(landmark(view)).getByRole('button', { name: 'Clear search' }))
    expect(notes$.search.peek()).toBe('')
  })
})

describe("mail's search in the band (#344)", () => {
  it('clears and leaves the field on Escape, and tells the operators, as the thread list did', () => {
    const view = render(<AppHeader />)
    const input = field(view)
    expect(input.title).toBe(messages.en['search.operatorsHint'])
    focus(input)
    type(input, 'from:ann')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(ui$.query.peek()).toBe('')
    expect(document.activeElement).not.toBe(input)
  })

  it('searches feeds in a feeds account, with no builder and no operators', () => {
    ui$.selectedAccount.set(feeds.id)
    const view = render(<AppHeader />)
    expect(field(view).getAttribute('aria-label')).toBe('Search feeds...')
    expect(field(view).title).toBe('')
    expect(within(landmark(view)).queryByRole('button', { name: 'Search options' })).toBeNull()
    type(field(view), 'rust')
    expect(ui$.query.peek()).toBe('rust')
    // Saving a search is still there.
    expect(within(landmark(view)).getByRole('button', { name: 'Save this search' })).toBeTruthy()
  })

  it('opens the search builder and the saved searches from the end of the field', async () => {
    answers['search.parse'] = () => ({
      query: { text: 'budget', from: ['Ann'], to: [], subject: [], flags: [], label: null, after: null, before: null },
    })
    answers['search.compose'] = () => ({ text: 'budget from:Ann is:unread' })
    const view = render(<AppHeader />)
    const search = landmark(view)
    // Nothing to save and nothing saved: only the builder, after the field.
    expect(within(search).queryByRole('button', { name: 'Save this search' })).toBeNull()
    const builder = within(search).getByRole('button', { name: 'Search options' })
    expect(field(view).compareDocumentPosition(builder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    type(field(view), 'budget from:Ann')
    fireEvent.click(builder)
    const dialog = await view.findByRole('dialog', { name: 'Search options' })
    await waitFor(() => expect((within(dialog).getByLabelText('From') as HTMLInputElement).value).toBe('Ann'))
    fireEvent.change(within(dialog).getByLabelText('Read or unread'), { target: { value: 'unread' } })
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Search' })))
    expect(ui$.query.peek()).toBe('budget from:Ann is:unread')
    expect(field(view).value).toBe('budget from:Ann is:unread')

    // A query: it can be saved, from the band, and opened again from there.
    fireEvent.click(within(landmark(view)).getByRole('button', { name: 'Save this search' }))
    expect(settings$.savedSearches.peek()).toEqual([
      expect.objectContaining({ query: 'budget from:Ann is:unread', account: account.id, folder: 'INBOX' }),
    ])
    type(field(view), '')
    fireEvent.click(within(landmark(view)).getByRole('button', { name: 'Saved searches' }))
    fireEvent.click(view.getByRole('menuitem', { name: /budget from:Ann is:unread/ }))
    expect(ui$.query.peek()).toBe('budget from:Ann is:unread')
  })
})

describe("a board's search in the band (#344)", () => {
  it('searches the open board, with its scope at the end of the field', () => {
    kanban$.activeBoardId.set(board.id)
    settings$.kanbanMinimizedColumns[`${board.id}\n${account.id}\nArchive`].set(true)
    const view = render(<AppHeader />)
    const input = field(view)
    type(input, 'invoice')
    expect(kanban$.searchQuery.peek()).toBe('invoice')
    expect(ui$.query.peek()).toBe('')
    // The scope: a menu of the board's columns, after the field.
    const scope = within(landmark(view)).getByTitle('Search scope')
    expect(input.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(scope)
    const choices = view.getAllByRole('menuitemradio')
    expect(choices).toHaveLength(3)
    fireEvent.click(choices[2])
    expect(kanban$.searchScope.peek()).toBe(`${account.id}\nArchive`)
    // Scoped to a collapsed column, the column opens to show what it found.
    expect(settings$.kanbanMinimizedColumns[`${board.id}\n${account.id}\nArchive`].peek()).toBe(false)
    // Escape clears, then leaves, as the board's own field did.
    focus(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(kanban$.searchQuery.peek()).toBe('')
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(document.activeElement).not.toBe(input)
    settings$.kanbanMinimizedColumns[`${board.id}\n${account.id}\nArchive`].delete()
  })

  it("scopes it to a column from the column's «Search», and focuses the band", async () => {
    kanban$.activeBoardId.set(board.id)
    answers['mail.threadList'] = () => ({ threads: [], next_cursor: '', pagination: 'conversation-v1' })
    const view = render(
      <>
        <AppHeader />
        <KanbanView boardId={board.id} />
      </>,
    )
    // The board has no field of its own any more.
    expect(view.container.querySelectorAll('section[data-region="content"] input[type="text"]')).toHaveLength(0)
    expect(view.queryByRole('button', { name: 'Search board' })).toBeNull()
    const columns = view.getAllByRole('button', { name: 'Thread actions' })
    expect(columns).toHaveLength(2)
    // The second column's menu: «Search».
    fireEvent.click(columns[1])
    await act(async () => fireEvent.click(view.getByRole('menuitem', { name: 'Search' })))
    expect(kanban$.searchScope.peek()).toBe(`${account.id}\nArchive`)
    await waitFor(() => expect(document.activeElement).toBe(field(view)))
    expect(field(view).getAttribute('aria-label')).toBe('Search board...')
  })
})

describe('Calendar and Chat in the band (owner decision 3 on #342, #344)', () => {
  for (const [module, reason] of [
    ['calendar', 'Calendar has no search yet'],
    ['chat', 'Chat has no search yet'],
  ] as const) {
    it(`shows the field disabled in ${module}, and says why`, () => {
      ui$.module.set(module)
      const view = render(<AppHeader />)
      const search = landmark(view)
      expect(search.dataset.searchScope).toBe(module)
      const input = field(view)
      expect(input.disabled).toBe(true)
      // The reason is what the field shows, its tooltip and its description.
      expect(input.getAttribute('placeholder')).toBe(reason)
      expect(input.title).toBe(reason)
      expect(input.getAttribute('aria-label')).toBe('Search')
      expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(reason)
      // Nothing that would do nothing: no clear, no builder, no saved searches.
      expect(within(search).queryAllByRole('button')).toHaveLength(0)
      // The shortcut has nothing to focus.
      render(<AppHotkeys />)
      fireEvent.keyDown(document.body, { key: 'F', shiftKey: true, ...mod })
      expect(document.activeElement).not.toBe(input)
    })
  }
})

describe("each module's search from the band keeps its delay and its texts (#344)", () => {
  it('Notes: asks the core 200 ms after the last key, and says when nothing matches', async () => {
    ui$.module.set('notes')
    answers['notes.list'] = (payload) => ({ notes: [], tags: [], payload })
    const view = render(
      <>
        <AppHeader />
        <NotesView />
      </>,
    )
    await waitFor(() => expect(calls.filter((call) => call.command === 'notes.list')).toHaveLength(1))
    type(field(view), 'pa')
    type(field(view), 'pasta')
    await wait(100)
    expect(calls.filter((call) => call.command === 'notes.list')).toHaveLength(1)
    await waitFor(() => expect(calls.filter((call) => call.command === 'notes.list')).toHaveLength(2))
    expect(calls.at(-1)!.payload).toMatchObject({ search: 'pasta' })
    expect(view.container.textContent).toContain('No notes match')
    // Cleared, the list comes back at once.
    fireEvent.click(within(landmark(view)).getByRole('button', { name: 'Clear search' }))
    await waitFor(() => expect(calls.filter((call) => call.command === 'notes.list')).toHaveLength(3))
    expect(calls.filter((call) => call.command === 'notes.list').at(-1)!.payload).toMatchObject({ search: '' })
    await waitFor(() => expect(view.container.textContent).toContain('No notes yet'))
  })

  it('People: asks the core 150 ms after the last key, and says nobody matched', async () => {
    ui$.module.set('people')
    const ana = {
      id: 'local::ana',
      source: 'local',
      account: '',
      book: 'local',
      name: 'Ana Prat',
      organisation: '',
      note: '',
      photo: '',
      emails: [],
      phones: [],
    } as unknown as Person
    people$.people.set([ana])
    answers['people.list'] = (payload) => ({ people: payload.query === 'zzz' ? [] : [ana] })
    answers['people.duplicates'] = () => ({ duplicates: [] })
    answers['people.groups'] = () => ({ groups: [] })
    const view = render(
      <>
        <AppHeader />
        <PeopleView />
      </>,
    )
    const asked = () => calls.filter((call) => call.command === 'people.list')
    await waitFor(() => expect(asked()).toHaveLength(1))
    type(field(view), 'zz')
    type(field(view), 'zzz')
    // Not before the 150 ms (a wide margin, for a slow machine).
    await wait(50)
    expect(asked()).toHaveLength(1)
    await waitFor(() => expect(asked()).toHaveLength(2))
    expect(asked().at(-1)!.payload).toMatchObject({ query: 'zzz' })
    await waitFor(() => expect(view.container.textContent).toContain('Nobody by that name'))
    // Cleared, everybody again, after the same 150 ms.
    fireEvent.click(within(landmark(view)).getByRole('button', { name: 'Clear search' }))
    expect(people$.query.peek()).toBe('')
    // Not before the 150 ms (a wide margin, for a slow machine), then once.
    await wait(50)
    expect(asked()).toHaveLength(2)
    await waitFor(() => expect(asked()).toHaveLength(3))
    expect(asked().at(-1)!.payload).toMatchObject({ query: '' })
    await waitFor(() => expect(view.container.textContent).toContain('Ana Prat'))
  })

  it('Attachments: asks the core 200 ms after the last key, by file name', async () => {
    ui$.module.set('attachments')
    answers['attachments.list'] = () => ({ items: [], total: 0, coverage: { messages: 0, downloaded: 0 } })
    const view = render(
      <>
        <AppHeader />
        <AttachmentsView />
      </>,
    )
    const asked = () => calls.filter((call) => call.command === 'attachments.list')
    await waitFor(() => expect(asked()).toHaveLength(1))
    type(field(view), 'sc')
    type(field(view), 'scan')
    await wait(100)
    expect(asked()).toHaveLength(1)
    await waitFor(() => expect(asked()).toHaveLength(2))
    expect(asked().at(-1)!.payload).toMatchObject({ name: 'scan' })
    expect(view.container.textContent).toContain('No attachments found')
    // The name is no longer one of the filters: one place to type it.
    expect(view.queryByRole('textbox', { name: 'File name' })).toBeNull()
    // Cleared, the list is asked for again at once, with no name.
    fireEvent.click(within(landmark(view)).getByRole('button', { name: 'Clear search' }))
    expect(attachmentList$.filter.name.peek()).toBe('')
    await waitFor(() => expect(asked()).toHaveLength(3))
    expect(asked().at(-1)!.payload).toMatchObject({ name: '' })
  })

  it('Tasks: filters what is loaded as the key is typed, by title, note and sender', async () => {
    ui$.module.set('tasks')
    const task = (id: number, title: string) => ({
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
      list_id: 'mail',
      title,
      priority: 1,
      revision: 1,
    })
    answers['tasks.list'] = () => ({ tasks: [task(1, 'Renew the contract'), task(2, 'Fix the tap')] })
    answers['tasks.lists'] = () => ({ lists: [{ id: 'mail', name: '', position: 0, open: 2 }] })
    const view = render(
      <>
        <AppHeader />
        <TasksView />
      </>,
    )
    await waitFor(() => expect(view.container.textContent).toContain('Fix the tap'))
    type(field(view), 'renew')
    expect(view.container.textContent).not.toContain('Fix the tap')
    expect(view.container.textContent).toContain('Renew the contract')
    type(field(view), 'nothing like it')
    expect(view.container.textContent).toContain('No tasks')
    // Cleared, every task again.
    fireEvent.click(within(landmark(view)).getByRole('button', { name: 'Clear search' }))
    expect(tasks$.search.peek()).toBe('')
    expect(view.container.textContent).toContain('Fix the tap')
    expect(view.container.textContent).toContain('Renew the contract')
  })
})

describe('the shortcuts reach the band (#344)', () => {
  const shell = () =>
    render(
      <>
        <AppHotkeys />
        <AppHeader />
        <button type="button" id="elsewhere">
          Elsewhere
        </button>
      </>,
    )

  it('Ctrl/⌘+Shift+F focuses and selects the field of the module on screen', () => {
    ui$.query.set('budget')
    const view = shell()
    const away = view.container.querySelector<HTMLElement>('#elsewhere')!
    focus(away)
    expect(fireEvent.keyDown(away, { key: 'F', shiftKey: true, ...mod })).toBe(false)
    const input = field(view)
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6])
    goTo('notes')
    focus(away)
    fireEvent.keyDown(away, { key: 'F', shiftKey: true, ...mod })
    expect(document.activeElement).toBe(within(landmark(view)).getByRole('textbox', { name: 'Search notes' }))
  })

  it('takes no focus when it mounts, whatever was asked before it was there', () => {
    // The first account arriving mounts the field; an earlier request is not
    // a request to it.
    act(() => ui$.globalSearchFocus.set(ui$.globalSearchFocus.peek() + 1))
    const view = shell()
    expect(document.activeElement).not.toBe(field(view))
    cleanup()
    setWidth(600)
    const narrow = shell()
    expect(within(band(narrow)).queryByRole('search')).toBeNull()
  })

  it('/ focuses it in the scheme that binds it, outside a text field', () => {
    setShortcutOverrides({ 'search.global': { key: '/' } })
    const view = shell()
    const away = view.container.querySelector<HTMLElement>('#elsewhere')!
    focus(away)
    expect(fireEvent.keyDown(away, { key: '/' })).toBe(false)
    expect(document.activeElement).toBe(field(view))
  })

  it('Ctrl/⌘+F opens the search of the conversation on screen, or else focuses the band', () => {
    const view = shell()
    const away = view.container.querySelector<HTMLElement>('#elsewhere')!
    // No conversation: the band's field.
    focus(away)
    fireEvent.keyDown(away, { key: 'f', ...mod })
    expect(document.activeElement).toBe(field(view))
    expect(thread$.searchOpen.peek()).toBe(false)
    // A conversation on screen: its own search, as before.
    act(() => ui$.selectedThread.set('synthetic-account#INBOX#1'))
    focus(away)
    fireEvent.keyDown(away, { key: 'f', ...mod })
    expect(thread$.searchOpen.peek()).toBe(true)
    expect(document.activeElement).toBe(away)
    // In another module, mail's conversation is not on screen: the band's
    // field, scoped to that module.
    act(() => thread$.searchOpen.set(false))
    goTo('notes')
    focus(away)
    fireEvent.keyDown(away, { key: 'f', ...mod })
    expect(thread$.searchOpen.peek()).toBe(false)
    expect(document.activeElement).toBe(within(landmark(view)).getByRole('textbox', { name: 'Search notes' }))
  })

  // Owner decision on #344: the palette's and the menu's search commands are
  // mail's, so from another module they go to mail first, as the account and
  // folder commands do, and search there.
  const command = (id: string) => {
    let commands: ReturnType<typeof useCommandList> = []
    function Probe() {
      commands = useCommandList()
      return null
    }
    render(<Probe />)
    return commands.find((item) => item.id === id)!
  }
  // Looked up as the module on screen has it, then run as the palette runs it.
  const run = (id: string) => {
    const found = command(id)
    act(() => found.run())
  }

  it("«Search all messages» goes to mail from Calendar or Notes, and focuses mail's field", () => {
    const view = shell()
    const away = view.container.querySelector<HTMLElement>('#elsewhere')!
    for (const module of ['calendar', 'notes'] as const) {
      goTo(module)
      focus(away)
      run('search.global')
      expect(ui$.module.peek(), module).toBe('mail')
      expect(document.activeElement, module).toBe(field(view))
      expect(field(view).getAttribute('aria-label'), module).toBe('Search messages...')
    }
  })

  it('«Search current thread» goes to mail from Calendar or Notes, and searches the conversation there', () => {
    const view = shell()
    const away = view.container.querySelector<HTMLElement>('#elsewhere')!
    // A conversation open in mail: its own search, once mail is on screen.
    // The conversation pane mounts with mail and resets its view, so the
    // search is asked of it for that conversation, and it opens it then
    // (MessagePane; MessagePaneThreadSearch.test.tsx renders it).
    act(() => ui$.selectedThread.set('synthetic-account#INBOX#1'))
    for (const module of ['calendar', 'notes'] as const) {
      goTo(module)
      focus(away)
      run('search.thread')
      expect(ui$.module.peek(), module).toBe('mail')
      expect(pendingThreadSearch(), module).toBe('synthetic-account#INBOX#1')
      expect(document.activeElement, module).not.toBe(field(view))
      clearThreadSearchRequest()
    }
    // In mail, with the pane on screen, it opens at once, as before.
    run('search.thread')
    expect(thread$.searchOpen.peek()).toBe(true)
    expect(pendingThreadSearch()).toBe('')
    // No conversation: mail's field in the band.
    act(() => {
      thread$.searchOpen.set(false)
      ui$.selectedThread.set('')
    })
    goTo('notes')
    focus(away)
    run('search.thread')
    expect(ui$.module.peek()).toBe('mail')
    expect(thread$.searchOpen.peek()).toBe(false)
    expect(pendingThreadSearch()).toBe('')
    expect(document.activeElement).toBe(field(view))
  })

  it("the app menu's «Search all messages» does the same from Calendar", async () => {
    ui$.module.set('calendar')
    const view = shell()
    fireEvent.click(within(band(view)).getByRole('button', { name: 'App menu' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Search all messages' }))
    await act(async () => await Promise.resolve())
    expect(ui$.module.peek()).toBe('mail')
    expect(document.activeElement).toBe(field(view))
    expect(field(view).getAttribute('aria-label')).toBe('Search messages...')
  })
})

describe('the band below 769 px (#344)', () => {
  it('closes the field over the band when the module on screen has no search, focus back on the button', () => {
    setWidth(768)
    const view = render(<AppHeader />)
    const button = within(band(view)).getByRole('button', { name: 'Search messages...' })
    const start = band(view).querySelector<HTMLElement>('[data-band-start]')!
    fireEvent.click(button)
    expect(document.activeElement).toBe(field(view))
    type(field(view), 'budget')
    goTo('calendar')
    // No disabled field left over the band, and the band is usable again.
    expect(within(band(view)).queryByRole('search')).toBeNull()
    expect(start.hasAttribute('inert')).toBe(false)
    expect(band(view).querySelector('[data-band-end]')!.hasAttribute('inert')).toBe(false)
    // The focus, which was in the field, is on the button, which says why.
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.className).not.toContain('invisible')
    expect(document.activeElement).toBe(button)
    // Back in mail it stays closed, with mail's query.
    goTo('mail')
    expect(within(band(view)).queryByRole('search')).toBeNull()
    expect(ui$.query.peek()).toBe('budget')
    expect(button.getAttribute('aria-label')).toBe('Search messages...')
  })

  it('leaves the focus where it went when the field closes for a module with no search', () => {
    setWidth(768)
    const view = render(
      <>
        <AppHeader />
        <button type="button" id="elsewhere">
          Elsewhere
        </button>
      </>,
    )
    fireEvent.click(within(band(view)).getByRole('button', { name: 'Search messages...' }))
    const away = view.container.querySelector<HTMLElement>('#elsewhere')!
    // The field stays open when the focus leaves it.
    focus(away)
    expect(landmark(view).hasAttribute('data-band-search-overlay')).toBe(true)
    goTo('chat')
    expect(within(band(view)).queryByRole('search')).toBeNull()
    expect(band(view).querySelector('[data-band-start]')!.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(away)
  })

  it('makes one attempt at a focus it was asked for, and does not take the focus later', () => {
    setWidth(600)
    const view = render(
      <>
        <AppHeader />
        <button type="button" id="elsewhere">
          Elsewhere
        </button>
      </>,
    )
    // The field refuses the focus once, as a browser may while it draws it.
    const proto = HTMLInputElement.prototype as unknown as { focus: (options?: FocusOptions) => void }
    let refuse = true
    proto.focus = function (this: HTMLInputElement, options?: FocusOptions) {
      if (!refuse) HTMLElement.prototype.focus.call(this, options)
    }
    try {
      fireEvent.click(within(band(view)).getByRole('button', { name: 'Search messages...' }))
      expect(landmark(view).hasAttribute('data-band-search-overlay')).toBe(true)
      expect(document.activeElement).not.toBe(field(view))
      refuse = false
      const away = view.container.querySelector<HTMLElement>('#elsewhere')!
      focus(away)
      // Later renders of the band do not take the focus from where it is.
      act(() => ui$.query.set('budget'))
      act(() => ui$.query.set('budget report'))
      expect(document.activeElement).toBe(away)
    } finally {
      delete (proto as { focus?: unknown }).focus
    }
  })

  it('has a search button that opens the field over the band; Escape closes it and gives the focus back', () => {
    setWidth(768)
    const view = render(<AppHeader />)
    expect(within(band(view)).queryByRole('search')).toBeNull()
    const button = within(band(view)).getByRole('button', { name: 'Search messages...' })
    const start = band(view).querySelector<HTMLElement>('[data-band-start]')!
    expect(start.hasAttribute('inert')).toBe(false)
    fireEvent.click(button)
    const search = landmark(view)
    expect(search.hasAttribute('data-band-search-overlay')).toBe(true)
    expect(search.className).toContain('absolute')
    expect(search.className).toContain('inset-0')
    expect(document.activeElement).toBe(field(view))
    // It covers the band: the rest takes neither the focus nor the pointer.
    expect(start.hasAttribute('inert')).toBe(true)
    // At the end, its controls; its live regions stay out of it, to keep announcing (#345).
    const endControls = [...band(view).querySelectorAll('[data-band-end] button')]
    expect(endControls.length).toBeGreaterThan(0)
    for (const control of endControls) expect(control.closest('[inert]')).not.toBeNull()
    expect(button.className).toContain('invisible')
    type(field(view), 'budget')
    fireEvent.keyDown(field(view), { key: 'Escape' })
    expect(within(band(view)).queryByRole('search')).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(start.hasAttribute('inert')).toBe(false)
    // It keeps its query, which the button shows, and shows it again.
    expect(ui$.query.peek()).toBe('budget')
    expect(button.className).toContain('text-accent-fg')
    fireEvent.click(button)
    expect(field(view).value).toBe('budget')
    // The close button does the same as Escape.
    fireEvent.click(within(landmark(view)).getByRole('button', { name: 'Close search' }))
    expect(within(band(view)).queryByRole('search')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('opens it for Ctrl/⌘+Shift+F, and in Calendar the button says why there is no search', () => {
    setWidth(600)
    const view = render(
      <>
        <AppHotkeys />
        <AppHeader />
      </>,
    )
    fireEvent.keyDown(document.body, { key: 'F', shiftKey: true, ...mod })
    expect(document.activeElement).toBe(field(view))
    fireEvent.keyDown(field(view), { key: 'Escape' })
    goTo('calendar')
    const button = within(band(view)).getByRole('button', { name: 'Search' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.title).toBe('Calendar has no search yet')
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Calendar has no search yet',
    )
    fireEvent.click(button)
    expect(within(band(view)).queryByRole('search')).toBeNull()
  })

  it('keeps the field, and its focus, when the window narrows while it is in use', async () => {
    const view = render(<AppHeader />)
    const input = field(view)
    focus(input)
    type(input, 'budget')
    // happy-dom tells a media query's listeners about a change only once the
    // query has matched, so the window is resized wide once before it narrows.
    await act(async () => setWidth(1500))
    await act(async () => setWidth(768))
    expect(field(view)).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(landmark(view).hasAttribute('data-band-search-overlay')).toBe(true)
    // Widened again, it is the field in the band, still focused.
    await act(async () => setWidth(1024))
    expect(field(view)).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(landmark(view).hasAttribute('data-band-search-overlay')).toBe(false)
    expect(band(view).querySelector('[data-band-start]')!.hasAttribute('inert')).toBe(false)
  })
})

describe('what the band follows (#344)', () => {
  it('does not render again for a change to the accounts that does not make the one on screen a feeds one', () => {
    let commits = 0
    const view = render(
      <Profiler id="band" onRender={() => commits++}>
        <AppHeader />
      </Profiler>,
    )
    const before = commits
    act(() =>
      accounts$.set([
        { ...account, display_name: 'Alex, renamed' },
        { ...feeds, display_name: 'News' },
      ]),
    )
    expect(commits).toBe(before)
    // A change it follows: the account on screen becomes the feeds one.
    act(() => ui$.selectedAccount.set(feeds.id))
    expect(commits).toBeGreaterThan(before)
    expect(field(view).getAttribute('aria-label')).toBe('Search feeds...')
  })
})

describe('the band on the first-account setup screen (#344)', () => {
  it('has no search: there is nothing to search yet', () => {
    accounts$.set([])
    const view = render(<AppHeader setup />)
    expect(within(band(view)).queryByRole('search')).toBeNull()
    expect(band(view).querySelectorAll('input')).toHaveLength(0)
    expect(
      within(band(view))
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['App menu'])
    setWidth(600)
    cleanup()
    const narrow = render(<AppHeader setup />)
    expect(within(band(narrow)).getAllByRole('button')).toHaveLength(1)
  })
})

describe('the names and strings of the band search (#344)', () => {
  // A screen reader reads two names that differ only in case or spacing the
  // same, so compare them as it would hear them.
  const regions = [
    'shell.region.banner',
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
  const heard = (language: string, text: string | undefined) =>
    (text ?? '').trim().normalize('NFC').toLocaleLowerCase(language.replace('_', '-'))

  it('names the search landmark apart from every other region, in all 20 catalogs', () => {
    expect(supportedI18nLanguages.length).toBe(20)
    const clashes = supportedI18nLanguages.flatMap((language) => {
      const catalog = messages[language]
      const name = catalog['shell.region.search']
      if (!name?.trim()) return [`${language}: missing`]
      return regions
        .filter((key) => heard(language, catalog[key]) === heard(language, name))
        .map((key) => `${language}: same as ${key}, "${name}"`)
    })
    expect(clashes).toEqual([])
    expect(messages.ca['shell.region.search']).toBe('Cerca')
  })

  it('has every string of the band search in every catalog, and each reason names its module', () => {
    const keys = [
      'shell.region.search',
      'search.band.calendar',
      'search.band.chat',
      'search.band.close',
      'attachmentsView.search',
      'threads.searchMessages',
      'threads.searchFeeds',
      'kanban.searchBoard',
      'notes.search',
      'people.search',
      'tasks.search',
      'common.clearSearch',
    ]
    const missing = supportedI18nLanguages.flatMap((language) =>
      keys.filter((key) => !messages[language][key]?.trim()).map((key) => `${language}: ${key}`),
    )
    expect(missing).toEqual([])
    for (const language of supportedI18nLanguages) {
      const catalog = messages[language]
      expect(heard(language, catalog['search.band.calendar']), language).not.toBe(
        heard(language, catalog['search.band.chat']),
      )
    }
    expect(messages.ca['search.band.calendar']).toBe('El Calendari encara no té cerca')
    expect(messages.ca['search.band.chat']).toBe('El Xat encara no té cerca')
  })
})
