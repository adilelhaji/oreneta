import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TasksView } from './TasksView'
import { tasks$, type AccountTaskList, type Task, type TaskList } from '../../states/tasks'
import { accounts$ } from '../../states/accounts'
import { ui$ } from '../../states/ui'
import type { Account } from '../../types'

// The task lists that come with an account (#281, ADR-0070), in Tasks.

const exchange = { id: 'acc', email: 'me@corp.example', provider: 'exchange' } as Account

const waiting: AccountTaskList = {
  account: 'acc',
  source: 'ews',
  state: 'pending',
  list_id: '',
  adopted: false,
  notified: true,
  last_error: '',
  kind: 'ews',
  url: '',
}
const davList: TaskList = {
  id: 'list:dav',
  name: 'Feina',
  position: 1,
  open: 1,
  remote_url: 'https://dav.example/ana/tasks/',
  synced_at: 1_700_000_000,
  last_error: '',
  conflicts: 0,
}
const upgraded: AccountTaskList = {
  ...waiting,
  source: 'caldav:https://dav.example/ana/tasks/',
  state: 'linked',
  list_id: 'list:dav',
  notified: false,
  kind: 'caldav',
  url: 'https://dav.example/ana/tasks/',
}
const mail = { id: 'mail', name: '', position: 0, open: 0 }
const fromAccount: Task = {
  id: 3,
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
  title: 'Informe',
  priority: 1,
  revision: 1,
}

function stubBridge(answers: Record<string, (payload: any) => unknown>) {
  const calls: { command: string; payload: any }[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          return answers[command]?.(payload) ?? {}
        },
      },
    },
  }
  return calls
}

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

beforeEach(() => {
  tasks$.set({ ...empty })
  ui$.taskEditor.set(null)
  ui$.module.set('tasks')
  accounts$.set([exchange])
})
const settled = () => new Promise((resolve) => setTimeout(resolve, 20))
afterEach(() => {
  cleanup()
  delete (window as any).go
  delete (window as any).runtime
  accounts$.set([])
  tasks$.set({ ...empty })
  ui$.confirm.set(null)
  ui$.taskEditor.set(null)
  ui$.module.set('mail')
})

describe('the task lists that come with an account (ADR-0070)', () => {
  it('reads a waiting list on opening Tasks and never calls it “No tasks”', async () => {
    const calls = stubBridge({
      'tasks.list': () => ({ tasks: [] }),
      'tasks.lists': () => ({ lists: [mail], account_lists: [waiting] }),
      'tasks.sync': () => ({ lists: [], accounts: [] }),
    })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.getByText('Reading the tasks of me@corp.example…')).toBeTruthy())
    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.sync')).toBe(true))
    expect(calls.find((c) => c.command === 'tasks.sync')!.payload).toEqual({})
    expect(view.queryByText('No tasks')).toBeNull()
    expect(view.getByText(/have not been read yet/)).toBeTruthy()
    await settled()
  })

  // Text queries only: role queries over the whole Tasks view are slow
  // enough under happy-dom to starve these flows past the test timeout.
  const button = (view: ReturnType<typeof render>, text: string) =>
    view.getByText(text).closest('button') as HTMLButtonElement

  it(
    'says why a list could not be read, tries again and declines it on request',
    async () => {
      let declined = false
      const calls = stubBridge({
        'tasks.list': () => ({ tasks: [] }),
        'tasks.lists': () => ({
          lists: [mail],
          account_lists: [declined ? { ...waiting, state: 'declined' } : { ...waiting, last_error: 'ErrorAccessDenied' }],
        }),
        'tasks.sync': () => ({ lists: [], accounts: [{ account: 'acc', source: 'ews', ok: false }] }),
        'tasks.declineAccountList': () => {
          declined = true
          return { ok: true }
        },
      })
      const view = render(<TasksView />)
      await waitFor(() =>
        expect(view.queryByText('The tasks of me@corp.example could not be read: ErrorAccessDenied')).not.toBeNull(),
      )
      const syncs = () => calls.filter((c) => c.command === 'tasks.sync').length
      await waitFor(() => expect(syncs()).toBe(1))
      await waitFor(() => expect(tasks$.syncing.get()).toBe(false))
      await waitFor(() => expect(button(view, 'Try again').disabled).toBe(false))
      fireEvent.click(button(view, 'Try again'))
      await waitFor(() => expect(syncs()).toBe(2))
      await waitFor(() => expect(tasks$.syncing.get()).toBe(false))
      fireEvent.click(button(view, 'Don’t add it'))
      await waitFor(() => expect(tasks$.accountLists.get()[0]?.state).toBe('declined'))
      await waitFor(() => expect(view.queryByText(/could not be read/)).toBeNull())
      expect(calls.find((c) => c.command === 'tasks.declineAccountList')!.payload).toEqual({ account: 'acc', source: 'ews' })
      // Declined, it is offered under “Add a list”, and “No tasks” is true now.
      await waitFor(() => expect(view.queryByText(/Add a list/)).not.toBeNull())
      expect(view.queryByText('No tasks')).not.toBeNull()
      await settled()
    },
    15_000,
  )

  it(
    'shows the upgrade’s notice until “Remove it” or “OK”, kept by the core',
    async () => {
      let answered = ''
      const calls = stubBridge({
        'tasks.list': () => ({ tasks: answered === 'removed' ? [] : [fromAccount] }),
        'tasks.lists': () =>
          answered === 'removed'
            ? { lists: [mail], account_lists: [{ ...upgraded, state: 'declined', list_id: '', notified: true }] }
            : { lists: [mail, davList], account_lists: [{ ...upgraded, notified: answered === 'ok' }] },
        'tasks.sync': () => ({ lists: [{ id: 'list:dav', ok: true }], accounts: [] }),
        'tasks.acknowledgeAccountList': () => {
          answered = 'ok'
          return { ok: true }
        },
        'tasks.declineAccountList': () => {
          answered = 'removed'
          return { ok: true }
        },
      })
      const view = render(<TasksView />)
      const notice = 'The list Feina of me@corp.example was added on its own when Oreneta was updated.'
      // Wait on the state first, then read the DOM once it has rendered: a
      // waitFor that re-queries the whole view on every mutation starves the
      // render it is waiting for (#334).
      await waitFor(() => expect(tasks$.accountLists.get()[0]?.notified).toBe(false))
      await waitFor(() => expect(tasks$.syncing.get()).toBe(false))
      await waitFor(() => expect(view.queryByText(notice)).not.toBeNull())
      fireEvent.click(button(view, 'OK'))
      await waitFor(() => expect(tasks$.accountLists.get()[0]?.notified).toBe(true))
      await waitFor(() => expect(view.queryByText(notice)).toBeNull())
      expect(calls.find((c) => c.command === 'tasks.acknowledgeAccountList')!.payload).toEqual({
        account: 'acc',
        source: upgraded.source,
      })

      // «Treu-la» on another one: the list goes, declined.
      answered = ''
      tasks$.accountLists.set([upgraded])
      await waitFor(() => expect(view.queryByText('Remove it')).not.toBeNull())
      fireEvent.click(button(view, 'Remove it'))
      await waitFor(() => expect(calls.some((c) => c.command === 'tasks.declineAccountList')).toBe(true))
      await waitFor(() => expect(tasks$.items.get()).toEqual([]))
      await waitFor(() => expect(view.queryByText('Informe')).toBeNull())
      await waitFor(() => expect(view.queryByText(/Add a list/)).not.toBeNull())
      await settled()
    },
    15_000,
  )

  it('shows a list read behind the view as soon as the core says it is here', async () => {
    const listeners: Record<string, () => void> = {}
    ;(window as any).runtime = {
      EventsOn: (name: string, callback: () => void) => {
        listeners[name] = callback
        return () => delete listeners[name]
      },
    }
    let arrived = false
    stubBridge({
      'tasks.list': () => ({ tasks: arrived ? [fromAccount] : [] }),
      'tasks.lists': () =>
        arrived
          ? { lists: [mail, davList], account_lists: [{ ...upgraded, notified: true }] }
          : { lists: [mail], account_lists: [] },
    })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.getByText('No tasks')).toBeTruthy())
    arrived = true
    act(() => listeners['tasks.changed']())
    await waitFor(() => expect(view.getByText('Informe')).toBeTruthy())
    expect(view.getByRole('tab', { name: /Feina/ })).toBeTruthy()
    view.unmount()
    expect(listeners['tasks.changed']).toBeUndefined()
    await settled()
  })

  it('says a deleted list of an account does not come back, and mentions a password only if it has one', async () => {
    const ews: TaskList = { ...davList, id: 'list:ews', name: 'Exchange', remote_url: '', ews_account: 'acc' }
    stubBridge({
      'tasks.list': () => ({ tasks: [] }),
      'tasks.lists': () => ({
        lists: [mail, davList, ews],
        account_lists: [
          { ...upgraded, notified: true },
          { ...waiting, state: 'linked', list_id: 'list:ews' },
        ],
      }),
      'tasks.sync': () => ({ lists: [], accounts: [] }),
    })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.getByRole('tab', { name: /Exchange/ })).toBeTruthy())
    fireEvent.click(view.getByRole('tab', { name: /Exchange/ }))
    fireEvent.click(view.getByRole('button', { name: 'Delete list' }))
    await waitFor(() => expect(ui$.confirm.get()).toBeTruthy())
    expect(ui$.confirm.get()!.message).toContain('does not come back on its own')
    expect(ui$.confirm.get()!.message).not.toContain('password')
    act(() => ui$.confirm.set(null))
    fireEvent.click(view.getByRole('tab', { name: /Feina/ }))
    fireEvent.click(view.getByRole('button', { name: 'Delete list' }))
    await waitFor(() => expect(ui$.confirm.get()?.message).toContain('with its saved password'))
    expect(ui$.confirm.get()!.message).toContain('does not come back on its own')
    await settled()
  })
})
