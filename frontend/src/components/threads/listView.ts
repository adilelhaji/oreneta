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

/**
 * The renderer for a chosen view at a list width.
 *
 * `drawnWidth` is 0 while the list has not been measured (first paint, or no
 * layout at all); the stored width then stands in for it, because that is the
 * width the list is about to be drawn at unless the window squeezes it.
 */
export function resolveListView(view: ListView, drawnWidth: number, storedWidth: number): DrawnListView {
  if (view === 'cards' || view === 'table') return view
  if (view !== 'auto') throw new Error(`Unknown list view: ${String(view)}`)
  const width = drawnWidth > 0 ? drawnWidth : storedWidth
  return width >= AUTO_TABLE_MIN_WIDTH ? 'table' : 'cards'
}
