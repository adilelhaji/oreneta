import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TaskDialog } from './TaskDialog'
import { TasksView } from './TasksView'
import { tasks$, type Task } from '../../states/tasks'
import { ui$ } from '../../states/ui'

// Repeating tasks (ADR-0053): the shared repeat editor in the task dialog,
// the indicator in the list, and the choice made on completing one.

afterEach(() => {
  cleanup()
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
  ui$.toast.set('')
  delete (window as any).go
})

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

/** Local midnight on a date, as the due date field stores it. */
function midnight(y: number, m: number, d: number): number {
  return Math.floor(new Date(y, m - 1, d).getTime() / 1000)
}

const lists = { lists: [{ id: 'mail', name: '', position: 0, open: 0 }] }

describe('the task editor', () => {
  it('writes a monthly rule on the nth weekday of the due date', async () => {
    ui$.taskEditor.set({ threadId: '', id: 0, dueAt: null, note: '', listId: 'mail' })
    const calls = stubBridge({ 'tasks.lists': lists, 'tasks.create': { ok: true, id: 3 } })
    const view = render(<TaskDialog />)

    fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Pay the rent' } })
    // Tuesday 13 October 2026 is the second Tuesday of the month.
    fireEvent.change(view.getByLabelText('Due date'), { target: { value: '2026-10-13' } })
    fireEvent.change(view.getByLabelText('Repeats'), { target: { value: 'monthly' } })
    const which = view.getByLabelText('Which day of the month') as HTMLSelectElement
    expect([...which.options].map((option) => option.value)).toEqual(['day', 'nth'])
    expect(which.options[0].textContent).toBe('On day 13')
    fireEvent.change(which, { target: { value: 'nth' } })
    fireEvent.change(view.getByLabelText('Ends'), { target: { value: 'after' } })
    fireEvent.change(view.getByLabelText('times'), { target: { value: '6' } })
    fireEvent.click(view.getByText('Save'))

    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.create')).toBe(true))
    const task = calls.find((c) => c.command === 'tasks.create')?.payload.task
    expect(task.due_at).toBe(midnight(2026, 10, 13))
    expect(task.recurrence).toMatchObject({ freq: 'monthly', interval: 1, month_week: 2, weekdays: [1], count: 6 })
  })

  it('makes a task with no due date due today when a repetition is chosen', () => {
    ui$.taskEditor.set({ threadId: '', id: 0, dueAt: null, note: '', listId: 'mail' })
    stubBridge({ 'tasks.lists': lists })
    const view = render(<TaskDialog />)
    expect((view.getByLabelText('Due date') as HTMLInputElement).value).toBe('')
    fireEvent.change(view.getByLabelText('Repeats'), { target: { value: 'daily' } })
    const today = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    expect((view.getByLabelText('Due date') as HTMLInputElement).value).toBe(
      `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    )
  })

  it('opens a repeating task on its rule and saves it back, or without it', async () => {
    ui$.taskEditor.set({ threadId: '', id: 9, dueAt: null, note: '' })
    const calls = stubBridge({
      'tasks.lists': lists,
      'tasks.get': {
        due_at: midnight(2026, 10, 14),
        note: '',
        title: 'Water the plants',
        list_id: 'mail',
        priority: 1,
        revision: 4,
        linked: false,
        recurrence: { freq: 'weekly', interval: 2, weekdays: [0, 2], until: null, count: null },
      },
      'tasks.update': { ok: true, revision: 5 },
    })
    const view = render(<TaskDialog />)
    await waitFor(() => expect((view.getByLabelText('Repeats') as HTMLSelectElement).value).toBe('weekly'))
    expect((view.getByLabelText('Repeat interval') as HTMLInputElement).value).toBe('2')
    const pressed = view.getAllByRole('button').filter((button) => button.getAttribute('aria-pressed') === 'true')
    expect(pressed.length).toBe(2)

    fireEvent.click(view.getByText('Save'))
    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.update')).toBe(true))
    expect(calls.find((c) => c.command === 'tasks.update')?.payload).toMatchObject({
      id: 9,
      revision: 4,
      task: { recurrence: { freq: 'weekly', interval: 2, weekdays: [0, 2] } },
    })
  })

  it('offers no repetition for a task tied to a conversation', () => {
    ui$.taskEditor.set({ threadId: 'acct#INBOX#t1', id: 0, dueAt: null, note: '' })
    stubBridge({ 'tasks.lists': lists })
    const view = render(<TaskDialog />)
    expect(view.queryByLabelText('Repeats')).toBeNull()
  })
})

function repeating(over: Partial<Task> = {}): Task {
  return {
    id: 5,
    thread_id: '',
    account_id: '',
    folder_id: '',
    note: '',
    due_at: midnight(2026, 10, 13),
    completed_at: null,
    created_at: 0,
    subject: '',
    from_name: '',
    from_addr: '',
    linked: false,
    list_id: 'mail',
    title: 'Water the plants',
    recurrence: { freq: 'weekly', interval: 1, weekdays: [1] },
    ...over,
  }
}

describe('a repeating task in the list', () => {
  it('shows how it repeats', () => {
    tasks$.items.set([repeating(), repeating({ id: 6, recurrence: { freq: 'daily', interval: 3, weekdays: [] } })])
    tasks$.loaded.set(true)
    stubBridge()
    const view = render(<TasksView />)
    expect(view.container.textContent).toContain('Every week')
    expect(view.container.textContent).toContain('Every 3 days')
  })

  it('asks before completing, and completes this occurrence', async () => {
    tasks$.items.set([repeating()])
    tasks$.loaded.set(true)
    const calls = stubBridge({
      'tasks.setCompleted': { ok: true, next_due: midnight(2026, 10, 20) },
      'tasks.list': { tasks: [repeating({ due_at: midnight(2026, 10, 20) })] },
    })
    const view = render(<TasksView />)
    fireEvent.click(view.getByLabelText('Mark done'))
    expect(calls.some((c) => c.command === 'tasks.setCompleted')).toBe(false)
    fireEvent.click(view.getByText('Complete this occurrence'))
    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.setCompleted')).toBe(true))
    const payload = calls.find((c) => c.command === 'tasks.setCompleted')?.payload
    expect(payload).toEqual({ id: 5, completed: true })
    await waitFor(() => expect(String(ui$.toast.get())).toContain('Next due'))
  })

  it('stops repeating when asked', async () => {
    tasks$.items.set([repeating()])
    tasks$.loaded.set(true)
    const calls = stubBridge({ 'tasks.setCompleted': { ok: true, next_due: null }, 'tasks.list': { tasks: [] } })
    const view = render(<TasksView />)
    fireEvent.click(view.getByLabelText('Mark done'))
    fireEvent.click(view.getByText('Stop repeating'))
    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.setCompleted')).toBe(true))
    expect(calls.find((c) => c.command === 'tasks.setCompleted')?.payload).toEqual({
      id: 5,
      completed: true,
      stop_repeating: true,
    })
  })

  it('cancelling the choice changes nothing', () => {
    tasks$.items.set([repeating()])
    tasks$.loaded.set(true)
    const calls = stubBridge()
    const view = render(<TasksView />)
    fireEvent.click(view.getByLabelText('Mark done'))
    fireEvent.click(view.getByText('Cancel'))
    expect(view.queryByText('Complete this occurrence')).toBeNull()
    expect(calls.some((c) => c.command === 'tasks.setCompleted')).toBe(false)
  })
})
