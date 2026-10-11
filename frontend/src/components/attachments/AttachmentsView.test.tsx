import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { AttachmentsView } = await import('./AttachmentsView')
const { attachmentList$, loadAttachments } = await import('../../states/attachmentList')
const { ui$ } = await import('../../states/ui')
const { accounts$ } = await import('../../states/accounts')

const item = (over: Record<string, unknown>) => ({
  account: 'a@x',
  folder: 'INBOX',
  uid: 2,
  thread_key: 'k',
  thread_id: 'a@x#INBOX#t.aw',
  subject: 'Quarterly',
  from_name: 'Ana',
  from_addr: 'ana@x.cat',
  date: 1_760_000_000,
  index: 0,
  filename: 'scan.pdf',
  mime: 'application/pdf',
  size: 900_000,
  key: 'a/INBOX/2/0.pdf',
  kind: 'pdf',
  unavailable: '',
  ...over,
})

function bridge(answer: (payload: any) => unknown) {
  const calls: any[] = []
  ;(window as any).go = {
    main: {
      App: { Invoke: async (command: string, payload: any) => (calls.push({ command, payload }), answer(payload)) },
    },
  }
  return calls
}

beforeEach(() => {
  accounts$.set([
    { id: 'a@x', email: 'a@x', auth_type: 'password' } as any,
    { id: 'b@z', email: 'b@z', auth_type: 'password' } as any,
  ])
  attachmentList$.assign({
    filter: { account: '', name: '', sender: '', kind: '', within: 0 },
    items: [],
    total: 0,
    coverage: { messages: 0, downloaded: 0 },
    loading: false,
    loaded: false,
  })
  ui$.attachmentsOpen.set(true)
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('lists files with their message, says how much mail is covered, and opens the message', async () => {
  bridge(() => ({
    items: [
      item({}),
      item({ uid: 3, index: 1, filename: 'old.zip', kind: 'archive', key: null, thread_id: 'a@x#INBOX#3' }),
    ],
    total: 2,
    coverage: { messages: 10, downloaded: 7 },
  }))
  const view = render(<AttachmentsView />)
  await waitFor(() => expect(view.getByText('scan.pdf')).toBeTruthy())
  expect(view.getByText('2 files')).toBeTruthy()
  expect(view.getByText(/3 of 10 messages have not been downloaded yet/)).toBeTruthy()
  expect(view.getByText(/Not on this computer right now/)).toBeTruthy()
  expect(view.getByRole('button', { name: 'Save scan.pdf' })).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Save old.zip' })).toBeNull()

  fireEvent.click(view.getByRole('button', { name: 'Open the message with scan.pdf' }))
  expect(ui$.attachmentsOpen.get()).toBe(false)
  expect(ui$.selectedThread.get()).toBe('a@x#INBOX#t.aw')
})

it('asks the core with the filters chosen', async () => {
  const calls = bridge(() => ({ items: [], total: 0, coverage: { messages: 1, downloaded: 1 } }))
  const view = render(<AttachmentsView />)
  await waitFor(() => expect(calls.length).toBe(1))
  fireEvent.change(view.getByLabelText('Type'), { target: { value: 'image' } })
  fireEvent.change(view.getByLabelText('Account'), { target: { value: 'b@z' } })
  await waitFor(() => expect(calls.at(-1).payload).toMatchObject({ kind: 'image', account: 'b@z' }))
  expect(view.getByText('No attachments found')).toBeTruthy()
  expect(view.queryByText(/have not been downloaded/)).toBeNull()
})

it('a slower answer to an older question does not replace a newer one', async () => {
  let release: (value: unknown) => void = () => {}
  let first = true
  bridge(() => {
    if (first) {
      first = false
      return new Promise((resolve) => (release = resolve))
    }
    return { items: [item({ filename: 'new.pdf' })], total: 1, coverage: { messages: 1, downloaded: 1 } }
  })
  const older = loadAttachments()
  await loadAttachments()
  release({ items: [item({ filename: 'stale.pdf' })], total: 1, coverage: { messages: 1, downloaded: 1 } })
  await older
  expect(attachmentList$.items.get().map((i) => i.filename)).toEqual(['new.pdf'])
})
