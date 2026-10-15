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
    selectedList: 'all',
    search: '',
    syncing: false,
  })
  ui$.taskEditor.set(null)
  ui$.tasksOpen.set(true)
  accounts$.set([exchange])
})
afterEach(() => {
  cleanup()
  delete (window as any).go
  accounts$.set([])
})

describe('Exchange task lists (ADR-0058)', () => {
  it('adds an Exchange account’s Tasks folder as a list kept on a server', async () => {
    let added = false
    const calls = stubBridge({
      'tasks.list': () => ({ tasks: [] }),
      'tasks.lists': () => ({ lists: added ? lists : lists.slice(0, 1) }),
      'tasks.exchangeAdd': () => {
        added = true
        return { ok: true, id: 'list:ews' }
      },
    })
    const view = render(<TasksView />)
    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.lists')).toBe(true))
    fireEvent.click(view.getByText(/Exchange tasks of me@corp\.example/))
    await waitFor(() => expect(tasks$.selectedList.get()).toBe('list:ews'))
    expect(calls.find((c) => c.command === 'tasks.exchangeAdd')!.payload).toEqual({
      account: 'acc',
      name: 'me@corp.example',
    })
    expect(isRemoteList(bound)).toBe(true)
    await waitFor(() => expect(view.getByText(/Kept on me@corp\.example/)).toBeTruthy())
    // Once it is a list, the offer goes.
    expect(view.queryByText(/Exchange tasks of/)).toBeNull()
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
  })
})
