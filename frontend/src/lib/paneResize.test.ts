import { describe, expect, it } from 'bun:test'
import { clampPaneSize, drawnPane, kanbanPane, sidebarLayout, THREAD_LIST_WIDTH } from './paneResize'

describe('pane limits (#212)', () => {
  it('clamps and rounds; something that is not a size is the minimum', () => {
    expect(clampPaneSize(300.4, THREAD_LIST_WIDTH)).toBe(300)
    expect(clampPaneSize(9000, THREAD_LIST_WIDTH)).toBe(560)
    expect(clampPaneSize(NaN, THREAD_LIST_WIDTH)).toBe(280)
    expect(clampPaneSize(Infinity, THREAD_LIST_WIDTH)).toBe(280)
  })

  it('states a squeezed pane at the width it is drawn, and no wider than that', () => {
    // Stored 560, drawn 300 on a narrow window: the arrows act on 300.
    expect(drawnPane(560, 300, THREAD_LIST_WIDTH)).toEqual({ value: 300, limits: { min: 280, max: 300 } })
    // Drawn as stored: the full range.
    expect(drawnPane(400, 400, THREAD_LIST_WIDTH)).toEqual({ value: 400, limits: { min: 280, max: 560 } })
    // Not measured yet: the stored width stands.
    expect(drawnPane(400, 0, THREAD_LIST_WIDTH)).toEqual({ value: 400, limits: THREAD_LIST_WIDTH })
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

  it("raises the board pane's smallest percentage to its 320 px minimum, and gives up where nothing is left", () => {
    expect(kanbanPane(33, 0, 0)).toEqual({ value: 33, limits: { min: 25, max: 60 } })
    expect(kanbanPane(33, 475, 1440)).toEqual({ value: 33, limits: { min: 25, max: 60 } })
    // 1000 px shell: 320 px is 32 %, so a stored 25 % is drawn, and stated, as 32 %.
    expect(kanbanPane(25, 320, 1000)).toEqual({ value: 32, limits: { min: 32, max: 60 } })
    expect(kanbanPane(40, 210, 520)).toBeNull()
    expect(kanbanPane(40, 600, 600)).toBeNull()
  })
})
