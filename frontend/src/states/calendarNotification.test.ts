import { beforeEach, expect, test } from 'bun:test'
import { calendar$, openCalendarFromNotification, startOfDay } from './calendar'
import { ui$ } from './ui'

// A notice of missed reminders (#225) names the first missed day; clicking it
// opens the calendar's day view there, in place of whatever had the pane.
beforeEach(() => {
  calendar$.view.set('month')
  calendar$.anchor.set(0)
  ui$.calendarOpen.set(false)
  ui$.messagingOpen.set(true)
})

test('a missed-reminders notice opens the calendar on the day it names', () => {
  openCalendarFromNotification('2026-10-19')
  expect(calendar$.anchor.get()).toBe(new Date(2026, 9, 19).getTime())
  expect(calendar$.view.get()).toBe('day')
  expect(ui$.calendarOpen.get()).toBe(true)
  expect(ui$.messagingOpen.get()).toBe(false)
})

test('a day it cannot read opens the calendar on today', () => {
  for (const day of ['', '2026-13-01', '2026-02-30', 'tomorrow']) {
    calendar$.anchor.set(0)
    openCalendarFromNotification(day)
    expect(calendar$.anchor.get()).toBe(startOfDay(new Date()).getTime())
    expect(calendar$.view.get()).toBe('day')
  }
})
