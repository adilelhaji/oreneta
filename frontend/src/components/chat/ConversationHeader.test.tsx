import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ConversationHeader } from './ConversationHeader'
import { accounts$ } from '../../states/accounts'
import { kanban$ } from '../../states/kanban'
import { mail$ } from '../../states/mail'
import { thread$ } from '../../states/thread'
import { runToastUndo, ui$ } from '../../states/ui'
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
    await waitFor(() => expect(sent('mail.move')).toEqual([{ thread_id: 'acct#INBOX.Pourriel#k1', target_folder_id: 'INBOX' }]))
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
