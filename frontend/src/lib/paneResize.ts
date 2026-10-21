// Limits and pointer dragging for the resizable panes (#212, ADR-0059). Each
// pane keeps its size in settings$ (persisted there); the separator itself is
// components/resizer/PaneResizer, which takes the pointer and the keyboard.

export const THREAD_LIST_WIDTH = { min: 280, max: 560 } as const
/**
 * The thread list's width on a profile that never resized it (#283): room for
 * a sender and a subject on their own lines without taking the reader's.
 */
export const THREAD_LIST_DEFAULT_WIDTH = 360
/** Percent of the app shell. */
export const KANBAN_PANE_WIDTH = { min: 25, max: 60 } as const
/** The board's conversation pane is never drawn narrower than this, whatever its percentage. */
export const KANBAN_PANE_MIN_PX = 320
export const DETAILS_PANEL_WIDTH = { min: 280, max: 560 } as const
/** What the reader keeps beside the details sidebar when it sits next to it. */
export const READER_ROOM = 360
/** The common folder pane (ADR-0068 §4): one width for every module, in px. */
export const FOLDER_PANE_WIDTH = { min: 200, max: 400 } as const
export const FOLDER_PANE_DEFAULT_WIDTH = 260

export type PaneLimits = { readonly min: number; readonly max: number }

/** A size within its pane's limits, rounded. Something that is not a finite number is the minimum. */
export function clampPaneSize(value: number, limits: PaneLimits): number {
  if (!Number.isFinite(value)) return limits.min
  return Math.round(Math.min(limits.max, Math.max(limits.min, value)))
}

/**
 * What a separator states and moves: the size as drawn, and the largest size
 * that would still be drawn.
 *
 * A pane squeezed by a narrow window is drawn narrower than its stored size;
 * stating the stored size would make the arrow keys do nothing visible until
 * they had worked their way down to what is on screen. `drawn` is 0 when it
 * has not been measured (no layout yet), and the stored size stands.
 *
 * Drawn wider than stored is a measurement that has not caught up with a new,
 * smaller size yet (Home, then an arrow, before the next layout): the stored
 * size stands, or the arrow would step from the old width and be lost.
 */
export function drawnPane(stored: number, drawn: number, limits: PaneLimits): { value: number; limits: PaneLimits } {
  if (!(drawn > 0)) return { value: clampPaneSize(stored, limits), limits }
  // Squeezed: growing it further would not show, so this is as wide as it goes.
  if (drawn < stored - 0.5) {
    const value = clampPaneSize(drawn, limits)
    return { value, limits: { min: limits.min, max: Math.max(limits.min, value) } }
  }
  return { value: clampPaneSize(stored, limits), limits }
}

/**
 * How the details sidebar sits (ADR-0059): beside the reader only on a wide
 * window and where its row leaves the reader its room; otherwise as an
 * overlay. `rowWidth` is 0 when not measured, and the window alone decides.
 * The board's conversation pane can be narrow on a wide window, which is why
 * the row is measured rather than the window alone trusted.
 */
export function sidebarLayout(wideWindow: boolean, rowWidth: number): { beside: boolean; max: number } {
  if (!wideWindow) return { beside: false, max: DETAILS_PANEL_WIDTH.max }
  if (!(rowWidth > 0)) return { beside: true, max: DETAILS_PANEL_WIDTH.max }
  const room = Math.floor(rowWidth - READER_ROOM)
  if (room < DETAILS_PANEL_WIDTH.min) return { beside: false, max: DETAILS_PANEL_WIDTH.max }
  return { beside: true, max: Math.min(DETAILS_PANEL_WIDTH.max, room) }
}

/**
 * The board's conversation pane as a percentage of the shell, as drawn: its
 * pixel minimum raises the smallest percentage that is honoured. Null when
 * the shell is too narrow for the pane to be resized at all.
 */
export function kanbanPane(stored: number, paneWidth: number, shellWidth: number): { value: number; limits: PaneLimits } | null {
  if (!(shellWidth > 0)) return { value: clampPaneSize(stored, KANBAN_PANE_WIDTH), limits: KANBAN_PANE_WIDTH }
  // At 600 px and below the pane takes the whole shell (App.tsx).
  if (shellWidth <= 600) return null
  const min = Math.max(KANBAN_PANE_WIDTH.min, Math.ceil((KANBAN_PANE_MIN_PX / shellWidth) * 100))
  if (min >= KANBAN_PANE_WIDTH.max) return null
  const limits = { min, max: KANBAN_PANE_WIDTH.max }
  const drawn = paneWidth > 0 ? (paneWidth / shellWidth) * 100 : stored
  return { value: clampPaneSize(drawn, limits), limits }
}

/**
 * Follows the pointer until it is released, cancelled or its capture lost.
 * The pointer is captured on the separator, so a drag that crosses the
 * reader's frame keeps reporting here instead of stopping in the frame with
 * the cursor and text selection still held.
 */
export function beginDrag(onMove: (event: PointerEvent) => void, capture?: { element: Element; pointerId: number }) {
  let done = false
  const onUp = () => {
    if (done) return
    done = true
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    capture?.element.removeEventListener('lostpointercapture', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  if (capture) {
    try {
      capture.element.setPointerCapture?.(capture.pointerId)
    } catch {
      // No such pointer (a synthetic event): the window listeners still follow it.
    }
    capture.element.addEventListener('lostpointercapture', onUp)
  }
  return onUp
}
