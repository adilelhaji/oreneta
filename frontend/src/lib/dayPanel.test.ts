import { describe, expect, it } from 'bun:test'
import { buildDay, dayOf, dayQueryWindow, dayWindow, shiftDay, startingDay } from './dayPanel'
import type { CalendarEvent } from '../states/calendar'

// The sidebar's Dia panel (ADR-0069 §3, #362): one day, all-day events on
// top by their dates, the rest by start, and today's time as a line.

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
const allDay = (id: string, firstDay: number, days = 1, extra: Partial<CalendarEvent> = {}) =>
  event(id, utcDay(firstDay), utcDay(firstDay + days), { all_day: true, ...extra })

const titles = (content: ReturnType<typeof buildDay>) => content.items.map((item) => item.event.subject)
// Another day than the one shown, so that no line is drawn.
const ELSEWHERE = at(1, 12)

// The zone is the process's own: CI runs this file in UTC and again west and
// east of it (America/Sao_Paulo, Australia/Sydney; test.yml), where an
// all-day date read as an instant lands a day early or lingers a day late.
// Switching TZ inside one Bun process is not used: it leaks into later files.
describe('the day panel (#362)', () => {
  it('shows all-day events first, by their dates, then the rest by start, end and title', () => {
    const content = buildDay(
      [
        event('lunch', at(15, 13), at(15, 14)),
        allDay('holiday', 15),
        event('standup', at(15, 9), at(15, 9, 15)),
        allDay('trip', 13, 4), // 13th to 16th: began earlier
        event('review', at(15, 9), at(15, 10)),
        event('also at nine', at(15, 9), at(15, 10)),
        event('late', at(15, 23), at(16, 1)), // into tomorrow
        event('overnight', at(14, 22), at(15, 2)), // since yesterday
      ],
      at(15),
      ELSEWHERE,
    )
    expect(titles(content)).toEqual([
      'trip',
      'holiday',
      'overnight',
      'standup',
      'also at nine',
      'review',
      'lunch',
      'late',
    ])
    expect(content.items.map((item) => [item.event.subject, item.allDay, item.startsBefore, item.endsAfter])).toEqual([
      ['trip', true, true, true],
      ['holiday', true, false, false],
      ['overnight', false, true, false],
      ['standup', false, false, false],
      ['also at nine', false, false, false],
      ['review', false, false, false],
      ['lunch', false, false, false],
      ['late', false, false, true],
    ])
  })

  it('leaves out what is on another day, and a meeting that ends at midnight from the next morning', () => {
    const content = buildDay(
      [
        event('yesterday', at(14, 9), at(14, 10)),
        event('until midnight', at(14, 23), at(15)),
        event('tomorrow', at(16, 0), at(16, 1)),
        event('at midnight', at(15), at(15)), // no length, at the day's start
        event('last minute', at(15, 23, 59), at(16)),
        allDay('yesterday all day', 14),
        allDay('tomorrow all day', 16),
      ],
      at(15, 15),
      ELSEWHERE,
    )
    expect(titles(content)).toEqual(['at midnight', 'last minute'])
  })

  it('places an all-day event on its own date from any hour of the day, and a run of dates on each of them', () => {
    const events = [allDay('yesterday', 14), allDay('today', 15), allDay('tomorrow', 16)]
    for (const day of [at(15), at(15, 0, 30), at(15, 10), at(15, 23, 30)]) {
      expect(titles(buildDay(events, day, ELSEWHERE))).toEqual(['today'])
    }
    expect(titles(buildDay(events, at(14), ELSEWHERE))).toEqual(['yesterday'])
    expect(titles(buildDay(events, at(16), ELSEWHERE))).toEqual(['tomorrow'])
    // The 13th to the 16th: on each of its four dates, and on neither side.
    const trip = allDay('trip', 13, 4)
    for (const day of [13, 14, 15, 16]) expect(titles(buildDay([trip], at(day), ELSEWHERE)), `${day}`).toEqual(['trip'])
    expect(titles(buildDay([trip], at(12), ELSEWHERE))).toEqual([])
    expect(titles(buildDay([trip], at(17), ELSEWHERE))).toEqual([])
    const [first] = buildDay([trip], at(13), ELSEWHERE).items
    const [last] = buildDay([trip], at(16), ELSEWHERE).items
    expect([first.startsBefore, first.endsAfter, last.startsBefore, last.endsAfter]).toEqual([false, true, true, false])
  })

  it('does not show cancelled events, all-day or timed', () => {
    const content = buildDay(
      [
        event('cancelled', at(15, 12), at(15, 13), { is_cancelled: true }),
        allDay('cancelled all day', 15, 1, { is_cancelled: true }),
        event('kept', at(15, 14), at(15, 15)),
      ],
      at(15),
      at(15, 10),
    )
    expect(titles(content)).toEqual(['kept'])
  })

  it('shows the same occurrence once, asked of two windows or merged twice', () => {
    const meeting = event('meeting', at(15, 9), at(15, 10))
    const holiday = allDay('holiday', 15)
    const content = buildDay(
      [meeting, { ...meeting }, holiday, { ...holiday }, { ...meeting, accountId: 'home' }],
      at(15),
      ELSEWHERE,
    )
    expect(titles(content)).toEqual(['holiday', 'meeting', 'meeting'])
  })

  it('draws the current time as a line on today only: after the all-day events and what has begun', () => {
    const events = [
      allDay('holiday', 15),
      event('early', at(15, 8), at(15, 9)),
      event('under way', at(15, 9, 30), at(15, 11)),
      event('at ten', at(15, 10), at(15, 10, 30)),
      event('later', at(15, 14), at(15, 15)),
    ]
    // Before anything has begun: right after the all-day events.
    expect(buildDay(events, at(15), at(15, 7)).now).toBe(1)
    // What starts this very minute has begun.
    expect(buildDay(events, at(15), at(15, 10)).now).toBe(4)
    expect(buildDay(events, at(15), at(15, 12)).now).toBe(4)
    // After the last one: at the end.
    expect(buildDay(events, at(15), at(15, 23, 30)).now).toBe(5)
    // Another day has no line, whatever the hour.
    expect(buildDay(events, at(14), at(15, 12)).now).toBeNull()
    expect(buildDay(events, at(16), at(15, 12)).now).toBeNull()
    // An empty today still has it.
    expect(buildDay([], at(15), at(15, 12))).toEqual({ items: [], now: 0 })
    // Past midnight, the day shown is no longer today.
    expect(buildDay(events, at(15), at(16, 0, 1)).now).toBeNull()
  })

  it('opens on the day selected in Calendar, and on today elsewhere', () => {
    expect(startingDay(true, at(20), at(15, 10))).toBe(at(20))
    expect(startingDay(true, at(20, 16), at(15, 10))).toBe(at(20))
    expect(startingDay(false, at(20), at(15, 10))).toBe(at(15))
  })

  it('moves by local days, and asks the day and one more on each side, across a change of the clocks', () => {
    expect(dayOf(at(15, 18, 45))).toBe(at(15))
    expect(shiftDay(at(15), 1)).toBe(at(16))
    expect(shiftDay(at(15), -1)).toBe(at(14))
    expect(dayWindow(at(15, 10))).toEqual({ from: sec(at(15)), to: sec(at(16)) })
    expect(dayQueryWindow(at(15, 10))).toEqual({ from: sec(at(15)) - 86_400, to: sec(at(16)) + 86_400 })
    // Across the end of summer time in Europe (25 October) the day still ends
    // on a local midnight, and the next one begins there.
    expect(dayWindow(at(25, 12))).toEqual({ from: sec(at(25)), to: sec(at(26)) })
    expect(shiftDay(at(25), 1)).toBe(at(26))
    expect(shiftDay(at(26), -1)).toBe(at(25))
  })
})
