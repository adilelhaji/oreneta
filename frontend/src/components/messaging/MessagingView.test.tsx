import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MessagingView } from './MessagingView'
import { messaging$, onChatEvent } from '../../states/messaging'

const calls: { command: string; payload: any }[] = []
let answers: Record<string, (payload: any) => unknown> = {}

const history = [
  {
    account: 'c1',
    conversation: 'pau@chat.test',
    id: 'm1',
    stanza_id: 'a1',
    direction: 'in',
    sender: 'pau@chat.test',
    body: 'Hola Ana',
    stamp: 1_760_000_000,
    state: 'received',
  },
  {
    account: 'c1',
    conversation: 'pau@chat.test',
    id: 's1',
    stanza_id: null,
    direction: 'out',
    sender: 'ana@chat.test',
    body: 'Hola, ¿qué tal?',
    stamp: 1_760_000_060,
    state: 'delivered',
  },
  {
    account: 'c1',
    conversation: 'pau@chat.test',
    id: 's2',
    stanza_id: null,
    direction: 'out',
    sender: 'ana@chat.test',
    body: '¿Sigues ahí?',
    stamp: 1_760_000_120,
    state: 'uncertain',
  },
]

beforeEach(() => {
  calls.length = 0
  messaging$.set({ accounts: [], status: {}, account: '', conversations: [], conversation: '', history: [] })
  answers = {
    'chat.accounts': () => [{ id: 'c1', jid: 'ana@chat.test', host: '', port: 5222 }],
    'chat.status': () => ({ c1: { account: 'c1', state: 'online' } }),
    'chat.conversations': () => [
      {
        conversation: 'pau@chat.test',
        last_body: '¿Sigues ahí?',
        last_stamp: 1_760_000_120,
        last_direction: 'out',
        unread: 1,
      },
    ],
    'chat.history': () => history,
    'chat.send': () => ({ id: 'new' }),
  }
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          return answers[command]?.(payload) ?? { ok: true }
        },
      },
    },
  }
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('shows conversations with what is new, and where each sent message got to', async () => {
  const screen = render(<MessagingView />)
  await waitFor(() => expect(screen.getByText('1 new')).toBeTruthy())
  expect(screen.getByRole('status').textContent).toBe('Connected')
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /pau@chat.test/ }))
  })
  await waitFor(() => expect(screen.getByText('Hola Ana')).toBeTruthy())
  expect(calls.find((c) => c.command === 'chat.markRead')?.payload).toEqual({
    account: 'c1',
    conversation: 'pau@chat.test',
  })
  expect(screen.getByText('Delivered')).toBeTruthy()
  expect(screen.getByText('May not have arrived')).toBeTruthy()

  // Nothing is sent again unless asked, and then with the same id.
  expect(calls.some((c) => c.command === 'chat.retry')).toBe(false)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }))
  })
  expect(calls.find((c) => c.command === 'chat.retry')?.payload).toEqual({ account: 'c1', id: 's2' })

  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Ya estoy' } })
  await act(async () => {
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' })
  })
  expect(calls.find((c) => c.command === 'chat.send')?.payload).toEqual({
    account: 'c1',
    conversation: 'pau@chat.test',
    body: 'Ya estoy',
  })
  expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('')
})

it('a message arriving elsewhere refreshes the list; one in the open conversation is read at once', async () => {
  const screen = render(<MessagingView />)
  await waitFor(() => expect(screen.getByText('1 new')).toBeTruthy())
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /pau@chat.test/ }))
  })
  calls.length = 0
  await act(async () => onChatEvent('chat.changed', { account: 'c1', conversation: 'pau@chat.test' }))
  await waitFor(() => expect(calls.some((c) => c.command === 'chat.markRead')).toBe(true))
  calls.length = 0
  await act(async () => onChatEvent('chat.changed', { account: 'other', conversation: 'x@y.z' }))
  expect(calls).toEqual([])
  await act(async () => onChatEvent('chat.status', { account: 'c1', state: 'offline', message: 'gone' }))
  expect(screen.getByRole('status').textContent).toBe('Not connected')
})

it('without an account, asks for an address and password', async () => {
  answers['chat.accounts'] = () => []
  const screen = render(<MessagingView />)
  const form = await waitFor(() => screen.getByRole('form', { name: 'Add a chat account' }))
  expect(form).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'ana@chat.test' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } })
  answers['chat.accounts'] = () => [{ id: 'c1', jid: 'ana@chat.test', host: '', port: 5222 }]
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  })
  const save = calls.find((c) => c.command === 'chat.save')!.payload
  expect(save.account).toMatchObject({ jid: 'ana@chat.test', host: '', port: 5222 })
  expect(save.password).toBe('secret')
})
