import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { SenderListsGroup } = await import('./SenderListsGroup')
const { RulesSettingsSection } = await import('./RulesSettingsSection')
const { accounts$ } = await import('../../states/accounts')
const { rules$ } = await import('../../states/rules')
const { settleConfirm, ui$ } = await import('../../states/ui')

const calls: { command: string; payload: any }[] = []
let entries: { pattern: string; allow: boolean }[] = []
let answers: Record<string, (payload: any) => unknown> = {}

beforeEach(() => {
  calls.length = 0
  entries = []
  answers = {}
  accounts$.set([{ id: 'acct', email: 'sam@example.com', provider: 'custom', auth_type: 'password' } as any])
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (answers[command]) return answers[command](payload)
          if (command === 'spam.lists') return { entries }
          if (command === 'spam.setListed') {
            if (payload.pattern === 'nonsense') throw new Error('write an address, or a domain such as @example.com')
            entries = entries.filter((e) => e.pattern !== payload.pattern)
            if (payload.allow !== undefined) entries.push({ pattern: payload.pattern, allow: payload.allow })
            return { ok: true, pattern: payload.pattern }
          }
          return {}
        },
      },
    },
  }
})
afterEach(() => {
  cleanup()
  delete (window as any).go
  ui$.confirm.set(null)
})

it('blocks and allows senders per account, and takes them off again', async () => {
  const view = render(<SenderListsGroup />)
  const input = view.getByLabelText('Address or domain')
  fireEvent.change(input, { target: { value: '@shop.example' } })
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Block' }))
  })
  await waitFor(() => expect(view.getByText('@shop.example')).toBeTruthy())
  expect(calls.find((c) => c.command === 'spam.setListed')?.payload).toEqual({
    account: 'acct',
    pattern: '@shop.example',
    allow: false,
  })
  expect(view.getByText('blocked')).toBeTruthy()
  await act(async () => {
    fireEvent.click(view.getByLabelText('Take @shop.example off the list'))
  })
  await waitFor(() => expect(view.queryByText('@shop.example')).toBeNull())
  expect(calls.filter((c) => c.command === 'spam.setListed').at(-1)?.payload).toEqual({
    account: 'acct',
    pattern: '@shop.example',
  })
  fireEvent.change(input, { target: { value: 'nonsense' } })
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Allow' }))
  })
  await waitFor(() => expect(ui$.toast.get()).toContain('write an address'))
})

it('runs the stored rules exactly as previewed and reports each failed step', async () => {
  rules$.assign({
    rules: [
      {
        id: 'r1',
        account: '',
        name: 'Receipts',
        enabled: true,
        matchMode: 'all',
        conditions: [{ field: 'from', op: 'contains', value: 'shop' }],
        actions: [{ type: 'markRead' }, { type: 'moveTo', folder: 'Receipts' }],
      },
    ],
    loaded: true,
  } as any)
  answers['rules.list'] = () => ({ rules: rules$.rules.peek() })
  answers['rules.preview'] = (payload) => ({
    examined: 10,
    matches: [{ uid: 5, subject: 'Order', from: 'shop@example.com', date: 1, actions: [] }],
    reviewId: payload.rules ? null : 'rules-1',
  })
  answers['rules.runReviewed'] = () => ({
    done: 0,
    failed: 1,
    messages: [
      {
        uid: 5,
        subject: 'Order',
        steps: [
          { action: 'Mark as read', ok: true },
          { action: 'Move to Receipts', ok: false, error: 'NO [TRYCREATE] no such mailbox' },
        ],
      },
    ],
  })
  const view = render(<RulesSettingsSection />)
  fireEvent.click(view.getByRole('button', { name: /Try/ }))
  await waitFor(() => expect(view.getByRole('button', { name: 'Run on these 1 messages' })).toBeTruthy())
  // The stored rules are previewed as stored, so the preview can be run.
  expect(calls.find((c) => c.command === 'rules.preview')?.payload.rules).toBeUndefined()
  fireEvent.click(view.getByRole('button', { name: 'Run on these 1 messages' }))
  await waitFor(() => expect(ui$.confirm.get()).toBeTruthy())
  settleConfirm(true)
  await waitFor(() => expect(view.getByText('Every step ran on 0 of 1 messages')).toBeTruthy())
  expect(calls.find((c) => c.command === 'rules.runReviewed')?.payload).toEqual({
    account: 'acct',
    folder: 'INBOX',
    review_id: 'rules-1',
  })
  expect(view.getByText(/Move to Receipts: NO \[TRYCREATE\]/)).toBeTruthy()
})
