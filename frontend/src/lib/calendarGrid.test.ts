import { afterEach, beforeEach, expect, test } from 'bun:test'
import { hoursIntoDay, instantAtHour } from './calendarGrid'

let zone: string | undefined
beforeEach(() => {
  zone = process.env.TZ
  process.env.TZ = 'Europe/Madrid'
})
afterEach(() => {
  process.env.TZ = zone
})

const at = (text: string) => Date.parse(text) / 1000

test('an event after the clocks go back sits on its own hour row', () => {
  // 25 October 2026: 03:00 CEST becomes 02:00 CET; the day lasts 25 hours.
  const day = new Date(2026, 9, 25)
  expect(hoursIntoDay(at('2026-10-25T10:00:00+01:00'), day)).toBe(10)
  expect(hoursIntoDay(at('2026-10-25T01:30:00+02:00'), day)).toBe(1.5)
})

test('an event after the clocks go forward sits on its own hour row', () => {
  // 29 March 2026: 02:00 CET becomes 03:00 CEST; the day lasts 23 hours.
  const day = new Date(2026, 2, 29)
  expect(hoursIntoDay(at('2026-03-29T10:00:00+02:00'), day)).toBe(10)
})

test('times outside the day are clamped to its edges', () => {
  const day = new Date(2028, 1, 29)
  expect(hoursIntoDay(at('2028-02-28T23:00:00+01:00'), day)).toBe(0)
  expect(hoursIntoDay(at('2028-03-01T00:30:00+01:00'), day)).toBe(24)
  expect(hoursIntoDay(at('2028-02-29T23:45:00+01:00'), day)).toBe(23.75)
})

test('a double-click creates the event at the hour clicked, on change days too', () => {
  expect(instantAtHour(new Date(2026, 9, 25), 10)).toBe(at('2026-10-25T10:00:00+01:00'))
  expect(instantAtHour(new Date(2026, 2, 29), 10)).toBe(at('2026-03-29T10:00:00+02:00'))
})
