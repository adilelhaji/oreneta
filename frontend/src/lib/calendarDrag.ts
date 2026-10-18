/**
 * Moving, resizing and creating events on the day and week grid (#266, #267):
 * the arithmetic, kept apart from the pointer and the keyboard so it can be
 * tested on its own.
 *
 * Every position is read on the wall clock, as the grid is drawn
 * (`lib/calendarGrid`): a day column is 24 hour rows even on the days the
 * clocks change, so 10:00 is the 10:00 row whatever the day's length. A move
 * keeps an event's length in elapsed time.
 *
 * An all-day event is a run of dates stored at midnight UTC with an exclusive
 * end (`allDayLocalDays`); it moves by whole dates, never by hours.
 */

/** The grid step a drag lands on and a key moves by, in minutes. */
export const SNAP_MINUTES = 15

const DAY_MINUTES = 24 * 60
const DAY_SECONDS = 24 * 3600

export type Times = { start: number; end: number }
export type TimedOrAllDay = Times & { all_day: boolean }

/** Which part of an event a drag holds: all of it, or one of its edges. */
export type DragEdge = 'move' | 'start' | 'end'

/** Local midnight of the day holding an instant. */
function localDay(seconds: number): Date {
  const at = new Date(seconds * 1000)
  return new Date(at.getFullYear(), at.getMonth(), at.getDate())
}

/** Minutes past local midnight of an instant, on the wall clock. */
export function minuteOfDay(seconds: number): number {
  const at = new Date(seconds * 1000)
  return at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60
}

/** The instant `minutes` past the local midnight of `day`, on its wall clock. */
export function instantAtMinute(day: Date, minutes: number): number {
  return Math.floor(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, Math.round(minutes)).getTime() / 1000)
}

/** The nearest grid line to an instant, on the wall clock of its day. */
export function snapInstant(seconds: number, step = SNAP_MINUTES): number {
  return instantAtMinute(localDay(seconds), Math.round(minuteOfDay(seconds) / step) * step)
}

/**
 * The instant under a point of a day column, `offsetPx` from its top, with
 * `hourPx` pixels per hour. A point above or below the column is its first or
 * last instant.
 */
export function instantAtOffset(day: Date, offsetPx: number, hourPx: number): number {
  const minutes = Math.min(Math.max((offsetPx / hourPx) * 60, 0), DAY_MINUTES)
  return instantAtMinute(day, minutes)
}

/**
 * Where a drag on the hour grid puts an event, or null when it puts it where
 * it already is.
 *
 * `from` is the instant under the pointer when the drag began and `to` the one
 * under it now. The pointer's travel is read on the wall clock — so many
 * days, so many minutes — and the edge held moves by the same, then lands on
 * the nearest grid line: an event at 14:37 dragged an hour down starts at
 * 15:30, not at 15:37, and one dragged to the next day keeps its hour even
 * when the clocks change in between. A pointer that moved less than half a
 * step changes nothing: an event off the grid is not pulled onto it by a
 * nudge. A resize never makes an event shorter than one step.
 */
export function draggedTimes(edge: DragEdge, event: Times, from: number, to: number, step = SNAP_MINUTES): Times | null {
  const days = daysBetween(localDay(from), localDay(to))
  const minutes = minuteOfDay(to) - minuteOfDay(from)
  if (days === 0 && Math.abs(minutes) < step / 2) return null
  const travelled = (edgeAt: number) => snapInstant(onClock(edgeAt, days, minutes), step)
  const shortest = step * 60
  let result: Times
  if (edge === 'move') {
    const start = travelled(event.start)
    result = { start, end: start + (event.end - event.start) }
  } else if (edge === 'start') {
    result = { start: Math.min(travelled(event.start), event.end - shortest), end: event.end }
  } else {
    result = { start: event.start, end: Math.max(travelled(event.end), event.start + shortest) }
  }
  return result.start === event.start && result.end === event.end ? null : result
}

/** An instant moved on the wall clock: so many days later, then so many minutes. */
function onClock(seconds: number, days: number, minutes: number): number {
  const day = localDay(seconds)
  return instantAtMinute(new Date(day.getFullYear(), day.getMonth(), day.getDate() + days), minuteOfDay(seconds) + minutes)
}

/** Calendar days from one local day to another, counted on dates: a clock change does not shift it. */
export function daysBetween(from: Date, to: Date): number {
  const date = (day: Date) => Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())
  return Math.round((date(to) - date(from)) / (DAY_SECONDS * 1000))
}

/**
 * An event moved by whole days, keeping its time of day: its dates for an
 * all-day event, its wall-clock time for a timed one. Null for no days.
 */
export function shiftedByDays(event: TimedOrAllDay, days: number): Times | null {
  if (days === 0) return null
  if (event.all_day) return { start: event.start + days * DAY_SECONDS, end: event.end + days * DAY_SECONDS }
  const at = new Date(event.start * 1000)
  const start = Math.floor(
    new Date(
      at.getFullYear(),
      at.getMonth(),
      at.getDate() + days,
      at.getHours(),
      at.getMinutes(),
      at.getSeconds(),
    ).getTime() / 1000,
  )
  return { start, end: start + (event.end - event.start) }
}

/** The local day an event begins on: its first date for an all-day event. */
export function firstDayOf(event: TimedOrAllDay): Date {
  if (!event.all_day) return localDay(event.start)
  const date = new Date(event.start * 1000)
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/** An event moved to another day, keeping its time (a drop on the mini calendar). Null for its own day. */
export function movedToDay(event: TimedOrAllDay, day: Date): Times | null {
  return shiftedByDays(event, daysBetween(firstDayOf(event), day))
}

/** The grid line `steps` lines after (or, negative, before) a minute; a minute off the grid counts its nearest line in that direction as the first. */
function gridLineFrom(minutes: number, steps: number, step: number): number {
  if (steps === 0) return minutes
  const base = steps > 0 ? Math.floor(minutes / step) : Math.ceil(minutes / step)
  return (base + steps) * step
}

/** One press of the keyboard alternative to dragging. */
export type Nudge = { edge: 'move' | 'end'; days: number; steps: number }

/**
 * Where a keyboard nudge puts an event, from where it is shown now.
 *
 * A move by days keeps the time of day (dates for an all-day event); a move
 * by steps goes to the next grid line in that direction, so an event at 14:37
 * goes to 14:45 or 14:30. Changing the end moves it a step (a day for an
 * all-day event) and never below one step (one day) of length. Steps do not
 * apply to an all-day event, which has no time of day.
 */
export function nudgedTimes(event: TimedOrAllDay, current: Times, nudge: Nudge, step = SNAP_MINUTES): Times {
  const shown = { ...event, ...current }
  if (nudge.edge === 'end') {
    if (event.all_day) {
      const end = Math.max(current.end + (nudge.days + nudge.steps) * DAY_SECONDS, current.start + DAY_SECONDS)
      return { start: current.start, end }
    }
    if (nudge.steps === 0) return current
    const day = localDay(current.end)
    const end = Math.max(instantAtMinute(day, gridLineFrom(minuteOfDay(current.end), nudge.steps, step)), current.start + step * 60)
    return { start: current.start, end }
  }
  let moved: Times = current
  if (nudge.days !== 0) moved = shiftedByDays(shown, nudge.days) ?? current
  if (nudge.steps !== 0 && !event.all_day) {
    const start = instantAtMinute(localDay(moved.start), gridLineFrom(minuteOfDay(moved.start), nudge.steps, step))
    moved = { start, end: start + (moved.end - moved.start) }
  }
  return moved
}

/**
 * The range a drag across a day column covers, between two points given in
 * minutes past midnight: from the grid line at or before the earlier to the
 * one at or after the later, at least one step long and inside the day.
 */
export function selectedRange(day: Date, a: number, b: number, step = SNAP_MINUTES): Times {
  const clamp = (minutes: number) => Math.min(Math.max(minutes, 0), DAY_MINUTES)
  const low = Math.min(Math.floor(clamp(Math.min(a, b)) / step) * step, DAY_MINUTES - step)
  const high = Math.max(Math.ceil(clamp(Math.max(a, b)) / step) * step, low + step)
  return { start: instantAtMinute(day, low), end: instantAtMinute(day, high) }
}

/** The grid slot holding a minute of a day: its start, on the line at or before it. */
export function slotStart(day: Date, minutes: number, step = SNAP_MINUTES): number {
  const clamped = Math.min(Math.max(minutes, 0), DAY_MINUTES - step)
  return instantAtMinute(day, Math.floor(clamped / step) * step)
}

/** A new all-day event on a local day: that date at midnight UTC, one date long. */
export function allDayOn(day: Date): Times {
  const start = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / 1000
  return { start, end: start + DAY_SECONDS }
}

/** What a pointer drag holds, as the drop arithmetic needs it. */
export type HeldDrag = {
  edge: DragEdge
  event: TimedOrAllDay
  /** The local day (local-midnight epoch ms) it was picked up on. */
  day: number
  /** The instant under the pointer when it was picked up from the hour grid; null from the all-day strip. */
  from: number | null
}

/** What is under the pointer: an hour-grid column, an all-day cell or a mini-calendar day. */
export type DropTarget = { area: 'grid' | 'allDay' | 'mini'; day: number }

/**
 * Where a held event would land, or null for where it already is.
 *
 * - On a day of the mini calendar: that day, keeping its time (a move only).
 * - On a column of the hour grid, picked up from the grid: by the pointer's
 *   travel (`draggedTimes`); `to` is the instant under the pointer, null when
 *   the pointer is outside the visible part of the grid.
 * - Anywhere else (the all-day strip, or a strip event over the grid): by
 *   whole days from the day it was picked up on. An edge held over anything
 *   but the grid stays where it was.
 */
export function landingTimes(held: HeldDrag, target: DropTarget | undefined, to: number | null): Times | null {
  if (!target) return null
  if (target.area === 'mini') return held.edge === 'move' ? movedToDay(held.event, new Date(target.day)) : null
  if (target.area === 'grid' && held.from !== null) {
    return to === null ? null : draggedTimes(held.edge, held.event, held.from, to)
  }
  if (held.edge !== 'move') return null
  return shiftedByDays(held.event, daysBetween(new Date(held.day), new Date(target.day)))
}
