import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { BulkActionBar } from './BulkActionBar'
import { accounts$ } from '../../states/accounts'
import { kanban$ } from '../../states/kanban'
import { mail$ } from '../../states/mail'
import { clearBulkSelection, runToastUndo, ui$, type BulkSelectionItem } from '../../states/ui'
import type { Account, Message } from '../../types'

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

function stubBridge() {
  calls = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'mail.markJunk') return { ok: true, moved: 1, folder: payload.junk ? 'Junk' : 'INBOX' }
          if (command === 'mail.move') return { ok: true, moved: 1 }
          if (command === 'mail.threadList') return { threads: [] }
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
  accounts$.set([{ id: 'acct', email: 'me@example.com', auth_type: 'password', provider: 'imap' } as Account])
  mail$.foldersByAccount.set({
    acct: [
      { id: 'INBOX', name: 'Inbox', account_id: 'acct', role: 'inbox' },
      { id: 'Junk', name: 'Junk', account_id: 'acct', role: 'junk' },
    ] as any,
  })
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
      { thread_id: 'acct#Junk#a', target_folder_id: 'INBOX' },
      { thread_id: 'acct#Junk#b', target_folder_id: 'INBOX' },
    ])
    await waitFor(() => expect(ui$.toast.get()).toBe('2 threads moved'))
  })

  it('reads "Not junk" in the junk folder and takes the selection back out', async () => {
    const first = thread('Junk', 'a')
    const second = thread('Junk', 'b')
    mail$.threads.set([first, second])
    const view = render(<BulkActionBar items={[item(first), item(second)]} />)

    expect(view.queryByRole('button', { name: 'Mark as junk' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Not junk' }))

    await waitFor(() => expect(ui$.toast.get()).toBe('Moved back to the inbox'))
    expect(sent('mail.markJunk')).toEqual([
      { thread_id: 'acct#Junk#a', junk: false },
      { thread_id: 'acct#Junk#b', junk: false },
    ])
    expect(ui$.toastUndo.peek()).toBeTruthy()
  })

  it('in a mixed selection files the rest as junk and leaves the junk ones alone', async () => {
    const inbox = thread('INBOX', 'a')
    const junk = thread('Junk', 'b')
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
      if (command === 'mail.markJunk') return { ok: true, moved: markJunkCalls++ === 0 ? 1 : 0, folder: 'Junk' }
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

  it('is not offered for feeds or drafts, which have no junk to file into', () => {
    const feed = thread('INBOX', 'f', { account_id: 'rss-1' })
    const draft = thread('Drafts', 'd')
    const view = render(<BulkActionBar items={[item(feed, { kind: 'feed' }), item(draft, { draft: true })]} />)

    expect(view.queryByRole('button', { name: 'Mark as junk' })).toBeNull()
    expect(view.queryByRole('button', { name: 'Not junk' })).toBeNull()
  })
})
