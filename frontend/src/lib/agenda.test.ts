import { describe, expect, it } from 'bun:test'
import { agendaQueryWindow, agendaWindow, buildAgenda } from './agenda'
import type { CalendarEvent } from '../states/calendar'
import type { Task } from '../states/tasks'

// Local wall-clock instants, read in whatever zone the test runs in.
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()
const sec = (ms: number) => Math.floor(ms / 1000)
// An all-day event is a run of dates stored at midnight UTC, end exclusive
// (states/calendar allDayLocalDays), never at a local midnight.
const utcDay = (day: number) => Date.UTC(2026, 9, day)

const event = (id: string, start: number, end: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  calendar_id: 'cal',
  subject: id,
  start: sec(start),
  end: sec(end),
  all_day: false,
  is_recurring: false,
  is_cancelled: false,
  free_busy: 'busy',
  my_response: '',
  attendees: [],
  accountId: 'work',
  ...extra,
})
const allDay = (id: string, firstDay: number, days = 1) =>
  event(id, utcDay(firstDay), utcDay(firstDay + days), { all_day: true })

const task = (id: number, due: number | null, extra: Partial<Task> = {}): Task => ({
  id,
  thread_id: '',
  account_id: '',
  folder_id: '',
  note: '',
  due_at: due === null ? null : sec(due),
  completed_at: null,
  created_at: 0,
  subject: '',
  from_name: '',
  from_addr: '',
  linked: false,
  title: `task ${id}`,
  priority: 1,
  ...extra,
})

const titles = (groups: ReturnType<typeof buildAgenda>) => groups.map((g) => [g.key, g.items.map((i) => i.title)])

// The zone is the process's own: CI runs this file in UTC and again west and
// east of it (America/Sao_Paulo, Australia/Sydney; test.yml), where an
// all-day date read as an instant lands a day early or lingers a day late.
// Switching TZ inside one Bun process is not used: it leaks into later files.
describe('agenda widget order (#212)', () => {
  it('lists overdue tasks first, then each day: all-day events, timed events by start, then tasks by priority', () => {
    const groups = buildAgenda(
      [
        event('standup', at(15, 11), at(15, 11, 15)),
        allDay('holiday', 16),
        event('review', at(15, 9, 30), at(15, 10, 30)), // under way
        event('lunch', at(16, 13), at(16, 14)),
        event('early', at(16, 8), at(16, 9)),
      ],
      [
        task(1, at(13), { title: 'old invoice' }),
        task(2, at(15), { title: 'normal today', priority: 1 }),
        task(3, at(15), { title: 'urgent today', priority: 2 }),
        task(4, at(16), { title: 'tomorrow task' }),
      ],
      at(15, 10),
    )
    expect(titles(groups)).toEqual([
      ['overdue', ['old invoice']],
      [at(15), ['review', 'standup', 'urgent today', 'normal today']],
      [at(16), ['holiday', 'early', 'lunch', 'tomorrow task']],
    ])
  })

  it('places an all-day event on its own date from morning to late evening', () => {
    const events = [allDay('yesterday', 14), allDay('today', 15), allDay('tomorrow', 16)]
    for (const now of [at(15, 0, 30), at(15, 10), at(15, 23, 30)]) {
      expect(titles(buildAgenda(events, [], now))).toEqual([
        [at(15), ['today']],
        [at(16), ['tomorrow']],
      ])
    }
  })

  it('shows an all-day event of several days once, under today while it runs, until its last date', () => {
    const trip = allDay('trip', 13, 4) // 13th to 16th
    expect(titles(buildAgenda([trip, { ...trip }], [], at(15, 10)))).toEqual([[at(15), ['trip']]])
    expect(titles(buildAgenda([trip], [], at(16, 23, 30)))).toEqual([[at(16), ['trip']]])
    expect(titles(buildAgenda([trip], [], at(17, 0, 30)))).toEqual([])
  })

  it('leaves out what is over, cancelled, done, undated or past the seventh day', () => {
    const groups = buildAgenda(
      [
        event('finished', at(15, 8), at(15, 9)),
        event('cancelled', at(15, 12), at(15, 13), { is_cancelled: true }),
        event('day seven', at(21, 9), at(21, 10)),
        event('day eight', at(22, 9), at(22, 10)),
        allDay('all day seven', 21),
        allDay('all day eight', 22),
      ],
      [
        task(1, at(16), { completed_at: sec(at(14)) }),
        task(2, null),
        task(3, at(21), { title: 'last day' }),
        task(4, at(22), { title: 'too late' }),
      ],
      at(15, 10),
    )
    expect(titles(groups)).toEqual([[at(21), ['all day seven', 'day seven', 'last day']]])
  })

  it('names a linked task by its conversation', () => {
    const groups = buildAgenda([], [task(9, at(15), { title: '', subject: 'Re: budget', linked: true })], at(15, 10))
    expect(groups[0].items[0]).toMatchObject({ kind: 'task', title: 'Re: budget' })
  })

  it('shows today through the seventh day by local midnights, and asks a day more on each side', () => {
    expect(agendaWindow(at(15, 10))).toEqual({ from: sec(at(15)), to: sec(at(22)) })
    expect(agendaQueryWindow(at(15, 10))).toEqual({ from: sec(at(15)) - 86_400, to: sec(at(22)) + 86_400 })
    // Across the end of summer time in Europe (25 October) the window still
    // ends on a local midnight.
    expect(agendaWindow(at(24, 23))).toEqual({ from: sec(at(24)), to: sec(at(31)) })
  })
})
