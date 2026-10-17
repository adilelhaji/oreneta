// Hidden folders (#273): which folders the folder tree leaves out, and which
// folders may be hidden at all. Hiding is a local preference of the tree only
// (states/folderPrefs); nothing here talks to the core or a server, so a
// hidden folder keeps syncing and keeps answering searches and views that span
// several folders.

import type { Folder } from '../types'
import { buildFolderTree, type TreeNode } from './folderTree'
import { UNIFIED_ACCOUNT, unifiedFolderRole } from './unifiedFolders'
import type { FolderRef } from '../states/folderPrefs'

export type FolderHideBlock = 'inbox' | 'containsInbox' | 'parentHidden'

/** i18n key and English text for each refusal. */
export const FOLDER_HIDE_BLOCK_TEXT: Record<FolderHideBlock, { key: string; text: string }> = {
  inbox: { key: 'folders.hide.blocked.inbox', text: 'The inbox cannot be hidden' },
  containsInbox: {
    key: 'folders.hide.blocked.containsInbox',
    text: 'This folder holds the inbox and cannot be hidden',
  },
  parentHidden: {
    key: 'folders.hide.blocked.parentHidden',
    text: 'Hidden because the folder that holds it is hidden',
  },
}

/** The inbox, by role or by its IMAP name. */
export function isInbox(folder: Pick<Folder, 'id' | 'role'>): boolean {
  return folder.role === 'inbox' || folder.id.toLowerCase() === 'inbox'
}

function marked(folder: Folder, hidden: FolderRef[]): boolean {
  return hidden.some((ref) => ref.accountId === folder.account_id && ref.folderId === folder.id)
}

/** Every real folder of the tree, with whether a folder above it is in `hidden`. */
function walk(folders: Folder[], hidden: FolderRef[]): Array<{ folder: Folder; underHidden: boolean }> {
  const out: Array<{ folder: Folder; underHidden: boolean }> = []
  const step = (node: TreeNode, underHidden: boolean) => {
    if (node.folder) out.push({ folder: node.folder, underHidden })
    const hides = underHidden || (!!node.folder && marked(node.folder, hidden))
    for (const child of node.children) step(child, hides)
  }
  for (const root of buildFolderTree(folders)) step(root, false)
  return out
}

/**
 * Ids of the folders the tree leaves out: every folder hidden by the person
 * and everything under it, whether the hierarchy is a path (IMAP, local) or
 * parent links (Microsoft Graph, Exchange). The inbox is never left out, even
 * when an older or hand-edited preference says so.
 */
export function hiddenFolderIds(folders: Folder[], hidden: FolderRef[]): Set<string> {
  const ids = new Set<string>()
  if (!hidden.length) return ids
  for (const { folder, underHidden } of walk(folders, hidden)) {
    if (!isInbox(folder) && (underHidden || marked(folder, hidden))) ids.add(folder.id)
  }
  return ids
}

/** Why `folder` cannot be hidden, or null when it can. */
export function folderHideBlock(folder: Folder, folders: Folder[], hidden: FolderRef[]): FolderHideBlock | null {
  if (isInbox(folder)) return 'inbox'
  const self: FolderRef[] = [{ accountId: folder.account_id, folderId: folder.id }]
  if (walk(folders, self).some((item) => item.underHidden && isInbox(item.folder))) return 'containsInbox'
  const underHidden = walk(folders, hidden).some((item) => item.folder.id === folder.id && item.underHidden)
  return underHidden ? 'parentHidden' : null
}

export type SearchScopeKind = 'starred' | 'unified' | 'unifiedInbox' | 'folder' | 'hiddenFolder'

/** i18n key and English text saying where a search looks, and whether hidden folders are in it. */
export const SEARCH_SCOPE_TEXT: Record<SearchScopeKind, { key: string; text: string }> = {
  starred: {
    key: 'search.scope.starred',
    text: 'Searches starred messages in every folder of every account, hidden folders included.',
  },
  unified: {
    key: 'search.scope.unified',
    text: 'Searches “{folder}”: that folder in each account in view, even where it is hidden.',
  },
  // An inbox is never hidden, so there is nothing to say about hidden folders.
  unifiedInbox: { key: 'search.scope.unifiedInbox', text: 'Searches “{folder}”: the inbox of each account in view.' },
  folder: { key: 'search.scope.folder', text: 'Searches only “{folder}”. Hidden folders are not included.' },
  hiddenFolder: { key: 'search.scope.hiddenFolder', text: 'Searches only “{folder}”, a hidden folder.' },
}

/**
 * Where the search box looks (#273). A search runs in the open folder. A
 * unified folder is that role's folder in each account in view, and Starred
 * spans every folder; the core answers both and knows nothing of hidden
 * folders, so a hidden one is searched there.
 */
export function searchScopeKind(
  accountId: string,
  folderId: string,
  folders: Folder[],
  hidden: FolderRef[],
): SearchScopeKind {
  if (accountId === UNIFIED_ACCOUNT) {
    const role = unifiedFolderRole(folderId)
    return role === 'starred' ? 'starred' : role === 'inbox' ? 'unifiedInbox' : 'unified'
  }
  return hiddenFolderIds(folders, hidden).has(folderId) ? 'hiddenFolder' : 'folder'
}
