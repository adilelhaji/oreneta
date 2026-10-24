// Limits and pointer dragging for the resizable panes (#212, ADR-0059). Each
// pane keeps its size in settings$ (persisted there); the separator itself is
// components/resizer/PaneResizer, which takes the pointer and the keyboard.

export const THREAD_LIST_WIDTH = { min: 280, max: 560 } as const
/**
 * The thread list's width on a profile that never resized it (#283): room for
 * a sender and a subject on their own lines without taking the reader's.
 */
export const THREAD_LIST_DEFAULT_WIDTH = 360
/** The app's sidebar, expanded beside the content (ADR-0059, ADR-0069 §2). */
export const DETAILS_PANEL_WIDTH = { min: 280, max: 560 } as const
/**
 * The reader's own minimum from 769 px (`min-[769px]:min-w-[360px]` in
 * MessagePane), and what it keeps beside the app's sidebar.
 */
export const READER_ROOM = 360
/**
 * Percent of the board's area: the row less the rail and the folder pane
 * (ADR-0068 §4, #353). Before the folder pane stayed beside a board, it was
 * the whole row.
 */
export const KANBAN_PANE_WIDTH = { min: 25, max: 60 } as const
/**
 * The board's conversation pane is never drawn narrower than the reader in it:
 * 360 px from 769 px, where the reader keeps that much, so it is never cut.
 */
export const KANBAN_PANE_MIN_PX = READER_ROOM
/** Below 769 px the reader has no minimum of its own, and the pane keeps 320 px. */
export const KANBAN_PANE_NARROW_MIN_PX = 320
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

/** The narrowest window the app's sidebar goes beside the content in (ADR-0069 §2). */
export const SIDEBAR_BESIDE_MIN_WINDOW = 1100
/** Below this window there is no minimised strip: the sidebar is only ever an overlay (ADR-0069 §2). */
export const SIDEBAR_STRIP_MIN_WINDOW = 769
/** The minimised strip, 2.5 rem: 40 px at 100 % (ADR-0069 §2). */
export const SIDEBAR_STRIP_REM = 2.5
/** A board's column, in place of mail's list (ADR-0069 §2). */
export const BOARD_COLUMN_ROOM = 280
/** What a module that is not mail keeps beside the sidebar where its piece fixed nothing else: the reader's 360 px. */
export const CONTENT_ROOM = READER_ROOM
/** People's list beside the folder pane, in px (#326): 18 rem before, now in px like the pane. */
export const PEOPLE_LIST_PX = 288
/** Notes' list beside the folder pane, in px (#335): 20 rem before, now in px like the pane. */
export const NOTES_LIST_PX = 320

/**
 * What each module that is not mail keeps beside the folder pane, and so
 * beside the app's sidebar (ADR-0069 §2 and its decision 5, «until its piece
 * fixes another»; owner decision D3 on #360). People and Notes keep the room
 * their pieces fixed: the list and, beside it, the person or the note at the
 * reader's 360 px. Calendar and Tasks fixed no minimum, and Chat and
 * Attachments fixed 360 px (the conversation, the list): 360 px for all four.
 */
export const MODULE_CONTENT_MIN = {
  calendar: CONTENT_ROOM,
  people: PEOPLE_LIST_PX + READER_ROOM,
  tasks: CONTENT_ROOM,
  notes: NOTES_LIST_PX + READER_ROOM,
  chat: CONTENT_ROOM,
  attachments: CONTENT_ROOM,
} as const

export type ContentModule = keyof typeof MODULE_CONTENT_MIN

/**
 * A module's content beside the folder pane (from 1025 px): it asks for its
 * minimum as its flex basis, so the folder pane, whose shrink factor dwarfs
 * this one's, gives way first, down to its 200 px. The app's sidebar goes
 * beside it only where the row leaves those 200 px and this minimum
 * (`appSidebarLayout`), so it never takes the room. It is not a hard minimum:
 * in a row too short even for that (the system's 200 % zoom), the content
 * gives way too rather than scroll the window sideways (ADR-0068 §7).
 */
export function moduleContentStyle(module: ContentModule): { flex: string } {
  return { flex: `1 1 ${MODULE_CONTENT_MIN[module]}px` }
}

/**
 * What the module shows beside the sidebar, which decides the room it keeps:
 * mail's list and reader; a board's column and, when a conversation is open on
 * it, the board's conversation pane; another module's own content.
 */
export type SidebarContent = 'mail' | 'board' | 'board-pane' | ContentModule

const CONTENT_MIN: Record<SidebarContent, number> = {
  mail: THREAD_LIST_WIDTH.min + READER_ROOM,
  board: BOARD_COLUMN_ROOM,
  // The board's conversation pane counts only with a card open, at 360 px
  // from 769 px: below, where there is no strip, the sidebar is an overlay.
  'board-pane': BOARD_COLUMN_ROOM + KANBAN_PANE_MIN_PX,
  ...MODULE_CONTENT_MIN,
}

/** What the frame row has, for the app's sidebar to fit in (ADR-0069 §2). */
export type SidebarRoom = {
  /** The window's width, in CSS px. */
  window: number
  /** The frame row as drawn without the sidebar; 0 or absent when not measured, and the window stands for it. */
  row?: number
  content: SidebarContent
  /** Whether the folder pane is drawn (from 1025 px): only then does its 200 px minimum count. */
  folders: boolean
  /** The narrow module bar's width where it is drawn (769–1024 px), in px. */
  bar?: number
  /** The minimised strip's width: 2.5 rem, so 40 px at 100 % and 80 px at the app's 200 %. */
  strip?: number
}

export type SidebarLayout = {
  /** Expanded, the sidebar goes beside the content; otherwise it can only be an overlay. */
  beside: boolean
  /** Beside, the widest it is drawn: min(560, rest). */
  max: number
  /** The minimised strip is drawn, always beside. */
  strip: boolean
}

/**
 * What the frame row leaves the sidebar (ADR-0069 §2): the row, less the
 * narrow module bar, the folder pane at its minimum (200 px, only where it is
 * drawn), and what the module keeps — mail's list (280 px) and reader
 * (360 px), a board's column (280 px) and its conversation pane (360 px from
 * 769 px) when one is open, or another module's own minimum
 * (MODULE_CONTENT_MIN: 648 px in People, 680 px in Notes, 360 px elsewhere).
 */
export function sidebarRest(room: SidebarRoom): number {
  const row = room.row && room.row > 0 ? room.row : room.window
  const folders = room.folders ? FOLDER_PANE_WIDTH.min : 0
  return Math.floor(row - (room.bar ?? 0) - folders - CONTENT_MIN[room.content])
}

/**
 * How the app's sidebar sits (ADR-0069 §2). Expanded, it goes beside the
 * content from 1100 px where the rest is at least its 280 px minimum, and is
 * at most min(560, rest) wide there: the folder pane and then the list give
 * way to it, down to their minimums. Otherwise it can only be an overlay, at
 * most 85 % of the window, which an action opens and the layout never does.
 * In mail, with the minimums, that is from 1120 px: at 1100 px the rest is
 * 260, at 1180 px 340 and at 1440 px 600 (so 560). At 1100 px it is 540 in
 * Calendar, Tasks, Chat and Attachments, 252 in People (beside from 1128 px)
 * and 220 in Notes (beside from 1160 px).
 *
 * The minimised strip is always beside, from 769 px, where there is room for
 * it next to what the module keeps (at the app's 200 %, the narrow bar and the
 * 80 px strip do not both fit beside mail's minimums just above 769 px).
 */
export function appSidebarLayout(room: SidebarRoom): SidebarLayout {
  const rest = sidebarRest(room)
  const beside = room.window >= SIDEBAR_BESIDE_MIN_WINDOW && rest >= DETAILS_PANEL_WIDTH.min
  const strip = room.window >= SIDEBAR_STRIP_MIN_WINDOW && rest >= (room.strip ?? SIDEBAR_STRIP_REM * 16)
  return { beside, max: beside ? Math.min(DETAILS_PANEL_WIDTH.max, rest) : DETAILS_PANEL_WIDTH.max, strip }
}

/**
 * The board's conversation pane as a percentage of the board's area, as
 * drawn: its pixel minimum (`minPx`, the reader's) raises the smallest
 * percentage that is honoured. Null when the area is too narrow for the pane to
 * be resized at all. Below 600 px the pane takes the whole window instead
 * (App.tsx), which the window decides, not the area (KanbanPaneResizer).
 */
export function kanbanPane(
  stored: number,
  paneWidth: number,
  shellWidth: number,
  minPx: number = KANBAN_PANE_MIN_PX,
): { value: number; limits: PaneLimits } | null {
  if (!(shellWidth > 0)) return { value: clampPaneSize(stored, KANBAN_PANE_WIDTH), limits: KANBAN_PANE_WIDTH }
  const min = Math.max(KANBAN_PANE_WIDTH.min, Math.ceil((minPx / shellWidth) * 100))
  if (min >= KANBAN_PANE_WIDTH.max) return null
  const limits = { min, max: KANBAN_PANE_WIDTH.max }
  const drawn = paneWidth > 0 ? (paneWidth / shellWidth) * 100 : stored
  return { value: clampPaneSize(drawn, limits), limits }
}

/**
 * How wide the board's area asks to be (its flex basis): one column at the
 * width the person chose and, with a conversation open beside the board, the
 * reader's 360 px. Where the row is shorter, the folder pane, which gives way
 * first (FolderPane.tsx), shrinks before the area does, as it does beside the
 * conversation list (ADR-0068 §7).
 */
export function kanbanAreaBase(columnWidth: number, paneOpen: boolean): number {
  return Math.round(columnWidth) + (paneOpen ? KANBAN_PANE_MIN_PX : 0)
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
