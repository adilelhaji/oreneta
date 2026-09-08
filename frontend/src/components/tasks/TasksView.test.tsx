import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TasksView } from './TasksView'
import { tasks$, type Task } from '../../states/tasks'
import { ui$ } from '../../states/ui'

afterEach(() => {
  cleanup()
  tasks$.set({ items: [], loaded: false, loading: false, includeCompleted: false })
  ui$.taskEditor.set(null)
  ui$.selectedAccount.set('')
  ui$.selectedFolder.set('inbox')
  ui$.selectedThread.set('')
  ui$.tasksOpen.set(false)
  delete (window as any).go
})

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    thread_id: 'acct#INBOX#t1',
    account_id: 'acct',
    folder_id: 'INBOX',
    note: '',
    due_at: null,
    completed_at: null,
    created_at: 0,
    subject: 'Renew the contract',
    from_name: 'Ann',
    from_addr: 'ann@example.com',
    ...over,
  }
}

function stubBridge(responses: Record<string, unknown> = {}) {
  const calls: { command: string; payload: any }[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          return responses[command] ?? {}
        },
      },
    },
  }
  return calls
}

describe('the tasks view', () => {
  it('shows an empty state when there are no tasks', async () => {
    stubBridge({ 'tasks.list': { tasks: [] } })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.container.textContent).toContain('No tasks'))
  })

  it('lists a task with its subject and sender', async () => {
    stubBridge({ 'tasks.list': { tasks: [task()] } })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.container.textContent).toContain('Renew the contract'))
    expect(view.container.textContent).toContain('Ann')
  })

  it('opening a task leaves the view and selects its conversation', async () => {
    stubBridge({ 'tasks.list': { tasks: [task()] } })
    ui$.tasksOpen.set(true)
    const view = render(<TasksView />)
    await waitFor(() => expect(view.container.textContent).toContain('Renew the contract'))

    fireEvent.click(view.getByText('Renew the contract'))

    expect(ui$.tasksOpen.get()).toBe(false)
    expect(ui$.selectedAccount.get()).toBe('acct')
    expect(ui$.selectedFolder.get()).toBe('INBOX')
    expect(ui$.selectedThread.get()).toBe('acct#INBOX#t1')
  })

  it('the edit button opens the edit dialog without navigating away', async () => {
    stubBridge({ 'tasks.list': { tasks: [task({ note: 'Call them back' })] } })
    ui$.tasksOpen.set(true)
    const view = render(<TasksView />)
    await waitFor(() => expect(view.container.textContent).toContain('Renew the contract'))

    fireEvent.click(view.getByLabelText('Edit task'))
    expect(ui$.taskEditor.get()).toMatchObject({ threadId: 'acct#INBOX#t1', id: 1 })
    // Unlike opening the row itself, editing must not leave the Tasks view.
    expect(ui$.tasksOpen.get()).toBe(true)
  })

  it('completing a task calls tasks.setCompleted and reloads', async () => {
    const calls = stubBridge({
      'tasks.list': { tasks: [task()] },
      'tasks.setCompleted': { ok: true },
    })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.container.textContent).toContain('Renew the contract'))

    fireEvent.click(view.getByLabelText('Mark done'))
    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.setCompleted')).toBe(true))
    expect(calls.find((c) => c.command === 'tasks.setCompleted')?.payload).toMatchObject({ id: 1, completed: true })
  })

  it('removing a task calls tasks.delete and drops it from the list without a reload', async () => {
    const calls = stubBridge({ 'tasks.list': { tasks: [task()] }, 'tasks.delete': { ok: true } })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.container.textContent).toContain('Renew the contract'))

    fireEvent.click(view.getByLabelText('Remove task'))
    await waitFor(() => expect(view.container.textContent).toContain('No tasks'))
    expect(calls.find((c) => c.command === 'tasks.delete')?.payload).toMatchObject({ id: 1 })
    // Only the initial list call and the delete — no second tasks.list round trip.
    expect(calls.filter((c) => c.command === 'tasks.list').length).toBe(1)
  })

  it('toggling "show completed" reloads with include_completed', async () => {
    const calls = stubBridge({ 'tasks.list': { tasks: [] } })
    const view = render(<TasksView />)
    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.list')).toBe(true))

    fireEvent.click(view.getByLabelText('Show completed'))
    await waitFor(() =>
      expect(calls.some((c) => c.command === 'tasks.list' && c.payload?.include_completed === true)).toBe(true),
    )
  })
})
