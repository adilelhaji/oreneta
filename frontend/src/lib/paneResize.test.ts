import { describe, expect, it } from 'bun:test'
import {
  clampPaneSize,
  drawnPane,
  FOLDER_PANE_DEFAULT_WIDTH,
  FOLDER_PANE_WIDTH,
  kanbanAreaBase,
  KANBAN_PANE_MIN_PX,
  KANBAN_PANE_NARROW_MIN_PX,
  kanbanPane,
  READER_ROOM,
  sidebarLayout,
  THREAD_LIST_WIDTH,
} from './paneResize'

describe('pane limits (#212)', () => {
  it('clamps and rounds; something that is not a size is the minimum', () => {
    expect(clampPaneSize(300.4, THREAD_LIST_WIDTH)).toBe(300)
    expect(clampPaneSize(9000, THREAD_LIST_WIDTH)).toBe(560)
    expect(clampPaneSize(NaN, THREAD_LIST_WIDTH)).toBe(280)
    expect(clampPaneSize(Infinity, THREAD_LIST_WIDTH)).toBe(280)
  })

  it('gives the folder pane 260 px by default, between 200 and 400 (ADR-0068 §4, #317)', () => {
    expect(FOLDER_PANE_WIDTH).toEqual({ min: 200, max: 400 })
    expect(FOLDER_PANE_DEFAULT_WIDTH).toBe(260)
    expect(clampPaneSize(FOLDER_PANE_DEFAULT_WIDTH, FOLDER_PANE_WIDTH)).toBe(260)
    expect(clampPaneSize(120, FOLDER_PANE_WIDTH)).toBe(200)
    expect(clampPaneSize(9000, FOLDER_PANE_WIDTH)).toBe(400)
    // Folders squeezed to 230 px on a narrow window: the separator says 230.
    expect(drawnPane(260, 230, FOLDER_PANE_WIDTH)).toEqual({ value: 230, limits: { min: 200, max: 230 } })
  })

  it('states a squeezed pane at the width it is drawn, and no wider than that', () => {
    // Stored 560, drawn 300 on a narrow window: the arrows act on 300.
    expect(drawnPane(560, 300, THREAD_LIST_WIDTH)).toEqual({ value: 300, limits: { min: 280, max: 300 } })
    // Drawn as stored: the full range.
    expect(drawnPane(400, 400, THREAD_LIST_WIDTH)).toEqual({ value: 400, limits: { min: 280, max: 560 } })
    // Not measured yet: the stored width stands.
    expect(drawnPane(400, 0, THREAD_LIST_WIDTH)).toEqual({ value: 400, limits: THREAD_LIST_WIDTH })
    // Home just set 280 and the list is still drawn at 560: the next arrow
    // steps from 280, not from the stale 560 (#283's restart test raced this).
    expect(drawnPane(280, 560, THREAD_LIST_WIDTH)).toEqual({ value: 280, limits: THREAD_LIST_WIDTH })
  })

  it('puts the details sidebar beside the reader only where the row leaves the reader 360 px', () => {
    expect(sidebarLayout(false, 2000)).toEqual({ beside: false, max: 560 })
    expect(sidebarLayout(true, 0)).toEqual({ beside: true, max: 560 })
    expect(sidebarLayout(true, 1200)).toEqual({ beside: true, max: 560 })
    // A 1100–1180 px window: the widest it goes is what the reader leaves.
    expect(sidebarLayout(true, 760)).toEqual({ beside: true, max: 400 })
    expect(sidebarLayout(true, 640)).toEqual({ beside: true, max: 280 })
    // The board's narrow conversation pane on a wide window: an overlay.
    expect(sidebarLayout(true, 400)).toEqual({ beside: false, max: 560 })
  })

  it("raises the board pane's smallest percentage to its reader's 360 px, and gives up where nothing is left", () => {
    expect(KANBAN_PANE_MIN_PX).toBe(READER_ROOM)
    expect(kanbanPane(33, 0, 0)).toEqual({ value: 33, limits: { min: 25, max: 60 } })
    expect(kanbanPane(33, 475, 1440)).toEqual({ value: 33, limits: { min: 25, max: 60 } })
    // A 1000 px area: 360 px is 36 %, so a stored 25 % is drawn, and stated, as 36 %.
    expect(kanbanPane(25, 360, 1000)).toEqual({ value: 36, limits: { min: 36, max: 60 } })
    // A 720 px area (1025 px, the folders given way): 360 px is half of it.
    expect(kanbanPane(33, 360, 720)).toEqual({ value: 50, limits: { min: 50, max: 60 } })
    // Narrower than 600 px, 360 px is more than the 60 % it may take.
    expect(kanbanPane(40, 360, 565)).toBeNull()
    expect(kanbanPane(40, 600, 600)).toBeNull()
  })

  it('keeps 320 px for the board pane below 769 px, and leaves the whole-window case to the window (#353)', () => {
    // Below 769 px the reader has no minimum: the pane keeps 320 px.
    expect(kanbanPane(25, 320, 1000, KANBAN_PANE_NARROW_MIN_PX)).toEqual({ value: 32, limits: { min: 32, max: 60 } })
    // An area under 600 px in a wider window still has its separator; only a
    // window under 600 px gives the pane the whole width (KanbanPaneResizer).
    expect(kanbanPane(40, 320, 580, KANBAN_PANE_NARROW_MIN_PX)).toEqual({ value: 56, limits: { min: 56, max: 60 } })
    expect(kanbanPane(40, 210, 520, KANBAN_PANE_NARROW_MIN_PX)).toBeNull()
  })

  it("asks for one column and, with a conversation open, the reader's 360 px for the board's area (#353)", () => {
    expect(kanbanAreaBase(360, false)).toBe(360)
    expect(kanbanAreaBase(360, true)).toBe(720)
    expect(kanbanAreaBase(240.4, true)).toBe(600)
  })
})
