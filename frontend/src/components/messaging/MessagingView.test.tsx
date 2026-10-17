import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { MessagingView } from './MessagingView'
import {
  chatPresence$,
  loadPresence,
  messaging$,
  onChatEvent,
  openChatFromNotification,
  statusPermissions$,
} from '../../states/messaging'
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
  chatPresence$.set({
    own: { show: 'available', status: '', applied: 'offline', invisible_supported: null },
    contacts: {},
    requests: [],
    occupants: [],
  })
  statusPermissions$.set({ allowed: null, more: false })
  ui$.toast.set('')
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

// ---- Presence, mentions and private messages (ADR-0055) --------------------------------

it('the person sets their status and text; invisible only where the server can hide them', async () => {
  answers['chat.presence'] = () => ({
    own: { show: 'available', status: '', applied: 'announced', invisible_supported: false },
    contacts: {},
    requests: [],
  })
  answers['chat.setPresence'] = (p: any) => ({ show: p.show, status: p.status })
  const screen = render(<MessagingView />)
  await waitFor(() => expect(screen.getByText('This chat server cannot hide you.')).toBeTruthy())
  const form = screen.getByRole('form', { name: 'Your status' })
  const select = within(form).getByRole('combobox', { name: 'Your status' }) as HTMLSelectElement
  expect((within(select).getByRole('option', { name: 'Invisible' }) as HTMLOptionElement).disabled).toBe(true)
  expect((within(form).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  // Busy says what it does to notifications.
  fireEvent.change(select, { target: { value: 'dnd' } })
  expect(screen.getByText('While busy, chat messages raise no notifications.')).toBeTruthy()
  fireEvent.change(select, { target: { value: 'away' } })
  expect(screen.queryByText('While busy, chat messages raise no notifications.')).toBeNull()
  fireEvent.change(within(form).getByLabelText('Status message'), { target: { value: 'Comiendo' } })
  await act(async () => {
    fireEvent.submit(form)
  })
  expect(calls.find((c) => c.command === 'chat.setPresence')?.payload).toEqual({
    account: 'c1',
    show: 'away',
    status: 'Comiendo',
  })
  expect(chatPresence$.own.peek().show).toBe('away')

  // A server that can hide: invisible is offered, and what it means is said.
  await act(async () =>
    onChatEvent('chat.own', { account: 'c1', show: 'invisible', applied: 'invisible', invisible_supported: true }),
  )
  expect((within(select).getByRole('option', { name: 'Invisible' }) as HTMLOptionElement).disabled).toBe(false)
  expect(screen.getByText('Hidden from your contacts. Groups you are in still see you.')).toBeTruthy()
  // Invisible chosen but not possible: said plainly, never shown as online.
  await act(async () =>
    onChatEvent('chat.own', { account: 'c1', applied: 'withheld', invisible_supported: false }),
  )
  expect(screen.getByRole('alert').textContent).toContain('your contacts see you offline')
  expect(screen.getByRole('alert').textContent).toContain('Groups you are in still see you')
  // Another account's status changes nothing here.
  await act(async () => onChatEvent('chat.own', { account: 'other', applied: 'announced' }))
  expect(chatPresence$.own.peek().applied).toBe('withheld')
})

it('a contact’s status shows once they allow it; asking and answering happen only on a click', async () => {
  answers['chat.presence'] = () => ({ own: {}, contacts: {}, requests: ['eva@chat.test'] })
  const screen = render(<MessagingView />)
  await waitFor(() => expect(screen.getByText('eva@chat.test wants to see your status')).toBeTruthy())
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /pau@chat.test/ }))
  })
  await waitFor(() => expect(screen.getByText('Hola Ana')).toBeTruthy())
  expect(calls.some((c) => c.command === 'chat.subscribe' || c.command === 'chat.answerSubscription')).toBe(false)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Ask to see their status' }))
  })
  expect(calls.find((c) => c.command === 'chat.subscribe')?.payload).toEqual({ account: 'c1', jid: 'pau@chat.test' })
  expect(screen.getByText('Asked. They decide whether you can see it.')).toBeTruthy()
  // Pau allowed it: Pau's status, with its text, in the list and the header.
  await act(async () =>
    onChatEvent('chat.presence', { account: 'c1', jid: 'pau@chat.test', show: 'away', status: 'En el tren' }),
  )
  expect(screen.getByText('— En el tren')).toBeTruthy()
  expect(screen.getByRole('button', { name: /pau@chat.test/ }).textContent).toContain('Away')
  await act(async () => onChatEvent('chat.presence', { account: 'c1', jid: 'pau@chat.test', show: 'offline' }))
  expect(screen.queryByText('— En el tren')).toBeNull()
  // Gone offline, still known: no offer to ask again.
  expect(within(screen.getByRole('region', { name: 'pau@chat.test' })).getByText('Offline')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Ask to see their status' })).toBeNull()
  // Not connected: no status is claimed.
  await act(async () =>
    onChatEvent('chat.presence', { account: 'c1', jid: 'pau@chat.test', show: 'dnd', status: '' }),
  )
  const open = screen.getByRole('region', { name: 'pau@chat.test' })
  await waitFor(() => expect(within(open).getByText('Busy')).toBeTruthy())
  await act(async () => onChatEvent('chat.status', { account: 'c1', state: 'offline' }))
  expect(within(open).queryByText('Busy')).toBeNull()

  // Eva's request: allowed only on the click.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  })
  expect(calls.find((c) => c.command === 'chat.answerSubscription')?.payload).toEqual({
    account: 'c1',
    jid: 'eva@chat.test',
    allow: true,
  })
  expect(screen.queryByText('eva@chat.test wants to see your status')).toBeNull()
  // A new request arrives, and is denied.
  await act(async () => onChatEvent('chat.subscription', { account: 'c1', jid: 'joan@chat.test' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
  })
  expect(calls.filter((c) => c.command === 'chat.answerSubscription').at(-1)?.payload).toEqual({
    account: 'c1',
    jid: 'joan@chat.test',
    allow: false,
  })
})

it('in a group, @ offers who is there, the picked names go with the message, and a mention stands out', async () => {
  withRoom()
  const mentioned = { ...roomHistory[0], id: 'g9', body: '@ana ¿vienes?', mention: true }
  answers['chat.history'] = (p: any) => (p.conversation === room.room ? [...roomHistory, mentioned] : history)
  answers['chat.occupants'] = () => [
    { nick: 'Pau', show: 'available', role: 'participant' },
    { nick: 'pablo', show: 'away', role: 'participant' },
    { nick: 'ana', show: 'available', role: 'participant' },
    { nick: 'Marta', show: 'dnd', role: 'moderator' },
  ]
  const screen = render(<MessagingView />)
  await waitFor(() => expect(screen.getByRole('list', { name: 'Groups' })).toBeTruthy())
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /team@rooms.chat.test/ }))
  })
  await waitFor(() => expect(screen.getByText('@ana ¿vienes?')).toBeTruthy())
  // Only the message naming the person is marked.
  expect(screen.getAllByText('Mentions you')).toHaveLength(1)
  expect(screen.getByText('@ana ¿vienes?').className).toContain('ring-2')
  const open = screen.getByRole('region', { name: 'team@rooms.chat.test' })
  expect(within(open).getByText('Hola equipo').className).not.toContain('ring-2')

  // Who is there has arrived before typing.
  await waitFor(() => expect(screen.getByRole('button', { name: /People in the group/ }).textContent).toContain('(4)'))
  const box = screen.getByLabelText('Message') as HTMLTextAreaElement
  fireEvent.change(box, { target: { value: 'Hola @pa', selectionStart: 8 } })
  const list = screen.getByRole('listbox', { name: 'People to mention' })
  expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['pablo', 'Pau'])
  expect(box.getAttribute('aria-activedescendant')).toBe('chat-mention-0')
  fireEvent.keyDown(box, { key: 'ArrowDown' })
  fireEvent.keyDown(box, { key: 'Enter' })
  expect(box.value).toBe('Hola @Pau ')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(calls.some((c) => c.command === 'chat.send')).toBe(false)
  // Escape closes the list without picking; the text stays as written.
  fireEvent.change(box, { target: { value: 'Hola @Pau y @m', selectionStart: 14 } })
  expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Marta'])
  fireEvent.keyDown(box, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' })
  })
  expect(calls.find((c) => c.command === 'chat.send')?.payload).toEqual({
    account: 'c1',
    conversation: 'team@rooms.chat.test',
    body: 'Hola @Pau y @m',
    mentions: ['Pau'],
  })
  // An address is not a mention.
  fireEvent.change(box, { target: { value: 'escribe a pau@chat', selectionStart: 18 } })
  expect(screen.queryByRole('listbox')).toBeNull()

  // Who is in the group, with a way to write to each privately.
  fireEvent.click(screen.getByRole('button', { name: /People in the group/ }))
  const people = screen.getByRole('list', { name: 'People in the group' })
  expect(within(people).getAllByRole('listitem')).toHaveLength(4)
  expect(within(people).getByText('Busy')).toBeTruthy()
})

it('a private message in a group is its own conversation, opened from a name in the group', async () => {
  withRoom()
  const privateHistory = [
    {
      account: 'c1',
      conversation: 'team@rooms.chat.test/Pau',
      id: 'p1',
      stanza_id: null,
      direction: 'in',
      sender: 'Pau',
      body: '¿Hablamos en privado?',
      stamp: 1_760_000_300,
      state: 'received',
      kind: 'private',
    },
  ]
  answers['chat.conversations'] = () => [
    {
      conversation: 'team@rooms.chat.test/Pau',
      last_body: '¿Hablamos en privado?',
      last_stamp: 1_760_000_300,
      last_direction: 'in',
      unread: 1,
      kind: 'private',
      room: 'team@rooms.chat.test',
    },
  ]
  answers['chat.history'] = (p: any) =>
    p.conversation === room.room ? roomHistory : p.conversation === 'team@rooms.chat.test/Pau' ? privateHistory : []
  const screen = render(<MessagingView />)
  await waitFor(() => expect(screen.getByText('Pau (team@rooms.chat.test)')).toBeTruthy())
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Pau \(team@rooms.chat.test\)/ }))
  })
  const open = screen.getByRole('region', { name: 'team@rooms.chat.test/Pau' })
  await waitFor(() => expect(within(open).getByText('¿Hablamos en privado?')).toBeTruthy())
  expect(screen.getByText('Private message in team@rooms.chat.test')).toBeTruthy()
  // The nickname keeps its capitals; nothing about a contact's status here.
  expect(calls.find((c) => c.command === 'chat.markRead')?.payload).toEqual({
    account: 'c1',
    conversation: 'team@rooms.chat.test/Pau',
  })
  expect(screen.queryByRole('button', { name: 'Ask to see their status' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Claro' } })
  await act(async () => {
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' })
  })
  expect(calls.find((c) => c.command === 'chat.send')?.payload).toEqual({
    account: 'c1',
    conversation: 'team@rooms.chat.test/Pau',
    body: 'Claro',
  })

  // From the group, a name opens the private conversation with that person.
  await act(async () => {
    fireEvent.click(within(screen.getByRole('list', { name: 'Groups' })).getByRole('button'))
  })
  await waitFor(() => expect(screen.getByText('Buenas')).toBeTruthy())
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Write privately to Marta' }))
  })
  expect(messaging$.conversation.peek()).toBe('team@rooms.chat.test/Marta')
})

it('clicking a chat notification opens its conversation in the Chat view', async () => {
  ui$.messagingOpen.set(false)
  ui$.calendarOpen.set(true)
  await act(async () => openChatFromNotification('c1', 'pau@chat.test'))
  expect(ui$.messagingOpen.peek()).toBe(true)
  expect(ui$.calendarOpen.peek()).toBe(false)
  expect(messaging$.conversation.peek()).toBe('pau@chat.test')
  expect(calls.find((c) => c.command === 'chat.markRead')?.payload).toEqual({ account: 'c1', conversation: 'pau@chat.test' })
  ui$.messagingOpen.set(false)
})

it('the saved status shows before connecting, and invisible says it needs the connection', async () => {
  answers['chat.status'] = () => ({ c1: { account: 'c1', state: 'offline' } })
  answers['chat.presence'] = () => ({
    own: { show: 'dnd', status: 'En clase', applied: 'offline', invisible_supported: null },
    contacts: {},
    requests: [],
  })
  const screen = render(<MessagingView />)
  const form = await waitFor(() => screen.getByRole('form', { name: 'Your status' }))
  await waitFor(() => expect((within(form).getByLabelText('Status message') as HTMLInputElement).value).toBe('En clase'))
  expect((within(form).getByRole('combobox', { name: 'Your status' }) as HTMLSelectElement).value).toBe('dnd')
  expect(screen.getByText('Connect to check whether this server can hide you.')).toBeTruthy()
  expect(screen.getByText('While busy, chat messages raise no notifications.')).toBeTruthy()
})

it('an answer about another account is not shown', async () => {
  let release: (value: unknown) => void = () => {}
  answers['chat.presence'] = () => new Promise((resolve) => (release = resolve))
  messaging$.account.set('c1')
  const pending = loadPresence()
  messaging$.account.set('c2')
  release({ own: { show: 'away', status: 'De c1', applied: 'announced', invisible_supported: true }, contacts: {}, requests: ['x@y.z'] })
  await pending
  expect(chatPresence$.own.peek().status).toBe('')
  expect(chatPresence$.requests.peek()).toEqual([])
})

it('a new chat session clears what the old one showed, and contacts shown stay bounded', async () => {
  messaging$.account.set('c1')
  messaging$.conversation.set('team@rooms.chat.test')
  onChatEvent('chat.presence', { account: 'c1', jid: 'pau@chat.test', show: 'available', status: '' })
  onChatEvent('chat.subscription', { account: 'c1', jid: 'eva@chat.test' })
  chatPresence$.occupants.set([{ nick: 'Pau', show: 'available', role: 'participant' }])
  // Another account's new session changes nothing here.
  onChatEvent('chat.presence', { account: 'c2', reset: true })
  expect(Object.keys(chatPresence$.contacts.peek())).toEqual(['pau@chat.test'])
  onChatEvent('chat.presence', { account: 'c1', reset: true })
  expect(chatPresence$.contacts.peek()).toEqual({})
  expect(chatPresence$.requests.peek()).toEqual([])
  expect(chatPresence$.occupants.peek()).toEqual([])
  // However many arrive, no more than the core keeps are shown.
  for (let n = 0; n < 1010; n++) onChatEvent('chat.presence', { account: 'c1', jid: `c${n}@chat.test`, show: 'away' })
  expect(Object.keys(chatPresence$.contacts.peek())).toHaveLength(1000)
  onChatEvent('chat.presence', { account: 'c1', jid: 'c0@chat.test', show: 'dnd' })
  expect(chatPresence$.contacts.peek()['c0@chat.test'].show).toBe('dnd')
  for (let n = 0; n < 210; n++) onChatEvent('chat.subscription', { account: 'c1', jid: `r${n}@chat.test` })
  expect(chatPresence$.requests.peek()).toHaveLength(200)
})

// ---- Who may see the status, muting and unread mentions (ADR-0064) --------------------

it('who can see the status comes from the server, and sharing stops only on a confirmed click', async () => {
  const presence = (allowed: string[] | null, more = false) => () => ({
    own: {},
    contacts: {},
    requests: [],
    allowed,
    allowed_more: more,
  })
  answers['chat.presence'] = presence(null)
  const screen = render(<MessagingView />)
  const toggle = await waitFor(() => screen.getByRole('button', { name: /Who can see your status/ }))
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  // Not known yet: never shown as "nobody".
  expect(screen.getByText('Not known yet: the chat server has not said.')).toBeTruthy()
  expect(screen.queryByText('Nobody can see your status.')).toBeNull()

  // The server said: Eva and Joan.
  answers['chat.presence'] = presence(['eva@chat.test', 'joan@chat.test'])
  await act(async () => onChatEvent('chat.permissions', { account: 'c1' }))
  const list = await waitFor(() => screen.getByRole('list', { name: 'Who can see your status' }))
  expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  expect(screen.getByRole('button', { name: /Who can see your status/ }).textContent).toContain('(2)')
  // Another account's change is not read for this one.
  calls.length = 0
  await act(async () => onChatEvent('chat.permissions', { account: 'other' }))
  expect(calls.some((c) => c.command === 'chat.presence')).toBe(false)

  // Stopping asks first; cancelled, nothing is sent.
  const stopEva = () => screen.getByRole('button', { name: 'Stop sharing your status with eva@chat.test' })
  fireEvent.click(stopEva())
  await waitFor(() => expect(ui$.confirm.peek()?.title).toBe('Stop sharing your status with eva@chat.test?'))
  await act(async () => {
    settleConfirm(false)
  })
  expect(calls.some((c) => c.command === 'chat.answerSubscription')).toBe(false)
  // Confirmed: the same answer as denying a request, then it waits for the server.
  fireEvent.click(stopEva())
  await waitFor(() => expect(ui$.confirm.peek()?.title).toBe('Stop sharing your status with eva@chat.test?'))
  await act(async () => {
    settleConfirm(true)
  })
  await waitFor(() =>
    expect(calls.find((c) => c.command === 'chat.answerSubscription')?.payload).toEqual({
      account: 'c1',
      jid: 'eva@chat.test',
      allow: false,
    }),
  )
  await waitFor(() => expect(screen.getByText('Stopping…')).toBeTruthy())
  // The server's word: Eva is no longer on the list.
  answers['chat.presence'] = presence(['joan@chat.test'])
  await act(async () => onChatEvent('chat.permissions', { account: 'c1' }))
  await waitFor(() => expect(screen.queryByText('eva@chat.test')).toBeNull())
  expect(screen.getByText('joan@chat.test')).toBeTruthy()

  // Refused by the core: said, and the address can be tried again.
  answers['chat.answerSubscription'] = () => {
    throw new Error('this chat account is not connected; nothing was sent')
  }
  fireEvent.click(screen.getByRole('button', { name: 'Stop sharing your status with joan@chat.test' }))
  await waitFor(() => expect(ui$.confirm.peek()?.title).toBe('Stop sharing your status with joan@chat.test?'))
  await act(async () => {
    settleConfirm(true)
  })
  await waitFor(() => expect(ui$.toast.peek()).toBe('this chat account is not connected; nothing was sent'))
  expect(screen.getByRole('button', { name: 'Stop sharing your status with joan@chat.test' })).toBeTruthy()

  // Nobody, said as such; more than the core keeps, said too.
  answers['chat.presence'] = presence([])
  await act(async () => onChatEvent('chat.permissions', { account: 'c1' }))
  await waitFor(() => expect(screen.getByText('Nobody can see your status.')).toBeTruthy())
  answers['chat.presence'] = presence(['a@chat.test'], true)
  await act(async () => onChatEvent('chat.permissions', { account: 'c1' }))
  await waitFor(() => expect(screen.getByText('Only the first 1 are shown.')).toBeTruthy())
  expect(screen.getByRole('button', { name: /Who can see your status/ }).textContent).toContain('(1+)')
  // A new session: unknown again.
  await act(async () => onChatEvent('chat.presence', { account: 'c1', reset: true }))
  await waitFor(() => expect(screen.getByText('Not known yet: the chat server has not said.')).toBeTruthy())
  // Not connected: not offered.
  await act(async () => onChatEvent('chat.status', { account: 'c1', state: 'offline' }))
  expect(screen.queryByRole('button', { name: /Who can see your status/ })).toBeNull()
})

it('a conversation is muted from its header, listed as muted and still counted as unread', async () => {
  let muted: string[] = []
  answers['chat.mute'] = (p: any) => {
    muted = p.muted ? [...muted, p.conversation] : muted.filter((c) => c !== p.conversation)
    return { muted }
  }
  answers['chat.conversations'] = () => [
    {
      conversation: 'pau@chat.test',
      last_body: '¿Sigues ahí?',
      last_stamp: 1_760_000_120,
      last_direction: 'out',
      unread: 1,
      muted: muted.includes('pau@chat.test'),
    },
  ]
  const screen = render(<MessagingView />)
  await waitFor(() => expect(screen.getByText('1 new')).toBeTruthy())
  expect(screen.getByRole('button', { name: /pau@chat.test/ }).textContent).not.toContain('Muted')
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /pau@chat.test/ }))
  })
  const toggle = () => screen.getByRole('button', { name: 'Mute notifications' })
  expect(toggle().getAttribute('aria-pressed')).toBe('false')
  await act(async () => {
    fireEvent.click(toggle())
  })
  expect(calls.find((c) => c.command === 'chat.mute')?.payload).toEqual({
    account: 'c1',
    conversation: 'pau@chat.test',
    muted: true,
  })
  await waitFor(() => expect(toggle().getAttribute('aria-pressed')).toBe('true'))
  expect(toggle().getAttribute('title')).toContain('New messages still count as unread')
  const item = screen.getByRole('button', { name: /pau@chat.test/ })
  expect(item.textContent).toContain('Muted')
  expect(item.textContent).toContain('1 new')
  // Unmuted again.
  await act(async () => {
    fireEvent.click(toggle())
  })
  expect(calls.filter((c) => c.command === 'chat.mute').at(-1)?.payload).toEqual({
    account: 'c1',
    conversation: 'pau@chat.test',
    muted: false,
  })
  await waitFor(() => expect(toggle().getAttribute('aria-pressed')).toBe('false'))
  // Refused by the core: said, nothing changes.
  answers['chat.mute'] = () => {
    throw new Error('at most 1000 conversations can be muted; unmute one first')
  }
  await act(async () => {
    fireEvent.click(toggle())
  })
  await waitFor(() => expect(ui$.toast.peek()).toBe('at most 1000 conversations can be muted; unmute one first'))
  expect(toggle().getAttribute('aria-pressed')).toBe('false')

  // A group is muted the same way, from its header.
  withRoom()
  answers['chat.mute'] = (p: any) => ({ muted: [p.conversation] })
  await act(async () => onChatEvent('chat.room', { account: 'c1', room: room.room }))
  await waitFor(() => expect(screen.getByRole('list', { name: 'Groups' })).toBeTruthy())
  await act(async () => {
    fireEvent.click(within(screen.getByRole('list', { name: 'Groups' })).getByRole('button'))
  })
  await waitFor(() => expect(screen.getByText('Buenas')).toBeTruthy())
  await act(async () => {
    fireEvent.click(toggle())
  })
  expect(calls.filter((c) => c.command === 'chat.mute').at(-1)?.payload).toEqual({
    account: 'c1',
    conversation: 'team@rooms.chat.test',
    muted: true,
  })
})

it('each group shows its unread mentions, the account its total, and a lower bound says so', async () => {
  answers['chat.rooms'] = () => [
    { ...room, unread_mentions: 2, muted: true },
    { ...room, room: 'club@rooms.chat.test', unread: 1, unread_mentions: 1 },
  ]
  const screen = render(<MessagingView />)
  const groups = await waitFor(() => screen.getByRole('list', { name: 'Groups' }))
  const team = within(groups).getByRole('button', { name: /team@rooms.chat.test/ })
  expect(team.textContent).toContain('Unread mentions: 2')
  expect(team.textContent).toContain('Muted')
  expect(team.textContent).toContain('2 new')
  expect(screen.getByText('Unread mentions in your groups: 3')).toBeTruthy()

  // A group with more unread than the core looked at: a lower bound, even at zero found.
  answers['chat.rooms'] = () => [
    { ...room, unread_mentions: 2 },
    { ...room, room: 'club@rooms.chat.test', unread: 2500, unread_mentions: 0, mentions_capped: true },
  ]
  await act(async () => onChatEvent('chat.room', { account: 'c1', room: 'club@rooms.chat.test' }))
  await waitFor(() => expect(screen.getByText('Unread mentions in your groups: 2 or more')).toBeTruthy())
  const club = within(screen.getByRole('list', { name: 'Groups' })).getByRole('button', { name: /club@rooms.chat.test/ })
  expect(club.textContent).toContain('Unread mentions: 0 or more')
  expect(club.textContent).toContain('0+')

  // Nothing unread names the person: no badge at all.
  answers['chat.rooms'] = () => [{ ...room, unread_mentions: 0 }]
  await act(async () => onChatEvent('chat.room', { account: 'c1', room: room.room }))
  await waitFor(() => expect(screen.queryByText(/Unread mentions in your groups/)).toBeNull())
  expect(within(screen.getByRole('list', { name: 'Groups' })).getByRole('button').textContent).not.toContain(
    'Unread mentions',
  )
})
