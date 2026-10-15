// Limits and pointer dragging for the resizable panes (#212, ADR-0059). Each
// pane keeps its size in settings$ (persisted there); the separator itself is
// components/resizer/PaneResizer, which takes the pointer and the keyboard.

export const THREAD_LIST_WIDTH = { min: 280, max: 560 } as const
/** Percent of the app shell. */
export const KANBAN_PANE_WIDTH = { min: 25, max: 60 } as const
export const DETAILS_PANEL_WIDTH = { min: 280, max: 560 } as const

export type PaneLimits = { readonly min: number; readonly max: number }

/** A size within its pane's limits, rounded; a value that is not a number is not a size. */
export function clampPaneSize(value: number, limits: PaneLimits): number {
  return Math.round(Math.min(limits.max, Math.max(limits.min, value)))
}

/**
 * Follows the pointer until it is released. The cursor and text selection
 * are held for the whole drag so a fast move over text does not select it.
 */
export function beginDrag(onMove: (event: PointerEvent) => void) {
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}
