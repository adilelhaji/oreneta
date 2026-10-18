import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TasksView } from './TasksView'
import { isRemoteList, tasks$, type Task, type TaskList } from '../../states/tasks'
import { accounts$ } from '../../states/accounts'
import { ui$ } from '../../states/ui'
import type { Account } from '../../types'

// Task lists kept in an Exchange account's Tasks folder (ADR-0058).

const exchange = {
  id: 'acc',
  email: 'me@corp.example',
  provider: 'exchange',
  ews_url: 'https://mail.corp.example/EWS/Exchange.asmx',
} as Account

const bound: TaskList = {
  id: 'list:ews',
  name: 'me@corp.example',
  position: 1,
  open: 1,
  remote_url: '',
  synced_at: 1_700_000_000,
  last_error: '',
  conflicts: 1,
  ews_account: 'acc',
}
const lists = [{ id: 'mail', name: '', position: 0, open: 0 }, bound]

const conflicted: Task = {
  id: 7,
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
  list_id: 'list:ews',
  title: 'Informe',
  priority: 1,
  revision: 2,
  pending: 'put',
  conflict: 'changed',
}

function stubBridge(answers: Record<string, (payload: any) => unknown>) {
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
  accounts$.set([exchange])
})
// Whatever a test started settles before the next file runs: a reload that
// lands later would put this file's tasks into another file's view.
const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

afterEach(() => {
  cleanup()
  delete (window as any).go
  accounts$.set([])
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
  ui$.tasksOpen.set(false)
})

describe('Exchange task lists (ADR-0058)', () => {
  // ADR-0070: the list arrives with the account; one declined is added
  // again from «Afegeix una llista», which is offered only then.
  it('adds a declined Exchange account’s Tasks folder again from “Add a list”', async () => {
    let added = false
    const declined = {
      account: 'acc',
      source: 'ews',
      state: 'declined',
      list_id: '',
      adopted: false,
      notified: true,
      last_error: '',
      kind: 'ews',
      url: '',
    }
    const calls = stubBridge({
      'tasks.list': () => ({ tasks: [] }),
      'tasks.lists': () =>
        added
          ? { lists, account_lists: [{ ...declined, state: 'linked', list_id: 'list:ews' }] }
          : { lists: lists.slice(0, 1), account_lists: [declined] },
      'tasks.exchangeAdd': () => {
        added = true
        return { ok: true, id: 'list:ews' }
      },
    })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.getByText(/Add a list/)).toBeTruthy())
    // Not a button of its own in the list bar any more.
    expect(view.queryByText(/Exchange tasks of me@corp\.example/)).toBeNull()
    fireEvent.click(view.getByText(/Add a list/))
    fireEvent.click(view.getByText(/Exchange tasks of me@corp\.example/))
    await waitFor(() => expect(tasks$.selectedList.get()).toBe('list:ews'))
    expect(calls.find((c) => c.command === 'tasks.exchangeAdd')!.payload).toEqual({ account: 'acc' })
    expect(isRemoteList(bound)).toBe(true)
    await waitFor(() => expect(view.getByText(/Kept on me@corp\.example/)).toBeTruthy())
    // Once it is a list again, nothing is offered.
    expect(view.queryByText(/Add a list/)).toBeNull()
    await settled()
  })

  it('settles a conflict on an Exchange task like a CalDAV one', async () => {
    const calls = stubBridge({
      'tasks.list': () => ({ tasks: [conflicted] }),
      'tasks.lists': () => ({ lists }),
      'tasks.resolveConflict': () => ({ ok: true }),
    })
    tasks$.selectedList.set('list:ews')
    const view = render(<TasksView />)
    await waitFor(() => expect(view.getByText('Conflict')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Take the server’s' }))
    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.resolveConflict')).toBe(true))
    expect(calls.find((c) => c.command === 'tasks.resolveConflict')!.payload).toEqual({ id: 7, keep: 'server' })
    // The reload after settling has landed before the next test.
    await waitFor(() => expect(calls.filter((c) => c.command === 'tasks.list').length).toBeGreaterThanOrEqual(2))
    await settled()
  })
})
