import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { waitFor } from '@testing-library/react'
import { accounts$ } from './accounts'
import { kanban$ } from './kanban'
import { bulkMarkSelectedJunk, mail$, markThreadJunk } from './mail'
import type { SpamJudgmentChange } from './spam'
import { clearBulkSelection, runToastUndo, ui$, type BulkSelectionItem } from './ui'
import type { Account, Message } from '../types'

// Undoing "Mark as junk" or "Not junk" also takes back what the change taught
// the learned spam filter (#254): `mail.markJunk` answers the judgment change
// it recorded, and the undo hands it to `mail.revertSpamJudgment` before it
// moves the conversation back. A move back that fails puts the learning back
// as the mark left it, so no conversation is half undone.

const JUNK = 'INBOX.Pourriel'
const FOLDERS = [
  { id: 'INBOX', name: 'Inbox', account_id: 'acct', role: 'inbox' },
  { id: JUNK, name: 'Pourriel', account_id: 'acct', role: 'junk' },
] as any[]

const thread = (folder: string, key: string): Message =>
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
  }) as Message

const item = (message: Message): BulkSelectionItem => ({
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
})

/** The change the core answers for marking conversation `key`. */
const judgment = (key: string, spam: boolean): SpamJudgmentChange => ({
  account: 'acct',
  message_id: key.charCodeAt(0),
  before: null,
  after: { spam, from_addr: 'sender@example.com', subject: `Subject ${key}` },
})

const inverse = (change: SpamJudgmentChange): SpamJudgmentChange => ({
  ...change,
  before: change.after,
  after: change.before,
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
/** How the stubbed core answers: per test. */
let core: {
  judged: boolean
  superseded: boolean
  revertFails: boolean
  failMovesOf: Set<string>
}

function stubBridge() {
  calls = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'mail.markJunk') {
            const [, source, key] = payload.thread_id.split('#')
            return {
              ok: true,
              moved: 1,
              source_folder: source,
              target_folder: payload.junk ? JUNK : 'INBOX',
              ...(core.judged ? { spam_judgment: judgment(key, payload.junk) } : {}),
            }
          }
          if (command === 'mail.revertSpamJudgment') {
            if (core.revertFails) throw new Error('database is locked')
            if (core.superseded) return { ok: true, reverted: false, judgment: null }
            return { ok: true, reverted: true, judgment: inverse(payload.judgment) }
          }
          if (command === 'mail.move') {
            const [, , key] = payload.thread_id.split('#')
            return { ok: true, moved: core.failMovesOf.has(key) ? 0 : 1 }
          }
          if (command === 'mail.threadList') return { threads: [] }
          if (command === 'mail.folderList') return { folders: FOLDERS }
          return {}
        },
      },
    },
  }
}

/** The undo's own commands, in the order the core received them. */
const undoCalls = () =>
  calls
    .filter((call) => call.command === 'mail.revertSpamJudgment' || call.command === 'mail.move')
    .map((call) => [call.command, call.command === 'mail.move' ? call.payload.thread_id : call.payload.judgment])

beforeEach(() => {
  previousGo = (window as any).go
  previousAccounts = accounts$.peek()
  previousState = {
    selectedAccount: ui$.selectedAccount.peek(),
    selectedFolder: ui$.selectedFolder.peek(),
    foldersByAccount: mail$.foldersByAccount.peek(),
    folders: mail$.folders.peek(),
  }
  core = { judged: true, superseded: false, revertFails: false, failMovesOf: new Set() }
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
  clearBulkSelection()
  mail$.threads.set([])
  accounts$.set(previousAccounts)
  ui$.selectedAccount.set(previousState.selectedAccount)
  ui$.selectedFolder.set(previousState.selectedFolder)
  mail$.foldersByAccount.set(previousState.foldersByAccount)
  mail$.folders.set(previousState.folders)
  // Pending toast timers compare the text: a cleared toast cannot cut short
  // the next test's.
  ui$.toast.set('')
  ui$.toastUndo.set(null)
  ;(window as any).go = previousGo
})

describe('undoing a junk change takes back its spam learning (#254)', () => {
  it('reverts what "Mark as junk" taught before moving the conversation back', async () => {
    mail$.threads.set([thread('INBOX', 'a')])
    await markThreadJunk('acct#INBOX#a', true)
    expect(ui$.toastUndo.peek()).toBeTruthy()

    runToastUndo()

    await waitFor(() => expect(undoCalls()).toHaveLength(2))
    expect(undoCalls()).toEqual([
      ['mail.revertSpamJudgment', judgment('a', true)],
      ['mail.move', `acct#${JUNK}#a`],
    ])
  })

  it('reverts what "Not junk" taught in the same way', async () => {
    mail$.threads.set([thread(JUNK, 'a')])
    await markThreadJunk(`acct#${JUNK}#a`, false)

    runToastUndo()

    await waitFor(() => expect(undoCalls()).toHaveLength(2))
    expect(undoCalls()).toEqual([
      ['mail.revertSpamJudgment', judgment('a', false)],
      ['mail.move', 'acct#INBOX#a'],
    ])
    expect(calls.find((call) => call.command === 'mail.move')?.payload.target_folder_id).toBe(JUNK)
  })

  it('keeps a later judgment the core says replaced it, and still moves the conversation back', async () => {
    core.superseded = true
    mail$.threads.set([thread('INBOX', 'a')])
    await markThreadJunk('acct#INBOX#a', true)

    runToastUndo()

    await waitFor(() => expect(ui$.toast.get()).toBe('Thread moved'))
    expect(undoCalls()).toEqual([
      ['mail.revertSpamJudgment', judgment('a', true)],
      ['mail.move', `acct#${JUNK}#a`],
    ])
  })

  it('puts the learning back when the move back fails, so nothing is half undone', async () => {
    core.failMovesOf.add('a')
    mail$.threads.set([thread('INBOX', 'a')])
    await markThreadJunk('acct#INBOX#a', true)

    runToastUndo()

    await waitFor(() => expect(undoCalls()).toHaveLength(3))
    expect(undoCalls()).toEqual([
      ['mail.revertSpamJudgment', judgment('a', true)],
      ['mail.move', `acct#${JUNK}#a`],
      ['mail.revertSpamJudgment', inverse(judgment('a', true))],
    ])
    expect(ui$.toastTone.get()).toBe('error')
  })

  it('moves nothing when the learning cannot be taken back, and says so', async () => {
    core.revertFails = true
    mail$.threads.set([thread('INBOX', 'a')])
    await markThreadJunk('acct#INBOX#a', true)

    runToastUndo()

    await waitFor(() => expect(ui$.toastTone.get()).toBe('error'))
    expect(ui$.toast.get()).toBe('database is locked')
    expect(undoCalls()).toEqual([['mail.revertSpamJudgment', judgment('a', true)]])
  })

  it('only moves the conversation back when the mark taught nothing', async () => {
    core.judged = false
    mail$.threads.set([thread('INBOX', 'a')])
    await markThreadJunk('acct#INBOX#a', true)

    runToastUndo()

    await waitFor(() => expect(undoCalls()).toHaveLength(1))
    expect(undoCalls()).toEqual([['mail.move', `acct#${JUNK}#a`]])
  })

  it('in a bulk undo reverts each conversation’s learning, then moves it back, in turn', async () => {
    const first = thread('INBOX', 'a')
    const second = thread('INBOX', 'b')
    mail$.threads.set([first, second])
    await bulkMarkSelectedJunk([item(first), item(second)], true)

    runToastUndo()

    await waitFor(() => expect(ui$.toast.get()).toBe('2 threads moved'))
    expect(undoCalls()).toEqual([
      ['mail.revertSpamJudgment', judgment('a', true)],
      ['mail.move', `acct#${JUNK}#a`],
      ['mail.revertSpamJudgment', judgment('b', true)],
      ['mail.move', `acct#${JUNK}#b`],
    ])
  })

  it('in a bulk undo that stops part way keeps only what it moved back reverted', async () => {
    core.failMovesOf.add('b')
    const first = thread('INBOX', 'a')
    const second = thread('INBOX', 'b')
    const third = thread('INBOX', 'c')
    mail$.threads.set([first, second, third])
    await bulkMarkSelectedJunk([item(first), item(second), item(third)], true)

    runToastUndo()

    await waitFor(() => expect(ui$.toastTone.get()).toBe('error'))
    expect(ui$.toast.get()).toBe('1 of 3 done, then stopped: Move failed: no matching messages found')
    // The first is undone whole; the second is left as the mark left it,
    // learning included; the third is not touched.
    expect(undoCalls()).toEqual([
      ['mail.revertSpamJudgment', judgment('a', true)],
      ['mail.move', `acct#${JUNK}#a`],
      ['mail.revertSpamJudgment', judgment('b', true)],
      ['mail.move', `acct#${JUNK}#b`],
      ['mail.revertSpamJudgment', inverse(judgment('b', true))],
    ])
  })

  it('in a bulk undo stops before moving a conversation whose learning cannot be taken back', async () => {
    const first = thread('INBOX', 'a')
    mail$.threads.set([first])
    await bulkMarkSelectedJunk([item(first)], true)
    core.revertFails = true

    runToastUndo()

    await waitFor(() => expect(ui$.toastTone.get()).toBe('error'))
    expect(ui$.toast.get()).toBe('database is locked')
    expect(undoCalls()).toEqual([['mail.revertSpamJudgment', judgment('a', true)]])
  })
})
