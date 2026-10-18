import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TasksView } from './TasksView'
import { TaskDialog } from './TaskDialog'
import { tasks$, type Task } from '../../states/tasks'
import { ui$ } from '../../states/ui'
import { useValue } from '@legendapp/state/react'

const lists = [
  { id: 'mail', name: '', position: 0, open: 1 },
  { id: 'list:home', name: 'Home', position: 1, open: 1 },
]

function task(over: Partial<Task>): Task {
  return {
    id: 1,
    thread_id: 'acct#INBOX#7',
    account_id: 'acct',
    folder_id: 'INBOX',
    note: '',
    due_at: null,
    completed_at: null,
    created_at: 0,
    subject: 'Renew the contract',
    from_name: 'Ann',
    from_addr: 'ann@example.com',
    linked: true,
    list_id: 'mail',
    title: '',
    priority: 1,
    revision: 1,
    ...over,
  }
}

const standalone = task({
  id: 2,
  thread_id: '',
  linked: false,
  list_id: 'list:home',
  title: 'Fix the tap',
  subject: '',
  from_name: '',
  from_addr: '',
  priority: 2,
})

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

/** Mounted the way App mounts it: only while the editor is open. */
function Editor() {
  const open = useValue(ui$.taskEditor)
  return open ? <TaskDialog /> : null
}

describe('task lists (ADR-0013)', () => {
  it('shows every list, filters by list and by search', async () => {
    stubBridge({ 'tasks.list': () => ({ tasks: [task({}), standalone] }), 'tasks.lists': () => ({ lists }) })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.container.textContent).toContain('Fix the tap'))
    expect(view.container.textContent).toContain('Renew the contract')
    fireEvent.click(view.getByRole('tab', { name: /Home/ }))
    expect(view.container.textContent).not.toContain('Renew the contract')
    fireEvent.click(view.getByRole('tab', { name: /All/ }))
    fireEvent.change(view.getByLabelText('Search tasks'), { target: { value: 'renew' } })
    expect(view.container.textContent).not.toContain('Fix the tap')
    expect(view.container.textContent).toContain('Renew the contract')
  })

  it('opening a standalone task edits it instead of going to mail', async () => {
    stubBridge({ 'tasks.list': () => ({ tasks: [standalone] }), 'tasks.lists': () => ({ lists }) })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.container.textContent).toContain('Fix the tap'))
    fireEvent.click(view.getByText('Fix the tap'))
    expect(ui$.tasksOpen.get()).toBe(true)
    expect(ui$.taskEditor.get()).toMatchObject({ id: 2, threadId: '' })
  })

  it('creates a standalone task in the list being looked at', async () => {
    const calls = stubBridge({
      'tasks.list': () => ({ tasks: [] }),
      'tasks.lists': () => ({ lists }),
      'tasks.create': () => ({ ok: true, id: 9, revision: 1 }),
    })
    tasks$.selectedList.set('list:home')
    tasks$.lists.set(lists)
    const view = render(
      <>
        <TasksView />
        <Editor />
      </>,
    )
    fireEvent.click(view.getByText('New task'))
    await waitFor(() => expect(view.getByLabelText('Title')).toBeTruthy())
    const save = view.getByText('Save').closest('button') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Buy stamps' } })
    fireEvent.change(view.getByLabelText('Priority'), { target: { value: '2' } })
    fireEvent.click(save)
    await waitFor(() => expect(ui$.taskEditor.get()).toBeNull())
    expect(calls.find((c) => c.command === 'tasks.create')!.payload.task).toMatchObject({
      list_id: 'list:home',
      title: 'Buy stamps',
      priority: 2,
    })
  })

  it('an edit from an older revision saves nothing until the reader keeps one copy', async () => {
    let updates = 0
    const calls = stubBridge({
      'tasks.lists': () => ({ lists }),
      'tasks.get': () => ({
        title: 'Fix the tap',
        note: '',
        due_at: null,
        list_id: 'list:home',
        priority: 2,
        revision: 3,
        linked: false,
      }),
      'tasks.update': (payload) =>
        ++updates === 1
          ? {
              ok: false,
              conflict: true,
              current: {
                title: 'Fix the kitchen tap',
                note: '',
                due_at: null,
                list_id: 'list:home',
                priority: 2,
                reminder_at: null,
                revision: 4,
              },
            }
          : { ok: true, revision: payload.revision + 1 },
      'tasks.list': () => ({ tasks: [] }),
    })
    tasks$.lists.set(lists)
    ui$.taskEditor.set({ threadId: '', id: 2, dueAt: null, note: '' })
    const view = render(<TaskDialog />)
    await waitFor(() => expect((view.getByLabelText('Title') as HTMLInputElement).value).toBe('Fix the tap'))
    fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Fix the bath tap' } })
    fireEvent.click(view.getByText('Save'))
    await waitFor(() => expect(view.getByText('Changed in another window')).toBeTruthy())
    expect(view.container.ownerDocument.body.textContent).toContain('Fix the kitchen tap')
    expect(calls.find((c) => c.command === 'tasks.update')!.payload.revision).toBe(3)
    fireEvent.click(view.getByText('Keep mine'))
    await waitFor(() => expect(ui$.taskEditor.get()).toBeNull())
    const second = calls.filter((c) => c.command === 'tasks.update')[1].payload
    expect(second).toMatchObject({ revision: 4, task: { title: 'Fix the bath tap' } })
  })
})

describe('task list tabs in the reading direction (#226, ADR-0061)', () => {
  afterEach(() => {
    document.documentElement.dir = ''
  })

  it('moves to the next list with the left arrow in right to left, and back with the right one', async () => {
    document.documentElement.dir = 'rtl'
    stubBridge({ 'tasks.list': () => ({ tasks: [task({}), standalone] }), 'tasks.lists': () => ({ lists }) })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.container.textContent).toContain('Fix the tap'))
    const tabs = view.getAllByRole('tab')
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' })
    expect(tasks$.selectedList.get()).toBe(lists[0].id)
    expect(document.activeElement).toBe(view.getAllByRole('tab')[1])
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(tasks$.selectedList.get()).toBe('all')
  })

  it('moves with the right arrow in left to right', async () => {
    stubBridge({ 'tasks.list': () => ({ tasks: [task({}), standalone] }), 'tasks.lists': () => ({ lists }) })
    const view = render(<TasksView />)
    await waitFor(() => expect(view.container.textContent).toContain('Fix the tap'))
    const tabs = view.getAllByRole('tab')
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
    expect(tasks$.selectedList.get()).toBe(lists[0].id)
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(tasks$.selectedList.get()).toBe(lists[1].id)
  })
})
