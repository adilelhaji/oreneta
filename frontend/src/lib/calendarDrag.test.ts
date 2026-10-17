import { describe, expect, it } from 'bun:test'
import {
  SNAP_MINUTES,
  allDayOn,
  daysBetween,
  draggedTimes,
  firstDayOf,
  instantAtOffset,
  movedToDay,
  nudgedTimes,
  selectedRange,
  shiftedByDays,
  slotStart,
  snapInstant,
} from './calendarDrag'

// Moving, resizing and creating events on the grid (#266, #267). Every case is
// written on the local wall clock, so it holds in any zone; CI runs this file
// again in Europe/Madrid, where 25 October 2026 lasts 25 hours.

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime() / 1000
const clock = (seconds: number) => {
  const date = new Date(seconds * 1000)
  return [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()]
}
const HOUR = 3600

describe('snapping to the grid', () => {
  it('snaps to the nearest 15-minute line', () => {
    expect(SNAP_MINUTES).toBe(15)
    expect(clock(snapInstant(at(2026, 9, 13, 14, 37)))).toEqual([2026, 9, 13, 14, 30])
    expect(clock(snapInstant(at(2026, 9, 13, 14, 38)))).toEqual([2026, 9, 13, 14, 45])
    expect(clock(snapInstant(at(2026, 9, 13, 23, 55)))).toEqual([2026, 9, 14, 0, 0])
  })

  it('reads a point of a column on the wall clock, inside the day', () => {
    const day = new Date(2026, 9, 25)
    // 52 px per hour: 10:00 is 520 px down, even on a 25-hour day.
    expect(clock(instantAtOffset(day, 520, 52))).toEqual([2026, 9, 25, 10, 0])
    expect(clock(instantAtOffset(day, -40, 52))).toEqual([2026, 9, 25, 0, 0])
    expect(clock(instantAtOffset(day, 99999, 52))).toEqual([2026, 9, 26, 0, 0])
  })
})

describe('dragging on the hour grid', () => {
  const event = { start: at(2026, 9, 13, 14, 37), end: at(2026, 9, 13, 15, 37) }
  const from = at(2026, 9, 13, 15, 0)

  it('moves by the pointer and lands the start on the nearest line, keeping the length', () => {
    const moved = draggedTimes('move', event, from, from + HOUR)!
    expect(clock(moved.start)).toEqual([2026, 9, 13, 15, 30])
    expect(moved.end - moved.start).toBe(HOUR)
  })

  it('moves to another day at the same pointer time', () => {
    const moved = draggedTimes('move', event, from, at(2026, 9, 15, 15, 0))!
    expect(clock(moved.start)).toEqual([2026, 9, 15, 14, 30])
  })

  it('changes nothing for a nudge of less than half a step', () => {
    expect(draggedTimes('move', event, from, from + 7 * 60)).toBeNull()
    expect(draggedTimes('end', event, from, from - 7 * 60)).toBeNull()
  })

  it('resizes the start or the end, never below one step', () => {
    const later = draggedTimes('start', event, from, from + 30 * 60)!
    expect(clock(later.start)).toEqual([2026, 9, 13, 15, 0])
    expect(later.end).toBe(event.end)
    const longer = draggedTimes('end', event, from, from + 45 * 60)!
    expect(clock(longer.end)).toEqual([2026, 9, 13, 16, 15])
    expect(longer.start).toBe(event.start)
    const crushed = draggedTimes('end', event, from, from - 5 * HOUR)!
    expect(crushed.end - crushed.start).toBe(SNAP_MINUTES * 60)
    const inverted = draggedTimes('start', event, from, from + 5 * HOUR)!
    expect(inverted.end - inverted.start).toBe(SNAP_MINUTES * 60)
  })

  it('keeps the wall clock across the end of summer time', () => {
    // 09:00–10:00 on Saturday 24 October, held at 09:30 and dropped on Sunday
    // at 09:30: Sunday at 09:00, an hour long, whatever the zone.
    const saturday = { start: at(2026, 9, 24, 9), end: at(2026, 9, 24, 10) }
    const moved = draggedTimes('move', saturday, at(2026, 9, 24, 9, 30), at(2026, 9, 25, 9, 30))!
    expect(clock(moved.start)).toEqual([2026, 9, 25, 9, 0])
    expect(moved.end - moved.start).toBe(HOUR)
  })
})

describe('moving by whole days', () => {
  it('counts calendar days, not 24-hour spans', () => {
    expect(daysBetween(new Date(2026, 9, 24), new Date(2026, 9, 26))).toBe(2)
    expect(daysBetween(new Date(2026, 9, 26), new Date(2026, 9, 24))).toBe(-2)
    expect(daysBetween(new Date(2026, 2, 28), new Date(2026, 2, 30))).toBe(2)
  })

  it('keeps a timed event at its hour and an all-day event on whole dates', () => {
    const timed = { start: at(2026, 9, 24, 9), end: at(2026, 9, 24, 10), all_day: false }
    const shifted = shiftedByDays(timed, 1)!
    expect(clock(shifted.start)).toEqual([2026, 9, 25, 9, 0])
    expect(shiftedByDays(timed, 0)).toBeNull()
    const holiday = { ...allDayOn(new Date(2026, 9, 24)), all_day: true }
    const later = shiftedByDays(holiday, 3)!
    expect(later.start).toBe(Date.UTC(2026, 9, 27) / 1000)
    expect(later.end - later.start).toBe(24 * HOUR)
  })

  it('drops on a mini-calendar day keeping the time, or the dates', () => {
    const timed = { start: at(2026, 9, 13, 14, 37), end: at(2026, 9, 13, 15, 7), all_day: false }
    const moved = movedToDay(timed, new Date(2026, 10, 2))!
    expect(clock(moved.start)).toEqual([2026, 10, 2, 14, 37])
    expect(moved.end - moved.start).toBe(30 * 60)
    expect(movedToDay(timed, new Date(2026, 9, 13))).toBeNull()
    const holiday = { start: Date.UTC(2026, 9, 12) / 1000, end: Date.UTC(2026, 9, 14) / 1000, all_day: true }
    expect(firstDayOf(holiday).getDate()).toBe(12)
    const dropped = movedToDay(holiday, new Date(2026, 9, 20))!
    expect(dropped).toEqual({ start: Date.UTC(2026, 9, 20) / 1000, end: Date.UTC(2026, 9, 22) / 1000 })
  })
})

describe('the keyboard alternative', () => {
  const event = { start: at(2026, 9, 13, 14, 37), end: at(2026, 9, 13, 15, 37), all_day: false }

  it('steps to the next line in either direction', () => {
    const down = nudgedTimes(event, event, { edge: 'move', days: 0, steps: 1 })
    expect(clock(down.start)).toEqual([2026, 9, 13, 14, 45])
    expect(down.end - down.start).toBe(HOUR)
    const up = nudgedTimes(event, event, { edge: 'move', days: 0, steps: -1 })
    expect(clock(up.start)).toEqual([2026, 9, 13, 14, 30])
    const again = nudgedTimes(event, up, { edge: 'move', days: 0, steps: -1 })
    expect(clock(again.start)).toEqual([2026, 9, 13, 14, 15])
  })

  it('moves a day keeping the time, and moves the end a step at a time', () => {
    const next = nudgedTimes(event, event, { edge: 'move', days: 1, steps: 0 })
    expect(clock(next.start)).toEqual([2026, 9, 14, 14, 37])
    const longer = nudgedTimes(event, event, { edge: 'end', days: 0, steps: 1 })
    expect(clock(longer.end)).toEqual([2026, 9, 13, 15, 45])
    expect(longer.start).toBe(event.start)
    let shorter = event as { start: number; end: number }
    for (let i = 0; i < 10; i++) shorter = nudgedTimes(event, shorter, { edge: 'end', days: 0, steps: -1 })
    expect(shorter.end - shorter.start).toBe(SNAP_MINUTES * 60)
  })

  it('moves an all-day event by dates only', () => {
    const holiday = { ...allDayOn(new Date(2026, 9, 13)), all_day: true }
    expect(nudgedTimes(holiday, holiday, { edge: 'move', days: 0, steps: 1 })).toEqual(holiday)
    expect(nudgedTimes(holiday, holiday, { edge: 'move', days: -1, steps: 0 }).start).toBe(Date.UTC(2026, 9, 12) / 1000)
    const two = nudgedTimes(holiday, holiday, { edge: 'end', days: 0, steps: 1 })
    expect(two.end - two.start).toBe(2 * 24 * HOUR)
    expect(nudgedTimes(holiday, holiday, { edge: 'end', days: 0, steps: -1 })).toEqual({
      start: holiday.start,
      end: holiday.end,
    })
  })
})

describe('creating on the grid', () => {
  const day = new Date(2026, 9, 13)

  it('selects from the line before the first point to the line after the second, either way round', () => {
    const range = selectedRange(day, 14 * 60 + 7, 15 * 60 + 20)
    expect(clock(range.start)).toEqual([2026, 9, 13, 14, 0])
    expect(clock(range.end)).toEqual([2026, 9, 13, 15, 30])
    expect(selectedRange(day, 15 * 60 + 20, 14 * 60 + 7)).toEqual(range)
  })

  it('is at least one step long and stays inside the day', () => {
    const tiny = selectedRange(day, 600, 600)
    expect(tiny.end - tiny.start).toBe(SNAP_MINUTES * 60)
    const late = selectedRange(day, 24 * 60, 24 * 60 + 90)
    expect(clock(late.start)).toEqual([2026, 9, 13, 23, 45])
    expect(clock(late.end)).toEqual([2026, 9, 14, 0, 0])
    expect(clock(selectedRange(day, -30, 20).start)).toEqual([2026, 9, 13, 0, 0])
  })

  it('opens a slot on the line at or before the point', () => {
    expect(clock(slotStart(day, 9 * 60 + 14))).toEqual([2026, 9, 13, 9, 0])
    expect(clock(slotStart(day, 9 * 60 + 15))).toEqual([2026, 9, 13, 9, 15])
    expect(clock(slotStart(day, 24 * 60))).toEqual([2026, 9, 13, 23, 45])
  })

  it('makes a new all-day event its date at midnight UTC, one date long', () => {
    expect(allDayOn(day)).toEqual({ start: Date.UTC(2026, 9, 13) / 1000, end: Date.UTC(2026, 9, 14) / 1000 })
  })
})
