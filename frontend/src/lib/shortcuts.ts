// Global keyboard shortcuts. The defaults live here as a small static table;
// users can rebind any of them from the shortcuts dialog, and those overrides
// are persisted in settings (`shortcut_overrides`) and pushed back in here via
// setShortcutOverrides. `mod` is ⌘ on macOS and Ctrl elsewhere — the
// platform-native "command" modifier.

export const RAIL_SHORTCUT_IDS = [
  'view.rail1',
  'view.rail2',
  'view.rail3',
  'view.rail4',
  'view.rail5',
  'view.rail6',
  'view.rail7',
  'view.rail8',
  'view.rail9',
] as const

export type RailShortcutId = (typeof RAIL_SHORTCUT_IDS)[number]

export type ShortcutId =
  | 'palette.open'
  | 'compose.new'
  | 'settings.open'
  | 'mail.sync'
  | 'view.toggle'
  | 'search.thread'
  | 'search.global'
  | 'compose.replyFull'
  | 'shortcuts.help'
  | 'tab.close'
  | 'thread.next'
  | 'thread.prev'
  | 'thread.archive'
  | 'thread.star'
  | 'thread.unread'
  | 'thread.delete'
  | 'thread.details'
  | 'thread.junk'
  | 'reply.focus'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomReset'
  | 'pane.next'
  | 'pane.prev'
  | RailShortcutId

/** F1–F12: keys that never type text (ADR-0068 §6). */
export function isFunctionKey(key: string): boolean {
  return /^F([1-9]|1[0-2])$/.test(key)
}

/** True for single-key shortcuts (no ⌘/Ctrl/Alt). These only fire when the user
 * isn't typing and no modal is open — so they don't hijack text entry. F1–F12
 * type no text, so a chord on one of them is not bare: it works while typing,
 * like a ⌘/Ctrl chord. */
export function isBareShortcut(id: ShortcutId): boolean {
  const chord = shortcutChord(id)
  return !chord.mod && !chord.alt && !isFunctionKey(chord.key)
}

export type Chord = {
  mod?: boolean
  shift?: boolean
  alt?: boolean
  key: string
}

/** User rebindings, keyed by shortcut id. Missing ids use the default chord. */
export type ShortcutOverrides = Partial<Record<ShortcutId, Chord>>

export const DEFAULT_SHORTCUTS: Record<ShortcutId, Chord> = {
  'palette.open': { mod: true, key: 'k' },
  'compose.new': { mod: true, key: 'n' },
  'settings.open': { mod: true, key: ',' },
  'mail.sync': { mod: true, shift: true, key: 'r' },
  'view.toggle': { mod: true, shift: true, key: 'v' },
  'view.rail1': { mod: true, key: '1' },
  'view.rail2': { mod: true, key: '2' },
  'view.rail3': { mod: true, key: '3' },
  'view.rail4': { mod: true, key: '4' },
  'view.rail5': { mod: true, key: '5' },
  'view.rail6': { mod: true, key: '6' },
  'view.rail7': { mod: true, key: '7' },
  'view.rail8': { mod: true, key: '8' },
  'view.rail9': { mod: true, key: '9' },
  // VSCode-style: find in current thread / find across all messages.
  'search.thread': { mod: true, key: 'f' },
  'search.global': { mod: true, shift: true, key: 'f' },
  // Expand the current thread's quick reply into the full-window editor.
  'compose.replyFull': { mod: true, key: 'e' },
  // ⌘/Ctrl+? — "?" already implies Shift on most layouts.
  'shortcuts.help': { mod: true, shift: true, key: '?' },
  'tab.close': { mod: true, key: 'w' },
  // The browser's zoom keys, which the webview leaves unbound (#181).
  'view.zoomIn': { mod: true, key: '=' },
  'view.zoomOut': { mod: true, key: '-' },
  'view.zoomReset': { mod: true, key: '0' },
  // From one region of the window to the next and back (ADR-0068 §6).
  'pane.next': { key: 'F6' },
  'pane.prev': { shift: true, key: 'F6' },
  // Gmail-style single-key thread shortcuts (only when not typing).
  'thread.next': { key: 'j' },
  'thread.prev': { key: 'k' },
  'thread.archive': { key: 'e' },
  'thread.star': { key: 's' },
  'thread.unread': { key: 'u' },
  'thread.delete': { shift: true, key: '#' },
  'thread.details': { key: 'i' },
  // Gmail's, and the one this table was missing now that junk exists.
  'thread.junk': { shift: true, key: '!' },
  'reply.focus': { key: 'r' },
}

/**
 * The letters other clients taught people.
 *
 * A scheme is a set of rebindings, not a second mechanism: it writes the same
 * overrides the shortcuts dialog writes, so a reader can pick a scheme and
 * then change one row of it without those two ideas fighting. Picking a scheme
 * replaces the bindings it names and leaves every other one alone.
 *
 * Only bindings this app can actually honour are listed. A scheme that
 * promised Gmail's `g` `i` — a two-key sequence this app has no machinery for
 * — would be a scheme that quietly does not work.
 */
export type ShortcutScheme = 'oreneta' | 'gmail' | 'outlook'

export const SHORTCUT_SCHEMES: Record<ShortcutScheme, ShortcutOverrides> = {
  // The app's own, which is what the defaults already are.
  oreneta: {},
  gmail: {
    'compose.new': { key: 'c' },
    'search.global': { key: '/' },
    'thread.archive': { key: 'e' },
    'thread.star': { key: 's' },
    'thread.unread': { key: 'u' },
    'thread.delete': { shift: true, key: '#' },
    'thread.junk': { shift: true, key: '!' },
    'reply.focus': { key: 'r' },
    'thread.next': { key: 'j' },
    'thread.prev': { key: 'k' },
  },
  outlook: {
    'compose.new': { mod: true, key: 'n' },
    'mail.sync': { key: 'F9' },
    'thread.archive': { key: 'e' },
    'thread.delete': { key: 'Delete' },
    'thread.junk': { mod: true, alt: true, key: 'j' },
    'reply.focus': { mod: true, key: 'r' },
    'thread.unread': { mod: true, key: 'q' },
  },
}

export const SHORTCUT_IDS = Object.keys(DEFAULT_SHORTCUTS) as ShortcutId[]

// Live overrides. states/settings owns the persisted copy and pushes it here on
// hydrate and on every edit; keeping the mirror local means this module stays
// free of state imports (and testable without the settings/bridge stack).
let overrides: ShortcutOverrides = {}

/** Replace the active rebindings. Called by states/settings. */
export function setShortcutOverrides(next: ShortcutOverrides) {
  overrides = next
}

/** The chord currently bound to a shortcut: the user's override, else the default. */
export function shortcutChord(id: ShortcutId): Chord {
  return overrides[id] ?? DEFAULT_SHORTCUTS[id]
}

/** Whether a shortcut is rebound (so the UI can offer to reset just that row). */
export function isShortcutCustomized(id: ShortcutId): boolean {
  return !!overrides[id]
}

export function chordEquals(a: Chord, b: Chord): boolean {
  return (
    !!a.mod === !!b.mod && !!a.shift === !!b.shift && !!a.alt === !!b.alt && a.key.toLowerCase() === b.key.toLowerCase()
  )
}

// Keys that can't stand alone as a binding: bare modifiers produce a keydown of
// their own, Escape cancels the recorder, and Tab has to keep moving focus.
const UNBINDABLE_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Escape', 'Tab'])

/**
 * The chord a keydown represents, for the rebinding recorder. Returns null for
 * keystrokes that can't be bound — a lone modifier, Escape/Tab, or the "other"
 * command key (⌃ on macOS, ⌘ elsewhere), which chords here never use.
 */
export function chordFromEvent(event: KeyboardEvent): Chord | null {
  if (UNBINDABLE_KEYS.has(event.key)) return null
  const otherMod = isMac ? event.ctrlKey : event.metaKey
  if (otherMod) return null

  const chord: Chord = { key: event.key.length === 1 ? event.key.toLowerCase() : event.key }
  if (isMac ? event.metaKey : event.ctrlKey) chord.mod = true
  if (event.shiftKey) chord.shift = true
  if (event.altKey) chord.alt = true
  return chord
}

/** The shortcut already using this chord, if any — so a rebind can warn first. */
export function shortcutConflict(id: ShortcutId, chord: Chord): ShortcutId | null {
  for (const other of SHORTCUT_IDS) {
    if (other === id) continue
    if (chordEquals(shortcutChord(other), chord)) return other
  }
  return null
}

/**
 * Coerce persisted overrides into the canonical shape, dropping unknown ids and
 * malformed chords. Returns null for anything unrecognizable so hydration
 * leaves the current value alone.
 */
export function sanitizeShortcutOverrides(raw: unknown): ShortcutOverrides | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: ShortcutOverrides = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(id in DEFAULT_SHORTCUTS)) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const chord = value as Record<string, unknown>
    if (typeof chord.key !== 'string' || !chord.key || UNBINDABLE_KEYS.has(chord.key)) continue
    const next: Chord = { key: chord.key }
    if (chord.mod === true) next.mod = true
    if (chord.shift === true) next.shift = true
    if (chord.alt === true) next.alt = true
    // A rebinding that matches the default is redundant; drop it so the row
    // doesn't read as customized.
    if (chordEquals(next, DEFAULT_SHORTCUTS[id as ShortcutId])) continue
    out[id as ShortcutId] = next
  }
  return out
}

/** Human-readable name for each shortcut, shown in the help overlay. */
export const SHORTCUT_LABELS: Record<ShortcutId, string> = {
  'palette.open': 'Command palette',
  'shortcuts.help': 'Keyboard shortcuts',
  'settings.open': 'Open settings',
  'compose.new': 'Compose new message',
  'compose.replyFull': 'Reply in full editor',
  'thread.junk': 'Mark as junk',
  'reply.focus': 'Reply (focus quick reply)',
  'mail.sync': 'Sync mailbox',
  'search.thread': 'Search current thread',
  'search.global': 'Search all messages',
  'view.toggle': 'Toggle Mail / Kanban board',
  'view.rail1': 'Go to item 1 of Accounts and folders',
  'view.rail2': 'Go to item 2 of Accounts and folders',
  'view.rail3': 'Go to item 3 of Accounts and folders',
  'view.rail4': 'Go to item 4 of Accounts and folders',
  'view.rail5': 'Go to item 5 of Accounts and folders',
  'view.rail6': 'Go to item 6 of Accounts and folders',
  'view.rail7': 'Go to item 7 of Accounts and folders',
  'view.rail8': 'Go to item 8 of Accounts and folders',
  'view.rail9': 'Go to item 9 of Accounts and folders',
  'tab.close': 'Close tab',
  'view.zoomIn': 'Make everything larger',
  'view.zoomOut': 'Make everything smaller',
  'view.zoomReset': 'Reset size',
  'pane.next': 'Next region',
  'pane.prev': 'Previous region',
  'thread.next': 'Next thread',
  'thread.prev': 'Previous thread',
  'thread.archive': 'Archive thread',
  'thread.star': 'Toggle star',
  'thread.unread': 'Mark unread',
  'thread.delete': 'Delete thread',
  'thread.details': 'Toggle details sidebar',
}

/** Grouping for the help overlay, in display order. */
export const SHORTCUT_GROUPS: { title: string; ids: ShortcutId[] }[] = [
  { title: 'General', ids: ['palette.open', 'shortcuts.help', 'settings.open'] },
  {
    title: 'Threads',
    ids: [
      'thread.next',
      'thread.prev',
      'thread.archive',
      'thread.star',
      'thread.unread',
      'thread.delete',
      'thread.details',
      'thread.junk',
    ],
  },
  {
    title: 'Mail',
    ids: ['compose.new', 'reply.focus', 'compose.replyFull', 'mail.sync', 'search.thread', 'search.global'],
  },
  {
    title: 'View',
    ids: ['view.toggle', 'tab.close', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset', 'pane.next', 'pane.prev'],
  },
  // Every slot gets a row, so all nine are visible and rebindable. The slots
  // are the rail's, in «Comptes i carpetes» since the rail went (#354): the
  // unified inbox if shown, the boards, then the accounts shown.
  { title: 'Accounts and folders', ids: [...RAIL_SHORTCUT_IDS] },
]

export const isMac = /mac|iphone|ipad|ipod/i.test(navigator.userAgent + ' ' + (navigator.platform ?? ''))

/** Identify which shortcut, if any, a keydown event matches. Returns null when
 * nothing matches so callers can let the event through. */
export function matchShortcut(event: KeyboardEvent): ShortcutId | null {
  // The "other" command key must be up, so ⌃K on macOS doesn't fire ⌘K.
  const otherMod = isMac ? event.ctrlKey : event.metaKey
  if (otherMod) return null

  return shortcutForChord({
    key: event.key,
    mod: isMac ? event.metaKey : event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  })
}

/**
 * The other keys browsers zoom with, while zoom keeps its default binding:
 * ⌘/Ctrl with `+` (Shift+`=` on many layouts, or the keypad's plus). The
 * keypad's minus already arrives as `-`. A rebinding replaces these too.
 */
export function zoomAlias(chord: Chord): ShortcutId | null {
  if (!chord.mod || chord.alt || chord.key !== '+') return null
  return isShortcutCustomized('view.zoomIn') ? null : 'view.zoomIn'
}

/** Same lookup for a chord reconstructed by hand — e.g. a keystroke forwarded
 * out of a message iframe, which arrives as data rather than a KeyboardEvent. */
export function shortcutForChord(chord: Chord): ShortcutId | null {
  for (const id of SHORTCUT_IDS) {
    if (chordEquals(shortcutChord(id), chord)) return id
  }
  return zoomAlias(chord)
}

/** Render a shortcut as display parts, e.g. ["⌘", "K"] or ["Ctrl", "Shift", "R"]. */
export function formatShortcut(id: ShortcutId): string[] {
  return formatChord(shortcutChord(id))
}

function formatChord(chord: Chord): string[] {
  const parts: string[] = []
  if (chord.mod) parts.push(isMac ? '⌘' : 'Ctrl')
  if (chord.alt) parts.push(isMac ? '⌥' : 'Alt')
  // "?" and "#" already carry Shift on most layouts, so don't double it up.
  if (chord.shift && chord.key !== '?' && chord.key !== '#') {
    parts.push(isMac ? '⇧' : 'Shift')
  }
  // Space's KeyboardEvent.key is " ", which would render as an empty badge.
  if (chord.key === ' ') parts.push('Space')
  else parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return parts
}
