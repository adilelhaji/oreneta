import { describe, expect, it } from 'bun:test'
import { dateGroup, groupByDate } from './dateGroups'

// A Wednesday, so "this week" has days behind it and "last week" is a real
// stretch rather than an edge case.
const NOW = new Date(2026, 8, 2, 14, 0, 0)
const at = (year: number, month: number, day: number, hour = 12) =>
  Math.floor(new Date(year, month, day, hour).getTime() / 1000)

describe('the stretches of time people think in', () => {
  it('names today, yesterday and the days before', () => {
    expect(dateGroup(at(2026, 8, 2, 9), NOW)).toBe('today')
    expect(dateGroup(at(2026, 8, 1, 9), NOW)).toBe('yesterday')
    // Monday of the same week.
    expect(dateGroup(at(2026, 7, 31, 9), NOW)).toBe('thisWeek')
    expect(dateGroup(at(2026, 7, 26, 9), NOW)).toBe('lastWeek')
    expect(dateGroup(at(2026, 7, 5, 9), NOW)).toBe('earlier')
  })

  it('has a this-month stretch only once the month has one', () => {
    // Early in a month there is nothing between last week and the month's
    // start, so the heading simply does not appear — which is right, and is
    // why it is asserted from a date late enough to have one.
    const lateInMonth = new Date(2026, 8, 22, 14)
    expect(dateGroup(at(2026, 8, 3, 9), lateInMonth)).toBe('thisMonth')
    expect(dateGroup(at(2026, 7, 30, 9), lateInMonth)).toBe('earlier')
  })

  it('measures against midnight, not against a count of hours', () => {
    // Eleven last night is yesterday at nine this morning, even though it is
    // ten hours old — because that is what yesterday means to a reader.
    const lateLastNight = at(2026, 8, 1, 23)
    expect(dateGroup(lateLastNight, new Date(2026, 8, 2, 9))).toBe('yesterday')
    // And one minute after midnight is today, one minute old.
    expect(dateGroup(at(2026, 8, 2, 0), new Date(2026, 8, 2, 0, 1))).toBe('today')
  })

  it('starts the week on Monday, as a working calendar does', () => {
    const sunday = new Date(2026, 8, 6, 12)
    // The Monday of the same week is still this week on a Sunday.
    expect(dateGroup(at(2026, 7, 31, 9), sunday)).toBe('thisWeek')
    // And the Sunday before it is not.
    expect(dateGroup(at(2026, 7, 30, 9), sunday)).toBe('lastWeek')
  })

  it('will not put a message with no date under a heading nobody knows', () => {
    // Rare, and inventing "earlier" for it would be asserting something nobody
    // can know.
    expect(dateGroup(0, NOW)).toBe('unknown')
    expect(dateGroup(-1, NOW)).toBe('unknown')
  })

  it('groups consecutive runs and keeps the order it was given', () => {
    const items = [
      { id: 'a', date: at(2026, 8, 2, 10) },
      { id: 'b', date: at(2026, 8, 2, 8) },
      { id: 'c', date: at(2026, 8, 1, 8) },
      { id: 'd', date: at(2026, 5, 1, 8) },
    ]
    const groups = groupByDate(items, (item) => item.date, NOW)
    expect(groups.map((group) => group.group)).toEqual(['today', 'yesterday', 'earlier'])
    expect(groups[0].items.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('does not gather scattered rows under one heading', () => {
    // The list is already ordered; pulling a later "today" up next to an
    // earlier one would silently reorder the list under the reader.
    const items = [
      { id: 'a', date: at(2026, 8, 2, 10) },
      { id: 'b', date: at(2026, 8, 1, 10) },
      { id: 'c', date: at(2026, 8, 2, 9) },
    ]
    const groups = groupByDate(items, (item) => item.date, NOW)
    expect(groups.map((group) => group.group)).toEqual(['today', 'yesterday', 'today'])
    expect(groups.flatMap((group) => group.items.map((item) => item.id))).toEqual(['a', 'b', 'c'])
  })

  it('makes no groups from nothing', () => {
    expect(groupByDate([], () => 0, NOW)).toEqual([])
  })
})
