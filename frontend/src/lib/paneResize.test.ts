import { describe, expect, it } from 'bun:test'
import {
  appSidebarLayout,
  BOARD_COLUMN_ROOM,
  clampPaneSize,
  CONTENT_ROOM,
  DETAILS_PANEL_WIDTH,
  drawnPane,
  FOLDER_PANE_DEFAULT_WIDTH,
  FOLDER_PANE_WIDTH,
  kanbanAreaBase,
  KANBAN_PANE_MIN_PX,
  KANBAN_PANE_NARROW_MIN_PX,
  kanbanPane,
  MODULE_CONTENT_MIN,
  moduleContentStyle,
  NOTES_LIST_PX,
  PEOPLE_LIST_PX,
  READER_ROOM,
  SIDEBAR_BESIDE_MIN_WINDOW,
  SIDEBAR_STRIP_MIN_WINDOW,
  sidebarRest,
  THREAD_LIST_WIDTH,
  type SidebarRoom,
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

// The app's sidebar (ADR-0069 §2): beside the content from 1100 px where
// rest = row − folders (200, if drawn) − list (280, mail) − content (360) ≥ 280,
// at most min(560, rest); otherwise only an overlay. The strip from 769 px.
describe("the app sidebar's room (ADR-0069 §2, #361)", () => {
  // Mail from 1025 px: the folder pane is drawn; at 100 % the strip is 40 px.
  const mail = (window: number, extra: Partial<SidebarRoom> = {}): SidebarRoom => ({
    window,
    content: 'mail',
    folders: window >= 1025,
    bar: window >= 769 && window < 1025 ? 48 : 0,
    strip: 40,
    ...extra,
  })
  // Calendar: one of the modules that keep the reader's 360 px.
  const other = (window: number, extra: Partial<SidebarRoom> = {}): SidebarRoom => ({
    ...mail(window),
    content: 'calendar',
    ...extra,
  })

  it('uses the minimums of the ADR', () => {
    expect(SIDEBAR_BESIDE_MIN_WINDOW).toBe(1100)
    expect(SIDEBAR_STRIP_MIN_WINDOW).toBe(769)
    expect(DETAILS_PANEL_WIDTH).toEqual({ min: 280, max: 560 })
    expect(FOLDER_PANE_WIDTH.min).toBe(200)
    expect(THREAD_LIST_WIDTH.min).toBe(280)
    expect(CONTENT_ROOM).toBe(360)
    expect(BOARD_COLUMN_ROOM).toBe(280)
  })

  it('in mail with the folders: an overlay at 1100 px, beside from 1120 px, up to 340 px at 1180 and 560 px at 1440', () => {
    // 1100 − 200 − 280 − 360 = 260 < 280.
    expect(sidebarRest(mail(1100))).toBe(260)
    expect(appSidebarLayout(mail(1100))).toEqual({ beside: false, max: 560, strip: true })
    expect(appSidebarLayout(mail(1119)).beside).toBe(false)
    expect(appSidebarLayout(mail(1120))).toEqual({ beside: true, max: 280, strip: true })
    expect(appSidebarLayout(mail(1180))).toEqual({ beside: true, max: 340, strip: true })
    // 1440 − 840 = 600: held to 560.
    expect(sidebarRest(mail(1440))).toBe(600)
    expect(appSidebarLayout(mail(1440))).toEqual({ beside: true, max: 560, strip: true })
  })

  it("in mail without the folder pane, its 200 px are the sidebar's", () => {
    expect(appSidebarLayout(mail(1100, { folders: false }))).toEqual({ beside: true, max: 460, strip: true })
    expect(appSidebarLayout(mail(1440, { folders: false }))).toEqual({ beside: true, max: 560, strip: true })
  })

  it('in Calendar, Tasks, Chat and Attachments: beside from 1100 px, with 540 px of room there', () => {
    // 1100 − 200 − 360 = 540, in each of the four.
    for (const content of ['calendar', 'tasks', 'chat', 'attachments'] as const) {
      expect(MODULE_CONTENT_MIN[content]).toBe(360)
      expect(appSidebarLayout(other(1100, { content }))).toEqual({ beside: true, max: 540, strip: true })
    }
    expect(appSidebarLayout(other(1120))).toEqual({ beside: true, max: 560, strip: true })
    expect(appSidebarLayout(other(1180))).toEqual({ beside: true, max: 560, strip: true })
    expect(appSidebarLayout(other(1440))).toEqual({ beside: true, max: 560, strip: true })
    expect(appSidebarLayout(other(1100, { folders: false }))).toEqual({ beside: true, max: 560, strip: true })
    // Under 1100 px never beside, whatever the room.
    expect(appSidebarLayout(other(1099))).toEqual({ beside: false, max: 560, strip: true })
  })

  // Owner decision D3 on #360: People and Notes keep the room their pieces
  // fixed, the list and the person or the note at the reader's 360 px.
  it('in People and Notes, the room their pieces fixed: an overlay at 1100 px, beside from 1128 and 1160 px', () => {
    expect(PEOPLE_LIST_PX).toBe(288)
    expect(NOTES_LIST_PX).toBe(320)
    expect(MODULE_CONTENT_MIN.people).toBe(PEOPLE_LIST_PX + READER_ROOM)
    expect(MODULE_CONTENT_MIN.notes).toBe(NOTES_LIST_PX + READER_ROOM)
    const people = (window: number) => other(window, { content: 'people' })
    const notes = (window: number) => other(window, { content: 'notes' })
    // 1100 − 200 − 648 = 252, and 1100 − 200 − 680 = 220.
    expect(sidebarRest(people(1100))).toBe(252)
    expect(appSidebarLayout(people(1100))).toEqual({ beside: false, max: 560, strip: true })
    expect(appSidebarLayout(people(1127)).beside).toBe(false)
    expect(appSidebarLayout(people(1128))).toEqual({ beside: true, max: 280, strip: true })
    expect(appSidebarLayout(people(1180))).toEqual({ beside: true, max: 332, strip: true })
    expect(appSidebarLayout(people(1440))).toEqual({ beside: true, max: 560, strip: true })
    expect(sidebarRest(notes(1100))).toBe(220)
    expect(appSidebarLayout(notes(1100))).toEqual({ beside: false, max: 560, strip: true })
    expect(appSidebarLayout(notes(1159)).beside).toBe(false)
    expect(appSidebarLayout(notes(1160))).toEqual({ beside: true, max: 280, strip: true })
    expect(appSidebarLayout(notes(1180))).toEqual({ beside: true, max: 300, strip: true })
    expect(appSidebarLayout(notes(1440))).toEqual({ beside: true, max: 560, strip: true })
    // Beside them, the sidebar leaves the person and the note their 360 px:
    // the row less the folders, the list and the widest sidebar.
    expect(1180 - 200 - PEOPLE_LIST_PX - 332).toBe(360)
    expect(1180 - 200 - NOTES_LIST_PX - 300).toBe(360)
  })

  // Owner decision D6 on #360 (ADR-0069 §2, erratum): the board's
  // conversation pane counts 360 px from 769 px, and only with a card open.
  it('flips a board from beside to the strip between 1100 and 1119 px when a card opens', () => {
    expect(KANBAN_PANE_MIN_PX).toBe(360)
    expect(KANBAN_PANE_NARROW_MIN_PX).toBe(320)
    for (const width of [1100, 1110, 1119]) {
      expect(appSidebarLayout(mail(width, { content: 'board' })).beside).toBe(true)
      expect(appSidebarLayout(mail(width, { content: 'board-pane' })).beside).toBe(false)
    }
    expect(appSidebarLayout(mail(1120, { content: 'board-pane' })).beside).toBe(true)
  })

  it("asks each module's content, beside the folder pane, for its minimum as its basis, not as a hard minimum", () => {
    expect(moduleContentStyle('people')).toEqual({ flex: '1 1 648px' })
    expect(moduleContentStyle('notes')).toEqual({ flex: '1 1 680px' })
    for (const module of ['calendar', 'tasks', 'chat', 'attachments'] as const) {
      expect(moduleContentStyle(module)).toEqual({ flex: '1 1 360px' })
    }
  })

  it('with a board open, its column and its conversation pane count in place of the list and the reader', () => {
    const board = (window: number, pane: boolean) => mail(window, { content: pane ? 'board-pane' : 'board' })
    // A column alone: 1100 − 200 − 280 = 620, held to 560.
    expect(appSidebarLayout(board(1100, false))).toEqual({ beside: true, max: 560, strip: true })
    // With the pane, its 360 px as well, which is mail's sum: as mail.
    expect(KANBAN_PANE_MIN_PX).toBe(360)
    expect(appSidebarLayout(board(1100, true))).toEqual({ beside: false, max: 560, strip: true })
    expect(appSidebarLayout(board(1120, true))).toEqual({ beside: true, max: 280, strip: true })
    expect(appSidebarLayout(board(1180, true))).toEqual({ beside: true, max: 340, strip: true })
    expect(appSidebarLayout(board(1440, true))).toEqual({ beside: true, max: 560, strip: true })
  })

  it('measures the row, drawn without the sidebar, rather than trusting the window', () => {
    // A row narrower than the window: what is left of it is what counts.
    expect(appSidebarLayout(mail(1440, { row: 1100 }))).toEqual({ beside: false, max: 560, strip: true })
    expect(appSidebarLayout(mail(1440, { row: 1180 }))).toEqual({ beside: true, max: 340, strip: true })
    // Not measured (0): the window stands for it.
    expect(appSidebarLayout(mail(1180, { row: 0 }))).toEqual({ beside: true, max: 340, strip: true })
  })

  it('draws the minimised strip from 769 px, beside, and nothing below', () => {
    expect(appSidebarLayout(mail(1024))).toEqual({ beside: false, max: 560, strip: true })
    expect(appSidebarLayout(mail(769))).toEqual({ beside: false, max: 560, strip: true })
    expect(appSidebarLayout(mail(768))).toEqual({ beside: false, max: 560, strip: false })
    expect(appSidebarLayout(mail(600))).toEqual({ beside: false, max: 560, strip: false })
    expect(appSidebarLayout(other(600))).toEqual({ beside: false, max: 560, strip: false })
  })

  it("at the app's 200 %, the 80 px strip where it fits beside the narrow bar and mail's minimums", () => {
    const zoomed = (window: number, content: SidebarRoom['content'] = 'mail') =>
      mail(window, { content, bar: window >= 769 && window < 1025 ? 96 : 0, strip: 80 })
    // 769 − 96 − 640 = 33: no room for it just above 769 px.
    expect(appSidebarLayout(zoomed(769)).strip).toBe(false)
    expect(appSidebarLayout(zoomed(900)).strip).toBe(true)
    expect(appSidebarLayout(zoomed(1024))).toEqual({ beside: false, max: 560, strip: true })
    expect(appSidebarLayout(zoomed(769, 'calendar')).strip).toBe(true)
    // People keeps 648 px: 769 − 96 − 648 = 25, no room for the strip until 824 px.
    expect(appSidebarLayout(zoomed(769, 'people')).strip).toBe(false)
    expect(appSidebarLayout(zoomed(824, 'people')).strip).toBe(true)
    // The widths in px do not grow with the zoom: the same room as at 100 %.
    expect(appSidebarLayout(zoomed(1440))).toEqual({ beside: true, max: 560, strip: true })
  })
})
