import { describe, expect, it } from 'bun:test'
import type { Folder } from '../types'
import { buildFolderTree, selectableFolderIds, type TreeNode } from './folderTree'

it('keeps opaque Graph IDs, duplicate labels and explicit parents independent', () => {
  const folders: Folder[] = [
    { id: 'graph.a', account_id: 'a', name: 'Same/name', role: '', unread: 0, parent_id: '' },
    { id: 'graph.b', account_id: 'a', name: 'Same/name', role: '', unread: 0, parent_id: 'graph.a' },
    { id: 'graph.c', account_id: 'a', name: 'Same/name', role: '', unread: 0, parent_id: '' },
  ]
  const tree = buildFolderTree(folders)
  expect(tree).toHaveLength(2)
  expect(tree[0].children[0].folder?.id).toBe('graph.b')
  expect(tree[0].name).toBe('Same/name')
  expect(buildFolderTree(folders.slice(1))).toHaveLength(2)
})

it('renders inconsistent cyclic Graph parents as roots without recursion', () => {
  const folders: Folder[] = ['a', 'b'].map((id) => ({
    id,
    account_id: 'a',
    name: id,
    role: '',
    unread: 0,
    parent_id: id === 'a' ? 'b' : 'a',
  }))
  expect(buildFolderTree(folders).map((node) => node.children)).toEqual([[], []])
})

const folder = (id: string): Folder => ({
  id,
  account_id: 'account',
  name: id,
  role: '',
  unread: 0,
  delimiter: '/',
})

describe('folder tree selection', () => {
  it('selects a real parent folder independently from its children', () => {
    const [parent] = buildFolderTree([folder('t2'), folder('t2/テスト'), folder('t2/t21')])

    expect(selectableFolderIds(parent)).toEqual(['t2'])
    expect(selectableFolderIds(parent.children[0])).toEqual(['t2/テスト'])
  })

  it('group-selects descendants when a path node is not a real folder', () => {
    const structural: TreeNode = {
      name: 't2',
      children: [
        { name: 'one', folder: folder('t2/one'), children: [] },
        { name: 'two', folder: folder('t2/two'), children: [] },
      ],
    }

    expect(selectableFolderIds(structural)).toEqual(['t2/one', 't2/two'])
  })
})
