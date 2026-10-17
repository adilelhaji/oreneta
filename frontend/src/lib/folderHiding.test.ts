import { describe, expect, it } from 'bun:test'
import { folderHideBlock, hiddenFolderIds, searchScopeKind } from './folderHiding'
import type { Folder } from '../types'

const folder = (id: string, extra: Partial<Folder> = {}): Folder => ({
  id,
  account_id: 'acc',
  name: id,
  role: 'folder',
  unread: 0,
  delimiter: '/',
  ...extra,
})

// IMAP and local folders: the hierarchy is the path.
const paths: Folder[] = [
  folder('INBOX', { role: 'inbox' }),
  folder('INBOX/Lists'),
  folder('Sent', { role: 'sent' }),
  folder('Work'),
  folder('Work/2026'),
  folder('Work/2026/Q1'),
  folder('Workshop'),
]

// Microsoft Graph and Exchange folders: opaque ids linked by parent.
const linked: Folder[] = [
  folder('id-inbox', { name: 'Inbox', role: 'inbox', parent_id: '' }),
  folder('id-work', { name: 'Work', parent_id: '' }),
  folder('id-2026', { name: '2026', parent_id: 'id-work' }),
  folder('id-other', { name: 'Other', parent_id: '' }),
]

const ref = (folderId: string, accountId = 'acc') => ({ accountId, folderId })

describe('hidden folders in the tree (#273)', () => {
  it('leaves out a hidden folder and everything under it, by path', () => {
    expect([...hiddenFolderIds(paths, [ref('Work/2026')])].sort()).toEqual(['Work/2026', 'Work/2026/Q1'])
    // A sibling whose name only starts the same way is not under it.
    expect([...hiddenFolderIds(paths, [ref('Work')])].sort()).toEqual(['Work', 'Work/2026', 'Work/2026/Q1'])
    expect(hiddenFolderIds(paths, [])).toEqual(new Set())
  })

  it('does not guess a hierarchy where the server reports none (NIL delimiter)', () => {
    const flat = [
      folder('INBOX', { role: 'inbox', delimiter: undefined }),
      folder('Work', { delimiter: undefined }),
      folder('Work/Reports', { delimiter: '' }),
    ]
    expect([...hiddenFolderIds(flat, [ref('Work')])]).toEqual(['Work'])
    expect(folderHideBlock(flat[2], flat, [ref('Work')])).toBeNull()
  })

  it('leaves out a hidden folder and everything under it, by parent link', () => {
    expect([...hiddenFolderIds(linked, [ref('id-work')])].sort()).toEqual(['id-2026', 'id-work'])
  })

  it('only counts marks of the same account and never leaves out the inbox', () => {
    expect(hiddenFolderIds(paths, [ref('Work', 'other')])).toEqual(new Set())
    // An older or hand-edited preference cannot take the inbox away.
    expect([...hiddenFolderIds(paths, [ref('INBOX')])]).toEqual(['INBOX/Lists'])
    // Nor when a hand-edited mark sits on a folder that holds it.
    const holder = [folder('Mail'), folder('Mail/INBOX', { role: 'inbox' }), folder('Mail/Old')]
    expect([...hiddenFolderIds(holder, [ref('Mail')])].sort()).toEqual(['Mail', 'Mail/Old'])
  })

  it('refuses to hide the inbox, a folder holding it, or one already hidden with its parent', () => {
    expect(folderHideBlock(paths[0], paths, [])).toBe('inbox')
    expect(folderHideBlock(linked[0], linked, [])).toBe('inbox')
    const holder = [folder('Mail'), folder('Mail/INBOX', { role: 'inbox' })]
    expect(folderHideBlock(holder[0], holder, [])).toBe('containsInbox')
    expect(folderHideBlock(paths[4], paths, [ref('Work')])).toBe('parentHidden')
    expect(folderHideBlock(linked[2], linked, [ref('id-work')])).toBe('parentHidden')
    expect(folderHideBlock(paths[3], paths, [])).toBeNull()
    expect(folderHideBlock(paths[1], paths, [])).toBeNull()
    expect(folderHideBlock(paths[2], paths, [])).toBeNull()
  })
})

describe('search scope and hidden folders (#273)', () => {
  it('says hidden folders are in a search that spans folders, and out of one that does not', () => {
    expect(searchScopeKind('unified', 'starred', [], [])).toBe('starred')
    expect(searchScopeKind('unified', 'sent', [], [])).toBe('unified')
    expect(searchScopeKind('unified', 'inbox', [], [])).toBe('unifiedInbox')
    // A bare or unknown selection is the unified inbox, as the list loads it.
    expect(searchScopeKind('unified', '', [], [])).toBe('unifiedInbox')
    expect(searchScopeKind('acc', 'Work', paths, [])).toBe('folder')
    expect(searchScopeKind('acc', 'Work/2026', paths, [ref('Work')])).toBe('hiddenFolder')
    expect(searchScopeKind('acc', 'Sent', paths, [ref('Work')])).toBe('folder')
  })
})
