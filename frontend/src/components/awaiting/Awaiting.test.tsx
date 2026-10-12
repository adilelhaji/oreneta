import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { AwaitingDialog } = await import('./AwaitingDialog')
const { awaiting$, reminderAt, waitForReply } = await import('../../states/awaiting')

const base = {
  account: 'acct',
  messageId: 'q1@example.com',
  threadKey: 't-roof',
  subject: 'Quote for the roof',
  recipients: ['ann@example.com'],
  sentAt: 1_800_000_000,
  remindAt: null,
  answer: null,
  possible: [],
  overdue: false,
}
let calls: { command: string; payload: any }[] = []
let items: any[] = []

beforeEach(() => {
  calls = []
  items = []
  awaiting$.assign({ open: false, items: [], loaded: false })
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'awaiting.list') return { items }
          return { ok: true }
        },
      },
    },
  }
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('says how an answer is known, and leaves a doubtful one to the person', async () => {
  items = [
    {
      ...base,
      status: 'answered',
      answer: { messageId: 'r@example.com', from: 'ann@example.com', date: 1_800_000_100, link: 'direct', doubt: '' },
    },
    {
      ...base,
      messageId: 'q2@example.com',
      subject: 'Invoice',
      status: 'possible',
      possible: [
        {
          messageId: 'auto@example.com',
          from: 'no-reply@example.com',
          date: 1_800_000_200,
          link: 'direct',
          doubt: 'automated',
        },
      ],
    },
    {
      ...base,
      messageId: 'q3@example.com',
      subject: 'Keys',
      status: 'waiting',
      overdue: true,
      remindAt: 1_800_000_050,
    },
  ]
  awaiting$.open.set(true)
  const view = render(<AwaitingDialog />)
  await waitFor(() => expect(view.getByText('Invoice')).toBeTruthy())
  expect(view.getByText(/ann@example.com replied to it on/)).toBeTruthy()
  expect(view.getByText('Maybe answered')).toBeTruthy()
  expect(view.getByText('It comes from an address that sends automatic messages.')).toBeTruthy()
  expect(view.getByText('No reply yet, past its reminder')).toBeTruthy()

  fireEvent.click(view.getByRole('button', { name: 'Not an answer' }))
  await waitFor(() => expect(calls.some((c) => c.command === 'awaiting.ruleOn')).toBe(true))
  expect(calls.find((c) => c.command === 'awaiting.ruleOn')?.payload).toEqual({
    account: 'acct',
    message_id: 'q2@example.com',
    candidate: 'auto@example.com',
    is_answer: false,
  })

  fireEvent.click(view.getAllByRole('button', { name: 'Stop waiting' })[2])
  await waitFor(() =>
    expect(calls.find((c) => c.command === 'awaiting.setState')?.payload).toEqual({
      account: 'acct',
      message_id: 'q3@example.com',
      state: 'cancelled',
    }),
  )
})

it('starts waiting on a conversation with a local reminder, and says so', async () => {
  const at = reminderAt(3, new Date(2026, 9, 12, 15, 30))
  const when = new Date(at * 1000)
  expect([when.getDate(), when.getHours(), when.getMinutes()]).toEqual([15, 9, 0])
  await waitForReply('acct#INBOX#t-roof', at)
  expect(calls[0]).toEqual({ command: 'awaiting.add', payload: { thread_id: 'acct#INBOX#t-roof', remind_at: at } })
  expect(calls.map((c) => c.command)).toContain('awaiting.list')
})
