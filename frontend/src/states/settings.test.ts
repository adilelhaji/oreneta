import { afterEach, describe, expect, it } from 'bun:test'
import {
  EMPTY_PROXY,
  hydrateSettings,
  isProxyUsable,
  sanitizeKanbanBoards,
  sanitizeListSort,
  sanitizeProxy,
  settings$,
  sortParam,
} from './settings'

const baseBoard = {
  id: 'kb-1',
  name: 'Work',
  columns: [{ accountId: 'acc-1', folderId: 'inbox' }],
}

describe('sanitizeKanbanBoards', () => {
  it('keeps boards without customization fields untouched', () => {
    expect(sanitizeKanbanBoards([baseBoard])).toEqual([baseBoard])
  })

  it('accepts an app-managed avatar url', () => {
    const boards = sanitizeKanbanBoards([{ ...baseBoard, avatarUrl: '/media/avatars/kb-1/a.png' }])
    expect(boards?.[0].avatarUrl).toBe('/media/avatars/kb-1/a.png')
  })

  it('drops avatar urls outside /media/avatars/', () => {
    for (const avatarUrl of ['https://example.com/a.png', '/media/wallpapers/kb-1/a.png', 7, '']) {
      const boards = sanitizeKanbanBoards([{ ...baseBoard, avatarUrl }])
      expect(boards?.[0].avatarUrl).toBeUndefined()
    }
  })

  it('accepts preset and custom wallpapers', () => {
    expect(
      sanitizeKanbanBoards([{ ...baseBoard, wallpaper: { kind: 'preset', presetId: 'dots' } }])?.[0].wallpaper,
    ).toEqual({ kind: 'preset', presetId: 'dots' })
    expect(
      sanitizeKanbanBoards([{ ...baseBoard, wallpaper: { kind: 'custom', url: '/media/wallpapers/kb-1/w.png' } }])?.[0]
        .wallpaper,
    ).toEqual({ kind: 'custom', url: '/media/wallpapers/kb-1/w.png' })
  })

  it('drops invalid wallpapers', () => {
    for (const wallpaper of [
      { kind: 'preset', presetId: 'nope' },
      { kind: 'custom', url: 'https://example.com/w.png' },
      'dots',
      null,
    ]) {
      const boards = sanitizeKanbanBoards([{ ...baseBoard, wallpaper }])
      expect(boards?.[0].wallpaper).toBeUndefined()
    }
  })
})

describe('spellCheck setting', () => {
  afterEach(() => {
    settings$.spellCheck.set(true)
  })

  it('defaults spell check on', () => {
    expect(settings$.spellCheck.get()).toBe(true)
  })

  it('hydrates a persisted spell check preference', () => {
    hydrateSettings({ spell_check: false })
    expect(settings$.spellCheck.get()).toBe(false)

    hydrateSettings({ spell_check: true })
    expect(settings$.spellCheck.get()).toBe(true)
  })

  it('ignores invalid persisted spell check values', () => {
    settings$.spellCheck.set(false)
    hydrateSettings({ spell_check: 'true' })
    expect(settings$.spellCheck.get()).toBe(false)
  })
})

describe('proxy setting', () => {
  afterEach(() => {
    settings$.proxy.set(EMPTY_PROXY)
  })

  it('defaults to no proxy', () => {
    expect(settings$.proxy.get()).toEqual(EMPTY_PROXY)
  })

  it('hydrates a persisted proxy', () => {
    hydrateSettings({ proxy: { mode: 'socks5', host: ' 127.0.0.1 ', port: 1080, username: 'u', password: 'p' } })
    expect(settings$.proxy.get()).toEqual({
      mode: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'u',
      password: 'p',
    })
  })

  it('rejects unknown modes and out-of-range ports', () => {
    expect(sanitizeProxy({ mode: 'ftp', host: 'h', port: 1 })).toBeNull()
    expect(sanitizeProxy('socks5')).toBeNull()
    expect(sanitizeProxy({ mode: 'http', host: 'h', port: 70000 })?.port).toBe(0)
    expect(sanitizeProxy({ mode: 'http', host: 'h', port: -1 })?.port).toBe(0)
  })

  it('treats a half-filled proxy as unusable', () => {
    expect(isProxyUsable({ mode: 'off', host: 'h', port: 1080, username: '', password: '' })).toBe(false)
    expect(isProxyUsable({ mode: 'http', host: '', port: 8080, username: '', password: '' })).toBe(false)
    expect(isProxyUsable({ mode: 'http', host: 'h', port: 0, username: '', password: '' })).toBe(false)
    expect(isProxyUsable({ mode: 'http', host: 'h', port: 8080, username: '', password: '' })).toBe(true)
  })
})

describe('reading settings', () => {
  afterEach(() => {
    settings$.listDensity.set('cosy')
    settings$.readingWidth.set('comfortable')
    settings$.markReadMode.set('immediately')
    settings$.markReadDelaySeconds.set(3)
  })

  it('leaves a mailbox reading as it always has until asked otherwise', () => {
    expect(settings$.listDensity.get()).toBe('cosy')
    expect(settings$.readingWidth.get()).toBe('comfortable')
    // Marking on sight is what Oreneta has always done: nobody's mailbox
    // changes behaviour because a setting appeared.
    expect(settings$.markReadMode.get()).toBe('immediately')
  })

  it('hydrates persisted reading preferences', () => {
    hydrateSettings({
      list_density: 'compact',
      reading_width: 'full',
      mark_read_mode: 'delayed',
      mark_read_delay_seconds: 10,
    })

    expect(settings$.listDensity.get()).toBe('compact')
    expect(settings$.readingWidth.get()).toBe('full')
    expect(settings$.markReadMode.get()).toBe('delayed')
    expect(settings$.markReadDelaySeconds.get()).toBe(10)
  })

  it('ignores stored values this version does not offer', () => {
    // A value written by a later version, or edited by hand. A density nobody
    // can render, or a delay of an hour, would leave the list unreadable or a
    // message unread for reasons the reader never chose.
    hydrateSettings({
      list_density: 'spacious',
      reading_width: 'infinite',
      mark_read_mode: 'never',
      mark_read_delay_seconds: 3600,
    })

    expect(settings$.listDensity.get()).toBe('cosy')
    expect(settings$.readingWidth.get()).toBe('comfortable')
    expect(settings$.markReadMode.get()).toBe('immediately')
    expect(settings$.markReadDelaySeconds.get()).toBe(3)
  })
})

describe('saved searches', () => {
  afterEach(() => {
    settings$.savedSearches.set([])
  })

  it('keeps a name and the text that was typed', () => {
    hydrateSettings({ saved_searches: [{ id: 's1', name: 'Invoices', query: 'from:billing' }] })
    expect(settings$.savedSearches.get()).toEqual([{ id: 's1', name: 'Invoices', query: 'from:billing' }])
  })

  it('drops a stored row that would do nothing when clicked', () => {
    hydrateSettings({
      saved_searches: [
        { id: 's1', name: 'Good', query: 'invoice' },
        { id: 's2', name: 'No query', query: '   ' },
        { id: 's3', name: '  ', query: 'nameless' },
        { id: '', name: 'No id', query: 'orphan' },
        'not an object',
        null,
      ],
    })

    // A row with nothing to search for sits in the list doing nothing, which
    // is worse than not being there at all.
    expect(settings$.savedSearches.get().map((search) => search.id)).toEqual(['s1'])
  })

  it('leaves the list alone when the stored value is not a list', () => {
    settings$.savedSearches.set([{ id: 's1', name: 'Kept', query: 'invoice' }])
    hydrateSettings({ saved_searches: 'nonsense' })
    expect(settings$.savedSearches.get()).toHaveLength(1)
  })

  it('trims what it stores', () => {
    hydrateSettings({ saved_searches: [{ id: 's1', name: '  Invoices  ', query: '  invoice  ' }] })
    expect(settings$.savedSearches.get()[0]).toEqual({ id: 's1', name: 'Invoices', query: 'invoice' })
  })
})

describe('list view and ordering', () => {
  afterEach(() => {
    settings$.listView.set('cards')
    settings$.listSort.set({ key: 'date', dir: 'desc' })
  })

  it('starts as the list has always looked, newest first', () => {
    expect(settings$.listView.get()).toBe('cards')
    expect(settings$.listSort.get()).toEqual({ key: 'date', dir: 'desc' })
  })

  it('writes an ordering the core can read', () => {
    expect(sortParam({ key: 'date', dir: 'desc' })).toBe('date')
    expect(sortParam({ key: 'sender', dir: 'asc' })).toBe('sender:asc')
    expect(sortParam({ key: 'subject', dir: 'desc' })).toBe('subject')
  })

  it('hydrates a stored view and ordering', () => {
    hydrateSettings({ list_view: 'table', list_sort: { key: 'sender', dir: 'asc' } })
    expect(settings$.listView.get()).toBe('table')
    expect(settings$.listSort.get()).toEqual({ key: 'sender', dir: 'asc' })
  })

  it('keeps the usual order rather than claiming one it cannot apply', () => {
    // A column a later version can sort by would leave the list saying it is
    // in an order it is not in, which is worse than being in the usual one.
    expect(sanitizeListSort({ key: 'size', dir: 'asc' })).toBeNull()
    expect(sanitizeListSort('sender')).toBeNull()
    expect(sanitizeListSort(null)).toBeNull()
    // An unreadable direction is the default direction, not a dropped sort.
    expect(sanitizeListSort({ key: 'subject', dir: 'sideways' })).toEqual({ key: 'subject', dir: 'desc' })
  })

  it('ignores a view it cannot draw', () => {
    settings$.listView.set('table')
    hydrateSettings({ list_view: 'mosaic' })
    expect(settings$.listView.get()).toBe('table')
  })
})
