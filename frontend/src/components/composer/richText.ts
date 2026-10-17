import { Extension, getStyleProperty, type Editor, type Extensions } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { BackgroundColor, Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { TextAlign } from '@tiptap/extension-text-align'
import { Table, TableCell, TableHeader, TableRow, TableView } from '@tiptap/extension-table'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { isMac } from '../../lib/shortcuts'
import { INDENTABLE_TYPES, ParagraphIndent } from './indentExtension'

// The composer's rich-text formatting (#274, ADR-0067): font, size, text and
// background colour, alignment, paragraph indent and tables.
//
// The editor's schema is the only filter between what is pasted or loaded and
// the HTML that is sent (the core does not clean outgoing HTML). The upstream
// colour, font and size attributes copy the raw value of `style` back out as
// they found it, so each is wrapped here with a validator: a value that does
// not pass is dropped, the text keeps its words and loses only that style.

/** Fonts offered in the toolbar: ones mail clients have, with fallbacks. */
export const FONT_FAMILIES = [
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Courier New', value: "'Courier New', Courier, monospace" },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
  { label: 'Times New Roman', value: "'Times New Roman', Times, serif" },
  { label: 'Trebuchet MS', value: "'Trebuchet MS', Helvetica, sans-serif" },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
] as const

/** Sizes offered in the toolbar, in points (what mail clients size text in). */
export const FONT_SIZES = ['8pt', '9pt', '10pt', '11pt', '12pt', '14pt', '16pt', '18pt', '20pt', '24pt', '28pt', '36pt'] as const

export const COLOR_NAMES = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const
export type ColorName = (typeof COLOR_NAMES)[number]

/** Text colours: dark enough to read on white. */
export const TEXT_COLORS: Record<ColorName, string> = {
  gray: '#6b7280',
  red: '#dc2626',
  orange: '#ea580c',
  yellow: '#ca8a04',
  green: '#16a34a',
  blue: '#2563eb',
  purple: '#9333ea',
}

/** Background colours: light enough for dark text on top. */
export const BACKGROUND_COLORS: Record<ColorName, string> = {
  gray: '#e5e7eb',
  red: '#fecaca',
  orange: '#fed7aa',
  yellow: '#fef08a',
  green: '#bbf7d0',
  blue: '#bfdbfe',
  purple: '#e9d5ff',
}

export const ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const
export type Alignment = (typeof ALIGNMENTS)[number]

// Never in a value, whatever the property: a fetch (`url(`), old script
// (`expression`), an indirection the value check cannot see through (`var(`),
// an escape, a declaration or rule boundary, markup, or a comment.
const FORBIDDEN = /url\(|expression|var\(|\\|;|[<>{}]|\/\*|\*\//i

function cleanValue(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > maxLength || FORBIDDEN.test(value)) return null
  return value
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const CHANNEL = '\\s*\\d{1,3}(?:\\.\\d+)?%?\\s*'
const ALPHA = '\\s*(?:\\d{1,3}%|[01]|[01]?\\.\\d+)\\s*'
const RGB_COLOR = new RegExp(`^rgba?\\(${CHANNEL},${CHANNEL},${CHANNEL}(?:,${ALPHA})?\\)$`, 'i')
const NAMED_COLOR = /^[a-z]{3,20}$/i

/** A colour as `#hex`, `rgb()`/`rgba()` with numbers, or a name of letters; else null. */
export function safeCssColor(raw: unknown): string | null {
  const value = cleanValue(raw, 64)
  if (!value) return null
  return HEX_COLOR.test(value) || RGB_COLOR.test(value) || NAMED_COLOR.test(value) ? value : null
}

const FONT_SIZE = /^(\d{1,4}(?:\.\d{1,2})?)(pt|px|em|%)$/i
const FONT_SIZE_LIMITS: Record<string, [number, number]> = {
  pt: [1, 144],
  px: [1, 192],
  em: [0.1, 12],
  '%': [10, 1200],
}

/** A size as a number in pt, px, em or %, within a closed range per unit; else null. */
export function safeFontSize(raw: unknown): string | null {
  const value = cleanValue(raw, 16)
  if (!value) return null
  const match = FONT_SIZE.exec(value)
  if (!match) return null
  const unit = match[2].toLowerCase()
  const [min, max] = FONT_SIZE_LIMITS[unit]
  const size = Number(match[1])
  return size >= min && size <= max ? `${match[1]}${unit}` : null
}

const FAMILY_NAME = /^[\p{L}\p{N} _-]+$/u
const MAX_FAMILY_NAMES = 10

/**
 * A font list: names of letters, digits, spaces, `_` and `-`, each bare or in
 * a pair of matching quotes. Comes back with single quotes around any name
 * that was quoted or has a space, so the sent `style` needs no `&quot;`.
 */
export function safeFontFamily(raw: unknown): string | null {
  const value = cleanValue(raw, 200)
  if (!value) return null
  const names = value.split(',').map((name) => name.trim())
  if (names.length > MAX_FAMILY_NAMES) return null
  const out: string[] = []
  for (const name of names) {
    const quoted = /^(['"])(.*)\1$/.exec(name)
    const bare = (quoted ? quoted[2] : name).trim()
    if (!bare || !FAMILY_NAME.test(bare)) return null
    out.push(quoted || /\s/.test(bare) ? `'${bare}'` : bare)
  }
  return out.join(', ')
}

// The same attribute as upstream (same name, same `style` property), read and
// written through the validator. Validated on the way out too, so a value set
// by a command can never reach the sent HTML unchecked.
function validatedStyle(property: string, attribute: string, validate: (raw: unknown) => string | null) {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => validate(getStyleProperty(element, property)),
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = validate(attributes[attribute])
      return value ? { style: `${property}: ${value}` } : {}
    },
  }
}

export const SafeColor = Color.extend({
  addGlobalAttributes() {
    return [{ types: this.options.types, attributes: { color: validatedStyle('color', 'color', safeCssColor) } }]
  },
})

export const SafeBackgroundColor = BackgroundColor.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: { backgroundColor: validatedStyle('background-color', 'backgroundColor', safeCssColor) },
      },
    ]
  },
})

export const SafeFontFamily = FontFamily.extend({
  addGlobalAttributes() {
    return [
      { types: this.options.types, attributes: { fontFamily: validatedStyle('font-family', 'fontFamily', safeFontFamily) } },
    ]
  },
})

export const SafeFontSize = FontSize.extend({
  addGlobalAttributes() {
    return [{ types: this.options.types, attributes: { fontSize: validatedStyle('font-size', 'fontSize', safeFontSize) } }]
  },
})

/**
 * Marks a table made in Oreneta, which is sent with a visible grid. A table
 * that came in with quoted or pasted mail is usually layout and keeps no
 * borders. A class rather than a `data-` attribute: the sanitizer that reads
 * stored mail keeps `class`, so a draft reopened from the server keeps it.
 */
export const GRID_TABLE_CLASS = 'oreneta-table'

// The editor draws a table through this view, not through renderHTML, so the
// class has to be put on its <table> here too for the grid to show while
// writing.
class GridTableView extends TableView {
  constructor(node: ProseMirrorNode, cellMinWidth: number) {
    super(node, cellMinWidth)
    this.table.classList.toggle(GRID_TABLE_CLASS, Boolean(node.attrs.grid))
  }

  update(node: ProseMirrorNode) {
    if (!super.update(node)) return false
    this.table.classList.toggle(GRID_TABLE_CLASS, Boolean(node.attrs.grid))
    return true
  }
}

export const GridTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      grid: {
        default: true,
        parseHTML: (element: HTMLElement) => element.classList.contains(GRID_TABLE_CLASS),
        renderHTML: (attributes: Record<string, unknown>) => (attributes.grid ? { class: GRID_TABLE_CLASS } : {}),
      },
    }
  },
})

/**
 * The most columns or rows one cell may span. Quoted mail is untrusted, and the
 * table code walks a cell's span one column at a time: `colspan="2000000000"`
 * would hang the composer when the reply opens.
 */
export const MAX_TABLE_SPAN = 50

/** A span as a whole number within 1..MAX_TABLE_SPAN; 1 for anything else. */
export function clampSpan(raw: unknown): number {
  const span = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(span) || span < 1) return 1
  return Math.min(MAX_TABLE_SPAN, Math.floor(span))
}

function boundedSpans() {
  return {
    colspan: { default: 1, parseHTML: (element: HTMLElement) => clampSpan(element.getAttribute('colspan')) },
    rowspan: { default: 1, parseHTML: (element: HTMLElement) => clampSpan(element.getAttribute('rowspan')) },
  }
}

export const BoundedTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...boundedSpans() }
  },
})

export const BoundedTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...boundedSpans() }
  },
})

const ALIGN_KEYS = new Map<string, Alignment>([
  ['l', 'left'],
  ['e', 'center'],
  ['r', 'right'],
  ['j', 'justify'],
])

/**
 * The formatting command a keydown asks for, or null. Mod is ⌘ on macOS and
 * Ctrl elsewhere: Mod+Shift+L/E/R/J align left, centre, right and justify;
 * Mod+] and Mod+[ increase and decrease the indent. The brackets also take Alt
 * held: on Catalan, Spanish, French or German keyboards `[` and `]` are typed
 * with AltGr, which arrives as Ctrl+Alt.
 */
export function formattingCommandFor(event: KeyboardEvent): ((editor: Editor) => boolean) | null {
  const mod = isMac ? event.metaKey : event.ctrlKey
  const otherMod = isMac ? event.ctrlKey : event.metaKey
  if (!mod || otherMod) return null
  // The key as typed, whatever it took to type it (AltGr, Option or Shift).
  if (event.key === ']' || event.key === '[') {
    return event.key === ']'
      ? (editor) => editor.chain().focus().increaseIndent().run()
      : (editor) => editor.chain().focus().decreaseIndent().run()
  }
  if (event.altKey || !event.shiftKey) return null
  const to = ALIGN_KEYS.get(event.key.toLowerCase())
  return to ? (editor) => editor.chain().focus().setTextAlign(to).run() : null
}

/**
 * The formatting chords, owned by the editor while it has the keyboard.
 * Mod+Shift+R aligns right here and syncs the mailbox everywhere else (owner,
 * 2026-10-17): the keydown stops at the editor so the window-level shortcut
 * handler never sees it. Runs before every other keymap, the alignment
 * extension's own included.
 */
export const FormattingShortcuts = Extension.create({
  name: 'formattingShortcuts',
  priority: 1000,
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('formattingShortcuts'),
        props: {
          handleKeyDown: (_view, event) => {
            const run = formattingCommandFor(event)
            if (!run) return false
            event.stopPropagation()
            run(editor)
            return true
          },
        },
      }),
    ]
  },
})

/** Everything #274 adds to the composer's editor, in one place for the tests. */
export function richTextExtensions(): Extensions {
  return [
    TextStyle,
    SafeFontFamily,
    SafeFontSize,
    SafeColor,
    SafeBackgroundColor,
    TextAlign.configure({ types: [...INDENTABLE_TYPES], alignments: [...ALIGNMENTS] }),
    // No column resizing: the sent table carries no fixed widths.
    GridTable.configure({ resizable: false, View: GridTableView }),
    TableRow,
    BoundedTableHeader,
    BoundedTableCell,
    ParagraphIndent,
    FormattingShortcuts,
  ]
}
