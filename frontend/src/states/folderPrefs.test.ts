import { beforeEach, describe, expect, it } from 'bun:test'
import {
  FOLDER_COLORS_KEY,
  FOLDER_FAVORITES_KEY,
  addFavorite,
  applyFolderRenames,
  folderPrefs$,
  forgetAccountFolderPrefs,
  forgetFolders,
  hydrateFolderPrefs,
  moveFavorite,
  pruneMissingFolders,
  removeFavorite,
  reorderFavorite,
  setFolderColor,
  toggleFavorite,
} from './folderPrefs'

const writes: Array<{ key: string; value: unknown }> = []
const ids = () => folderPrefs$.favorites.get().map((ref) => `${ref.accountId}:${ref.folderId}`)

beforeEach(() => {
  writes.length = 0
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => (command === 'app.prefsSet' && writes.push(payload), {}),
      },
    },
  }
  folderPrefs$.favorites.set([])
  folderPrefs$.colors.set([])
  folderPrefs$.dropped.set(0)
})

describe('folder favorites (ADR-0050)', () => {
  it('adds, removes and toggles favorites from any account, once each, and persists them', () => {
    addFavorite({ accountId: 'work', folderId: 'Projects/Reviews' })
    addFavorite({ accountId: 'local-archive', folderId: '2025' })
    addFavorite({ accountId: 'work', folderId: 'Projects/Reviews' })
    expect(ids()).toEqual(['work:Projects/Reviews', 'local-archive:2025'])
    toggleFavorite({ accountId: 'local-archive', folderId: '2025' })
    expect(ids()).toEqual(['work:Projects/Reviews'])
    removeFavorite({ accountId: 'work', folderId: 'Projects/Reviews' })
    expect(ids()).toEqual([])
    expect(writes.every((write) => write.key === FOLDER_FAVORITES_KEY)).toBe(true)
    expect(writes.at(-1)?.value).toEqual([])
  })

  it('reorders by drag position and one step at a time, persisting the order', () => {
    for (const folderId of ['A', 'B', 'C']) addFavorite({ accountId: 'acc', folderId })
    expect(reorderFavorite(0, 2)).toBe(true)
    expect(ids()).toEqual(['acc:B', 'acc:C', 'acc:A'])
    expect(moveFavorite({ accountId: 'acc', folderId: 'A' }, -1)).toBe(true)
    expect(ids()).toEqual(['acc:B', 'acc:A', 'acc:C'])
    expect(moveFavorite({ accountId: 'acc', folderId: 'B' }, -1)).toBe(false)
    expect(moveFavorite({ accountId: 'acc', folderId: 'C' }, 1)).toBe(false)
    expect(writes.at(-1)).toEqual({
      key: FOLDER_FAVORITES_KEY,
      value: [
        { accountId: 'acc', folderId: 'B' },
        { accountId: 'acc', folderId: 'A' },
        { accountId: 'acc', folderId: 'C' },
      ],
    })
  })

  it('hydrates what was saved and ignores what is malformed', () => {
    hydrateFolderPrefs({
      [FOLDER_FAVORITES_KEY]: JSON.stringify([
        { accountId: 'acc', folderId: 'Work' },
        { accountId: 'acc' },
        'junk',
        { accountId: 'acc', folderId: 'Work' },
      ]),
      [FOLDER_COLORS_KEY]: [
        { accountId: 'acc', folderId: 'Work', color: 'teal' },
        { accountId: 'acc', folderId: 'Old', color: '#123456' },
      ],
    })
    expect(ids()).toEqual(['acc:Work'])
    expect(folderPrefs$.colors.get()).toEqual([{ accountId: 'acc', folderId: 'Work', color: 'teal' }])
    hydrateFolderPrefs({ [FOLDER_FAVORITES_KEY]: '{not json' })
    expect(ids()).toEqual([])
  })

  it('follows renames the core reports, subtree included, for favorites and colors', () => {
    addFavorite({ accountId: 'acc', folderId: 'Work' })
    addFavorite({ accountId: 'acc', folderId: 'Work/2026' })
    addFavorite({ accountId: 'other', folderId: 'Work' })
    setFolderColor({ accountId: 'acc', folderId: 'Work/2026' }, 'blue')
    applyFolderRenames('acc', [
      { from: 'Work', to: 'Projects/Work' },
      { from: 'Work/2026', to: 'Projects/Work/2026' },
    ])
    expect(ids()).toEqual(['acc:Projects/Work', 'acc:Projects/Work/2026', 'other:Work'])
    expect(folderPrefs$.colors.get()).toEqual([{ accountId: 'acc', folderId: 'Projects/Work/2026', color: 'blue' }])
  })

  it('drops the entries of deleted folders and removed accounts', () => {
    addFavorite({ accountId: 'acc', folderId: 'Work' })
    addFavorite({ accountId: 'acc', folderId: 'Keep' })
    addFavorite({ accountId: 'gone', folderId: 'INBOX' })
    setFolderColor({ accountId: 'gone', folderId: 'INBOX' }, 'red')
    forgetFolders('acc', ['Work'])
    expect(ids()).toEqual(['acc:Keep', 'gone:INBOX'])
    forgetAccountFolderPrefs('gone')
    expect(ids()).toEqual(['acc:Keep'])
    expect(folderPrefs$.colors.get()).toEqual([])
  })

  it('drops favorites whose folder vanished elsewhere, and counts them for the note', () => {
    addFavorite({ accountId: 'acc', folderId: 'Work' })
    addFavorite({ accountId: 'acc', folderId: 'Gone' })
    // An inbox-only list is what an account shows before its first sync.
    expect(pruneMissingFolders('acc', ['INBOX'])).toBe(0)
    expect(ids()).toEqual(['acc:Work', 'acc:Gone'])
    expect(pruneMissingFolders('acc', ['INBOX', 'Work'])).toBe(1)
    expect(ids()).toEqual(['acc:Work'])
    expect(folderPrefs$.dropped.get()).toBe(1)
  })
})

describe('folder colors (ADR-0050)', () => {
  it('sets, replaces and clears a color, persisting only palette ids', () => {
    const ref = { accountId: 'acc', folderId: 'Work' }
    setFolderColor(ref, 'green')
    setFolderColor(ref, 'purple')
    expect(folderPrefs$.colors.get()).toEqual([{ ...ref, color: 'purple' }])
    setFolderColor(ref, null)
    expect(folderPrefs$.colors.get()).toEqual([])
    expect(writes.map((write) => write.key)).toEqual([FOLDER_COLORS_KEY, FOLDER_COLORS_KEY, FOLDER_COLORS_KEY])
  })
})
