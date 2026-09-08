import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TaskDialog } from './TaskDialog'
import { ui$ } from '../../states/ui'

afterEach(() => {
  cleanup()
  ui$.taskEditor.set(null)
  delete (window as any).go
})

function stubBridge(responses: Record<string, unknown>) {
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

describe('creating a new task', () => {
  it('has no delete button and saves with the note and due date given', async () => {
    ui$.taskEditor.set({ threadId: 'acct#INBOX#t1', id: 0, dueAt: null, note: '' })
    const calls = stubBridge({ 'tasks.save': { ok: true, id: 1 } })
    const view = render(<TaskDialog />)

    expect(view.container.textContent).toContain('New task')
    expect(view.queryByText('Delete')).toBeNull()

    fireEvent.change(view.getByLabelText('Note'), { target: { value: 'Follow up next week' } })
    fireEvent.click(view.getByText('Save'))

    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.save')).toBe(true))
    const save = calls.find((c) => c.command === 'tasks.save')
    expect(save?.payload).toMatchObject({ thread_id: 'acct#INBOX#t1', note: 'Follow up next week' })
    expect(save?.payload).not.toHaveProperty('due_at')
  })
})

describe('editing an existing task', () => {
  it('fetches the real note rather than trusting the blank placeholder, and offers delete', async () => {
    ui$.taskEditor.set({ threadId: 'acct#INBOX#t1', id: 7, dueAt: 1_700_000_000, note: '' })
    const calls = stubBridge({
      'tasks.get': { due_at: 1_700_000_000, note: 'Call back about the invoice' },
    })
    const view = render(<TaskDialog />)

    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.get')).toBe(true))
    const getCall = calls.find((c) => c.command === 'tasks.get')
    expect(getCall?.payload).toMatchObject({ id: 7 })

    await waitFor(() =>
      expect((view.getByLabelText('Note') as HTMLTextAreaElement).value).toBe('Call back about the invoice'),
    )
    expect(view.container.textContent).toContain('Edit task')
    expect(view.getByText('Delete')).toBeTruthy()
  })

  it('deleting calls tasks.delete with the task id and closes', async () => {
    ui$.taskEditor.set({ threadId: 'acct#INBOX#t1', id: 7, dueAt: null, note: '' })
    const calls = stubBridge({
      'tasks.get': { due_at: null, note: 'Old note' },
      'tasks.delete': { ok: true },
    })
    const view = render(<TaskDialog />)
    await waitFor(() => expect((view.getByLabelText('Note') as HTMLTextAreaElement).value).toBe('Old note'))

    fireEvent.click(view.getByText('Delete'))
    await waitFor(() => expect(calls.some((c) => c.command === 'tasks.delete')).toBe(true))
    expect(calls.find((c) => c.command === 'tasks.delete')?.payload).toMatchObject({ id: 7 })
    expect(ui$.taskEditor.get()).toBeNull()
  })
})

describe('with no task being edited', () => {
  it('renders nothing', () => {
    ui$.taskEditor.set(null)
    expect(render(<TaskDialog />).container.textContent).toBe('')
  })
})
