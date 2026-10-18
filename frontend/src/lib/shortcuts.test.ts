import { afterEach, describe, expect, it } from 'bun:test'
import {
  chordFromEvent,
  DEFAULT_SHORTCUTS,
  formatShortcut,
  isBareShortcut,
  isFunctionKey,
  isMac,
  isShortcutCustomized,
  matchShortcut,
  sanitizeShortcutOverrides,
  setShortcutOverrides,
  SHORTCUT_GROUPS,
  SHORTCUT_IDS,
  SHORTCUT_LABELS,
  SHORTCUT_SCHEMES,
  shortcutChord,
  shortcutConflict,
  shortcutForChord,
  type Chord,
  type ShortcutId,
} from './shortcuts'

const keydown = (key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  }) as KeyboardEvent

const modKey = isMac ? { metaKey: true } : { ctrlKey: true }
const otherModKey = isMac ? { ctrlKey: true } : { metaKey: true }
const modLabel = isMac ? '⌘' : 'Ctrl'
const shiftLabel = isMac ? '⇧' : 'Shift'

describe('matchShortcut', () => {
  it('matches a mod chord', () => {
    expect(matchShortcut(keydown('k', modKey))).toBe('palette.open')
  })

  it('matches a mod+shift chord', () => {
    expect(matchShortcut(keydown('R', { ...modKey, shiftKey: true }))).toBe('mail.sync')
  })

  it('matches bare single-key shortcuts', () => {
    expect(matchShortcut(keydown('j'))).toBe('thread.next')
    expect(matchShortcut(keydown('#', { shiftKey: true }))).toBe('thread.delete')
  })

  it('does not fire when the other command key is held', () => {
    expect(matchShortcut(keydown('k', { ...modKey, ...otherModKey }))).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(matchShortcut(keydown('q'))).toBeNull()
    expect(matchShortcut(keydown('j', modKey))).toBeNull()
  })
})

describe('keyboard zoom (#181)', () => {
  afterEach(() => setShortcutOverrides({}))

  it('takes the browser keys, with plus however the layout types it', () => {
    expect(matchShortcut(keydown('=', modKey))).toBe('view.zoomIn')
    expect(matchShortcut(keydown('+', { ...modKey, shiftKey: true }))).toBe('view.zoomIn')
    expect(matchShortcut(keydown('+', modKey))).toBe('view.zoomIn')
    expect(matchShortcut(keydown('-', modKey))).toBe('view.zoomOut')
    expect(matchShortcut(keydown('0', modKey))).toBe('view.zoomReset')
    // Never without the command key, so typing them is untouched.
    expect(matchShortcut(keydown('+'))).toBeNull()
    expect(matchShortcut(keydown('-'))).toBeNull()
    expect(matchShortcut(keydown('+', { ...modKey, altKey: true }))).toBeNull()
  })

  it('a rebound zoom-in replaces the plus key too, and a forwarded chord matches the same', () => {
    expect(shortcutForChord({ mod: true, shift: true, key: '+' })).toBe('view.zoomIn')
    setShortcutOverrides({ 'view.zoomIn': { mod: true, alt: true, key: 'i' } })
    expect(matchShortcut(keydown('+', modKey))).toBeNull()
    expect(matchShortcut(keydown('=', modKey))).toBeNull()
    expect(matchShortcut(keydown('i', { ...modKey, altKey: true }))).toBe('view.zoomIn')
  })

  it('collides with no other default binding', () => {
    for (const id of ['view.zoomIn', 'view.zoomOut', 'view.zoomReset'] as ShortcutId[]) {
      expect(shortcutConflict(id, DEFAULT_SHORTCUTS[id])).toBeNull()
    }
  })
})

describe('isBareShortcut', () => {
  afterEach(() => setShortcutOverrides({}))

  it('is true for single-key and shift-only chords, false for mod chords', () => {
    expect(isBareShortcut('thread.next')).toBe(true)
    expect(isBareShortcut('thread.delete')).toBe(true)
    expect(isBareShortcut('palette.open')).toBe(false)
  })

  it('leaves out F1–F12, which type no text, with or without Shift (ADR-0068 §6)', () => {
    expect(isBareShortcut('pane.next')).toBe(false)
    expect(isBareShortcut('pane.prev')).toBe(false)
    setShortcutOverrides({ 'thread.next': { key: 'F12' }, 'thread.prev': { shift: true, key: 'F1' } })
    expect(isBareShortcut('thread.next')).toBe(false)
    expect(isBareShortcut('thread.prev')).toBe(false)
  })

  it('puts the barrier back when F6 is rebound to a letter', () => {
    setShortcutOverrides({ 'pane.next': { key: 'g' } })
    expect(isBareShortcut('pane.next')).toBe(true)
    expect(isBareShortcut('pane.prev')).toBe(false)
  })
})

describe('isFunctionKey', () => {
  it('is F1 to F12 and nothing else', () => {
    for (let n = 1; n <= 12; n++) expect(isFunctionKey(`F${n}`)).toBe(true)
    for (const key of ['F0', 'F13', 'F', 'f6', 'F6 ', 'Escape', '6']) expect(isFunctionKey(key)).toBe(false)
  })
})

describe('region shortcuts (ADR-0068 §6)', () => {
  afterEach(() => setShortcutOverrides({}))

  it('binds F6 and Shift+F6 by default', () => {
    expect(matchShortcut(keydown('F6'))).toBe('pane.next')
    expect(matchShortcut(keydown('F6', { shiftKey: true }))).toBe('pane.prev')
    expect(matchShortcut(keydown('F6', modKey))).toBeNull()
    expect(formatShortcut('pane.next')).toEqual(['F6'])
    expect(formatShortcut('pane.prev')).toEqual([shiftLabel, 'F6'])
  })

  it('collides with no other default binding', () => {
    expect(shortcutConflict('pane.next', DEFAULT_SHORTCUTS['pane.next'])).toBeNull()
    expect(shortcutConflict('pane.prev', DEFAULT_SHORTCUTS['pane.prev'])).toBeNull()
  })

  it('can be rebound, and the old key stops working', () => {
    setShortcutOverrides({ 'pane.next': { key: 'F8' } })
    expect(matchShortcut(keydown('F8'))).toBe('pane.next')
    expect(matchShortcut(keydown('F6'))).toBeNull()
    expect(shortcutForChord({ key: 'F8' })).toBe('pane.next')
  })

  it('records F6 in the rebinding recorder and keeps it through sanitising', () => {
    expect(chordFromEvent(keydown('F6', { shiftKey: true }))).toEqual({ key: 'F6', shift: true })
    expect(sanitizeShortcutOverrides({ 'pane.prev': { key: 'F7', shift: true } })).toEqual({
      'pane.prev': { key: 'F7', shift: true },
    })
  })
})

describe('formatShortcut', () => {
  it('renders mod chords with the platform command modifier', () => {
    expect(formatShortcut('palette.open')).toEqual([modLabel, 'K'])
    expect(formatShortcut('mail.sync')).toEqual([modLabel, shiftLabel, 'R'])
  })

  it('names Space, whose key is a blank string', () => {
    setShortcutOverrides({ 'thread.star': { key: ' ' } })
    expect(formatShortcut('thread.star')).toEqual(['Space'])
    setShortcutOverrides({})
  })

  it('does not double Shift for keys that imply it', () => {
    expect(formatShortcut('shortcuts.help')).toEqual([modLabel, '?'])
    expect(formatShortcut('thread.delete')).toEqual(['#'])
  })

  it('covers every defined shortcut without throwing', () => {
    for (const id of SHORTCUT_IDS) {
      expect(formatShortcut(id).length).toBeGreaterThan(0)
    }
  })
})

describe('custom bindings', () => {
  afterEach(() => setShortcutOverrides({}))

  it('resolves, matches and formats an override in place of the default', () => {
    setShortcutOverrides({ 'thread.next': { key: 'n' } })
    expect(shortcutChord('thread.next')).toEqual({ key: 'n' })
    expect(matchShortcut(keydown('n'))).toBe('thread.next')
    expect(matchShortcut(keydown('j'))).toBeNull()
    expect(formatShortcut('thread.next')).toEqual(['N'])
    expect(isShortcutCustomized('thread.next')).toBe(true)
    expect(isShortcutCustomized('thread.prev')).toBe(false)
  })

  it('re-evaluates bareness from the bound chord', () => {
    setShortcutOverrides({ 'thread.next': { mod: true, key: 'j' }, 'palette.open': { key: 'p' } })
    expect(isBareShortcut('thread.next')).toBe(false)
    expect(isBareShortcut('palette.open')).toBe(true)
  })

  it('reports the shortcut already holding a chord', () => {
    expect(shortcutConflict('thread.next', { key: 'k' })).toBe('thread.prev')
    expect(shortcutConflict('thread.next', { key: 'j' })).toBeNull()
    expect(shortcutConflict('thread.next', { key: 'z' })).toBeNull()
    // Conflicts are checked against the live bindings, not the defaults.
    setShortcutOverrides({ 'thread.prev': { key: 'z' } })
    expect(shortcutConflict('thread.next', { key: 'k' })).toBeNull()
    expect(shortcutConflict('thread.next', { key: 'z' })).toBe('thread.prev')
  })
})

describe('shortcutForChord', () => {
  afterEach(() => setShortcutOverrides({}))

  it('resolves a hand-built chord, so forwarded keys match the same table', () => {
    expect(shortcutForChord({ key: 'j' })).toBe('thread.next')
    expect(shortcutForChord({ key: 'ArrowDown' })).toBeNull()
    setShortcutOverrides({ 'thread.archive': { key: 'ArrowDown' } })
    expect(shortcutForChord({ key: 'ArrowDown' })).toBe('thread.archive')
  })
})

describe('chordFromEvent', () => {
  it('captures modifiers and lowercases printable keys', () => {
    expect(chordFromEvent(keydown('J', { ...modKey, shiftKey: true }))).toEqual({
      key: 'j',
      mod: true,
      shift: true,
    })
    expect(chordFromEvent(keydown('ArrowDown'))).toEqual({ key: 'ArrowDown' })
  })

  it('rejects keystrokes that cannot be bound', () => {
    expect(chordFromEvent(keydown('Shift', { shiftKey: true }))).toBeNull()
    expect(chordFromEvent(keydown('Escape'))).toBeNull()
    expect(chordFromEvent(keydown('Tab'))).toBeNull()
    expect(chordFromEvent(keydown('k', otherModKey))).toBeNull()
  })
})

describe('sanitizeShortcutOverrides', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(
      sanitizeShortcutOverrides({
        'thread.next': { key: 'n', mod: true, shift: 'yes' },
        'thread.prev': { key: '' },
        'not.a.shortcut': { key: 'x' },
        'thread.star': 'nope',
        'thread.unread': { key: 'Escape' },
      }),
    ).toEqual({ 'thread.next': { key: 'n', mod: true } })
  })

  it('drops overrides that just repeat the default', () => {
    expect(sanitizeShortcutOverrides({ 'thread.next': DEFAULT_SHORTCUTS['thread.next'] })).toEqual({})
  })

  it('returns null for values that are not an object map', () => {
    expect(sanitizeShortcutOverrides(null)).toBeNull()
    expect(sanitizeShortcutOverrides([])).toBeNull()
  })
})

describe('SHORTCUT_GROUPS', () => {
  it('lists every shortcut exactly once, so all of them are visible and rebindable', () => {
    const listed = SHORTCUT_GROUPS.flatMap((group) => group.ids)
    expect([...listed].sort()).toEqual([...SHORTCUT_IDS].sort())
  })
})

describe('the letters other clients taught people', () => {
  it('names only bindings this app can actually honour', () => {
    // A scheme that promised Gmail's `g` then `i` — a two-key sequence this
    // app has no machinery for — would be a scheme that quietly does not work.
    for (const [name, scheme] of Object.entries(SHORTCUT_SCHEMES)) {
      for (const id of Object.keys(scheme)) {
        expect(SHORTCUT_IDS).toContain(id as ShortcutId)
        expect(SHORTCUT_LABELS[id as ShortcutId]).toBeTruthy()
      }
      expect(name).toBeTruthy()
    }
  })

  it('gives no scheme two actions on one chord', () => {
    // Within a scheme, and against the defaults it leaves alone: a duplicate
    // would make one of the two silently unreachable.
    for (const scheme of Object.values(SHORTCUT_SCHEMES)) {
      const merged = { ...DEFAULT_SHORTCUTS, ...scheme } as Record<string, Chord>
      const seen = new Map<string, string>()
      for (const [id, chord] of Object.entries(merged)) {
        const key = `${chord.mod ? 'm' : ''}${chord.shift ? 's' : ''}${chord.alt ? 'a' : ''}${chord.key.toLowerCase()}`
        expect(seen.has(key) ? `${seen.get(key)} and ${id} share ${key}` : '').toBe('')
        seen.set(key, id)
      }
    }
  })

  it('leaves the app in its own scheme by default', () => {
    expect(SHORTCUT_SCHEMES.oreneta).toEqual({})
  })

  it('uses the letters those clients are known for', () => {
    expect(SHORTCUT_SCHEMES.gmail['compose.new']).toEqual({ key: 'c' })
    expect(SHORTCUT_SCHEMES.gmail['search.global']).toEqual({ key: '/' })
    expect(SHORTCUT_SCHEMES.outlook['thread.delete']).toEqual({ key: 'Delete' })
  })
})
