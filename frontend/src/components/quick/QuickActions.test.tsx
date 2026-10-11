import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { QuickActionsGroup } = await import('./QuickActionsGroup')
const { QuickActionDialog } = await import('./QuickActionDialog')
const { settings$ } = await import('../../states/settings')
const { quickRun$, startQuickAction } = await import('../../states/quickActions')
const { accounts$ } = await import('../../states/accounts')

beforeEach(() => {
  settings$.quickActions.set([])
  accounts$.set([{ id: 'a@x', email: 'a@x', auth_type: 'password' } as any])
  quickRun$.assign({ pending: null, report: null, running: false, error: '' })
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('builds an action step by step and will not keep one that cannot run', () => {
  const view = render(<QuickActionsGroup />)
  fireEvent.click(view.getByRole('button', { name: 'New Quick Action' }))
  const save = view.getByRole('button', { name: 'Save' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Done' } })
  fireEvent.click(view.getByRole('button', { name: 'Add step' }))
  fireEvent.click(view.getByRole('button', { name: 'Add step' }))
  fireEvent.change(view.getByLabelText('Step 1'), { target: { value: 'archive' } })
  expect(view.getByText(/has to be the last step/)).toBeTruthy()
  expect(save.disabled).toBe(true)
  fireEvent.click(view.getAllByRole('button', { name: 'Move down' })[0])
  expect(save.disabled).toBe(false)
  fireEvent.click(save)
  expect(settings$.quickActions.get()).toMatchObject([
    { name: 'Done', steps: [{ kind: 'markRead' }, { kind: 'archive' }] },
  ])
  expect(view.getByText('Alt+1')).toBeTruthy()
})

it('asks first, runs on the frozen set, and reports each step that failed', async () => {
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          if (command === 'mail.markStarred' && payload.thread_id === 't2') throw new Error('server said no')
          return {}
        },
      },
    },
  }
  startQuickAction({ id: 'q', name: 'Star it', steps: [{ kind: 'markRead' }, { kind: 'star' }] }, [
    { key: 't1', kind: 'mail', threadId: 't1', accountId: 'a@x', folderId: 'INBOX' } as any,
    { key: 't2', kind: 'mail', threadId: 't2', accountId: 'a@x', folderId: 'INBOX' } as any,
  ])
  const view = render(<QuickActionDialog />)
  expect(view.getByText('Run “Star it”?')).toBeTruthy()
  expect(view.getByText(/Mail that arrives while it runs is not touched/)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Run on 2 conversations' }))
  await waitFor(() => expect(view.getByText('“Star it” stopped for some conversations')).toBeTruthy())
  expect(view.getByText('Every step ran for 1 of 2 conversations.')).toBeTruthy()
  expect(view.getByText(/Star: server said no/)).toBeTruthy()
})
