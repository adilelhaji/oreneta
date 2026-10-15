import { describe, expect, it } from 'bun:test'
import { agendaWindow, buildAgenda } from './agenda'
import type { CalendarEvent } from '../states/calendar'
import type { Task } from '../states/tasks'

// Local wall-clock instants, so the expectations hold in any time zone.
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()
const sec = (ms: number) => Math.floor(ms / 1000)
const NOW = at(15, 10) // Thursday 15 October 2026, 10:00

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

describe('agenda widget order (#212)', () => {
  it('lists overdue tasks first, then each day: all-day events, timed events by start, then tasks by priority', () => {
    const groups = buildAgenda(
      [
        event('standup', at(15, 11), at(15, 11, 15)),
        event('holiday', at(16), at(17), { all_day: true }),
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
      NOW,
    )
    expect(titles(groups)).toEqual([
      ['overdue', ['old invoice']],
      [at(15), ['review', 'standup', 'urgent today', 'normal today']],
      [at(16), ['holiday', 'early', 'lunch', 'tomorrow task']],
    ])
  })

  it('leaves out what is over, cancelled, done, undated or past the seventh day', () => {
    const groups = buildAgenda(
      [
        event('finished', at(15, 8), at(15, 9)),
        event('cancelled', at(15, 12), at(15, 13), { is_cancelled: true }),
        event('day seven', at(21, 9), at(21, 10)),
        event('day eight', at(22, 9), at(22, 10)),
      ],
      [
        task(1, at(16), { completed_at: sec(at(14)) }),
        task(2, null),
        task(3, at(21), { title: 'last day' }),
        task(4, at(22), { title: 'too late' }),
      ],
      NOW,
    )
    expect(titles(groups)).toEqual([[at(21), ['day seven', 'last day']]])
  })

  it('shows an event running since an earlier day under today, once', () => {
    const trip = event('trip', at(13), at(17), { all_day: true })
    const groups = buildAgenda([trip, { ...trip }], [], NOW)
    expect(titles(groups)).toEqual([[at(15), ['trip']]])
  })

  it('names a linked task by its conversation', () => {
    const groups = buildAgenda([], [task(9, at(15), { title: '', subject: 'Re: budget', linked: true })], NOW)
    expect(groups[0].items[0]).toMatchObject({ kind: 'task', title: 'Re: budget' })
  })

  it('asks the calendars for today through the end of the seventh day, by local midnights', () => {
    expect(agendaWindow(NOW)).toEqual({ from: sec(at(15)), to: sec(at(22)) })
    // Across the end of summer time in Europe (25 October) the window still
    // ends on a local midnight.
    expect(agendaWindow(at(24, 23))).toEqual({ from: sec(at(24)), to: sec(at(31)) })
  })
})
