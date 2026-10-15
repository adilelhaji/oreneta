// Folder moves (ADR-0050, ADR-0057): which folder may go where, decided before
// anything is asked of the core. The core re-checks the same rules on its own
// cached folder list; these exist so the navigation can refuse a drop, disable
// a menu row and explain why without a round trip. IMAP and local folders are
// paths split by a delimiter; Microsoft Graph folders are opaque ids linked by
// `parent_id`, so their tree is walked by parent instead.

import type { Account, Folder } from '../types'
import { pickDelimiter } from './folderTree'

export type FolderMoveBlock =
  | 'unsupported'
  | 'needsChanges'
  | 'special'
  | 'containsSpecial'
  | 'self'
  | 'sameParent'
  | 'exists'
  | 'otherAccount'

/** i18n key and English text for each refusal. */
export const FOLDER_MOVE_BLOCK_TEXT: Record<FolderMoveBlock, { key: string; text: string }> = {
  unsupported: {
    key: 'folders.move.blocked.unsupported',
    text: 'Moving folders is not available for this account yet',
  },
  needsChanges: {
    key: 'folders.move.blocked.needsChanges',
    text: 'Allow changes for this account in its settings to move its folders',
  },
  special: {
    key: 'folders.move.blocked.special',
    text: 'Inbox, Sent, Drafts, Trash, Junk and Archive cannot be moved',
  },
  containsSpecial: {
    key: 'folders.move.blocked.containsSpecial',
    text: 'This folder holds a special folder and cannot be moved',
  },
  self: { key: 'folders.move.blocked.self', text: 'A folder cannot go into itself or one of its subfolders' },
  sameParent: { key: 'folders.move.blocked.sameParent', text: 'The folder is already there' },
  exists: { key: 'folders.move.blocked.exists', text: 'A folder with this name is already there' },
  otherAccount: {
    key: 'folders.move.blocked.otherAccount',
    text: 'Folders can only be moved within their own account',
  },
}

/**
 * Whether this account's folders can be moved here at all. IMAP and the local
 * stores (archive, POP3) can; Microsoft Graph can once the account allows
 * changes (#210); Exchange (EWS) does not manage folders in the core yet, and
 * RSS and the unified view have no folders.
 */
export function folderMovesSupported(account: Account | undefined): boolean {
  if (!account) return false
  if (account.auth_type === 'graph_oauth') return account.graph_writes === true
  if (account.auth_type === 'rss' || account.provider === 'rss') return false
  if (account.provider === 'exchange' || !!account.ews_url) return false
  return true
}

function unsupportedBlock(account: Account | undefined): FolderMoveBlock {
  return account?.auth_type === 'graph_oauth' ? 'needsChanges' : 'unsupported'
}

/** Graph folders say who their parent is; path folders do not. */
function linkedByParent(folders: Folder[]): boolean {
  return folders.some((folder) => folder.parent_id !== undefined)
}

export function isSpecialFolder(folder: Pick<Folder, 'role'>): boolean {
  return !!folder.role && folder.role !== 'folder'
}

export function folderDelimiter(folder: Folder, folders: Folder[]): string {
  return folder.delimiter || pickDelimiter(folders)
}

/** Whether `id` sits somewhere under `ancestor`. */
function inside(id: string, ancestor: string, delimiter: string, folders: Folder[]): boolean {
  if (!linkedByParent(folders)) return id.startsWith(`${ancestor}${delimiter}`)
  const seen = new Set<string>()
  let parent = folders.find((folder) => folder.id === id)?.parent_id
  while (parent && !seen.has(parent)) {
    if (parent === ancestor) return true
    seen.add(parent)
    const above = parent
    parent = folders.find((folder) => folder.id === above)?.parent_id
  }
  return false
}

/** The folder's parent (its path, or its Graph parent), or null at the top level. */
export function parentFolderId(folder: Folder, folders: Folder[]): string | null {
  if (folder.parent_id !== undefined) return folder.parent_id || null
  const delimiter = folderDelimiter(folder, folders)
  const at = folder.id.lastIndexOf(delimiter)
  return at > 0 ? folder.id.slice(0, at) : null
}

/** Why `source` cannot go under `target` (null: the top level), or null when it can. */
export function folderMoveBlock(
  source: Folder | undefined,
  target: Folder | null,
  folders: Folder[],
  account: Account | undefined,
): FolderMoveBlock | null {
  if (!source) return 'unsupported'
  if (!folderMovesSupported(account)) return unsupportedBlock(account)
  if (target && target.account_id !== source.account_id) return 'otherAccount'
  if (isSpecialFolder(source)) return 'special'
  const delimiter = folderDelimiter(source, folders)
  if (folders.some((folder) => inside(folder.id, source.id, delimiter, folders) && isSpecialFolder(folder))) {
    return 'containsSpecial'
  }
  if (target && (target.id === source.id || inside(target.id, source.id, delimiter, folders))) return 'self'
  const parent = parentFolderId(source, folders)
  if ((target?.id ?? null) === parent) return 'sameParent'
  if (linkedByParent(folders)) {
    // Graph refuses two folders of one name side by side, whatever the case.
    const name = source.name.toLocaleLowerCase()
    const beside = (folder: Folder) => (folder.parent_id || null) === (target?.id ?? null)
    const clash = folders.some(
      (folder) => folder.id !== source.id && beside(folder) && folder.name.toLocaleLowerCase() === name,
    )
    return clash ? 'exists' : null
  }
  const leaf = source.id.slice(source.id.lastIndexOf(delimiter) + 1)
  const destination = target ? `${target.id}${delimiter}${leaf}` : leaf
  if (folders.some((folder) => folder.id === destination)) return 'exists'
  return null
}

/** Whether a folder can be moved anywhere, ignoring where (for menu rows). */
export function folderMoveSourceBlock(
  source: Folder | undefined,
  folders: Folder[],
  account: Account | undefined,
): FolderMoveBlock | null {
  const block = folderMoveBlock(source, null, folders, account)
  return block === 'sameParent' || block === 'exists' ? null : block
}

/** Destinations the picker offers: every folder the source may go into. */
export function folderMoveTargets(source: Folder, folders: Folder[], account: Account | undefined): Folder[] {
  return folders.filter((folder) => !folderMoveBlock(source, folder, folders, account))
}
