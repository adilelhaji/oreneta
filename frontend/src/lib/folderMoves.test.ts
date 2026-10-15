import { describe, expect, it } from 'bun:test'
import {
  folderMoveBlock,
  folderMoveSourceBlock,
  folderMoveTargets,
  folderMovesSupported,
  parentFolderId,
} from './folderMoves'
import type { Account, Folder } from '../types'

const account = { id: 'acc', provider: 'imap', auth_type: 'password' } as Account
const f = (id: string, role = 'folder', account_id = 'acc'): Folder => ({
  id,
  account_id,
  name: id,
  role,
  delimiter: '/',
  unread: 0,
})
const folders = [
  f('INBOX', 'inbox'),
  f('Sent', 'sent'),
  f('Drafts', 'drafts'),
  f('Trash', 'trash'),
  f('Junk', 'junk'),
  f('Archive', 'archive'),
  f('Work'),
  f('Work/2026'),
  f('Projects'),
  f('Projects/Work'),
  f('Mail'),
  f('Mail/Archive', 'archive'),
]
const find = (id: string) => folders.find((folder) => folder.id === id)!

describe('folder move rules (ADR-0050)', () => {
  it('refuses every special-use folder as the one moved', () => {
    for (const id of ['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive']) {
      expect(folderMoveBlock(find(id), find('Work'), folders, account)).toBe('special')
    }
    expect(folderMoveBlock(find('Mail'), find('Work'), folders, account)).toBe('containsSpecial')
  })

  it('refuses a move into the folder itself or its own subtree', () => {
    expect(folderMoveBlock(find('Work'), find('Work'), folders, account)).toBe('self')
    expect(folderMoveBlock(find('Work'), find('Work/2026'), folders, account)).toBe('self')
  })

  it('refuses no-ops, name clashes, other accounts and accounts without folder moves', () => {
    expect(folderMoveBlock(find('Work/2026'), find('Work'), folders, account)).toBe('sameParent')
    expect(folderMoveBlock(find('Work'), null, folders, account)).toBe('sameParent')
    expect(folderMoveBlock(find('Work'), find('Projects'), folders, account)).toBe('exists')
    expect(folderMoveBlock(find('Work'), f('Elsewhere', 'folder', 'other'), folders, account)).toBe('otherAccount')
    const graph = { ...account, auth_type: 'graph_oauth' } as Account
    const ews = { ...account, provider: 'exchange', ews_url: 'https://ews.test/EWS/Exchange.asmx' } as Account
    expect(folderMovesSupported(graph)).toBe(false)
    // Exchange moves folders since ADR-0058.
    expect(folderMovesSupported(ews)).toBe(true)
    expect(folderMoveBlock(find('Work/2026'), find('Projects'), folders, ews)).toBeNull()
    expect(folderMovesSupported({ ...account, auth_type: 'local_archive' } as Account)).toBe(true)
    expect(folderMoveBlock(find('Work'), find('Projects/Work'), folders, graph)).toBe('unsupported')
  })

  it('allows an ordinary folder into another folder, a special one or the top level', () => {
    expect(folderMoveBlock(find('Work/2026'), find('Projects'), folders, account)).toBeNull()
    expect(folderMoveBlock(find('Work/2026'), null, folders, account)).toBeNull()
    expect(folderMoveBlock(find('Work'), find('INBOX'), folders, account)).toBeNull()
    expect(folderMoveSourceBlock(find('Work'), folders, account)).toBeNull()
    expect(folderMoveSourceBlock(find('Sent'), folders, account)).toBe('special')
    expect(parentFolderId(find('Work/2026'), folders)).toBe('Work')
    expect(parentFolderId(find('Work'), folders)).toBeNull()
    expect(folderMoveTargets(find('Work'), folders, account).map((folder) => folder.id)).toEqual([
      'INBOX',
      'Sent',
      'Drafts',
      'Trash',
      'Junk',
      'Archive',
      'Projects/Work',
      'Mail',
      'Mail/Archive',
    ])
  })
})
