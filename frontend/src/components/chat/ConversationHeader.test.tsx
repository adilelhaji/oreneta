import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createRef } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ConversationHeader } from './ConversationHeader'
import { accounts$ } from '../../states/accounts'
import { kanban$ } from '../../states/kanban'
import { mail$ } from '../../states/mail'
import { thread$ } from '../../states/thread'
import { runToastUndo, ui$ } from '../../states/ui'
import type { Account, Message } from '../../types'

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

beforeEach(() => {
  previousGo = (window as any).go
  previousAccounts = accounts$.peek()
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
    await waitFor(() => expect(sent('mail.move')).toEqual([{ thread_id: 'acct#Junk#k1', target_folder_id: 'INBOX' }]))
  })

  it('reads "Not junk" in the junk folder and takes the conversation back out', async () => {
    const view = renderHeader(conversation('Junk'))

    expect(view.queryByRole('button', { name: 'Mark as junk' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Not junk' }))

    await waitFor(() => expect(ui$.toast.get()).toBe('Moved back to the inbox'))
    expect(sent('mail.markJunk')).toEqual([{ thread_id: 'acct#Junk#k1', junk: false }])
    expect(ui$.toastUndo.peek()).toBeTruthy()
  })

  it('stays reachable from the actions menu when the header is too narrow for the button', async () => {
    const view = renderHeader(conversation('INBOX'))

    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    // The header button and the menu entry, both with the same label.
    const entries = view.getAllByRole('button', { name: 'Mark as junk' })
    expect(entries).toHaveLength(2)
    fireEvent.click(entries[1])

    await waitFor(() => expect(sent('mail.markJunk')).toEqual([{ thread_id: 'acct#INBOX#k1', junk: true }]))
    // The menu closes behind the action, leaving only the header button.
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

  it('is not offered for a feed item', () => {
    const view = renderHeader(conversation('INBOX', { account_id: 'rss-1', thread_id: 'rss-1#feed#k1' }), true)

    expect(view.queryByRole('button', { name: 'Mark as junk' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'More actions' }))
    expect(view.queryByRole('button', { name: 'Mark as junk' })).toBeNull()
  })
})
