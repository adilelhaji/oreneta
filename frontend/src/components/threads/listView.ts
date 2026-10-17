// Which renderer the thread list uses at the width it is drawn (#283).
//
// The automatic view draws rows while the list is narrow and the table once
// there is room for its columns. A table squeezed into a narrow list gave the
// sender and the subject a few characters each; a row gives each its own line.

import type { ListView } from '../../states/settings'

/** From this list width, in CSS pixels, the automatic view draws the table. */
export const AUTO_TABLE_MIN_WIDTH = 520

/** What is actually on screen: rows or the table. */
export type DrawnListView = 'cards' | 'table'

/** Whether a list this wide has room for the table's columns. */
export function isWideList(width: number): boolean {
  return width >= AUTO_TABLE_MIN_WIDTH
}

/**
 * The renderer for a chosen view.
 *
 * `drawnWide` says whether the list as drawn is wide enough for the table
 * (`isWideList`); it is null while the list has not been measured (first
 * paint, hidden, or no layout at all). The stored width then stands in for
 * it, because that is the width the list is about to be drawn at unless the
 * window squeezes it.
 */
export function resolveListView(view: ListView, drawnWide: boolean | null, storedWidth: number): DrawnListView {
  switch (view) {
    case 'cards':
    case 'table':
      return view
    case 'auto':
      return (drawnWide ?? isWideList(storedWidth)) ? 'table' : 'cards'
    default: {
      // Hydration only lets known views through, so this is a programming error.
      const unknown: never = view
      throw new Error(`Unknown list view: ${String(unknown)}`)
    }
  }
}
