import { beforeEach, expect, test } from 'bun:test'
import { calendar$, openCalendarFromNotification, startOfDay } from './calendar'
import { onNotificationClicked } from './notificationClick'
import { ui$ } from './ui'

// A notice of missed reminders (#225) names the most recent missed day;
// clicking it opens the calendar there, in place of whatever had the pane:
// its day view, or its week when the misses span several days.
beforeEach(() => {
  calendar$.view.set('month')
  calendar$.anchor.set(0)
  ui$.calendarOpen.set(false)
  ui$.messagingOpen.set(true)
})

test('a click on a missed-reminders notice opens the calendar on the day it names', () => {
  // As Go sends it through `notification-clicked`, which useAppEffects hands
  // to onNotificationClicked.
  onNotificationClicked({ account: 'acc', threadId: 'calendar:2026-10-19' })
  expect(calendar$.anchor.get()).toBe(new Date(2026, 9, 19).getTime())
  expect(calendar$.view.get()).toBe('day')
  expect(ui$.calendarOpen.get()).toBe(true)
  expect(ui$.messagingOpen.get()).toBe(false)
})

test('misses on several days open the week of the most recent one', () => {
  onNotificationClicked({ account: 'acc', threadKey: 'calendar:week:2026-10-21' })
  expect(calendar$.anchor.get()).toBe(new Date(2026, 9, 21).getTime())
  expect(calendar$.view.get()).toBe('week')
  expect(ui$.calendarOpen.get()).toBe(true)
})

test('a day it cannot read opens the calendar on today', () => {
  for (const target of ['', '2026-13-01', '2026-02-30', 'tomorrow', 'week:']) {
    calendar$.anchor.set(0)
    openCalendarFromNotification(target)
    expect(calendar$.anchor.get()).toBe(startOfDay(new Date()).getTime())
  }
  onNotificationClicked({ threadId: 'calendar:' })
  expect(calendar$.view.get()).toBe('day')
})
