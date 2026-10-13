import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ReceiptNotice } from './ReceiptNotice'
import { ReceiptsGroup } from '../dialog/ReceiptsGroup'
import { MessageContent } from './MessageContent'
import { hydrateSettings, settings$ } from '../../states/settings'

const calls: { command: string; payload: any }[] = []
let answers: Record<string, (payload: any) => unknown> = {}

const message = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'acct#INBOX#7',
    folder_id: 'INBOX',
    thread_id: 'acct#INBOX#t',
    account_id: 'acct',
    message_id: 'm1@example.test',
    receipt_requested: true,
    ...overrides,
  }) as any

const status = (over: Record<string, unknown> = {}) => ({
  state: 'ask',
  to: ['ana@example.test'],
  automatic: false,
  ...over,
})

beforeEach(() => {
  calls.length = 0
  answers = {}
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
})
afterEach(() => {
  cleanup()
  delete (window as any).go
  settings$.readReceiptPolicy.set('ask')
})

it('asks, without blocking, and sends only on the click', async () => {
  answers['receipts.status'] = () => status()
  answers['receipts.answer'] = () => status({ state: 'sent' })
  const view = render(<ReceiptNotice message={message()} />)
  await waitFor(() => expect(view.getByText('The sender asked to be told when you read this.')).toBeTruthy())
  expect(calls.map((c) => c.command)).toEqual(['receipts.status'])
  expect(calls[0].payload).toEqual({ id: 'acct#INBOX#7', folder: 'INBOX' })

  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Send receipt' }))
  })
  expect(calls.find((c) => c.command === 'receipts.answer')?.payload).toEqual({
    id: 'acct#INBOX#7',
    folder: 'INBOX',
    send: true,
  })
  await waitFor(() => expect(view.getByText('A read receipt was sent.')).toBeTruthy())
  expect(view.queryByRole('button', { name: 'Send receipt' })).toBeNull()
})

it('remembers a refusal: the bar goes and nothing is sent', async () => {
  answers['receipts.status'] = () => status()
  answers['receipts.answer'] = (payload) => status({ state: payload.send ? 'sent' : 'declined' })
  const view = render(<ReceiptNotice message={message()} />)
  await waitFor(() => expect(view.getByRole('button', { name: 'Don’t send' })).toBeTruthy())
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Don’t send' }))
  })
  expect(calls.find((c) => c.command === 'receipts.answer')?.payload.send).toBe(false)
  await waitFor(() => expect(view.queryByRole('group')).toBeNull())
})

it('says why "always" did not apply', async () => {
  answers['receipts.status'] = () => status({ caution: 'addressMismatch', to: ['track@elsewhere.test'] })
  const view = render(<ReceiptNotice message={message()} />)
  await waitFor(() =>
    expect(view.getByText('The receipt would go to track@elsewhere.test, not where the message came from.')).toBeTruthy(),
  )
})

it('shows nothing for an answered, silent or unrequested message', async () => {
  for (const state of ['declined', 'silent', 'none']) {
    calls.length = 0
    answers['receipts.status'] = () => status({ state })
    const view = render(<ReceiptNotice message={message()} />)
    await waitFor(() => expect(calls.length).toBe(1))
    expect(view.container.textContent).toBe('')
    cleanup()
  }
})

it('says when a receipt went on its own under "always"', async () => {
  answers['receipts.status'] = () => status({ state: 'sent', automatic: true })
  const view = render(<ReceiptNotice message={message()} />)
  await waitFor(() => expect(view.getByText('A read receipt was sent, as your settings ask.')).toBeTruthy())
})

it('never asks the core about a message that did not request one, or one of our own', () => {
  const view = (outgoing: boolean) =>
    ({
      outgoing,
      isDraft: false,
      attachmentImages: [],
      bubbleAttachmentImages: [],
      videos: [],
      files: [],
      hiddenRemoteCount: 0,
      useHtmlBody: false,
      normalizedSearchQuery: '',
      activeSearchMatch: false,
    }) as any
  render(<MessageContent message={message({ receipt_requested: false, body: 'x' })} view={view(false)} galleryOffset={0} />)
  render(<MessageContent message={message({ body: 'x' })} view={view(true)} galleryOffset={0} />)
  expect(calls.some((c) => c.command.startsWith('receipts.'))).toBe(false)
  render(<MessageContent message={message({ body: 'x' })} view={view(false)} galleryOffset={0} />)
  expect(calls.filter((c) => c.command === 'receipts.status').length).toBe(1)
})

it('settings choose the policy and the defaults, starting at "ask"', () => {
  expect(settings$.readReceiptPolicy.get()).toBe('ask')
  const view = render(<ReceiptsGroup />)
  act(() => {
    fireEvent.click(view.getByRole('button', { name: 'Always send' }))
  })
  expect(settings$.readReceiptPolicy.get()).toBe('always')
  act(() => {
    fireEvent.click(view.getByRole('switch', { name: 'Request a read receipt on new messages' }))
  })
  expect(settings$.requestReadReceipt.get()).toBe(true)
  settings$.requestReadReceipt.set(false)

  // Only a known policy is taken from the store.
  hydrateSettings({ read_receipt_policy: 'never', request_delivery_receipt: true })
  expect(settings$.readReceiptPolicy.get()).toBe('never')
  expect(settings$.requestDeliveryReceipt.get()).toBe(true)
  hydrateSettings({ read_receipt_policy: 'sometimes' })
  expect(settings$.readReceiptPolicy.get()).toBe('never')
  settings$.requestDeliveryReceipt.set(false)
})
