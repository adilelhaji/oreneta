import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TasksView } from './TasksView'
import { TaskDialog } from './TaskDialog'
import { tasks$, type Task, type TaskList } from '../../states/tasks'
import { ui$ } from '../../states/ui'

const URL = 'https://dav.example/ana/chores/'

const local: TaskList = { id: 'list:home', name: 'Home', position: 1, open: 0 }
const bound: TaskList = {
  id: 'list:dav',
  name: 'Chores',
  position: 2,
  open: 1,
  remote_url: URL,
  remote_user: 'ana',
  synced_at: 1_700_000_000,
  last_error: '',
  conflicts: 0,
}
const lists = [{ id: 'mail', name: '', position: 0, open: 0 }, local, bound]

function task(over: Partial<Task>): Task {
  return {
    id: 5,
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
    list_id: 'list:dav',
    title: 'Paint the door',
    priority: 1,
    revision: 1,
    pending: '',
    conflict: '',
    ...over,
  }
}

type Answers = Record<string, (payload: any) => unknown>

function stubBridge(answers: Answers) {
  const calls: { command: string; payload: any }[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          const answer = answers[command]
          return answer ? answer(payload) : {}
        },
      },
    },
  }
  return calls
}

beforeEach(() => {
  tasks$.set({
    items: [],
    loaded: false,
    loading: false,
    includeCompleted: false,
    lists: [],
    accountLists: [],
    selectedList: 'all',
    search: '',
    syncing: false,
  })
  ui$.taskEditor.set(null)
  ui$.tasksOpen.set(true)
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

describe('task lists kept on a CalDAV server (ADR-0039)', () => {
  it('finds the collections on a server and adds the one chosen as a list', async () => {
    let added = false
    const calls = stubBridge({
      'tasks.list': () => ({ tasks: [] }),
      'tasks.lists': () => ({ lists: added ? lists : lists.slice(0, 2) }),
      'tasks.caldavDiscover': () => ({
        calendars: [
          { url: 'https://dav.example/ana/work/', name: 'Work', writable: true },
          { url: URL, name: 'Chores', writable: true },
        ],
      }),
      'tasks.caldavAdd': () => {
        added = true
        return { ok: true, id: 'list:dav' }
      },
    })
    const view = render(<TasksView />)
    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.lists')).toBe(true))
    expect(calls.some((c) => c.command === 'tasks.sync')).toBe(false)
    fireEvent.click(view.getByText(/CalDAV task list/))
    fireEvent.change(view.getByLabelText('Server or address'), { target: { value: 'dav.example' } })
    fireEvent.change(view.getByLabelText('User name'), { target: { value: 'ana' } })
    fireEvent.change(view.getByLabelText('Password'), { target: { value: 'secret' } })
    fireEvent.click(view.getByRole('button', { name: 'Find lists' }))
    await waitFor(() => expect(view.getByText('Collections on this server')).toBeTruthy())
    expect(calls.find((c) => c.command === 'tasks.caldavDiscover')!.payload).toEqual({
      server: 'dav.example',
      username: 'ana',
      password: 'secret',
    })
    fireEvent.click(view.getByRole('radio', { name: 'Chores' }))
    expect((view.getByLabelText('Name here') as HTMLInputElement).value).toBe('Chores')
    fireEvent.click(view.getByRole('button', { name: 'Add list' }))
    // Compared as a boolean: a failing match on an element prints all of it.
    await waitFor(() => expect(view.queryByText('Collections on this server') === null).toBe(true))
    expect(calls.find((c) => c.command === 'tasks.caldavAdd')!.payload).toEqual({
      url: URL,
      name: 'Chores',
      server: 'dav.example',
      username: 'ana',
      password: 'secret',
    })
    expect(tasks$.selectedList.get()).toBe('list:dav')
    await waitFor(() => expect(view.getByText(/Kept on dav\.example/)).toBeTruthy())
  })

  it('keeps the dialog open with the reason when the list cannot be read', async () => {
    stubBridge({
      'tasks.list': () => ({ tasks: [] }),
      'tasks.lists': () => ({ lists: lists.slice(0, 2) }),
      'tasks.caldavDiscover': () => ({ calendars: [{ url: URL, name: 'Chores' }] }),
      'tasks.caldavAdd': () => {
        throw new Error('the server refused those credentials')
      },
    })
    const view = render(<TasksView />)
    fireEvent.click(view.getByText(/CalDAV task list/))
    fireEvent.change(view.getByLabelText('Server or address'), { target: { value: 'dav.example' } })
    fireEvent.click(view.getByRole('button', { name: 'Find lists' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Add list' })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Add list' }))
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('refused those credentials'))
    expect(view.getByText('Collections on this server')).toBeTruthy()
  })

  it('syncs lists kept on a server when the view opens, and shows why the last sync failed', async () => {
    const failing = { ...bound, last_error: 'the server would not list the calendar (HTTP 503)' }
    const calls = stubBridge({
      'tasks.list': () => ({ tasks: [task({})] }),
      'tasks.lists': () => ({ lists: [lists[0], local, failing] }),
      'tasks.sync': (payload) => ({ lists: [{ id: 'list:dav', ok: false, error: failing.last_error, ...payload }] }),
    })
    tasks$.selectedList.set('list:dav')
    const view = render(<TasksView />)
    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.sync')).toBe(true))
    expect(calls.find((c) => c.command === 'tasks.sync')!.payload).toEqual({})
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('HTTP 503'))
    expect(view.getByRole('alert').textContent).toContain('Nothing here was lost')
    fireEvent.click(view.getByRole('button', { name: 'Sync' }))
    await waitFor(() => expect(calls.filter((c) => c.command === 'tasks.sync').length).toBe(2))
    expect(calls.filter((c) => c.command === 'tasks.sync')[1].payload).toEqual({ list_id: 'list:dav' })
  })

  it('a task in conflict is settled with either copy', async () => {
    const calls = stubBridge({
      'tasks.list': () => ({ tasks: [task({ conflict: 'changed', pending: 'put' })] }),
      'tasks.lists': () => ({ lists: [lists[0], local, { ...bound, conflicts: 1 }] }),
      'tasks.resolveConflict': () => ({ ok: true }),
    })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.getByText('Conflict')).toBeTruthy())
    expect(view.container.textContent).toContain('Changed here and on the server.')
    fireEvent.click(view.getByRole('button', { name: 'Keep mine' }))
    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.resolveConflict')).toBe(true))
    expect(calls.find((c) => c.command === 'tasks.resolveConflict')!.payload).toEqual({ id: 5, keep: 'mine' })
    await waitFor(() =>
      expect((view.getByRole('button', { name: 'Take the server’s' }) as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(view.getByRole('button', { name: 'Take the server’s' }))
    await waitFor(() => expect(calls.filter((c) => c.command === 'tasks.resolveConflict').length).toBe(2))
    expect(calls.filter((c) => c.command === 'tasks.resolveConflict')[1].payload).toEqual({ id: 5, keep: 'server' })
  })

  it('says a task cannot be moved between a server list and another one, and does not save', async () => {
    const calls = stubBridge({
      'tasks.lists': () => ({ lists }),
      'tasks.get': () => ({
        title: 'Paint the door',
        note: '',
        due_at: null,
        list_id: 'list:dav',
        priority: 1,
        revision: 2,
        linked: false,
      }),
    })
    tasks$.lists.set(lists)
    ui$.taskEditor.set({ threadId: '', id: 5, dueAt: null, note: '' })
    const view = render(<TaskDialog />)
    await waitFor(() => expect((view.getByLabelText('Title') as HTMLInputElement).value).toBe('Paint the door'))
    expect(view.queryByRole('alert') === null).toBe(true)
    fireEvent.change(view.getByLabelText('List'), { target: { value: 'list:home' } })
    expect(view.getByRole('alert').textContent).toContain('cannot be moved between a list kept on a server')
    const save = view.getByText('Save').closest('button') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(calls.some((c) => c.command === 'tasks.update')).toBe(false)
  })
  it('a date-only due date shows its own day in the editor, whatever the zone', async () => {
    const midnight = Math.floor(new Date(2026, 2, 10).getTime() / 1000)
    stubBridge({
      'tasks.lists': () => ({ lists }),
      'tasks.get': () => ({
        title: 'Paint',
        note: '',
        due_at: midnight,
        list_id: 'list:dav',
        priority: 1,
        revision: 1,
      }),
    })
    tasks$.lists.set(lists)
    ui$.taskEditor.set({ threadId: '', id: 5, dueAt: midnight, note: '' })
    const view = render(<TaskDialog />)
    await waitFor(() => expect((view.getByLabelText('Title') as HTMLInputElement).value).toBe('Paint'))
    expect((view.container.ownerDocument.getElementById('task-due') as HTMLInputElement).value).toBe('2026-03-10')
  })
})
