import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { MergeDialog } = await import('./MergeDialog')
const { merge$ } = await import('../../states/merge')
const { accounts$ } = await import('../../states/accounts')
const { settleConfirm, ui$ } = await import('../../states/ui')

let calls: { command: string; payload: any }[] = []
let previewAnswer: any = null
let batches: any[] = []

beforeEach(() => {
  calls = []
  batches = []
  previewAnswer = {
    ready: true,
    problems: [],
    messages: [
      { index: 0, line: 2, to: 'ann@example.com', name: 'Ann', subject: 'For Acme', body: 'Dear Ann', problems: [] },
      { index: 1, line: 3, to: 'bob@example.com', name: 'Bob', subject: 'For Beta', body: 'Dear Bob', problems: [] },
    ],
  }
  accounts$.set([
    {
      id: 'acct',
      email: 'sam@example.com',
      display_name: 'Sam Example',
      provider: 'custom',
      auth_type: 'password',
    } as any,
  ])
  merge$.assign({ open: true, batches: [] })
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'merge.preview') return previewAnswer
          if (command === 'merge.start') {
            batches = [
              {
                id: 'b1',
                account: 'acct',
                from: 'sam@example.com',
                subject: 'For {{company}}',
                spacing: 3,
                state: 'paused',
                reason: 'the server asked to wait: 451 slow down',
                createdAt: 1,
                items: [
                  {
                    index: 0,
                    to: 'ann@example.com',
                    name: 'Ann',
                    subject: '',
                    body: '',
                    messageId: 'm0',
                    state: 'accepted',
                    error: '',
                  },
                  {
                    index: 1,
                    to: 'bob@example.com',
                    name: 'Bob',
                    subject: '',
                    body: '',
                    messageId: 'm1',
                    state: 'uncertain',
                    error: 'connection reset',
                  },
                ],
              },
            ]
            return { id: 'b1' }
          }
          if (command === 'merge.list') return { batches }
          return { ok: true }
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

const fill = (view: ReturnType<typeof render>) => {
  fireEvent.change(view.getByLabelText(/Recipients/), { target: { value: 'email,name\nann@example.com,Ann' } })
  fireEvent.change(view.getByLabelText('Subject'), { target: { value: 'For {{company}}' } })
  fireEvent.change(view.getByLabelText('Message (plain text)'), { target: { value: 'Dear {{to.firstName}}' } })
}

it('shows every message before anything can be sent, and sends exactly what was reviewed', async () => {
  const view = render(<MergeDialog />)
  const send = () => view.getByRole('button', { name: /^Send \d+ messages$/ }) as HTMLButtonElement
  fill(view)
  expect(send().disabled).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Preview every message' }))
  await waitFor(() => expect(view.getByText('Dear Bob')).toBeTruthy())
  expect(view.getByText('ann@example.com · For Acme')).toBeTruthy()
  expect(calls.find((c) => c.command === 'merge.preview')?.payload).toMatchObject({
    account: 'acct',
    from: 'sam@example.com',
    me_name: 'Sam Example',
  })

  fireEvent.click(send())
  await waitFor(() => expect(ui$.confirm.get()).toBeTruthy())
  settleConfirm(true)
  await waitFor(() => expect(calls.some((c) => c.command === 'merge.start')).toBe(true))
  expect(calls.find((c) => c.command === 'merge.start')?.payload.reviewed).toBe(2)

  // Then what happened to each, said as it is.
  await waitFor(() => expect(view.getByText(/1 of 2 sent/)).toBeTruthy())
  expect(view.getByText(/1 unknown, never sent again on their own/)).toBeTruthy()
  expect(view.getByText('the server asked to wait: 451 slow down')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Carry on' }))
  await waitFor(() =>
    expect(calls.find((c) => c.command === 'merge.resume')?.payload).toEqual({ id: 'b1', retry_rejected: false }),
  )
})

it('marks what must be fixed and will not send until it is', async () => {
  previewAnswer = {
    ready: false,
    problems: ['unknown:nickname'],
    messages: [
      { index: 0, line: 2, to: 'ann@example.com', name: 'Ann', subject: 's', body: 'b', problems: [] },
      { index: 1, line: 3, to: 'ANN@example.com', name: 'Ann', subject: 's', body: 'b', problems: ['duplicate'] },
      {
        index: 2,
        line: 4,
        to: 'bob@example.com',
        name: '',
        subject: 's',
        body: 'b',
        problems: ['missing:to.firstName'],
      },
    ],
  }
  const view = render(<MergeDialog />)
  fill(view)
  fireEvent.click(view.getByRole('button', { name: 'Preview every message' }))
  await waitFor(() => expect(view.getByText('Fix what is marked before sending.')).toBeTruthy())
  expect(view.getByText('{{nickname}} is not a column or placeholder')).toBeTruthy()
  expect(view.getByText(/Line 3.*already in the list/)).toBeTruthy()
  expect(view.getByText(/Line 4.*nothing for \{\{to.firstName\}\}/)).toBeTruthy()
  expect((view.getByRole('button', { name: /^Send \d+ messages$/ }) as HTMLButtonElement).disabled).toBe(true)
})

it('asks for a new review after any change', async () => {
  const view = render(<MergeDialog />)
  fill(view)
  fireEvent.click(view.getByRole('button', { name: 'Preview every message' }))
  await waitFor(() => expect(view.getByText('Dear Ann')).toBeTruthy())
  fireEvent.change(view.getByLabelText('Subject'), { target: { value: 'Changed' } })
  expect(view.queryByText('Dear Ann')).toBeNull()
  expect((view.getByRole('button', { name: /^Send \d+ messages$/ }) as HTMLButtonElement).disabled).toBe(true)
})
