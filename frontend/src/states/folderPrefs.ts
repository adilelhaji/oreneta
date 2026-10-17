// Folder favorites, colors (ADR-0050, ledger SET-07) and hidden folders (#273):
// local preferences only, never written to a server. All three are keyed by
// account id + folder id
// (the folder's full path on its server), so they work the same for IMAP,
// Exchange, Graph and the local archive. A move reported by the core carries
// them to the folder's new path; a folder or account that goes away takes its
// entries with it; an entry whose folder has vanished some other way is
// dropped with a visible note.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { isFolderColorId, type FolderColorId } from '../lib/folderColors'

export type FolderRef = { accountId: string; folderId: string }
export type FolderColorEntry = FolderRef & { color: FolderColorId }
export type FolderRename = { from: string; to: string }

export const FOLDER_FAVORITES_KEY = 'folder_favorites'
export const FOLDER_COLORS_KEY = 'folder_colors'
export const FOLDER_HIDDEN_KEY = 'folder_hidden'
export const FOLDER_PREF_KEYS = [FOLDER_FAVORITES_KEY, FOLDER_COLORS_KEY, FOLDER_HIDDEN_KEY]

export const folderPrefs$ = observable({
  /** Favorite folders, in the order the person arranged them. */
  favorites: [] as FolderRef[],
  colors: [] as FolderColorEntry[],
  /**
   * Folders hidden from the folder tree (#273). Only the tree reads this:
   * the core never learns of it, so a hidden folder keeps syncing.
   */
  hidden: [] as FolderRef[],
  /** How many stale favorites were last dropped, for the visible note. */
  dropped: 0,
})

function same(a: FolderRef, b: FolderRef): boolean {
  return a.accountId === b.accountId && a.folderId === b.folderId
}

function safeParse(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function isRef(value: unknown): value is FolderRef {
  const ref = value as FolderRef | null
  return (
    !!ref && typeof ref.accountId === 'string' && !!ref.accountId && typeof ref.folderId === 'string' && !!ref.folderId
  )
}

function unique<T extends FolderRef>(list: T[]): T[] {
  const out: T[] = []
  for (const item of list) if (!out.some((seen) => same(seen, item))) out.push(item)
  return out
}

/** A saved list of folder references (favorites, hidden folders); malformed entries are left out. */
export function parseFolderRefs(value: unknown): FolderRef[] {
  const list = safeParse(value)
  if (!Array.isArray(list)) return []
  return unique(list.filter(isRef).map(({ accountId, folderId }) => ({ accountId, folderId })))
}

export const parseFavorites = parseFolderRefs

export function parseColors(value: unknown): FolderColorEntry[] {
  const list = safeParse(value)
  if (!Array.isArray(list)) return []
  return unique(
    list
      .filter((item): item is FolderColorEntry => isRef(item) && isFolderColorId((item as FolderColorEntry).color))
      .map(({ accountId, folderId, color }) => ({ accountId, folderId, color })),
  )
}

export function hydrateFolderPrefs(prefs: Record<string, unknown>) {
  folderPrefs$.favorites.set(parseFavorites(prefs[FOLDER_FAVORITES_KEY]))
  folderPrefs$.colors.set(parseColors(prefs[FOLDER_COLORS_KEY]))
  folderPrefs$.hidden.set(parseFolderRefs(prefs[FOLDER_HIDDEN_KEY]))
}

function persistFavorites() {
  void invoke('app.prefsSet', { key: FOLDER_FAVORITES_KEY, value: folderPrefs$.favorites.peek() }).catch(() => {})
}

function persistColors() {
  void invoke('app.prefsSet', { key: FOLDER_COLORS_KEY, value: folderPrefs$.colors.peek() }).catch(() => {})
}

function persistHidden() {
  void invoke('app.prefsSet', { key: FOLDER_HIDDEN_KEY, value: folderPrefs$.hidden.peek() }).catch(() => {})
}

export function isFavorite(ref: FolderRef): boolean {
  return folderPrefs$.favorites.get().some((item) => same(item, ref))
}

export function addFavorite(ref: FolderRef) {
  if (!isRef(ref) || folderPrefs$.favorites.peek().some((item) => same(item, ref))) return
  folderPrefs$.favorites.set([...folderPrefs$.favorites.peek(), { accountId: ref.accountId, folderId: ref.folderId }])
  persistFavorites()
}

export function removeFavorite(ref: FolderRef) {
  const favorites = folderPrefs$.favorites.peek()
  if (!favorites.some((item) => same(item, ref))) return
  folderPrefs$.favorites.set(favorites.filter((item) => !same(item, ref)))
  persistFavorites()
}

export function toggleFavorite(ref: FolderRef) {
  if (folderPrefs$.favorites.peek().some((item) => same(item, ref))) removeFavorite(ref)
  else addFavorite(ref)
}

/** Move the favorite at `from` to position `to` (both clamped). */
export function reorderFavorite(from: number, to: number): boolean {
  const favorites = [...folderPrefs$.favorites.peek()]
  if (from < 0 || from >= favorites.length) return false
  const target = Math.max(0, Math.min(favorites.length - 1, to))
  if (target === from) return false
  const [item] = favorites.splice(from, 1)
  favorites.splice(target, 0, item)
  folderPrefs$.favorites.set(favorites)
  persistFavorites()
  return true
}

/** One step up (-1) or down (+1); Alt+↑/↓ and the menu's Move up/down. */
export function moveFavorite(ref: FolderRef, delta: -1 | 1): boolean {
  const index = folderPrefs$.favorites.peek().findIndex((item) => same(item, ref))
  return index !== -1 && reorderFavorite(index, index + delta)
}

export function folderColorOf(ref: FolderRef): FolderColorId | undefined {
  return folderPrefs$.colors.get().find((item) => same(item, ref))?.color
}

export function setFolderColor(ref: FolderRef, color: FolderColorId | null) {
  const colors = folderPrefs$.colors.peek().filter((item) => !same(item, ref))
  if (color && isFolderColorId(color)) colors.push({ accountId: ref.accountId, folderId: ref.folderId, color })
  folderPrefs$.colors.set(colors)
  persistColors()
}

/** Whether the folder itself was hidden (a subfolder of a hidden one is hidden with it, see lib/folderHiding). */
export function isHiddenFolder(ref: FolderRef): boolean {
  return folderPrefs$.hidden.get().some((item) => same(item, ref))
}

/** Hide a folder from the folder tree. Nothing is asked of the server. */
export function hideFolder(ref: FolderRef) {
  if (!isRef(ref) || folderPrefs$.hidden.peek().some((item) => same(item, ref))) return
  folderPrefs$.hidden.set([...folderPrefs$.hidden.peek(), { accountId: ref.accountId, folderId: ref.folderId }])
  persistHidden()
}

export function unhideFolder(ref: FolderRef) {
  const hidden = folderPrefs$.hidden.peek()
  if (!hidden.some((item) => same(item, ref))) return
  folderPrefs$.hidden.set(hidden.filter((item) => !same(item, ref)))
  persistHidden()
}

function rewrite(update: (list: FolderRef[]) => FolderRef[]) {
  const favorites = folderPrefs$.favorites.peek()
  const nextFavorites = unique(update(favorites))
  const colors = folderPrefs$.colors.peek()
  const nextColors = unique(update(colors) as FolderColorEntry[])
  const hidden = folderPrefs$.hidden.peek()
  const nextHidden = unique(update(hidden))
  if (JSON.stringify(nextFavorites) !== JSON.stringify(favorites)) {
    folderPrefs$.favorites.set(nextFavorites)
    persistFavorites()
  }
  if (JSON.stringify(nextColors) !== JSON.stringify(colors)) {
    folderPrefs$.colors.set(nextColors)
    persistColors()
  }
  if (JSON.stringify(nextHidden) !== JSON.stringify(hidden)) {
    folderPrefs$.hidden.set(nextHidden)
    persistHidden()
  }
}

/** A folder move the core reported: favorites, colors and hidden folders follow every renamed path. */
export function applyFolderRenames(accountId: string, renames: FolderRename[]) {
  if (!renames.length) return
  const to = new Map(renames.map((rename) => [rename.from, rename.to]))
  rewrite((list) =>
    list.map((item) =>
      item.accountId === accountId && to.has(item.folderId) ? { ...item, folderId: to.get(item.folderId)! } : item,
    ),
  )
}

/** Deleted folders (the whole subtree the core reported) lose their entries. */
export function forgetFolders(accountId: string, folderIds: string[]) {
  if (!folderIds.length) return
  rewrite((list) => list.filter((item) => item.accountId !== accountId || !folderIds.includes(item.folderId)))
}

/** A removed account takes its favorites, colors and hidden folders with it. */
export function forgetAccountFolderPrefs(accountId: string) {
  rewrite((list) => list.filter((item) => item.accountId !== accountId))
}

/**
 * Drop entries for folders an account's full folder list no longer has (a
 * folder renamed or deleted elsewhere), and remember how many favorites went
 * so the navigation can say so. Colors and hidden marks of a vanished folder
 * go too: there is nothing left for them to apply to. An empty or inbox-only list is not trusted:
 * it is what an account shows before its first folder sync.
 */
export function pruneMissingFolders(accountId: string, folderIds: string[]): number {
  const known = new Set(folderIds)
  if (known.size < 2) return 0
  const stale = (item: FolderRef) => item.accountId === accountId && !known.has(item.folderId)
  const dropped = folderPrefs$.favorites.peek().filter(stale).length
  if (!dropped && !folderPrefs$.colors.peek().some(stale) && !folderPrefs$.hidden.peek().some(stale)) return 0
  rewrite((list) => list.filter((item) => !stale(item)))
  if (dropped) folderPrefs$.dropped.set(folderPrefs$.dropped.peek() + dropped)
  return dropped
}

export function dismissDroppedNote() {
  folderPrefs$.dropped.set(0)
}
