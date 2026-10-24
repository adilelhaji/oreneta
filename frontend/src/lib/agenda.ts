// The sidebar's agenda (#212, ADR-0059): what is coming up, events and tasks
// together, in the order the day will bring them. Pure, so the order is
// testable without a calendar or a clock.

import { allDayLocalDays, type CalendarEvent } from '../states/calendar'
import type { Task } from '../states/tasks'

/** How many days the widget looks ahead, today included. */
export const AGENDA_WIDGET_DAYS = 7

export type AgendaItem =
  | { kind: 'event'; key: string; title: string; at: number; allDay: boolean; event: CalendarEvent }
  | { kind: 'task'; key: string; title: string; at: number; priority: number; task: Task }

/** One heading's worth: tasks already overdue, or one local day. */
export type AgendaGroup = { key: 'overdue' | number; items: AgendaItem[] }

const startOfDay = (ms: number) => {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Local midnight `days` days after the day `ms` falls on, safe across DST. */
export const addDays = (ms: number, days: number) => {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime()
}

/**
 * One occurrence of an event: the same one asked of two overlapping windows,
 * or merged twice, is still one meeting.
 */
export const occurrenceKey = (event: CalendarEvent) =>
  `event:${event.accountId}:${event.calendar_id}:${event.id}:${event.start}`

/** The days shown, as epoch seconds: today's local midnight to the end of the last day. */
export function agendaWindow(now: number, days = AGENDA_WIDGET_DAYS): { from: number; to: number } {
  const today = startOfDay(now)
  return { from: Math.floor(today / 1000), to: Math.floor(addDays(today, days) / 1000) }
}

/**
 * The window asked of the calendars: the days shown and one more on each side.
 * An all-day event is stored at midnight UTC, which is up to a day away from
 * a local midnight; buildAgenda keeps only what falls on the days shown.
 */
export function agendaQueryWindow(now: number, days = AGENDA_WIDGET_DAYS): { from: number; to: number } {
  const { from, to } = agendaWindow(now, days)
  return { from: from - 86_400, to: to + 86_400 }
}

/**
 * Builds the agenda shown in the sidebar.
 *
 * - Events: not cancelled and not over yet, starting before the window ends.
 *   One already under way is listed under today. An all-day event is a run of
 *   dates stored at midnight UTC (allDayLocalDays), so it is placed by those
 *   dates, never by the instants; it is over once its last date is past. An
 *   event of several days appears once, on its first day in the window.
 * - Tasks: open, with a due date on or before the window's last day. A task's
 *   due date is a day, never a time (lib/date), so one due before today is
 *   overdue and comes first under its own heading.
 * - Within a day: events by start (all-day first), then that day's tasks,
 *   higher priority first, then by title.
 */
export function buildAgenda(
  events: CalendarEvent[],
  tasks: Task[],
  now: number,
  days = AGENDA_WIDGET_DAYS,
): AgendaGroup[] {
  const today = startOfDay(now)
  const end = addDays(today, days)
  const nowSeconds = Math.floor(now / 1000)
  const groups = new Map<'overdue' | number, AgendaItem[]>()
  const add = (key: 'overdue' | number, item: AgendaItem) => {
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }

  const seen = new Set<string>()
  for (const event of events) {
    if (event.is_cancelled) continue
    let first: number
    if (event.all_day) {
      const dates = allDayLocalDays(event)
      if (dates[dates.length - 1] < today) continue
      first = dates[0]
    } else {
      if (event.end <= nowSeconds) continue
      first = startOfDay(event.start * 1000)
    }
    if (first >= end) continue
    const key = occurrenceKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    const day = Math.max(first, today)
    add(day, {
      kind: 'event',
      key,
      title: event.subject,
      // An all-day event has no hour: it is ordered by its day.
      at: event.all_day ? Math.floor(day / 1000) : event.start,
      allDay: event.all_day,
      event,
    })
  }

  for (const task of tasks) {
    if (task.completed_at || task.due_at == null) continue
    const day = startOfDay(task.due_at * 1000)
    if (day >= end) continue
    add(day < today ? 'overdue' : day, {
      kind: 'task',
      key: `task:${task.id}`,
      title: task.title || task.subject,
      at: task.due_at,
      priority: task.priority ?? 1,
      task,
    })
  }

  const rank = (item: AgendaItem) => (item.kind === 'event' ? (item.allDay ? 0 : 1) : 2)
  const order = (a: AgendaItem, b: AgendaItem) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    if (a.kind === 'task' && b.kind === 'task') {
      if (a.priority !== b.priority) return b.priority - a.priority
      if (a.at !== b.at) return a.at - b.at
    } else if (a.at !== b.at) {
      return a.at - b.at
    }
    return a.title.localeCompare(b.title)
  }

  const keys = [...groups.keys()].sort((a, b) => (a === 'overdue' ? -1 : b === 'overdue' ? 1 : a - b))
  return keys.map((key) => ({ key, items: groups.get(key)!.sort(order) }))
}
