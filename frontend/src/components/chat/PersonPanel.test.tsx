import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { accounts$ } from '../../states/accounts'
import { calendar$ } from '../../states/calendar'
import { compose$ } from '../../states/compose'
import { kanban$ } from '../../states/kanban'
import { mail$ } from '../../states/mail'
import { people$ } from '../../states/people'
import { person$ } from '../../states/person'
import { settings$ } from '../../states/settings'
import { openSidebarPanel, sidebar$ } from '../../states/sidebar'
import { APP_MODULES, ui$ } from '../../states/ui'
import type { Account, Message, Person } from '../../types'
import { PeopleView } from '../people/PeopleView'
import { AppSidebar } from '../shell/AppSidebar'
import type { PersonContext } from './PersonHistory'

// The sidebar's Persona panel (ADR-0069 §4, #363): one person's history
// (#86) in every module. The person in context is the open conversation's in
// mail and the selected contact in Persones; the account is the
// conversation's, or the contact's book's, or asked for; nobody elsewhere.

const work = { id: 'work', email: 'me@work.test', display_name: 'Work' } as Account
const home = { id: 'home', email: 'me@home.test', display_name: 'Home' } as Account
const feeds = { id: 'rss:feeds', email: '', display_name: 'Feeds', provider: 'rss', auth_type: 'rss' } as Account

const message = (account: string, thread: string, patch: Partial<Message> = {}): Message => ({
  id: `${thread}#1`,
  account_id: account,
  folder_id: 'INBOX',
  thread_id: thread,
  from_name: 'Ana',
  from_addr: 'ana@x.test',
  to: `me@${account}.test`,
  subject: 'Budget',
  preview: '',
  body: '',
  date: 1,
  unread: false,
  starred: false,
  has_attachments: false,
  ...patch,
})

const contact = (patch: Partial<Person>): Person => ({
  id: 'carddav::src-1:c1',
  source: 'carddav',
  account: '',
  book: 'src-1',
  name: 'Ana Prat',
  organisation: '',
  note: '',
  photo: '',
  emails: [{ addr: 'ana@x.test', label: 'work' }],
  phones: [],
  ...patch,
})

const history = (account: string, address = 'ana@x.test'): PersonContext => ({
  address,
  conversations: [
    {
      thread_id: `${account}#INBOX#t1`,
      folder: 'INBOX',
      subject: `Budget (${account})`,
      date: 1_760_000_000,
      from_them: true,
    },
  ],
  events: [{ calendar_id: 'cal', event_id: 'e1', subject: 'Review', start: 1_790_000_000, end: 1_790_003_600 }],
  files: [],
  coverage: { messages: 12, downloaded: 12 },
})

let asked: { account: string; address: string }[] = []
let writes: { key: string; value: unknown }[] = []
// How `context.person` answers: at once, unless a test holds the answers back.
let answer: (account: string, address: string) => Promise<PersonContext> = async (account, address) =>
  history(account, address)

function openConversation(...messages: Message[]) {
  mail$.threads.set([messages[0]])
  mail$.messages.set(messages)
  ui$.selectedThread.set(messages[0].thread_id)
}

// <main> with the module (Persones' own view when asked), then the sidebar.
function Frame({ people = false }: { people?: boolean }) {
  const row = useRef<HTMLDivElement | null>(null)
  return (
    <div ref={row}>
      <main aria-label="Module">{people && <PeopleView />}</main>
      <AppSidebar row={row} content={ui$.module.peek() === 'mail' ? 'mail' : ui$.module.peek()} />
    </div>
  )
}

const panel = (screen: ReturnType<typeof render>) => within(screen.getByRole('tabpanel'))

beforeEach(() => {
  ;(window as any).happyDOM.setViewport({ width: 1440, height: 900 })
  accounts$.set([work, home, feeds])
  ui$.module.set('mail')
  kanban$.activeBoardId.set('')
  kanban$.paneThreadId.set('')
  compose$.tabs.set([])
  compose$.activeTab.set('')
  mail$.threadLoading.set(false)
  people$.people.set([])
  people$.loaded.set(true)
  people$.selectedId.set('')
  settings$.appSidebarState.set('expanded')
  ui$.sidebarSection.set('person')
  asked = []
  writes = []
  answer = async (account, address) => history(account, address)
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          if (command === 'app.prefsSet') writes.push(payload)
          if (command === 'context.person') {
            asked.push({ account: payload.account, address: payload.address })
            return answer(payload.account, payload.address)
          }
          if (command === 'calendar.events') return { events: [] }
          if (command === 'tasks.list') return { tasks: [] }
          if (command === 'people.list') return { people: people$.people.peek() }
          return {}
        },
      },
    },
  }
})

afterEach(() => {
  cleanup()
  delete (window as any).go
  person$.set({ participant: null, contact: null })
  ui$.module.set('mail')
  ui$.selectedThread.set('')
  ui$.selectedAccount.set('')
  ui$.mobilePane.set('threads')
  mail$.threadLoading.set(false)
  mail$.threads.set([])
  mail$.messages.set([])
  people$.people.set([])
  people$.selectedId.set('')
  people$.loaded.set(false)
  ui$.sidebarSection.set('overview')
  ui$.sidebarSection.set('agenda')
  settings$.appSidebarState.set('minimized')
  sidebar$.set({ fits: false, strip: false, conversationOpen: false, overlay: false })
  ;(window as any).happyDOM.setViewport({ width: 1024, height: 768 })
})

describe('the Persona panel in mail', () => {
  it("shows the history of the conversation's one other person, in the conversation's account", async () => {
    openConversation(message('work', 'work#INBOX#budget'))
    const screen = render(<Frame />)
    expect(screen.getByRole('heading', { name: 'Person' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Person' }).getAttribute('aria-selected')).toBe('true')
    expect(panel(screen).getByRole('heading', { name: 'With Ana' })).toBeTruthy()
    expect(panel(screen).getByText('Account: Work')).toBeTruthy()
    await waitFor(() => expect(panel(screen).getByText('Budget (work)')).toBeTruthy())
    expect(asked).toEqual([{ account: 'work', address: 'ana@x.test' }])
    // Nobody to choose from: no way back to a list.
    expect(screen.queryAllByRole('button', { name: 'Choose someone else' })).toHaveLength(0)
  })

  it('lists the people when there are several, and shows the one picked', async () => {
    openConversation(message('work', 'work#INBOX#team', { cc: 'Bea <bea@x.test>' }))
    const screen = render(<Frame />)
    const list = panel(screen).getByRole('list', { name: 'Choose whose history to see' })
    // The people who are not one of your accounts; nobody is guessed.
    expect(within(list).getAllByRole('button')).toEqual([
      within(list).getByRole('button', { name: 'Ana ana@x.test' }),
      within(list).getByRole('button', { name: 'Bea bea@x.test' }),
    ])
    expect(asked).toEqual([])
    fireEvent.click(within(list).getByRole('button', { name: 'Bea bea@x.test' }))
    const heading = panel(screen).getByRole('heading', { name: 'With Bea' })
    expect(document.activeElement === heading).toBe(true)
    await waitFor(() => expect(panel(screen).getByText('Budget (work)')).toBeTruthy())
    expect(asked).toEqual([{ account: 'work', address: 'bea@x.test' }])
    // Back to the list, on the person who was shown.
    fireEvent.click(panel(screen).getByRole('button', { name: 'Choose someone else' }))
    expect(document.activeElement === panel(screen).getByRole('button', { name: 'Bea bea@x.test' })).toBe(true)
    // Only the panel is remembered, never the person.
    expect(JSON.stringify(writes)).not.toContain('bea@x.test')
  })

  it('says so when nobody else is in the conversation', () => {
    openConversation(message('work', 'work#INBOX#self', { from_name: 'Me', from_addr: 'me@work.test' }))
    const screen = render(<Frame />)
    expect(panel(screen).getByText('No one else is in this conversation.')).toBeTruthy()
    expect(asked).toEqual([])
  })

  it('opens the panel from «History with …» in the participant menu, with that person and the focus on its tab', async () => {
    openConversation(message('work', 'work#INBOX#team', { cc: 'Bea <bea@x.test>' }))
    ui$.sidebarSection.set('overview')
    const screen = render(<Frame />)
    fireEvent.contextMenu(screen.getByText('bea@x.test'), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'History with Bea' }))
    const tab = screen.getByRole('tab', { name: 'Person' })
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(panel(screen).getByRole('heading', { name: 'With Bea' })).toBeTruthy()
    // Polled, and compared rather than printed: the menu's removal settles after the click.
    await waitFor(() => expect(document.activeElement === tab).toBe(true))
    await waitFor(() => expect(panel(screen).getByText('Budget (work)')).toBeTruthy())
    expect(asked).toEqual([{ account: 'work', address: 'bea@x.test' }])
    expect(ui$.sidebarSection.get()).toBe('person')
    // The sidebar stays expanded as it was; nothing but the panel is saved.
    expect(writes).toEqual([
      { key: 'session_sidebar_section_main', value: 'overview' },
      { key: 'session_sidebar_section_main', value: 'person' },
    ])
  })

  it('never shows a late answer for the account left behind', async () => {
    const pending: Record<string, (context: PersonContext) => void> = {}
    answer = (account) => new Promise((resolve) => (pending[account] = resolve))
    openConversation(message('work', 'work#INBOX#budget'))
    const screen = render(<Frame />)
    // The same person, in a conversation of another account.
    act(() => openConversation(message('home', 'home#INBOX#budget')))
    expect(panel(screen).getByText('Account: Home')).toBeTruthy()
    await act(async () => pending.home(history('home')))
    await act(async () => pending.work(history('work')))
    expect(panel(screen).getByText('Budget (home)')).toBeTruthy()
    expect(panel(screen).queryAllByText('Budget (work)')).toHaveLength(0)
    expect(asked.map((question) => question.account)).toEqual(['work', 'home'])
  })

  it('opens a conversation and an event from the history where they came from, the person going along', async () => {
    const team = message('work', 'work#INBOX#team', { cc: 'Bea <bea@x.test>' })
    const earlier = message('work', 'work#INBOX#t1', { cc: 'Bea <bea@x.test>' })
    openConversation(team)
    mail$.threads.set([team, earlier])
    const screen = render(<Frame />)
    fireEvent.click(panel(screen).getByRole('button', { name: 'Bea bea@x.test' }))
    await waitFor(() => expect(panel(screen).getByText('Budget (work)')).toBeTruthy())
    fireEvent.click(panel(screen).getByText('Budget (work)'))
    expect(ui$.selectedAccount.get()).toBe('work')
    expect(ui$.selectedThread.get()).toBe('work#INBOX#t1')
    expect(person$.participant.get()).toEqual({
      thread: 'work#INBOX#t1',
      account: 'work',
      address: 'bea@x.test',
      name: 'Bea',
    })
    // Once that conversation is read, the panel still shows Bea, not its list.
    act(() => mail$.messages.set([earlier]))
    expect(panel(screen).getByRole('heading', { name: 'With Bea' })).toBeTruthy()
    await waitFor(() => expect(panel(screen).getByText('Review')).toBeTruthy())
    fireEvent.click(panel(screen).getByText('Review'))
    expect(ui$.module.get()).toBe('calendar')
    expect(calendar$.view.get()).toBe('day')
  })
})

describe('the Persona panel in Persones', () => {
  it("reads the history in the account of the contact's address book", async () => {
    people$.people.set([
      contact({ id: 'google::google-home:c1', source: 'google', account: 'home', book: 'google-home' }),
    ])
    ui$.module.set('people')
    const screen = render(<Frame people />)
    expect(panel(screen).getByText('Select a contact to see your history with them.')).toBeTruthy()
    // Selecting the contact in the list is what puts them in context.
    fireEvent.click(screen.getByRole('option', { name: /Ana Prat/ }))
    expect(panel(screen).getByRole('heading', { name: 'With Ana Prat' })).toBeTruthy()
    expect(panel(screen).getByText('Account: Home')).toBeTruthy()
    await waitFor(() => expect(panel(screen).getByText('Budget (home)')).toBeTruthy())
    expect(asked).toEqual([{ account: 'home', address: 'ana@x.test' }])
    expect(panel(screen).queryAllByRole('combobox')).toHaveLength(0)
    // From the history, the conversation opens in mail, in that account.
    fireEvent.click(panel(screen).getByText('Budget (home)'))
    expect(ui$.module.get()).toBe('mail')
    expect(ui$.selectedAccount.get()).toBe('home')
    expect(ui$.selectedThread.get()).toBe('home#INBOX#t1')
  })

  it('asks for the account when the book is nobody’s, and never picks one by itself', async () => {
    const pending: Record<string, (context: PersonContext) => void> = {}
    answer = (account) => new Promise((resolve) => (pending[account] = resolve))
    people$.people.set([contact({ source: 'local', account: '', book: 'local' })])
    people$.selectedId.set('carddav::src-1:c1')
    ui$.module.set('people')
    const screen = render(<Frame />)
    expect(
      panel(screen).getByText(
        "This contact's address book doesn't belong to any account. Choose the account to look in.",
      ),
    ).toBeTruthy()
    const account = panel(screen).getByRole('combobox', { name: 'Account' }) as HTMLSelectElement
    expect(account.value).toBe('')
    // The accounts with mail, feeds left out, after «Choose an account».
    expect([...account.options].map((option) => option.textContent)).toEqual([
      'Choose an account',
      'Work (me@work.test)',
      'Home (me@home.test)',
    ])
    expect(asked).toEqual([])
    fireEvent.change(account, { target: { value: 'work' } })
    fireEvent.change(account, { target: { value: 'home' } })
    // The answer for the account left behind comes last and is not shown.
    await act(async () => pending.home(history('home')))
    await act(async () => pending.work(history('work')))
    expect(panel(screen).getByText('Budget (home)')).toBeTruthy()
    expect(panel(screen).queryAllByText('Budget (work)')).toHaveLength(0)
    expect(asked.map((question) => question.account)).toEqual(['work', 'home'])
  })

  it('asks which address when the contact has several, and says when it has none', async () => {
    people$.people.set([
      contact({
        account: 'work',
        emails: [
          { addr: 'ana@x.test', label: 'work' },
          { addr: 'ana@casa.test', label: 'home' },
        ],
      }),
      contact({ id: 'local::local:n', source: 'local', account: '', name: 'Nobody', emails: [] }),
    ])
    people$.selectedId.set('carddav::src-1:c1')
    ui$.module.set('people')
    const screen = render(<Frame />)
    expect(panel(screen).getByText('This contact has more than one address. Choose the one to look up.')).toBeTruthy()
    expect(asked).toEqual([])
    fireEvent.change(panel(screen).getByRole('combobox', { name: 'Address' }), { target: { value: 'ana@casa.test' } })
    await waitFor(() => expect(panel(screen).getByText('Budget (work)')).toBeTruthy())
    expect(asked).toEqual([{ account: 'work', address: 'ana@casa.test' }])
    act(() => people$.selectedId.set('local::local:n'))
    expect(panel(screen).getByRole('heading', { name: 'With Nobody' })).toBeTruthy()
    expect(panel(screen).getByText('This contact has no email address to look up.')).toBeTruthy()
  })
})

describe('the Persona panel elsewhere', () => {
  it('is in every module, with an empty state that says what to select', () => {
    for (const module of APP_MODULES) {
      ui$.module.set(module)
      const screen = render(<Frame />)
      expect(screen.getByRole('tab', { name: 'Person' }).getAttribute('aria-selected')).toBe('true')
      const text =
        module === 'mail'
          ? 'Open a conversation to see your history with one of its people.'
          : module === 'people'
            ? 'Select a contact to see your history with them.'
            : 'Open a conversation in Mail or a contact in People to see your history with someone.'
      expect(panel(screen).getByText(text)).toBeTruthy()
      cleanup()
    }
    // Not even with a conversation chosen in mail or a contact selected.
    openConversation(message('work', 'work#INBOX#budget'))
    people$.people.set([contact({ account: 'work' })])
    people$.selectedId.set('carddav::src-1:c1')
    ui$.module.set('calendar')
    const screen = render(<Frame />)
    expect(
      panel(screen).getByText('Open a conversation in Mail or a contact in People to see your history with someone.'),
    ).toBeTruthy()
    expect(asked).toEqual([])
  })
})

describe('the Persona panel and the conversation it reads (review of #363)', () => {
  it('counts an alias of your account as you: a conversation answered from it has one other person', async () => {
    accounts$.set([{ ...work, aliases: [{ email: 'Desk@Work.test', name: 'Desk' }] } as Account, home])
    // Ana wrote to the alias, and the alias answered.
    openConversation(
      message('work', 'work#INBOX#alias', { to: 'Desk <desk@work.test>' }),
      message('work', 'work#INBOX#alias', {
        id: 'work#INBOX#alias#2',
        from_name: 'Desk',
        from_addr: 'desk@work.test',
        to: 'Ana <ana@x.test>',
      }),
    )
    const screen = render(<Frame />)
    // No list with the alias in it as somebody else: Ana's history.
    expect(panel(screen).queryAllByRole('list', { name: 'Choose whose history to see' })).toHaveLength(0)
    expect(panel(screen).getByRole('heading', { name: 'With Ana' })).toBeTruthy()
    await waitFor(() => expect(asked).toEqual([{ account: 'work', address: 'ana@x.test' }]))
  })

  it('reads the list row when none of the messages is there and nothing loads, but waits while they load', async () => {
    // A conversation whose messages all wait for their bodies (offline, maybe
    // for good): none of them is listed, and nothing is loading.
    const row = message('work', 'work#INBOX#bodies')
    mail$.threads.set([row])
    mail$.messages.set([])
    mail$.threadLoading.set(true)
    ui$.selectedThread.set(row.thread_id)
    const screen = render(<Frame />)
    expect(panel(screen).getByLabelText('Loading...')).toBeTruthy()
    expect(asked).toEqual([])
    act(() => mail$.threadLoading.set(false))
    expect(panel(screen).getByRole('heading', { name: 'With Ana' })).toBeTruthy()
    await waitFor(() => expect(asked).toEqual([{ account: 'work', address: 'ana@x.test' }]))
  })

  it("never asks about the previous conversation's people in the account of the next one", async () => {
    const working = message('work', 'work#INBOX#budget')
    const athome = message('home', 'home#INBOX#garden', { from_name: 'Bea', from_addr: 'bea@x.test' })
    openConversation(working)
    mail$.threads.set([working, athome])
    const screen = render(<Frame />)
    await waitFor(() => expect(asked).toEqual([{ account: 'work', address: 'ana@x.test' }]))
    // Another account's conversation, while the messages are still the work one's.
    act(() => {
      mail$.threadLoading.set(true)
      ui$.selectedThread.set(athome.thread_id)
    })
    expect(panel(screen).getByLabelText('Loading...')).toBeTruthy()
    // The read ends with none of its messages: the row, which is Bea's.
    act(() => mail$.threadLoading.set(false))
    expect(panel(screen).getByRole('heading', { name: 'With Bea' })).toBeTruthy()
    act(() => mail$.messages.set([athome]))
    await waitFor(() => expect(panel(screen).getByText('Budget (home)')).toBeTruthy())
    expect(asked).toContainEqual({ account: 'home', address: 'bea@x.test' })
    expect(asked).not.toContainEqual({ account: 'home', address: 'ana@x.test' })
  })

  it('never shows the answer for the contact left behind, when the next one has another address', async () => {
    const pending: Record<string, (context: PersonContext) => void> = {}
    answer = (account, address) => new Promise((resolve) => (pending[address] = resolve))
    const said = (address: string): PersonContext => ({
      ...history('work', address),
      conversations: [{ ...history('work').conversations[0], subject: `About ${address}` }],
    })
    people$.people.set([
      contact({ id: 'c-ana', account: 'work' }),
      contact({ id: 'c-marc', account: 'work', name: 'Marc Roca', emails: [{ addr: 'marc@x.test', label: '' }] }),
    ])
    people$.selectedId.set('c-ana')
    ui$.module.set('people')
    const screen = render(<Frame />)
    act(() => people$.selectedId.set('c-marc'))
    expect(panel(screen).getByRole('heading', { name: 'With Marc Roca' })).toBeTruthy()
    await act(async () => pending['marc@x.test'](said('marc@x.test')))
    await act(async () => pending['ana@x.test'](said('ana@x.test')))
    expect(panel(screen).getByText('About marc@x.test')).toBeTruthy()
    expect(panel(screen).queryAllByText('About ana@x.test')).toHaveLength(0)
    expect(asked).toEqual([
      { account: 'work', address: 'ana@x.test' },
      { account: 'work', address: 'marc@x.test' },
    ])
  })

  it('below 769 px, opens a conversation from the history in Persones on the conversation, not the list', async () => {
    ;(window as any).happyDOM.setViewport({ width: 600, height: 800 })
    people$.people.set([contact({ account: 'work' })])
    people$.selectedId.set('carddav::src-1:c1')
    ui$.module.set('people')
    const screen = render(<Frame />)
    // Below 769 px the sidebar is only an overlay.
    act(() => openSidebarPanel('person'))
    expect(screen.getByRole('complementary', { name: 'Sidebar' }).dataset.layout).toBe('overlay')
    await waitFor(() => expect(panel(screen).getByText('Budget (work)')).toBeTruthy())
    fireEvent.click(panel(screen).getByText('Budget (work)'))
    expect(ui$.module.get()).toBe('mail')
    expect(ui$.selectedThread.get()).toBe('work#INBOX#t1')
    expect(ui$.mobilePane.get()).toBe('conversation')
    expect(sidebar$.overlay.get()).toBe(false)
  })
})
