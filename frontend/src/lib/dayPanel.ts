// The sidebar's Dia panel (ADR-0069 §3): one calendar day, all-day events on
// top and the rest by when they start, with today's time as a line. Pure, so
// the day is testable without a calendar or a clock; the windows are the
// agenda's own (lib/agenda), one day long.

import { allDayLocalDays, type CalendarEvent } from '../states/calendar'
import { addDays, agendaQueryWindow, agendaWindow, occurrenceKey } from './agenda'

/** One event on the day shown. */
export type DayItem = {
  key: string
  event: CalendarEvent
  allDay: boolean
  /** It began on an earlier day (a run of dates, or a meeting past midnight). */
  startsBefore: boolean
  /** It goes on into a later day. */
  endsAfter: boolean
}

export type DayContent = {
  items: DayItem[]
  /**
   * Where the current time's line goes, on today only: before `items[now]`,
   * after the all-day events and the timed ones already under way; `null` on
   * any other day.
   */
  now: number | null
}

/** Local midnight of the day `ms` falls on. */
export const dayOf = (ms: number) => addDays(ms, 0)

/** The day `by` days before or after `day`, as a local midnight, safe across DST. */
export const shiftDay = (day: number, by: number) => addDays(day, by)

/** The day shown, as epoch seconds: its local midnight to the next one. */
export const dayWindow = (day: number) => agendaWindow(day, 1)

/**
 * The window asked of the calendars for the day: the day and one more on each
 * side, as the agenda asks, for all-day dates stored at midnight UTC.
 */
export const dayQueryWindow = (day: number) => agendaQueryWindow(day, 1)

/**
 * The day the panel opens on (ADR-0069 §3, owner decision 3): in Calendar,
 * the day selected there when it opens; elsewhere, today. It does not follow
 * the calendar after that, so that it does not move while it is read.
 */
export function startingDay(inCalendar: boolean, selected: number, now: number): number {
  return dayOf(inCalendar ? selected : now)
}

/**
 * What the panel shows for `day` (a local midnight, or any instant in it).
 *
 * - Not cancelled, as in the agenda (ADR-0059).
 * - An all-day event is a run of dates stored at midnight UTC
 *   (allDayLocalDays): it is on the day when one of its dates is the day,
 *   never by its instants. These come first, by their first date.
 * - Any other event is on the day when it starts on it, or started before and
 *   ends after the day's midnight; a meeting ending at midnight does not
 *   occupy the next morning. These follow, by start, then end, then title.
 * - The same occurrence twice is one.
 */
export function buildDay(events: CalendarEvent[], day: number, now: number): DayContent {
  const start = dayOf(day)
  const end = addDays(start, 1)
  const seen = new Set<string>()
  const allDay: DayItem[] = []
  const firstDate = new Map<string, number>()
  const timed: DayItem[] = []
  for (const event of events) {
    if (event.is_cancelled) continue
    const key = occurrenceKey(event)
    if (seen.has(key)) continue
    if (event.all_day) {
      const dates = allDayLocalDays(event)
      if (!dates.includes(start)) continue
      seen.add(key)
      firstDate.set(key, dates[0])
      allDay.push({
        key,
        event,
        allDay: true,
        startsBefore: dates[0] < start,
        endsAfter: dates[dates.length - 1] > start,
      })
      continue
    }
    const from = event.start * 1000
    const until = Math.max(event.end * 1000, from)
    if (from >= end || (from < start && until <= start)) continue
    seen.add(key)
    timed.push({ key, event, allDay: false, startsBefore: from < start, endsAfter: until > end })
  }
  const title = (item: DayItem) => item.event.subject ?? ''
  allDay.sort((a, b) => firstDate.get(a.key)! - firstDate.get(b.key)! || title(a).localeCompare(title(b)))
  timed.sort((a, b) => a.event.start - b.event.start || a.event.end - b.event.end || title(a).localeCompare(title(b)))
  const items = [...allDay, ...timed]
  if (dayOf(now) !== start) return { items, now: null }
  // Today: the line goes after what has already begun.
  const nowSeconds = now / 1000
  const begun = timed.filter((item) => item.event.start <= nowSeconds).length
  return { items, now: allDay.length + begun }
}
