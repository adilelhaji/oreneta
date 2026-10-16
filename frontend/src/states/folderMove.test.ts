import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { accounts$ } from './accounts'
import { deleteFolder, loadFolders, mail$, moveFolder } from './mail'
import { folderPrefs$ } from './folderPrefs'
import { settings$ } from './settings'
import { settleConfirm, ui$ } from './ui'
import type { Account, Folder } from '../types'

const calls: Array<{ command: string; payload: any }> = []
let responses: Record<string, unknown> = {}
const folder = (id: string, role = 'folder'): Folder => ({
  id,
  account_id: 'acc',
  name: id,
  role,
  delimiter: '/',
  unread: 0,
})

// Shared observables outlive this file in the same test process; put back
// what was there so later files start where they expect to.
let saved: Record<string, unknown> = {}
beforeAll(() => {
  saved = {
    accounts: accounts$.peek(),
    folders: mail$.folders.peek(),
    byAccount: mail$.foldersByAccount.peek(),
    threads: mail$.threads.peek(),
    boards: settings$.kanbanBoards.peek(),
    account: ui$.selectedAccount.peek(),
    folder: ui$.selectedFolder.peek(),
    thread: ui$.selectedThread.peek(),
    go: (window as any).go,
  }
})
afterAll(() => {
  accounts$.set(saved.accounts as Account[])
  mail$.folders.set(saved.folders as Folder[])
  mail$.foldersByAccount.set(saved.byAccount as Record<string, Folder[]>)
  mail$.threads.set(saved.threads as never)
  settings$.kanbanBoards.set(saved.boards as never)
  ui$.selectedAccount.set(saved.account as string)
  ui$.selectedFolder.set(saved.folder as string)
  ui$.selectedThread.set(saved.thread as string)
  folderPrefs$.favorites.set([])
  folderPrefs$.colors.set([])
  ;(window as any).go = saved.go
})

beforeEach(() => {
  calls.length = 0
  responses = {
    'mail.folderMove': {
      ok: true,
      folder: 'Projects/Work',
      renames: [
        { from: 'Work', to: 'Projects/Work' },
        { from: 'Work/2026', to: 'Projects/Work/2026' },
      ],
      folders: [folder('INBOX', 'inbox'), folder('Projects'), folder('Projects/Work'), folder('Projects/Work/2026')],
    },
  }
  accounts$.set([
    { id: 'acc', email: 'a@x.test', display_name: 'A', provider: 'imap', auth_type: 'password' } as Account,
  ])
  const folders = [
    folder('INBOX', 'inbox'),
    folder('Sent', 'sent'),
    folder('Projects'),
    folder('Work'),
    folder('Work/2026'),
  ]
  mail$.folders.set(folders)
  mail$.foldersByAccount.set({ acc: folders })
  mail$.threads.set([])
  settings$.kanbanBoards.set([{ id: 'b1', name: 'Board', columns: [{ accountId: 'acc', folderId: 'Work/2026' }] }])
  folderPrefs$.favorites.set([
    { accountId: 'acc', folderId: 'Work/2026' },
    { accountId: 'acc', folderId: 'Projects' },
  ])
  folderPrefs$.colors.set([{ accountId: 'acc', folderId: 'Work', color: 'red' }])
  folderPrefs$.dropped.set(0)
  ui$.selectedAccount.set('acc')
  ui$.selectedFolder.set('Work/2026')
  ui$.selectedThread.set('')
  ui$.toast.set('')
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: unknown) => {
          calls.push({ command, payload })
          return responses[command] ?? {}
        },
      },
    },
  }
})

describe('moving a folder (ADR-0050)', () => {
  it('confirms with both names, then carries favorites, colors, columns and the view across', async () => {
    const pending = moveFolder('acc', 'Work', 'Projects')
    expect(ui$.confirm.get()?.message).toContain('“Work” into “Projects”')
    settleConfirm(true)
    expect(await pending).toBe(true)
    expect(calls.filter((call) => call.command === 'mail.folderMove')).toEqual([
      { command: 'mail.folderMove', payload: { account_id: 'acc', folder_id: 'Work', parent_id: 'Projects' } },
    ])
    expect(mail$.foldersByAccount.get().acc.map((item) => item.id)).toContain('Projects/Work/2026')
    expect(folderPrefs$.favorites.get()).toEqual([
      { accountId: 'acc', folderId: 'Projects/Work/2026' },
      { accountId: 'acc', folderId: 'Projects' },
    ])
    expect(folderPrefs$.colors.get()).toEqual([{ accountId: 'acc', folderId: 'Projects/Work', color: 'red' }])
    expect(folderPrefs$.dropped.get()).toBe(0)
    expect(settings$.kanbanBoards.get()[0].columns).toEqual([{ accountId: 'acc', folderId: 'Projects/Work/2026' }])
    expect(ui$.selectedFolder.get()).toBe('Projects/Work/2026')
    expect(ui$.toast.get()).toBe('Moved Work to Projects')
  })

  it('does nothing when the person cancels', async () => {
    const pending = moveFolder('acc', 'Work', 'Projects')
    settleConfirm(false)
    expect(await pending).toBe(false)
    expect(calls.some((call) => call.command === 'mail.folderMove')).toBe(false)
  })

  it('refuses special-use folders and moves into the own subtree without asking the core', async () => {
    expect(await moveFolder('acc', 'Sent', 'Projects')).toBe(false)
    expect(ui$.toast.get()).toContain('cannot be moved')
    expect(await moveFolder('acc', 'Work', 'Work/2026')).toBe(false)
    expect(ui$.toast.get()).toContain('itself')
    expect(ui$.confirm.get()).toBeNull()
    expect(calls).toEqual([])
  })

  it('reports a refusal from the core and changes nothing', async () => {
    ;(window as any).go.main.App.Invoke = async (command: string) => {
      if (command === 'mail.folderMove') throw new Error('RENAME Work Projects/Work: Mailbox exists')
      return {}
    }
    const pending = moveFolder('acc', 'Work', 'Projects')
    settleConfirm(true)
    expect(await pending).toBe(false)
    expect(ui$.toast.get()).toContain('Mailbox exists')
    expect(folderPrefs$.colors.get()[0].folderId).toBe('Work')
  })

  // ADR-0057: whatever the core answered, the tree is read again, so after a
  // move of unknown outcome it shows where the folder is.
  it('reads the folder list again after a refusal or an unknown outcome', async () => {
    const moved = [folder('INBOX', 'inbox'), folder('Projects'), folder('Projects/Work')]
    ;(window as any).go.main.App.Invoke = async (command: string, payload: unknown) => {
      calls.push({ command, payload })
      if (command === 'mail.folderMove') throw new Error('Microsoft Graph: no clear answer came back, so whether the folder moved is unknown')
      if (command === 'mail.folderList') return { folders: moved }
      return {}
    }
    const pending = moveFolder('acc', 'Work', 'Projects')
    settleConfirm(true)
    expect(await pending).toBe(false)
    expect(ui$.toast.get()).toContain('unknown')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.some((call) => call.command === 'mail.folderList')).toBe(true)
    expect(mail$.foldersByAccount.get().acc.map((item) => item.id)).toContain('Projects/Work')
  })

  it('says a folder already in place is already there, as news rather than a failure', async () => {
    expect(await moveFolder('acc', 'Work/2026', 'Work')).toBe(false)
    expect(ui$.toastTone.get()).toBe('info')
    expect(ui$.toast.get()).toBe('The folder is already there')
    expect(calls).toEqual([])
    expect(await moveFolder('acc', 'Sent', 'Projects')).toBe(false)
    expect(ui$.toastTone.get()).toBe('error')
  })

  it('deleting a folder drops its favorites and colors with it', async () => {
    responses['mail.folderDelete'] = {
      ok: true,
      removed: ['Work/2026', 'Work'],
      folders: [folder('INBOX', 'inbox'), folder('Projects')],
    }
    const pending = deleteFolder('acc', 'Work', 'Work', 1)
    settleConfirm(true)
    expect(await pending).toBe(true)
    expect(folderPrefs$.favorites.get()).toEqual([{ accountId: 'acc', folderId: 'Projects' }])
    expect(folderPrefs$.colors.get()).toEqual([])
  })
})

describe('folders renamed by a listing (ADR-0058)', () => {
  it('carries favorites, colors, columns, saved searches and the open folder to the new names', async () => {
    const searches = settings$.savedSearches.peek()
    settings$.savedSearches.set([
      { id: 's1', name: 'Invoices', query: 'invoice', account: 'acc', folder: 'Work/2026' },
      { id: 's2', name: 'Elsewhere', query: 'x', account: 'other', folder: 'Work/2026' },
    ] as never)
    responses['mail.folderList'] = {
      renames: [
        { from: 'Work', to: 'INBOX/Work' },
        { from: 'Work/2026', to: 'INBOX/Work/2026' },
      ],
      folders: [folder('INBOX', 'inbox'), folder('Projects'), folder('INBOX/Work'), folder('INBOX/Work/2026')],
    }
    await loadFolders('acc', false)
    expect(mail$.foldersByAccount.get().acc.map((item) => item.id)).toContain('INBOX/Work/2026')
    expect(folderPrefs$.favorites.get()).toEqual([
      { accountId: 'acc', folderId: 'INBOX/Work/2026' },
      { accountId: 'acc', folderId: 'Projects' },
    ])
    expect(folderPrefs$.colors.get()).toEqual([{ accountId: 'acc', folderId: 'INBOX/Work', color: 'red' }])
    expect(folderPrefs$.dropped.get()).toBe(0)
    expect(settings$.kanbanBoards.get()[0].columns).toEqual([{ accountId: 'acc', folderId: 'INBOX/Work/2026' }])
    expect(settings$.savedSearches.get().map((search) => search.folder)).toEqual(['INBOX/Work/2026', 'Work/2026'])
    expect(ui$.selectedFolder.get()).toBe('INBOX/Work/2026')
    settings$.savedSearches.set(searches)
  })

  it('changes nothing when the listing renamed nothing', async () => {
    responses['mail.folderList'] = { folders: [folder('INBOX', 'inbox'), folder('Work'), folder('Work/2026')] }
    await loadFolders('acc', false)
    expect(folderPrefs$.favorites.get()[0]).toEqual({ accountId: 'acc', folderId: 'Work/2026' })
    expect(ui$.selectedFolder.get()).toBe('Work/2026')
  })
})
