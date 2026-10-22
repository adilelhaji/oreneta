import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { BulkActionBar } from './BulkActionBar'
import { accounts$ } from '../../states/accounts'
import { kanban$ } from '../../states/kanban'
import { bulkMarkSelectedJunk, mail$ } from '../../states/mail'
import { clearBulkSelection, runToastUndo, ui$, type BulkSelectionItem } from '../../states/ui'
import type { Account, Message } from '../../types'

// A junk folder known only by its role: the name fallback would not find it,
// so these tests prove the role is what decides.
const JUNK = 'INBOX.Pourriel'
const FOLDERS = [
  { id: 'INBOX', name: 'Inbox', account_id: 'acct', role: 'inbox' },
  { id: JUNK, name: 'Pourriel', account_id: 'acct', role: 'junk' },
] as any[]

// The visible junk button of the selection bar (#245): the same core command
// and the same toast as the thread context menu, for every selected
// conversation, with one undo.

const thread = (folder: string, key: string, over: Partial<Message> = {}): Message =>
  ({
    id: `acct#${folder}#${key}`,
    account_id: 'acct',
    folder_id: folder,
    thread_id: `acct#${folder}#${key}`,
    from_name: 'Sender',
    from_addr: 'sender@example.com',
    to: 'me@example.com',
    subject: `Subject ${key}`,
    preview: '',
    body: '',
    date: 0,
    unread: false,
    starred: false,
    has_attachments: false,
    ...over,
  }) as Message

const item = (message: Message, over: Partial<BulkSelectionItem> = {}): BulkSelectionItem => ({
  key: `thread-list:${message.thread_id}`,
  groupKey: 'thread-list:acct',
  threadId: message.thread_id,
  accountId: message.account_id,
  folderId: message.folder_id,
  surface: 'thread-list',
  kind: 'mail',
  unread: message.unread,
  starred: message.starred,
  draft: false,
  trash: false,
  ...over,
})

let calls: { command: string; payload: any }[] = []
let previousGo: unknown
let previousAccounts: Account[]
let previousState: {
  selectedAccount: string
  selectedFolder: string
  foldersByAccount: ReturnType<typeof mail$.foldersByAccount.peek>
  folders: ReturnType<typeof mail$.folders.peek>
}

function stubBridge() {
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
}

const sent = (command: string) => calls.filter((call) => call.command === command).map((call) => call.payload)

beforeEach(() => {
  previousGo = (window as any).go
  previousAccounts = accounts$.peek()
  previousState = {
    selectedAccount: ui$.selectedAccount.peek(),
    selectedFolder: ui$.selectedFolder.peek(),
    foldersByAccount: mail$.foldersByAccount.peek(),
    folders: mail$.folders.peek(),
  }
  accounts$.set([{ id: 'acct', email: 'me@example.com', auth_type: 'password', provider: 'imap' } as Account])
  mail$.foldersByAccount.set({ acct: structuredClone(FOLDERS) })
  mail$.folders.set([])
  mail$.messages.set([])
  kanban$.threads.set({})
  ui$.selectedAccount.set('acct')
  ui$.selectedFolder.set('INBOX')
  ui$.selectedThread.set('')
  ui$.toast.set('')
  ui$.toastTone.set('success')
  ui$.toastUndo.set(null)
  stubBridge()
})

afterEach(() => {
  cleanup()
  clearBulkSelection()
  mail$.threads.set([])
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

describe('the junk button of the selection bar (#245)', () => {
  it('files every selected conversation as junk, with the context menu toast and one undo', async () => {
    const first = thread('INBOX', 'a')
    const second = thread('INBOX', 'b')
    mail$.threads.set([first, second])
    const view = render(<BulkActionBar items={[item(first), item(second)]} />)

    fireEvent.click(view.getByRole('button', { name: 'Mark as junk' }))

    await waitFor(() => expect(ui$.toast.get()).toBe('Moved to junk'))
    expect(sent('mail.markJunk')).toEqual([
      { thread_id: 'acct#INBOX#a', junk: true },
      { thread_id: 'acct#INBOX#b', junk: true },
    ])
    expect(ui$.toastTone.get()).toBe('success')
    expect(ui$.toastUndo.peek()).toBeTruthy()

    // One undo for the whole selection: each conversation back where it was.
    runToastUndo()
    await waitFor(() => expect(sent('mail.move')).toHaveLength(2))
    expect(sent('mail.move')).toEqual([
      { thread_id: 'acct#INBOX.Pourriel#a', target_folder_id: 'INBOX' },
      { thread_id: 'acct#INBOX.Pourriel#b', target_folder_id: 'INBOX' },
    ])
    await waitFor(() => expect(ui$.toast.get()).toBe('2 threads moved'))
  })

  it('reads "Not junk" in the junk folder and takes the selection back out', async () => {
    const first = thread('INBOX.Pourriel', 'a')
    const second = thread('INBOX.Pourriel', 'b')
    mail$.threads.set([first, second])
    const view = render(<BulkActionBar items={[item(first), item(second)]} />)

    expect(view.queryByRole('button', { name: 'Mark as junk' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Not junk' }))

    await waitFor(() => expect(ui$.toast.get()).toBe('Moved back to the inbox'))
    expect(sent('mail.markJunk')).toEqual([
      { thread_id: 'acct#INBOX.Pourriel#a', junk: false },
      { thread_id: 'acct#INBOX.Pourriel#b', junk: false },
    ])
    expect(ui$.toastUndo.peek()).toBeTruthy()
  })

  it('in a mixed selection files the rest as junk and leaves the junk ones alone', async () => {
    const inbox = thread('INBOX', 'a')
    const junk = thread('INBOX.Pourriel', 'b')
    mail$.threads.set([inbox, junk])
    const view = render(<BulkActionBar items={[item(inbox), item(junk)]} />)

    fireEvent.click(view.getByRole('button', { name: 'Mark as junk' }))

    await waitFor(() => expect(ui$.toast.get()).toBe('Moved to junk'))
    // Marking a junk message as junk again would train the filter twice.
    expect(sent('mail.markJunk')).toEqual([{ thread_id: 'acct#INBOX#a', junk: true }])
  })

  it('reports how far a stopped run got, as the other bulk actions do', async () => {
    const first = thread('INBOX', 'a')
    const second = thread('INBOX', 'b')
    mail$.threads.set([first, second])
    let markJunkCalls = 0
    ;(window as any).go.main.App.Invoke = async (command: string, payload: any) => {
      calls.push({ command, payload })
      if (command === 'mail.markJunk') return { ok: true, moved: markJunkCalls++ === 0 ? 1 : 0, target_folder: JUNK }
      return {}
    }
    const view = render(<BulkActionBar items={[item(first), item(second)]} />)

    fireEvent.click(view.getByRole('button', { name: 'Mark as junk' }))

    await waitFor(() => expect(ui$.toastTone.get()).toBe('error'))
    expect(ui$.toast.get()).toBe('1 of 2 done, then stopped: Junk failed: no matching messages found')
    expect(ui$.toastUndo.peek()).toBeNull()
    // Only the one that failed comes back to the list.
    expect(mail$.threads.get().map((row) => row.thread_id)).toEqual(['acct#INBOX#b'])
  })

  it('is a labelled button in the bar, between closing the selection and its menu', () => {
    const first = thread('INBOX', 'a')
    const view = render(<BulkActionBar items={[item(first)]} />)

    const junk = view.getByRole('button', { name: 'Mark as junk' }) as HTMLButtonElement
    expect(junk.tagName).toBe('BUTTON')
    expect(junk.type).toBe('button')
    expect(junk.getAttribute('title')).toBe('Mark as junk')
    expect(junk.disabled).toBe(false)
    // Keyboard order is document order: nothing here reorders it.
    const names = view.getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    expect(names).toEqual(['Close', 'Mark as junk', 'More'])
    junk.focus()
    expect(document.activeElement).toBe(junk)
  })

  it('is disabled for a Microsoft Graph account, which offers no junk folder action', () => {
    accounts$.set([{ id: 'acct', email: 'me@example.com', auth_type: 'graph_oauth', graph_writes: true } as Account])
    const first = thread('INBOX', 'a')
    mail$.threads.set([first])
    const view = render(<BulkActionBar items={[item(first)]} />)

    const junk = view.getByRole('button', { name: 'Mark as junk' }) as HTMLButtonElement
    expect(junk.disabled).toBe(true)
    fireEvent.click(junk)
    expect(sent('mail.markJunk')).toEqual([])
  })

  it('follows the folder list as it loads', () => {
    mail$.foldersByAccount.set({})
    const junk = thread(JUNK, 'a')
    const view = render(<BulkActionBar items={[item(junk)]} />)
    expect(view.getByRole('button', { name: 'Mark as junk' })).toBeTruthy()

    act(() => mail$.foldersByAccount.set({ acct: structuredClone(FOLDERS) }))

    expect(view.getByRole('button', { name: 'Not junk' })).toBeTruthy()
  })

  it('does nothing when every selected conversation is already where it would go', async () => {
    const junk = thread(JUNK, 'a')
    mail$.threads.set([junk])

    await bulkMarkSelectedJunk([item(junk)], true)

    expect(sent('mail.markJunk')).toEqual([])
    expect(mail$.threads.get()).toHaveLength(1)
    expect(ui$.toast.get()).toBe('')
  })

  it('refuses a selection that touches a Graph account, before asking the core', async () => {
    accounts$.set([{ id: 'acct', email: 'me@example.com', auth_type: 'graph_oauth', graph_writes: true } as Account])
    const first = thread('INBOX', 'a')
    mail$.threads.set([first])

    await bulkMarkSelectedJunk([item(first)], true)

    expect(sent('mail.markJunk')).toEqual([])
    expect(mail$.threads.get()).toHaveLength(1)
  })

  it('sends one command per conversation, however many rows of it are selected', async () => {
    const first = thread('INBOX', 'a')
    const sameThread = { ...first, id: 'acct#INBOX#a-2' }
    mail$.threads.set([first, sameThread])

    await bulkMarkSelectedJunk([item(first), item(sameThread, { key: 'thread-list:other-row' })], true)

    expect(sent('mail.markJunk')).toEqual([{ thread_id: 'acct#INBOX#a', junk: true }])
  })

  it('without a source folder to go back to, says what happened but offers no undo', async () => {
    const first = thread('INBOX', 'a')
    mail$.threads.set([first])

    await bulkMarkSelectedJunk([item(first, { folderId: '' })], true)

    expect(ui$.toast.get()).toBe('Moved to junk')
    expect(ui$.toastUndo.peek()).toBeNull()
  })

  it('reports an undo that stops part way', async () => {
    const first = thread('INBOX', 'a')
    const second = thread('INBOX', 'b')
    mail$.threads.set([first, second])
    await bulkMarkSelectedJunk([item(first), item(second)], true)
    expect(ui$.toastUndo.peek()).toBeTruthy()
    let moves = 0
    ;(window as any).go.main.App.Invoke = async (command: string, payload: any) => {
      calls.push({ command, payload })
      if (command === 'mail.move') return { ok: true, moved: moves++ === 0 ? 1 : 0 }
      return {}
    }

    runToastUndo()

    await waitFor(() => expect(ui$.toastTone.get()).toBe('error'))
    expect(ui$.toast.get()).toBe('1 of 2 done, then stopped: Move failed: no matching messages found')
  })

  it('is not offered for feeds or drafts, which have no junk to file into', () => {
    const feed = thread('INBOX', 'f', { account_id: 'rss-1' })
    const draft = thread('Drafts', 'd')
    const view = render(<BulkActionBar items={[item(feed, { kind: 'feed' }), item(draft, { draft: true })]} />)

    expect(view.queryByRole('button', { name: 'Mark as junk' })).toBeNull()
    expect(view.queryByRole('button', { name: 'Not junk' })).toBeNull()
  })
})
