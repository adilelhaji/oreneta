import { Extension, getStyleProperty } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'

// Paragraph indent (#274, ADR-0067). tiptap has no indent extension of its
// own, so this one is ours: a level from 0 to MAX_INDENT on paragraphs and
// headings. The editor shows it from `data-indent` (index.css); the sent HTML
// gets a physical margin per level from `inlineRichStyles`, on the side the
// paragraph's direction puts first. Inside a list the indent is the list's
// own (sink and lift the item), as the starter kit's Tab already does.

export const MAX_INDENT = 8
export const INDENT_STEP_PX = 40
export const INDENTABLE_TYPES = ['paragraph', 'heading'] as const

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphIndent: {
      /** One level more: the list item in a list, the blocks of the selection elsewhere. */
      increaseIndent: () => ReturnType
      /** One level less; nothing to do at level 0 outside a list. */
      decreaseIndent: () => ReturnType
    }
  }
}

export function clampIndent(value: unknown): number {
  const level = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(level)) return 0
  return Math.min(MAX_INDENT, Math.max(0, Math.round(level)))
}

/**
 * The level a block came in with: `data-indent` as the editor writes it, or,
 * where that is gone (the sanitizer that reads stored mail drops `data-*`),
 * the margin `inlineRichStyles` wrote, in steps of INDENT_STEP_PX.
 */
export function parseIndent(element: HTMLElement): number {
  const data = element.getAttribute('data-indent')?.trim()
  if (data && /^\d+$/.test(data)) return clampIndent(Number(data))
  for (const side of ['margin-left', 'margin-right']) {
    const margin = getStyleProperty(element, side)
    const px = margin ? /^(\d+(?:\.\d+)?)px$/i.exec(margin) : null
    if (px) return clampIndent(Number(px[1]) / INDENT_STEP_PX)
  }
  return 0
}

// Moves every paragraph and heading the selection touches one level, within
// 0..MAX_INDENT. True when at least one of them changed.
function shiftIndent(tr: Transaction, dispatch: unknown, step: 1 | -1): boolean {
  const { from, to } = tr.selection
  const types: readonly string[] = INDENTABLE_TYPES
  let changed = false
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!types.includes(node.type.name)) return true
    const current = clampIndent(node.attrs.indent)
    const next = clampIndent(current + step)
    if (next !== current) {
      changed = true
      if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next })
    }
    return false
  })
  return changed
}

export const ParagraphIndent = Extension.create({
  name: 'paragraphIndent',

  addGlobalAttributes() {
    return [
      {
        types: [...INDENTABLE_TYPES],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element: HTMLElement) => parseIndent(element),
            renderHTML: (attributes: Record<string, unknown>) => {
              const level = clampIndent(attributes.indent)
              return level ? { 'data-indent': String(level) } : {}
            },
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      increaseIndent:
        () =>
        ({ editor, commands, tr, dispatch }) =>
          editor.isActive('listItem') ? commands.sinkListItem('listItem') : shiftIndent(tr, dispatch, 1),
      decreaseIndent:
        () =>
        ({ editor, commands, tr, dispatch }) =>
          editor.isActive('listItem') ? commands.liftListItem('listItem') : shiftIndent(tr, dispatch, -1),
    }
  },
})
