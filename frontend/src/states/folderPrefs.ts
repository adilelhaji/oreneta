// Folder favorites and colors (ADR-0050, ledger SET-07): local preferences
// only, never written to a server. Both are keyed by account id + folder id
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
export const FOLDER_PREF_KEYS = [FOLDER_FAVORITES_KEY, FOLDER_COLORS_KEY]

export const folderPrefs$ = observable({
  /** Favorite folders, in the order the person arranged them. */
  favorites: [] as FolderRef[],
  colors: [] as FolderColorEntry[],
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

export function parseFavorites(value: unknown): FolderRef[] {
  const list = safeParse(value)
  if (!Array.isArray(list)) return []
  return unique(list.filter(isRef).map(({ accountId, folderId }) => ({ accountId, folderId })))
}

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
}

function persistFavorites() {
  void invoke('app.prefsSet', { key: FOLDER_FAVORITES_KEY, value: folderPrefs$.favorites.peek() }).catch(() => {})
}

function persistColors() {
  void invoke('app.prefsSet', { key: FOLDER_COLORS_KEY, value: folderPrefs$.colors.peek() }).catch(() => {})
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

function rewrite(update: (list: FolderRef[]) => FolderRef[]) {
  const favorites = folderPrefs$.favorites.peek()
  const nextFavorites = unique(update(favorites))
  const colors = folderPrefs$.colors.peek()
  const nextColors = unique(update(colors) as FolderColorEntry[])
  if (JSON.stringify(nextFavorites) !== JSON.stringify(favorites)) {
    folderPrefs$.favorites.set(nextFavorites)
    persistFavorites()
  }
  if (JSON.stringify(nextColors) !== JSON.stringify(colors)) {
    folderPrefs$.colors.set(nextColors)
    persistColors()
  }
}

/** A folder move the core reported: favorites and colors follow every renamed path. */
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

/** A removed account takes its favorites and colors with it. */
export function forgetAccountFolderPrefs(accountId: string) {
  rewrite((list) => list.filter((item) => item.accountId !== accountId))
}

/**
 * Drop entries for folders an account's full folder list no longer has (a
 * folder renamed or deleted elsewhere), and remember how many favorites went
 * so the navigation can say so. An empty or inbox-only list is not trusted:
 * it is what an account shows before its first folder sync.
 */
export function pruneMissingFolders(accountId: string, folderIds: string[]): number {
  const known = new Set(folderIds)
  if (known.size < 2) return 0
  const stale = (item: FolderRef) => item.accountId === accountId && !known.has(item.folderId)
  const dropped = folderPrefs$.favorites.peek().filter(stale).length
  if (!dropped && !folderPrefs$.colors.peek().some(stale)) return 0
  rewrite((list) => list.filter((item) => !stale(item)))
  if (dropped) folderPrefs$.dropped.set(folderPrefs$.dropped.peek() + dropped)
  return dropped
}

export function dismissDroppedNote() {
  folderPrefs$.dropped.set(0)
}
