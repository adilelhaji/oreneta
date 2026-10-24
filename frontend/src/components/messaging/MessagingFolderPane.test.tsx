import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { default: i18n } = await import('../../lib/i18n')
const { settings$ } = await import('../../states/settings')
const { chatPresence$, messaging$, mutedConversations$, statusPermissions$ } = await import('../../states/messaging')
const { ui$ } = await import('../../states/ui')
const { FolderPane } = await import('../shell/FolderPane')
const { messages, supportedI18nLanguages } = await import('../../generated/locales')
const { MessagingView } = await import('./MessagingView')

// #337: the conversations column in the common folder pane (ADR-0068 §4), at
// the width every module shares. At 1024 px and below the pane is not drawn,
// and the w-72 column stays as it was.

const accounts = [
  { id: 'c1', jid: 'ana@chat.test', host: '', port: 5222 },
  { id: 'c2', jid: 'ana@work.test', host: '', port: 5222 },
]
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
const direct = (conversation: string, last_body: string, unread = 0) => ({
  conversation,
  last_body,
  last_stamp: 1_760_000_120,
  last_direction: 'in',
  unread,
})
const invitation = {
  account: 'c1',
  room: 'club@rooms.chat.test',
  inviter: 'marta@chat.test',
  reason: 'Ven al club',
  has_password: false,
  received_at: 1,
}
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
]

let calls: { command: string; payload: any }[] = []

const setWidth = (width: number) => (window as any).happyDOM.setViewport({ width, height: 900 })
const reset = () => {
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
  mutedConversations$.set({ account: '', list: [] })
}

beforeEach(async () => {
  calls = []
  await i18n.changeLanguage('en')
  settings$.folderPaneWidth.set(260)
  reset()
  ui$.module.set('chat')
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          const second = payload?.account === 'c2'
          if (command === 'chat.accounts') return accounts
          if (command === 'chat.status')
            return { c1: { account: 'c1', state: 'online' }, c2: { account: 'c2', state: 'offline' } }
          if (command === 'chat.conversations')
            return second
              ? [direct('boss@work.test', 'Informe?')]
              : [direct('pau@chat.test', '¿Sigues ahí?', 1), direct('eva@chat.test', 'Adéu')]
          if (command === 'chat.rooms') return second ? [] : [room]
          if (command === 'chat.invitations') return second ? [] : [invitation]
          if (command === 'chat.history') return history
          return { ok: true }
        },
      },
    },
  }
  setWidth(1440)
})

afterEach(() => {
  cleanup()
  // happy-dom's own window: 1024 px wide.
  ;(window as any).happyDOM.setViewport({ width: 1024, height: 768 })
  reset()
  settings$.folderPaneWidth.set(260)
  ui$.module.set('mail')
  delete (window as any).go
})

const written = (key: string) =>
  calls.filter((call) => call.command === 'app.prefsSet' && call.payload.key === key).map((call) => call.payload.value)

const pane = (screen: ReturnType<typeof render>) => screen.getByRole('navigation', { name: 'Conversations' })
const content = (screen: ReturnType<typeof render>) =>
  screen.container.querySelector<HTMLElement>('[data-region="content"]')!
const ready = async (screen: ReturnType<typeof render>) => {
  await waitFor(() => expect(screen.container.textContent).toContain('¿Sigues ahí?'))
  await waitFor(() => expect(screen.container.textContent).toContain('Ven al club'))
  await waitFor(() => expect(screen.container.textContent).toContain('Hola equipo'))
}

describe('Chat in the common folder pane (ADR-0068 §4, #337)', () => {
  it('is the "folders" region beside the conversation, named by its title row', async () => {
    const screen = render(<MessagingView />)
    await ready(screen)
    const nav = pane(screen)
    expect(nav.dataset.region).toBe('folders')
    expect(nav.hasAttribute('data-folder-pane')).toBe(true)
    expect(within(nav).getByRole('heading', { level: 2, name: 'Conversations' }).getAttribute('title')).toBe(
      'Conversations',
    )
    // Beside the conversation, not inside it: the pane comes first.
    expect(content(screen).contains(nav)).toBe(false)
    expect(nav.compareDocumentPosition(content(screen)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The pane is the only "folders" region, and the old column is gone.
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
    expect(content(screen).querySelectorAll('[data-region="folders"]')).toHaveLength(0)
    // The one region inside it is the module strip at its foot (#354).
    expect([...nav.querySelectorAll<HTMLElement>('[data-region]')].map((region) => region.dataset.region)).toEqual([
      'modules',
    ])
    expect(nav.querySelector('[data-region="modules"]')?.getAttribute('aria-label')).toBe('Modules')
    expect(screen.container.querySelector('.w-72')).toBeNull()
    // The conversation side keeps its own section.
    expect(within(content(screen)).getByRole('region', { name: 'No conversation open' })).toBeTruthy()
  })

  it("has the column's body in its order, without the navigation button and the chat icon", async () => {
    const screen = render(<MessagingView />)
    await ready(screen)
    const nav = pane(screen)
    // The account row comes first in the body, with its status.
    expect(within(nav).getByRole('combobox', { name: 'Chat account' })).toBeTruthy()
    expect(within(nav).getByRole('status').textContent).toBe('Connected')
    // The column's chat icon is not there; the strip's Chat button has its own (#354).
    expect(
      [...nav.querySelectorAll('svg.lucide-messages-square')].filter((icon) => !icon.closest('[data-module-switcher]')),
    ).toEqual([])
    expect(within(nav).queryByRole('button', { name: /navigation|menu/i })).toBeNull()
    // Then the column's pieces, in the column's order.
    const order = [
      within(nav).getByRole('combobox', { name: 'Chat account' }),
      within(nav).getByRole('textbox', { name: 'Chat with (address)' }),
      within(nav).getByRole('button', { name: 'Join a group' }),
      within(nav).getByRole('list', { name: 'Invitations' }),
      within(nav).getByRole('list', { name: 'Groups' }),
      within(nav).getByRole('list', { name: 'Direct conversations' }),
      within(nav).getByRole('button', { name: 'Remove this chat account' }),
    ]
    const everything = [...nav.querySelectorAll('*')]
    const at = order.map((element) => everything.indexOf(element))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((x, y) => x - y))
    expect(within(within(nav).getByRole('list', { name: 'Groups' })).getByText('team@rooms.chat.test')).toBeTruthy()
    expect(within(within(nav).getByRole('list', { name: 'Direct conversations' })).getAllByRole('button')).toHaveLength(
      2,
    )
    // The footer is the pane's, under the body.
    expect(nav.querySelector('footer')).toBeTruthy()
    // Nothing of the column is left in the conversation side.
    expect(within(content(screen)).queryByRole('list', { name: 'Groups' })).toBeNull()
    expect(within(content(screen)).queryByRole('textbox', { name: 'Chat with (address)' })).toBeNull()
  })

  it('opens a conversation from the pane and shows it beside', async () => {
    const screen = render(<MessagingView />)
    await ready(screen)
    await act(async () => {
      fireEvent.click(within(pane(screen)).getByRole('button', { name: /pau@chat.test/ }))
    })
    await waitFor(() => expect(within(content(screen)).getByText('Hola Ana')).toBeTruthy())
    expect(messaging$.conversation.peek()).toBe('pau@chat.test')
    expect(within(content(screen)).getByRole('region', { name: 'pau@chat.test' })).toBeTruthy()
    expect(
      within(pane(screen))
        .getByRole('button', { name: /pau@chat.test/ })
        .getAttribute('aria-current'),
    ).toBe('true')
    // The open one is marked as mail's pane marks its folder: the pane is darker
    // than the column, so the tint alone would barely show.
    const open = within(pane(screen)).getByRole('button', { name: /pau@chat.test/ })
    expect(open.className).toContain('bg-active')
    expect(open.querySelector('[dir="auto"]')!.className).toContain('text-accent-fg')
    // Chat with an address, from the pane.
    fireEvent.change(within(pane(screen)).getByRole('textbox', { name: 'Chat with (address)' }), {
      target: { value: 'nou@chat.test' },
    })
    await act(async () => {
      fireEvent.click(within(pane(screen)).getByRole('button', { name: 'Open' }))
    })
    expect(messaging$.conversation.peek()).toBe('nou@chat.test')
  })

  it('switches account from the pane, and the lists follow', async () => {
    const screen = render(<MessagingView />)
    await ready(screen)
    const select = within(pane(screen)).getByRole('combobox', { name: 'Chat account' }) as HTMLSelectElement
    expect(select.value).toBe('c1')
    await act(async () => {
      fireEvent.change(select, { target: { value: 'c2' } })
    })
    expect(messaging$.account.peek()).toBe('c2')
    expect(messaging$.conversation.peek()).toBe('')
    await waitFor(() => expect(within(pane(screen)).getByText('boss@work.test')).toBeTruthy())
    expect(within(pane(screen)).queryByText('pau@chat.test')).toBeNull()
    expect(within(pane(screen)).queryByRole('list', { name: 'Groups' })).toBeNull()
    expect(within(pane(screen)).getByRole('status').textContent).toBe('Not connected')
  })

  it('keeps ChatSetup as it was when there is no account, beside an empty pane that holds the module strip', async () => {
    ;(window as any).go.main.App.Invoke = async (command: string) => (command === 'chat.accounts' ? [] : { ok: true })
    const screen = render(<MessagingView />)
    const form = await waitFor(() => screen.getByRole('form', { name: 'Add a chat account' }))
    // From 1025 px the module strip is at the foot of the folder pane (#354):
    // without a pane, Chat would be the one module with no way to the others
    // but the app menu. The pane has nothing else yet but a line that says
    // so, and the form is as it was.
    const nav = pane(screen)
    expect(nav.dataset.region).toBe('folders')
    const body = within(nav).getByRole('heading', { level: 2 }).parentElement!.nextElementSibling as HTMLElement
    expect(body.textContent).toBe('Nothing here yet')
    expect(within(body).queryAllByRole('button')).toEqual([])
    expect(within(nav).getByRole('navigation', { name: 'Modules' })).toBeTruthy()
    expect(nav.contains(form)).toBe(false)
    expect(nav.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // At 1024 px the setup is alone, as before.
    await act(async () => setWidth(1500))
    await act(async () => setWidth(1024))
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect(screen.container.querySelector('[data-region="folders"]')).toBeNull()
    expect(screen.getByRole('form', { name: 'Add a chat account' })).toBeTruthy()
  })

  it('has the width the other modules have, and shares it with them', async () => {
    settings$.folderPaneWidth.set(320)
    const screen = render(<MessagingView />)
    await ready(screen)
    expect(pane(screen).style.width).toBe('320px')
    const handle = within(pane(screen)).getByRole('separator', { name: 'Resize folder pane' })
    expect(handle.getAttribute('aria-valuenow')).toBe('320')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(written('folder_pane_width').at(-1)).toBe(200)
    expect(pane(screen).style.width).toBe('200px')
    // The conversation keeps 360 px as its basis, so the pane gives way first.
    expect(content(screen).style.flex).toBe('1 1 360px')
    // Not a hard minimum: too short a row (the system's 200 % zoom) shrinks it
    // rather than scroll sideways; the app's sidebar goes beside only with room
    // for it (ADR-0069 §2, owner decision D3 on #360).
    expect(content(screen).style.minWidth).toBe('')
    expect(pane(screen).style.flexShrink).toBe('1000')
    cleanup()

    // The same pane, drawn by mail, is as wide.
    const other = render(
      <FolderPane title="Accounts and folders">
        <button type="button">Inbox</button>
      </FolderPane>,
    )
    expect(other.getByRole('navigation', { name: 'Accounts and folders' }).style.width).toBe('200px')
  })
})

describe('the name of Chat\'s "folders" region (ADR-0068 §1, #337)', () => {
  it('is never the name of another region or list of Chat, in any language', () => {
    // A screen reader reads two names that differ only in case or spacing the
    // same, so compare them as it would hear them.
    const others = [
      'shell.region.mail',
      'shell.region.modules',
      'mailNavigation.title',
      'calendar.title',
      'calendar.calendars',
      'people.title',
      'people.contactGroups',
      'people.groups',
      'tasks.title',
      'tasks.taskLists',
      'notes.title',
      'notes.listLabel',
      'notes.editorLabel',
      'notes.tags',
      'notes.tagsPane',
      'messaging.title',
      'messaging.groups',
      'messaging.direct',
      'messaging.invitations',
      'messaging.noConversation',
      'attachmentsView.title',
    ]
    const clashes = supportedI18nLanguages.flatMap((language) => {
      const catalog = messages[language]
      const heard = (s: string | undefined) =>
        (s ?? '').trim().normalize('NFC').toLocaleLowerCase(language.replace('_', '-'))
      const name = catalog['messaging.conversations']
      if (!name?.trim()) return [`${language}: missing`]
      return others
        .filter((key) => heard(catalog[key]) === heard(name))
        .map((key) => `${language}: same as ${key}, "${name}"`)
    })
    expect(supportedI18nLanguages.length).toBe(20)
    expect(clashes).toEqual([])
    expect(messages.ca['messaging.conversations']).toBe('Converses')
  })
})

describe('Chat at 1024 px and below (#337)', () => {
  it('keeps the w-72 column with its header, as before', async () => {
    setWidth(1024)
    const screen = render(<MessagingView />)
    await waitFor(() => expect(screen.container.textContent).toContain('¿Sigues ahí?'))
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize folder pane' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Conversations' })).toBeNull()
    const column = screen.container.querySelector<HTMLElement>('[data-region="folders"]')!
    expect(column.tagName).toBe('SECTION')
    expect(column.getAttribute('aria-label')).toBe('Conversations')
    expect(column.className).toContain('w-72')
    expect(content(screen).contains(column)).toBe(true)
    expect(content(screen).className).toContain('flex-1')
    expect(content(screen).className).not.toContain('360px')
    expect(column.querySelector('header svg.lucide-messages-square')).toBeTruthy()
    expect(within(column).getByRole('status').textContent).toBe('Connected')
    expect(within(column).getByRole('button', { name: 'Remove this chat account' })).toBeTruthy()
    // With a conversation open the column steps aside on a narrow window.
    await act(async () => {
      fireEvent.click(within(column).getByRole('button', { name: /pau@chat.test/ }))
    })
    expect(column.className).toContain('max-[769px]:hidden')
  })

  it('follows the window across 1025 px, keeping the open conversation', async () => {
    setWidth(1024)
    const screen = render(<MessagingView />)
    await waitFor(() => expect(screen.container.textContent).toContain('¿Sigues ahí?'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /pau@chat.test/ }))
    })
    await waitFor(() => expect(screen.getByText('Hola Ana')).toBeTruthy())
    // The conversation stays mounted across the switch: the same composer, still focused.
    const composer = screen.getByLabelText('Message')
    composer.focus()
    await act(async () => setWidth(1025))
    expect(screen.getByLabelText('Message')).toBe(composer)
    expect(document.activeElement).toBe(composer)
    expect(pane(screen).hasAttribute('data-folder-pane')).toBe(true)
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
    expect(messaging$.conversation.peek()).toBe('pau@chat.test')
    expect(within(content(screen)).getByText('Hola Ana')).toBeTruthy()
    expect(
      within(pane(screen))
        .getByRole('button', { name: /pau@chat.test/ })
        .getAttribute('aria-current'),
    ).toBe('true')
    await act(async () => setWidth(1024))
    expect(screen.getByLabelText('Message')).toBe(composer)
    expect(document.activeElement).toBe(composer)
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
    expect(messaging$.conversation.peek()).toBe('pau@chat.test')
    expect(screen.getByText('Hola Ana')).toBeTruthy()
  })
})

// #341: the focus follows the control across 1025 px.
// happy-dom tells a media query's listeners about a change only once the query
// has matched, so a window that starts wide is resized wide once (1500 px)
// before it narrows to 1024 px, as a browser's would have been.
const narrowWindow = async () => {
  await act(async () => setWidth(1500))
  await act(async () => setWidth(1024))
}

describe('Chat keeps the focus across 1025 px (#341)', () => {
  it('moves it from a conversation in the pane to the same one in the column and back', async () => {
    const screen = render(<MessagingView />)
    await ready(screen)
    const button = within(pane(screen)).getByRole('button', { name: /pau@chat.test/ })
    button.focus()
    await narrowWindow()
    const column = screen.container.querySelector<HTMLElement>('[data-region="folders"]')!
    expect(column.hasAttribute('data-folder-pane')).toBe(false)
    expect(document.activeElement).toBe(within(column).getByRole('button', { name: /pau@chat.test/ }))
    await act(async () => setWidth(1025))
    expect(document.activeElement).toBe(within(pane(screen)).getByRole('button', { name: /pau@chat.test/ }))
  })

  it('keeps it on the account selector, the same control in the column', async () => {
    const screen = render(<MessagingView />)
    await ready(screen)
    within(pane(screen)).getByRole('combobox', { name: 'Chat account' }).focus()
    await narrowWindow()
    const column = screen.container.querySelector<HTMLElement>('[data-region="folders"]')!
    expect(document.activeElement).toBe(within(column).getByRole('combobox', { name: 'Chat account' }))
  })

  it('keeps it in the join form, on the same field and with what was typed, not on the account selector', async () => {
    const screen = render(<MessagingView />)
    await ready(screen)
    fireEvent.click(within(pane(screen)).getByRole('button', { name: 'Join a group' }))
    const room = within(pane(screen)).getByRole('textbox', { name: 'Group address' })
    room.focus()
    fireEvent.change(room, { target: { value: 'team@rooms.chat.test' } })
    // A second press in the field that already has the focus keeps it there.
    fireEvent.pointerDown(room)
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    await narrowWindow()
    const column = screen.container.querySelector<HTMLElement>('[data-region="folders"]')!
    const twin = within(column).getByRole('textbox', { name: 'Group address' })
    expect(document.activeElement).toBe(twin)
    expect((twin as HTMLInputElement).value).toBe('team@rooms.chat.test')
  })

  it('keeps an unsaved status and its Save button across the line, not falling to the account selector', async () => {
    const screen = render(<MessagingView />)
    await ready(screen)
    fireEvent.change(within(pane(screen)).getByRole('textbox', { name: 'Status message' }), {
      target: { value: 'In a meeting' },
    })
    within(pane(screen)).getByRole('button', { name: 'Save' }).focus()
    await narrowWindow()
    const column = screen.container.querySelector<HTMLElement>('[data-region="folders"]')!
    expect(document.activeElement).toBe(within(column).getByRole('button', { name: 'Save' }))
    expect((within(column).getByRole('textbox', { name: 'Status message' }) as HTMLInputElement).value).toBe(
      'In a meeting',
    )
  })

  it('keeps the permission list open and the focus on its Stop button across the line', async () => {
    const screen = render(<MessagingView />)
    await ready(screen)
    await act(async () => statusPermissions$.set({ allowed: ['x@chat.test'], more: false }))
    fireEvent.click(within(pane(screen)).getByRole('button', { name: /^Who can see your status/ }))
    within(pane(screen)).getByRole('button', { name: 'Stop sharing your status with x@chat.test' }).focus()
    await narrowWindow()
    const column = screen.container.querySelector<HTMLElement>('[data-region="folders"]')!
    expect(document.activeElement).toBe(
      within(column).getByRole('button', { name: 'Stop sharing your status with x@chat.test' }),
    )
  })

  it("forgets an account's unsaved status and open permission list on switching account", async () => {
    const screen = render(<MessagingView />)
    await ready(screen)
    await act(async () => statusPermissions$.set({ allowed: ['x@chat.test'], more: false }))
    fireEvent.change(within(pane(screen)).getByRole('textbox', { name: 'Status message' }), {
      target: { value: 'In a meeting' },
    })
    fireEvent.click(within(pane(screen)).getByRole('button', { name: /^Who can see your status/ }))
    await act(async () => {
      fireEvent.change(within(pane(screen)).getByRole('combobox', { name: 'Chat account' }), {
        target: { value: 'c2' },
      })
    })
    await act(async () => {
      fireEvent.change(within(pane(screen)).getByRole('combobox', { name: 'Chat account' }), {
        target: { value: 'c1' },
      })
    })
    expect((within(pane(screen)).getByRole('textbox', { name: 'Status message' }) as HTMLInputElement).value).not.toBe(
      'In a meeting',
    )
    expect(within(pane(screen)).queryByRole('button', { name: 'Stop sharing your status with x@chat.test' })).toBeNull()
  })

  it('leaves the focus alone when it was in the conversation side', async () => {
    const screen = render(<MessagingView />)
    await ready(screen)
    expect(document.activeElement).toBe(document.body)
    await narrowWindow()
    expect(document.activeElement).toBe(document.body)
  })
})
