import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { ConversationHeader } from './ConversationHeader'
import { accounts$ } from '../../states/accounts'
import { kanban$ } from '../../states/kanban'
import { labels$ } from '../../states/labels'
import { mail$ } from '../../states/mail'
import { sidebar$ } from '../../states/sidebar'
import { thread$ } from '../../states/thread'
import { isConversationSection, runToastUndo, ui$ } from '../../states/ui'
import type { Account, Message } from '../../types'

// A junk folder known only by its role: the name fallback would not find it,
// so these tests prove the role is what decides.
const JUNK = 'INBOX.Pourriel'
const FOLDERS = [
  { id: 'INBOX', name: 'Inbox', account_id: 'acct', role: 'inbox' },
  { id: JUNK, name: 'Pourriel', account_id: 'acct', role: 'junk' },
] as any[]

// The visible junk button of the reader (#245): the same core command, toast
// and undo as the thread context menu, on the open conversation.

const conversation = (folder: string, over: Partial<Message> = {}): Message =>
  ({
    id: `acct#${folder}#k1`,
    account_id: 'acct',
    folder_id: folder,
    thread_id: `acct#${folder}#k1`,
    from_name: 'Sender',
    from_addr: 'sender@example.com',
    to: 'me@example.com',
    subject: 'Claim your prize',
    preview: '',
    body: '',
    date: 0,
    unread: false,
    starred: false,
    has_attachments: false,
    ...over,
  }) as Message

let calls: { command: string; payload: any }[] = []
let previousGo: unknown
let previousAccounts: Account[]
let previousState: {
  selectedAccount: string
  selectedFolder: string
  foldersByAccount: ReturnType<typeof mail$.foldersByAccount.peek>
  folders: ReturnType<typeof mail$.folders.peek>
}

beforeEach(() => {
  previousGo = (window as any).go
  previousAccounts = accounts$.peek()
  previousState = {
    selectedAccount: ui$.selectedAccount.peek(),
    selectedFolder: ui$.selectedFolder.peek(),
    foldersByAccount: mail$.foldersByAccount.peek(),
    folders: mail$.folders.peek(),
  }
  calls = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          // The core's own answer: its move result, naming the destination
          // as target_folder.
          if (command === 'mail.markJunk') {
            const [, source] = payload.thread_id.split('#')
            return { ok: true, moved: 1, source_folder: source, target_folder: payload.junk ? JUNK : 'INBOX' }
          }
          if (command === 'mail.move') return { ok: true, moved: 1 }
          if (command === 'mail.threadList') return { threads: [] }
          if (command === 'mail.folderList') return { folders: FOLDERS }
          return {}
        },
      },
    },
  }
  accounts$.set([{ id: 'acct', email: 'me@example.com', auth_type: 'password', provider: 'imap' } as Account])
  mail$.foldersByAccount.set({ acct: structuredClone(FOLDERS) })
  mail$.folders.set([])
  mail$.messages.set([])
  kanban$.threads.set({})
  kanban$.activeBoardId.set('')
  thread$.searchOpen.set(false)
  thread$.search.set('')
  ui$.selectedAccount.set('acct')
  ui$.selectedFolder.set('INBOX')
  ui$.toast.set('')
  ui$.toastTone.set('success')
  ui$.toastUndo.set(null)
})

afterEach(() => {
  cleanup()
  mail$.threads.set([])
  ui$.selectedThread.set('')
  accounts$.set(previousAccounts)
  ui$.selectedAccount.set(previousState.selectedAccount)
  ui$.selectedFolder.set(previousState.selectedFolder)
  mail$.foldersByAccount.set(previousState.foldersByAccount)
  mail$.folders.set(previousState.folders)
  // Reset what is on screen; a pending timer from this test cannot clear the
  // next test's toast, whatever its text (#321).
  ui$.toast.set('')
  ui$.toastUndo.set(null)
  ;(window as any).go = previousGo
})

function renderHeader(activeThread: Message, isRSS = false) {
  mail$.threads.set([activeThread])
  ui$.selectedThread.set(activeThread.thread_id)
  return render(
    <ConversationHeader
      activeThread={activeThread}
      isRSS={isRSS}
      conversationMode="html"
      setQuickConversationMode={() => {}}
      searchMatches={[]}
      activeSearchIndex={0}
      goToSearchMatch={() => {}}
      desktopSearchInputRef={createRef<HTMLInputElement>()}
    />,
  )
}

const sent = (command: string) => calls.filter((call) => call.command === command).map((call) => call.payload)
const nameOf = (button: HTMLElement) => button.getAttribute('aria-label') ?? button.getAttribute('title') ?? ''

describe('the junk button of the reader (#245)', () => {
  it('marks the open conversation as junk with the context menu toast and undo', async () => {
    const view = renderHeader(conversation('INBOX'))

    fireEvent.click(view.getByRole('button', { name: 'Mark as junk' }))

    await waitFor(() => expect(ui$.toast.get()).toBe('Moved to junk'))
    expect(sent('mail.markJunk')).toEqual([{ thread_id: 'acct#INBOX#k1', junk: true }])
    expect(ui$.toastUndo.peek()).toBeTruthy()

    runToastUndo()
    await waitFor(() =>
      expect(sent('mail.move')).toEqual([{ thread_id: 'acct#INBOX.Pourriel#k1', target_folder_id: 'INBOX' }]),
    )
  })

  it('reads "Not junk" in the junk folder and takes the conversation back out', async () => {
    const view = renderHeader(conversation('INBOX.Pourriel'))

    expect(view.queryByRole('button', { name: 'Mark as junk' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Not junk' }))

    await waitFor(() => expect(ui$.toast.get()).toBe('Moved back to the inbox'))
    expect(sent('mail.markJunk')).toEqual([{ thread_id: 'acct#INBOX.Pourriel#k1', junk: false }])
    expect(ui$.toastUndo.peek()).toBeTruthy()
  })

  // happy-dom has no stylesheet, so the container query that hides the button
  // in a narrow header is not exercised here; this proves the menu entry works.
  it('also offers it in the actions menu', async () => {
    const view = renderHeader(conversation('INBOX'))

    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    // The header button and the menu entry, both with the same label.
    expect(view.getAllByRole('button', { name: 'Mark as junk' })).toHaveLength(1)
    fireEvent.click(view.getByRole('menuitem', { name: 'Mark as junk' }))

    await waitFor(() => expect(sent('mail.markJunk')).toEqual([{ thread_id: 'acct#INBOX#k1', junk: true }]))
    // The menu closes behind the action, leaving only the header button.
    expect(view.queryByRole('menuitem', { name: 'Mark as junk' })).toBeNull()
    expect(view.getAllByRole('button', { name: 'Mark as junk' })).toHaveLength(1)
  })

  it('is a labelled button that sits with archive and trash in keyboard order', () => {
    const view = renderHeader(conversation('INBOX'))

    const junk = view.getByRole('button', { name: 'Mark as junk' }) as HTMLButtonElement
    expect(junk.type).toBe('button')
    expect(junk.getAttribute('title')).toBe('Mark as junk')
    const names = view.getAllByRole('button').map(nameOf)
    const archive = names.indexOf('Archive thread')
    const position = names.indexOf('Mark as junk')
    const trash = names.indexOf('Move to Trash')
    expect(archive).toBeGreaterThan(-1)
    expect(position).toBe(archive + 1)
    expect(trash).toBe(position + 1)
    junk.focus()
    expect(document.activeElement).toBe(junk)
  })

  it('is disabled for a Microsoft Graph account, which offers no junk folder action', () => {
    accounts$.set([{ id: 'acct', email: 'me@example.com', auth_type: 'graph_oauth', graph_writes: true } as Account])
    const view = renderHeader(conversation('INBOX'))

    const junk = view.getByRole('button', { name: 'Mark as junk' }) as HTMLButtonElement
    expect(junk.disabled).toBe(true)
    fireEvent.click(junk)
    expect(sent('mail.markJunk')).toEqual([])
  })

  it('follows the folder list as it loads', () => {
    mail$.foldersByAccount.set({})
    const view = renderHeader(conversation('INBOX.Pourriel'))
    // Before the folders are known the role cannot be read, and the name says
    // nothing.
    expect(view.getByRole('button', { name: 'Mark as junk' })).toBeTruthy()

    act(() => mail$.foldersByAccount.set({ acct: structuredClone(FOLDERS) }))

    expect(view.getByRole('button', { name: 'Not junk' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Mark as junk' })).toBeNull()
  })

  it('is not offered for a draft, as in the selection bar', () => {
    mail$.foldersByAccount.set({
      acct: [...structuredClone(FOLDERS), { id: 'Drafts', name: 'Drafts', account_id: 'acct', role: 'drafts' }],
    })
    const view = renderHeader(conversation('Drafts'))

    expect(view.queryByRole('button', { name: 'Mark as junk' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    expect(view.getByRole('menu', { name: 'More actions' })).toBeTruthy()
    expect(view.queryByRole('menuitem', { name: 'Mark as junk' })).toBeNull()
  })

  it('is not offered for a feed item', () => {
    const view = renderHeader(conversation('INBOX', { account_id: 'rss-1', thread_id: 'rss-1#feed#k1' }), true)

    expect(view.queryByRole('button', { name: 'Mark as junk' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    expect(view.getByRole('menu', { name: 'More actions' })).toBeTruthy()
    expect(view.queryByRole('menuitem', { name: 'Mark as junk' })).toBeNull()
  })
})

// #347: in a narrow header (the app's 200 % leaves a 1025 px window a 360 px
// reader, 11.25 rem) only «Archive thread» and «More actions» stay (ADR-0068
// §3); search, label and details give way like the others, and «More actions»
// has them while they are hidden. happy-dom has no stylesheet, so the
// container widths are the e2e's; these prove the entries.
describe('what a narrow conversation header hides is in «More actions» (#347)', () => {
  let previousLabels: ReturnType<typeof labels$.labels.peek>
  let previousSection: ReturnType<typeof ui$.sidebarSection.peek>
  beforeEach(() => {
    previousLabels = labels$.labels.peek()
    previousSection = ui$.sidebarSection.peek()
    labels$.labels.set([
      { id: 'work', name: 'Work', colour: '#2563eb', inBar: false, links: {} },
      { id: 'review', name: 'Review', colour: '#15803d', inBar: false, links: {} },
    ])
  })
  afterEach(() => {
    // Unmounted first: the header reads what is reset below.
    cleanup()
    labels$.labels.set(previousLabels)
    ui$.sidebarSection.set(previousSection)
    sidebar$.set({ fits: false, strip: false, conversationOpen: false, overlay: false })
  })

  it('never hides «Archive thread» or «More actions»', () => {
    const view = renderHeader(conversation('INBOX'))
    for (const name of ['Archive thread', 'More actions']) {
      const button = view.getByRole('button', { name })
      expect(button.className.split(' ')).not.toContain('hidden')
      expect(button.closest('.hidden')).toBeNull()
    }
  })

  it('opens the search of the conversation and closes the menu', () => {
    const view = renderHeader(conversation('INBOX'))
    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Search thread' }))
    expect(thread$.searchOpen.peek()).toBe(true)
    expect(view.queryByRole('menu', { name: 'More actions' })).toBeNull()
  })

  it('says whether the Conversa panel is open and toggles it as the header button does', () => {
    sidebar$.conversationOpen.set(true)
    ui$.sidebarSection.set('agenda')
    const view = renderHeader(conversation('INBOX'))
    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    const details = view.getByRole('menuitemcheckbox', { name: 'Conversation details' })
    expect(details.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(details)
    expect(view.queryByRole('menu', { name: 'More actions' })).toBeNull()
    expect(isConversationSection(ui$.sidebarSection.peek())).toBe(true)
    // The header's own button and the menu entry say the same.
    const button = view.getAllByRole('button', { name: 'Conversation details' }).at(-1)!
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    expect(view.getByRole('menuitemcheckbox', { name: 'Conversation details' }).getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  it('puts labels on and off from «Label», which keeps «More actions» open', async () => {
    const view = renderHeader(conversation('INBOX', { labels: ['review'] }))
    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    const label = view.getByRole('menuitem', { name: 'Label' })
    expect(label.getAttribute('aria-haspopup')).toBe('menu')
    fireEvent.click(label)
    const labels = view.getByRole('menu', { name: 'Label' })
    const work = within(labels).getByRole('menuitemcheckbox', { name: 'Work' })
    expect(work.getAttribute('aria-checked')).toBe('false')
    expect(within(labels).getByRole('menuitemcheckbox', { name: 'Review' }).getAttribute('aria-checked')).toBe('true')
    // The submenu is drawn outside the header; pressing in it is not a click
    // outside the menu.
    fireEvent.mouseDown(work)
    await act(async () => {
      fireEvent.click(work)
    })
    await waitFor(() =>
      expect(sent('labels.assign')).toEqual([{ thread_id: 'acct#INBOX#k1', label_ids: ['review', 'work'] }]),
    )
    expect(view.getByRole('menu', { name: 'More actions' })).toBeTruthy()
    // A press elsewhere still closes it.
    fireEvent.mouseDown(document.body)
    expect(view.queryByRole('menu', { name: 'More actions' })).toBeNull()
  })

  it('offers «Manage labels» there, which opens Settings', () => {
    const previous = ui$.settingsOpen.peek()
    const view = renderHeader(conversation('INBOX'))
    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Label' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Manage labels…' }))
    expect(ui$.settingsOpen.peek()).toBe(true)
    expect(view.queryByRole('menu', { name: 'More actions' })).toBeNull()
    ui$.settingsOpen.set(previous)
  })

  it('has no «Label» for a feed item, and no search while the search is open', () => {
    const feed = renderHeader(conversation('INBOX', { account_id: 'rss-1', thread_id: 'rss-1#feed#k1' }), true)
    fireEvent.click(feed.getByRole('button', { name: 'More actions' }))
    expect(feed.queryByRole('menuitem', { name: 'Label' })).toBeNull()
    expect(feed.getByRole('menuitemcheckbox', { name: 'Feed details' })).toBeTruthy()
    cleanup()

    thread$.searchOpen.set(true)
    const view = renderHeader(conversation('INBOX'))
    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    expect(view.queryByRole('menuitem', { name: 'Search thread' })).toBeNull()
    expect(view.getByRole('menuitem', { name: 'Label' })).toBeTruthy()
  })
})

// #347 review: the thread search must not take «Archive thread» with it (it
// pushed «More actions» out of a narrow reader while the other buttons stepped
// aside); «More actions» is no taller than the room under it; and the header's
// label picker and its «Label» submenu share one save in flight.
describe('the conversation header with the search open, a short window and labels (#347)', () => {
  let previousLabels: ReturnType<typeof labels$.labels.peek>
  beforeEach(() => {
    previousLabels = labels$.labels.peek()
    labels$.labels.set([
      { id: 'work', name: 'Work', colour: '#2563eb', inBar: false, links: {} },
      { id: 'review', name: 'Review', colour: '#15803d', inBar: false, links: {} },
    ])
  })
  afterEach(() => {
    cleanup()
    labels$.labels.set(previousLabels)
    thread$.searchOpen.set(false)
  })

  it('keeps «Archive thread» and «More actions» while the search is open; the others step aside', () => {
    thread$.searchOpen.set(true)
    const view = renderHeader(conversation('INBOX'))
    for (const name of ['Archive thread', 'More actions']) {
      const button = view.getByRole('button', { name })
      expect(button.closest('.hidden')).toBeNull()
    }
    for (const name of ['Star', 'Mark as junk', 'Move to trash', 'Label'])
      expect(view.queryByRole('button', { name })).toBeNull()
    // In the order of the line: the search, «Archive thread», then «More actions».
    const order = [view.getByPlaceholderText('Search thread'), ...view.getAllByRole('button')]
    const archive = view.getByRole('button', { name: 'Archive thread' })
    const more = view.getByRole('button', { name: 'More actions' })
    expect(order.indexOf(archive)).toBeGreaterThan(0)
    expect(order.indexOf(more)).toBeGreaterThan(order.indexOf(archive))
  })

  it('caps «More actions» at the room under it, down to the edge that clips it, and makes it a Tab stop', () => {
    const realRect = HTMLElement.prototype.getBoundingClientRect
    const rect = (top: number, bottom: number) =>
      ({ top, bottom, left: 0, right: 200, width: 200, height: bottom - top, x: 0, y: top }) as DOMRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.getAttribute('role') === 'menu') return rect(300, 900)
      if (this.hasAttribute('data-clips')) return rect(0, 500)
      return realRect.call(this)
    }
    try {
      // The window alone: its height less the menu's top and 8 px.
      ;(window as any).happyDOM.setViewport({ width: 1024, height: 600 })
      let view = renderHeader(conversation('INBOX'))
      fireEvent.click(view.getByRole('button', { name: 'More actions' }))
      let menu = view.getByRole('menu', { name: 'More actions' })
      expect(menu.style.maxHeight).toBe('292px')
      expect(menu.className.split(' ')).toContain('overflow-y-auto')
      expect(menu.tabIndex).toBe(0)
      cleanup()

      // An ancestor that clips what overflows it (the reader) ends it sooner.
      const clip = document.createElement('div')
      clip.setAttribute('data-clips', '')
      clip.style.overflowY = 'hidden'
      document.body.appendChild(clip)
      mail$.threads.set([conversation('INBOX')])
      view = render(
        <ConversationHeader
          activeThread={conversation('INBOX')}
          isRSS={false}
          conversationMode="html"
          setQuickConversationMode={() => {}}
          searchMatches={[]}
          activeSearchIndex={0}
          goToSearchMatch={() => {}}
          desktopSearchInputRef={createRef<HTMLInputElement>()}
        />,
        { container: clip },
      )
      fireEvent.click(view.getByRole('button', { name: 'More actions' }))
      menu = view.getByRole('menu', { name: 'More actions' })
      expect(menu.style.maxHeight).toBe('192px')
      // A window resized while it is open moves the cap.
      act(() => {
        ;(window as any).happyDOM.setViewport({ width: 1024, height: 400 })
        window.dispatchEvent(new Event('resize'))
      })
      expect(menu.style.maxHeight).toBe('92px')
      cleanup()
      clip.remove()
    } finally {
      HTMLElement.prototype.getBoundingClientRect = realRect
      ;(window as any).happyDOM.setViewport({ width: 1024, height: 768 })
    }
  })

  it('keeps every label toggle disabled while a save is in flight, in the picker and in «Label», closed and opened again', async () => {
    let finish: () => void = () => {}
    const invoke = (window as any).go.main.App.Invoke
    ;(window as any).go.main.App.Invoke = (command: string, payload: any) => {
      if (command !== 'labels.assign') return invoke(command, payload)
      calls.push({ command, payload })
      return new Promise((resolve) => {
        finish = () => resolve({ labels: payload.label_ids })
      })
    }
    const view = renderHeader(conversation('INBOX', { labels: ['review'] }))
    const picker = view.getByRole('button', { name: 'Label' })
    const toggles = (menu: HTMLElement) => within(menu).getAllByRole('menuitemcheckbox')
    const disabled = (menu: HTMLElement) => toggles(menu).map((item) => item.getAttribute('aria-disabled'))

    // A save from the picker.
    fireEvent.click(picker)
    const pickerMenu = view.getByRole('menu', { name: 'Label' })
    await act(async () => {
      fireEvent.click(within(pickerMenu).getByRole('menuitemcheckbox', { name: 'Work' }))
    })
    expect(sent('labels.assign')).toEqual([{ thread_id: 'acct#INBOX#k1', label_ids: ['review', 'work'] }])
    expect(disabled(pickerMenu)).toEqual(['true', 'true'])
    // Closed and opened again: still saving.
    fireEvent.click(picker)
    expect(view.queryByRole('menu', { name: 'Label' })).toBeNull()
    fireEvent.click(picker)
    expect(disabled(view.getByRole('menu', { name: 'Label' }))).toEqual(['true', 'true'])
    fireEvent.click(picker)

    // «More actions» → «Label», another menu with the same labels: the same
    // save, so its toggles are disabled too, and a press starts nothing.
    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Label' }))
    const submenu = view.getByRole('menu', { name: 'Label' })
    expect(disabled(submenu)).toEqual(['true', 'true'])
    fireEvent.click(within(submenu).getByRole('menuitemcheckbox', { name: 'Review' }))
    expect(sent('labels.assign')).toHaveLength(1)

    // The save ends: both menus take toggles again.
    await act(async () => {
      finish()
    })
    await waitFor(() => expect(disabled(view.getByRole('menu', { name: 'Label' }))).toEqual([null, null]))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    expect(view.queryByRole('menu', { name: 'More actions' })).toBeNull()
    fireEvent.click(picker)
    expect(disabled(view.getByRole('menu', { name: 'Label' }))).toEqual([null, null])
  })
})
