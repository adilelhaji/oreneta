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
    expect(folderMovesSupported(ews)).toBe(false)
    expect(folderMovesSupported({ ...account, auth_type: 'local_archive' } as Account)).toBe(true)
    // A Graph account without changes is told what would allow it (#210).
    expect(folderMoveBlock(find('Work'), find('Projects/Work'), folders, graph)).toBe('needsChanges')
    expect(folderMoveBlock(find('Work'), find('Projects/Work'), folders, ews)).toBe('unsupported')
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

// Microsoft Graph (#210): opaque ids linked by parent, the root as ''.
describe('Graph folder move rules (ADR-0057)', () => {
  const graph = { id: 'acc', provider: 'outlook', auth_type: 'graph_oauth', graph_writes: true } as Account
  const g = (id: string, name: string, parent_id: string, role = 'folder'): Folder => ({
    id,
    account_id: 'acc',
    name,
    role,
    parent_id,
    unread: 0,
  })
  const tree = [
    g('INBOX', 'Inbox', '', 'inbox'),
    g('graph.work', 'Work', ''),
    g('graph.w26', '2026', 'graph.work'),
    g('graph.q1', 'Q1', 'graph.w26'),
    g('graph.projects', 'Projects', ''),
    g('graph.p26', '2026', 'graph.projects'),
    g('graph.holder', 'Holder', ''),
    g('graph.sent', 'Sent Items', 'graph.holder', 'sent'),
  ]
  const at = (id: string) => tree.find((folder) => folder.id === id)!

  it('is available once the account allows changes, and says so before', () => {
    expect(folderMovesSupported(graph)).toBe(true)
    const readOnly = { ...graph, graph_writes: false } as Account
    expect(folderMoveBlock(at('graph.work'), at('graph.projects'), tree, readOnly)).toBe('needsChanges')
    expect(folderMoveBlock(at('graph.work'), at('graph.projects'), tree, graph)).toBeNull()
    expect(folderMoveBlock(at('graph.w26'), null, tree, graph)).toBeNull()
  })

  it('walks the tree by parent, not by the shape of the id', () => {
    expect(parentFolderId(at('graph.w26'), tree)).toBe('graph.work')
    expect(parentFolderId(at('graph.work'), tree)).toBeNull()
    expect(folderMoveBlock(at('graph.work'), at('graph.q1'), tree, graph)).toBe('self')
    expect(folderMoveBlock(at('graph.holder'), at('graph.work'), tree, graph)).toBe('containsSpecial')
    expect(folderMoveBlock(at('graph.sent'), at('graph.work'), tree, graph)).toBe('special')
    expect(folderMoveBlock(at('graph.w26'), at('graph.work'), tree, graph)).toBe('sameParent')
    expect(folderMoveBlock(at('graph.work'), null, tree, graph)).toBe('sameParent')
  })

  it('refuses a folder beside one of the same name, whatever the case', () => {
    expect(folderMoveBlock(at('graph.w26'), at('graph.projects'), tree, graph)).toBe('exists')
    const renamed = tree.map((folder) => (folder.id === 'graph.p26' ? { ...folder, name: '2026 old' } : folder))
    expect(folderMoveBlock(at('graph.w26'), at('graph.projects'), renamed, graph)).toBeNull()
    const upper = [...tree, g('graph.top', 'WORK', 'graph.projects')]
    expect(folderMoveBlock(at('graph.work'), at('graph.projects'), upper, graph)).toBe('exists')
    expect(folderMoveTargets(at('graph.w26'), tree, graph).map((folder) => folder.id)).toEqual([
      'INBOX',
      'graph.p26',
      'graph.holder',
      'graph.sent',
    ])
  })
})
