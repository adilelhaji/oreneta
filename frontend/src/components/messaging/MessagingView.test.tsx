import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { MessagingView } from './MessagingView'
import { messaging$, onChatEvent } from '../../states/messaging'
import { settleConfirm, ui$ } from '../../states/ui'

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
  messaging$.set({
    accounts: [],
    status: {},
    account: '',
    conversations: [],
    conversation: '',
    history: [],
    rooms: [],
    invitations: [],
    uploads: {},
  })
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

// ---- Group chats and files (ADR-0044) --------------------------------------------------

const room = {
  account: 'c1',
  room: 'team@rooms.chat.test',
  nick: 'ana',
  has_password: false,
  last_body: 'Hola equipo',
  last_stamp: 1_760_000_200,
  unread: 2,
  state: 'joined',
  detail: null,
}

const roomHistory = [
  {
    account: 'c1',
    conversation: 'team@rooms.chat.test',
    id: 'g1',
    stanza_id: 'r1',
    direction: 'in',
    sender: 'Pau',
    body: 'Hola equipo',
    stamp: 1_760_000_100,
    state: 'received',
    kind: 'groupchat',
  },
  {
    account: 'c1',
    conversation: 'team@rooms.chat.test',
    id: 'g2',
    stanza_id: 'r2',
    direction: 'out',
    sender: 'ana',
    body: 'Buenas',
    stamp: 1_760_000_150,
    state: 'accepted',
    kind: 'groupchat',
  },
  {
    account: 'c1',
    conversation: 'team@rooms.chat.test',
    id: 'g3',
    stanza_id: 'r3',
    direction: 'in',
    sender: 'Marta',
    body: 'https://up.chat.test/abc/Informe.pdf',
    stamp: 1_760_000_200,
    state: 'received',
    kind: 'groupchat',
    file_url: 'https://up.chat.test/abc/Informe.pdf',
    file_name: 'Informe.pdf',
    file_size: null,
  },
]

function withRoom() {
  answers['chat.rooms'] = () => [room]
  answers['chat.history'] = (p: any) => (p.conversation === room.room ? roomHistory : history)
}

it('joins a group by its address with a nickname and an optional password', async () => {
  answers['chat.join'] = (p: any) => ({ room: p.room, connected: true })
  const screen = render(<MessagingView />)
  await waitFor(() => expect(screen.getByText('1 new')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Join a group' }))
  const form = screen.getByRole('form', { name: 'Join a group' })
  expect((screen.getByLabelText('Your name in the group') as HTMLInputElement).value).toBe('ana')
  expect((screen.getByRole('button', { name: 'Join' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Group address'), { target: { value: 'Team@Rooms.Chat.Test' } })
  fireEvent.change(screen.getByLabelText('Group password (if it has one)'), { target: { value: 'pw' } })
  withRoom()
  await act(async () => {
    fireEvent.submit(form)
  })
  expect(calls.find((c) => c.command === 'chat.join')?.payload).toEqual({
    account: 'c1',
    room: 'Team@Rooms.Chat.Test',
    nick: 'ana',
    password: 'pw',
  })
  // The group opens, listed beside the conversations.
  await waitFor(() => expect(screen.getByText('Buenas')).toBeTruthy())
  expect(screen.getByRole('region', { name: 'team@rooms.chat.test' })).toBeTruthy()
  expect(screen.getByRole('list', { name: 'Groups' }).textContent).toContain('team@rooms.chat.test')
  expect(screen.queryByRole('form', { name: 'Join a group' })).toBeNull()
})

it('a group shows who said what, its state, and can be left', async () => {
  withRoom()
  const screen = render(<MessagingView />)
  await waitFor(() => expect(screen.getByRole('list', { name: 'Groups' })).toBeTruthy())
  expect(screen.getByRole('list', { name: 'Groups' }).textContent).toContain('2 new')
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /team@rooms.chat.test/ }))
  })
  await waitFor(() => expect(screen.getByText('Buenas')).toBeTruthy())
  // Each message from someone else says who; our own does not repeat our name.
  expect(screen.getByText('Pau')).toBeTruthy()
  expect(screen.getByText('Marta')).toBeTruthy()
  expect(screen.queryByText('ana', { selector: 'li > span' })).toBeNull()
  expect(screen.getByText('In the group')).toBeTruthy()
  expect(calls.find((c) => c.command === 'chat.markRead')?.payload).toEqual({
    account: 'c1',
    conversation: 'team@rooms.chat.test',
  })
  // What is typed goes to the room.
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Voy' } })
  await act(async () => {
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' })
  })
  expect(calls.find((c) => c.command === 'chat.send')?.payload).toEqual({
    account: 'c1',
    conversation: 'team@rooms.chat.test',
    body: 'Voy',
  })
  // Leaving asks first.
  fireEvent.click(screen.getByRole('button', { name: 'Leave group' }))
  await waitFor(() => expect(ui$.confirm.peek()?.title).toBe('Leave this group?'))
  expect(calls.some((c) => c.command === 'chat.leave')).toBe(false)
  answers['chat.rooms'] = () => []
  await act(async () => {
    settleConfirm(true)
  })
  await waitFor(() =>
    expect(calls.find((c) => c.command === 'chat.leave')?.payload).toEqual({
      account: 'c1',
      room: 'team@rooms.chat.test',
    }),
  )
  await waitFor(() => expect(screen.queryByRole('list', { name: 'Groups' })).toBeNull())
})

it('an invitation is offered, and joining is the person’s choice', async () => {
  answers['chat.invitations'] = () => [
    {
      account: 'c1',
      room: 'club@rooms.chat.test',
      inviter: 'marta@chat.test',
      reason: 'Ven al club',
      has_password: true,
      received_at: 1,
    },
  ]
  answers['chat.join'] = (p: any) => ({ room: p.room, connected: true })
  const screen = render(<MessagingView />)
  const prompt = await waitFor(() => screen.getByRole('list', { name: 'Invitations' }))
  expect(prompt.textContent).toContain('marta@chat.test invites you to club@rooms.chat.test')
  expect(prompt.textContent).toContain('Ven al club')
  expect(calls.some((c) => c.command === 'chat.join')).toBe(false)
  // Joining from it fills the address; the password it brought stays in the keychain.
  fireEvent.click(screen.getByRole('button', { name: 'Join…' }))
  expect((screen.getByLabelText('Group address') as HTMLInputElement).value).toBe('club@rooms.chat.test')
  await act(async () => {
    fireEvent.submit(screen.getByRole('form', { name: 'Join a group' }))
  })
  expect(calls.find((c) => c.command === 'chat.join')?.payload).toEqual({
    account: 'c1',
    room: 'club@rooms.chat.test',
    nick: 'ana',
    password: '',
  })
  // Or set aside.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  })
  expect(calls.find((c) => c.command === 'chat.dismissInvitation')?.payload).toEqual({
    account: 'c1',
    room: 'club@rooms.chat.test',
  })
  // An invitation arriving refreshes the list.
  calls.length = 0
  await act(async () => onChatEvent('chat.invitation', { account: 'c1', room: 'x@rooms.chat.test' }))
  await waitFor(() => expect(calls.some((c) => c.command === 'chat.invitations')).toBe(true))
})

it('sends a file with its progress, and can cancel it', async () => {
  answers['chat.pickFile'] = () => ({ path: '/home/ana/plan.pdf', name: 'plan.pdf', size: 2048 })
  answers['chat.sendFile'] = (p: any) => ({ started: p.upload_id })
  const screen = render(<MessagingView />)
  await waitFor(() => expect(screen.getByText('1 new')).toBeTruthy())
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /pau@chat.test/ }))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send a file' }))
  })
  const started = calls.find((c) => c.command === 'chat.sendFile')!.payload
  expect(started).toMatchObject({ account: 'c1', conversation: 'pau@chat.test', path: '/home/ana/plan.pdf' })
  const uploadId = started.upload_id
  await act(async () => onChatEvent('chat.progress', { account: 'c1', upload_id: uploadId, done: 1024, total: 2048 }))
  const bar = screen.getByRole('progressbar', { name: 'Sending plan.pdf' }) as HTMLProgressElement
  expect([bar.value, bar.max]).toEqual([1024, 2048])
  await act(async () => {
    fireEvent.click(
      within(screen.getByRole('list', { name: 'Files being sent' })).getByRole('button', { name: 'Cancel' }),
    )
  })
  expect(calls.find((c) => c.command === 'chat.cancelUpload')?.payload).toEqual({ upload_id: uploadId })
  await act(async () =>
    onChatEvent('chat.uploaded', {
      account: 'c1',
      upload_id: uploadId,
      error: { message: 'cancelled', detail: { code: 'cancelled' } },
    }),
  )
  expect(screen.queryByRole('list', { name: 'Files being sent' })).toBeNull()

  // Too large: said, and nothing was sent.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send a file' }))
  })
  const second = calls.filter((c) => c.command === 'chat.sendFile').pop()!.payload.upload_id
  await act(async () =>
    onChatEvent('chat.uploaded', {
      account: 'c1',
      upload_id: second,
      error: { message: 'too large', detail: { code: 'tooLarge' } },
    }),
  )
  expect(screen.getByRole('alert').textContent).toBe('Too large for the chat server. Nothing was sent.')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByRole('list', { name: 'Files being sent' })).toBeNull()
})

it('a file received shows with its name and is saved only when asked', async () => {
  withRoom()
  answers['chat.saveFileAs'] = () => ({ saved: true, bytes: 10 })
  const screen = render(<MessagingView />)
  await waitFor(() => expect(screen.getByRole('list', { name: 'Groups' })).toBeTruthy())
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /team@rooms.chat.test/ }))
  })
  await waitFor(() => expect(screen.getByText('Informe.pdf')).toBeTruthy())
  // Shown as a file, not its raw link, and nothing fetched on its own.
  expect(screen.queryByText('https://up.chat.test/abc/Informe.pdf')).toBeNull()
  expect(calls.some((c) => c.command === 'chat.saveFileAs' || c.command === 'chat.download')).toBe(false)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save Informe.pdf' }))
  })
  expect(calls.find((c) => c.command === 'chat.saveFileAs')?.payload).toEqual({
    account: 'c1',
    url: 'https://up.chat.test/abc/Informe.pdf',
    name: 'Informe.pdf',
  })
})

it('a file behind a link that is not https is not offered for saving', async () => {
  answers['chat.history'] = () => [
    {
      ...history[0],
      id: 'f1',
      body: 'http://up.chat.test/a.zip',
      file_url: 'http://up.chat.test/a.zip',
      file_name: 'a.zip',
    },
  ]
  const screen = render(<MessagingView />)
  await waitFor(() => expect(screen.getByText('1 new')).toBeTruthy())
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /pau@chat.test/ }))
  })
  await waitFor(() => expect(screen.getByText('a.zip')).toBeTruthy())
  expect(screen.queryByRole('button', { name: 'Save a.zip' })).toBeNull()
  expect(screen.getByText('Not a secure link; not saved')).toBeTruthy()
})
