// Grammar underlines in the rich editor (#105, ADR-0030).
//
// The document is read as plain text with a map back to editor positions, the
// checker runs after a pause in typing, and each issue becomes an underline.
// Underlines move with the text as it is edited and are dropped when their
// text changes; nothing in the document is touched until a suggestion is
// picked, and that is one ordinary, undoable edit that keeps the formatting
// around it.

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { GrammarChecker, GrammarDialect, GrammarIssue, GrammarResult } from '../../lib/grammar'

export type DocText = {
  text: string
  /** Editor position of a text offset, or null where the offset is a
   * separator the document does not contain as text. */
  toPos: (offset: number) => number | null
}

/** The document as plain text: blocks separated by line breaks, a hard break
 * as one, anything that is not text (an image) as nothing. */
export function docText(doc: PMNode): DocText {
  const runs: { offset: number; pos: number; length: number }[] = []
  let text = ''
  let firstBlock = true
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (!firstBlock) text += '\n'
      firstBlock = false
      return true
    }
    if (node.isText && node.text) {
      runs.push({ offset: text.length, pos, length: node.text.length })
      text += node.text
      return false
    }
    if (node.type.name === 'hardBreak') text += '\n'
    return true
  })
  return {
    text,
    toPos(offset) {
      for (const run of runs) {
        if (offset >= run.offset && offset <= run.offset + run.length) return run.pos + (offset - run.offset)
      }
      return null
    },
  }
}

export type PlacedIssue = { from: number; to: number; issue: GrammarIssue }

/** Issues placed in the document; ones that span a block break are left out. */
export function placeIssues(doc: PMNode, issues: GrammarIssue[]): PlacedIssue[] {
  const mapped = docText(doc)
  return issues.flatMap((issue) => {
    const from = mapped.toPos(issue.start)
    const to = mapped.toPos(issue.end)
    if (from === null || to === null || to <= from) return []
    if (doc.textBetween(from, to) !== mapped.text.slice(issue.start, issue.end)) return []
    return [{ from, to, issue }]
  })
}

type GrammarState = { decorations: DecorationSet; placed: PlacedIssue[] }

export const grammarKey = new PluginKey<GrammarState>('grammar')

/** The issue under a document position, if any. */
export function issueAt(state: EditorState, pos: number): PlacedIssue | null {
  return grammarKey.getState(state)?.placed.find((p) => pos >= p.from && pos <= p.to) ?? null
}

/** Applies a suggestion as one undoable edit, keeping the formatting there. */
export function applySuggestion(view: EditorView, placed: PlacedIssue, replacement: string) {
  const tr = view.state.tr.insertText(replacement, placed.from, placed.to)
  tr.setMeta(grammarKey, { removeKey: placed.issue.key, at: placed.from })
  view.dispatch(tr)
}

export type GrammarOptions = {
  checker: GrammarChecker | null
  dialect: () => GrammarDialect | null
  delayMs: number
  onResult: (result: GrammarResult) => void
  /** The checker could not start (its WebAssembly would not load). */
  onError: (error: unknown) => void
  onPick: (placed: PlacedIssue, at: { left: number; top: number }) => void
}

export const GrammarExtension = Extension.create<GrammarOptions>({
  name: 'grammar',

  addOptions() {
    return {
      checker: null,
      dialect: () => null,
      delayMs: 900,
      onResult: () => {},
      onError: () => {},
      onPick: () => {},
    }
  },

  addProseMirrorPlugins() {
    const options = this.options
    let timer: ReturnType<typeof setTimeout> | null = null

    const run = (view: EditorView) => {
      const dialect = options.dialect()
      if (!options.checker || !dialect) {
        view.dispatch(view.state.tr.setMeta(grammarKey, { placed: [] }))
        return
      }
      const doc = view.state.doc
      void options.checker
        .check(docText(doc).text, dialect)
        .then((result) => {
          if (result.state === 'stale' || view.isDestroyed) return
          // Text changed while it was being checked: wait for the next run.
          if (!view.state.doc.eq(doc)) return
          const placed = result.state === 'checked' ? placeIssues(doc, result.issues) : []
          view.dispatch(view.state.tr.setMeta(grammarKey, { placed }))
          options.onResult(result)
        })
        .catch((error) => options.onError(error))
    }

    return [
      new Plugin<GrammarState>({
        key: grammarKey,
        state: {
          init: () => ({ decorations: DecorationSet.empty, placed: [] }),
          apply(tr, value, _old, state) {
            const meta = tr.getMeta(grammarKey) as
              | { placed: PlacedIssue[] }
              | { removeKey: string; at: number }
              | undefined
            if (meta && 'placed' in meta) {
              return {
                placed: meta.placed,
                decorations: DecorationSet.create(
                  state.doc,
                  meta.placed.map((p) =>
                    Decoration.inline(p.from, p.to, { class: 'oreneta-grammar-issue', 'data-grammar': p.issue.kind }),
                  ),
                ),
              }
            }
            if (!tr.docChanged) return value
            // Kept where the text around them moved; dropped where their own
            // text was changed, since the issue may be gone.
            const placed = value.placed.flatMap((p) => {
              if (meta && 'removeKey' in meta && p.issue.key === meta.removeKey && p.from === meta.at) return []
              const from = tr.mapping.map(p.from, 1)
              const to = tr.mapping.map(p.to, -1)
              if (to <= from || state.doc.textBetween(from, to) !== p.issue.problem) return []
              return [{ ...p, from, to }]
            })
            return {
              placed,
              decorations: DecorationSet.create(
                state.doc,
                placed.map((p) =>
                  Decoration.inline(p.from, p.to, { class: 'oreneta-grammar-issue', 'data-grammar': p.issue.kind }),
                ),
              ),
            }
          },
        },
        props: {
          decorations: (state) => grammarKey.getState(state)?.decorations,
          handleClick(view, pos) {
            const placed = issueAt(view.state, pos)
            if (!placed) return false
            const coords = view.coordsAtPos(placed.from)
            options.onPick(placed, { left: coords.left, top: coords.bottom })
            return false
          },
        },
        view(view) {
          if (options.dialect()) timer = setTimeout(() => run(view), options.delayMs)
          return {
            update(updated, previous) {
              if (updated.state.doc.eq(previous.doc)) return
              if (timer) clearTimeout(timer)
              timer = setTimeout(() => run(updated), options.delayMs)
            },
            destroy() {
              if (timer) clearTimeout(timer)
            },
          }
        },
      }),
    ]
  },
})
