import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_CALENDAR_PREFS,
  effectiveWorkDays,
  localeRegion,
  localeWeekInfo,
  offHourBands,
  resolveFirstDay,
  sanitizeCalendarPrefs,
  scrollHour,
  weekNumber,
  weekNumberRule,
  weekStartOf,
  weekdayOrder,
  workingInstants,
  type CalendarPrefs,
  type Weekday,
} from './calendarWeek'
import { hoursIntoDay } from './calendarGrid'

// SET-18 / ADR-0051. Every expectation is checked twice: through Intl.Locale's
// week info (what WebView2 and WebKitGTK use) and through the CLDR fallback
// table, so an engine without Intl week info lands on the same answer.
const LOCALES: { locale: string; firstDay: Weekday; weekend: Weekday[]; minimalDays: number }[] = [
  { locale: 'en-US', firstDay: 7, weekend: [6, 7], minimalDays: 1 },
  { locale: 'en-GB', firstDay: 1, weekend: [6, 7], minimalDays: 4 },
  { locale: 'de', firstDay: 1, weekend: [6, 7], minimalDays: 4 },
  { locale: 'ar-EG', firstDay: 6, weekend: [5, 6], minimalDays: 1 },
  { locale: 'ja', firstDay: 7, weekend: [6, 7], minimalDays: 1 },
  { locale: 'pt-BR', firstDay: 7, weekend: [6, 7], minimalDays: 1 },
  { locale: 'fa', firstDay: 6, weekend: [5], minimalDays: 1 },
]

describe('week start per locale', () => {
  for (const { locale, firstDay, weekend, minimalDays } of LOCALES) {
    test(`${locale}: Intl and the fallback table agree`, () => {
      expect(localeWeekInfo(locale)).toEqual({ firstDay, weekend, minimalDays })
      expect(localeWeekInfo(locale, false)).toEqual({ firstDay, weekend, minimalDays })
    })
  }

  test('a bare language takes its likely region, also without Intl', () => {
    expect(localeRegion('de', false)).toBe('DE')
    expect(localeRegion('fa', false)).toBe('IR')
    expect(localeRegion('ja', false)).toBe('JP')
    expect(localeRegion('en_GB', false)).toBe('GB')
    expect(localeRegion('es-419', false)).toBe('419')
  })

  test('an unknown or broken tag falls back to Monday weeks', () => {
    expect(localeWeekInfo('xx', false).firstDay).toBe(1)
    expect(localeWeekInfo('not a locale').firstDay).toBe(1)
  })

  test('an explicit choice wins over the locale', () => {
    const us = localeWeekInfo('en-US')
    expect(resolveFirstDay('locale', us)).toBe(7)
    expect(resolveFirstDay('monday', us)).toBe(1)
    expect(resolveFirstDay('saturday', us)).toBe(6)
    expect(resolveFirstDay('sunday', localeWeekInfo('de'))).toBe(7)
  })

  test('the week is listed and anchored from its first day', () => {
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(weekdayOrder(7)).toEqual([7, 1, 2, 3, 4, 5, 6])
    expect(weekdayOrder(6)).toEqual([6, 7, 1, 2, 3, 4, 5])
    // Tuesday 13 October 2026.
    const tuesday = new Date(2026, 9, 13, 15, 30)
    expect(weekStartOf(tuesday, 1)).toEqual(new Date(2026, 9, 12))
    expect(weekStartOf(tuesday, 7)).toEqual(new Date(2026, 9, 11))
    expect(weekStartOf(tuesday, 6)).toEqual(new Date(2026, 9, 10))
    // A Sunday opens its own week when weeks start on Sunday.
    expect(weekStartOf(new Date(2026, 9, 18), 7)).toEqual(new Date(2026, 9, 18))
  })
})

describe('week numbers', () => {
  const iso = weekNumberRule(1, localeWeekInfo('en-US'))
  const us = weekNumberRule(7, localeWeekInfo('en-US'))
  const persian = weekNumberRule(6, localeWeekInfo('fa'))

  test('Monday weeks are ISO 8601 whatever the locale says', () => {
    expect(iso).toEqual({ firstDay: 1, minimalDays: 4 })
    expect(weekNumberRule(1, localeWeekInfo('ar-EG'))).toEqual({ firstDay: 1, minimalDays: 4 })
  })

  test('ISO weeks across year boundaries', () => {
    expect(weekNumber(new Date(2026, 0, 1), iso)).toEqual({ week: 1, year: 2026 })
    // 2026 starts on a Thursday, so it has 53 weeks.
    expect(weekNumber(new Date(2026, 11, 31), iso)).toEqual({ week: 53, year: 2026 })
    expect(weekNumber(new Date(2027, 0, 3), iso)).toEqual({ week: 53, year: 2026 })
    expect(weekNumber(new Date(2027, 0, 4), iso)).toEqual({ week: 1, year: 2027 })
    // The last days of December can open the next year's week 1.
    expect(weekNumber(new Date(2024, 11, 30), iso)).toEqual({ week: 1, year: 2025 })
    expect(weekNumber(new Date(2021, 0, 3), iso)).toEqual({ week: 53, year: 2020 })
    expect(weekNumber(new Date(2026, 9, 13), iso)).toEqual({ week: 42, year: 2026 })
  })

  test('Sunday weeks follow the US rule: week 1 holds 1 January', () => {
    expect(us).toEqual({ firstDay: 7, minimalDays: 1 })
    expect(weekNumber(new Date(2026, 0, 1), us)).toEqual({ week: 1, year: 2026 })
    expect(weekNumber(new Date(2025, 11, 28), us)).toEqual({ week: 1, year: 2026 })
    expect(weekNumber(new Date(2025, 11, 27), us)).toEqual({ week: 52, year: 2025 })
    expect(weekNumber(new Date(2026, 9, 13), us)).toEqual({ week: 42, year: 2026 })
  })

  test('Saturday weeks across the year boundary', () => {
    expect(weekNumber(new Date(2025, 11, 27), persian)).toEqual({ week: 1, year: 2026 })
    expect(weekNumber(new Date(2025, 11, 26), persian)).toEqual({ week: 52, year: 2025 })
  })

  test('a clock change inside a week does not shift its number', () => {
    const zone = process.env.TZ
    process.env.TZ = 'Europe/Madrid'
    try {
      // Mon 26 Oct 2026, the day after the clocks go back; Sun 25 Oct is the change.
      expect(weekNumber(new Date(2026, 9, 25), iso)).toEqual({ week: 43, year: 2026 })
      expect(weekNumber(new Date(2026, 9, 26), iso)).toEqual({ week: 44, year: 2026 })
      expect(weekNumber(new Date(2026, 9, 25), us)).toEqual({ week: 44, year: 2026 })
    } finally {
      process.env.TZ = zone
    }
  })
})

describe('work hours', () => {
  let zone: string | undefined
  beforeEach(() => {
    zone = process.env.TZ
    process.env.TZ = 'Europe/Madrid'
  })
  afterEach(() => {
    process.env.TZ = zone
  })

  const everyDay: CalendarPrefs = { ...DEFAULT_CALENDAR_PREFS, workDays: [1, 2, 3, 4, 5, 6, 7] }
  const days = (prefs: CalendarPrefs) => effectiveWorkDays(prefs, localeWeekInfo('es-ES'))

  test('the default work week is the locale’s weekdays, 9:00 to 17:00', () => {
    expect(effectiveWorkDays(DEFAULT_CALENDAR_PREFS, localeWeekInfo('de'))).toEqual([1, 2, 3, 4, 5])
    expect(effectiveWorkDays(DEFAULT_CALENDAR_PREFS, localeWeekInfo('ar-EG'))).toEqual([1, 2, 3, 4, 7])
    expect(effectiveWorkDays(DEFAULT_CALENDAR_PREFS, localeWeekInfo('fa'))).toEqual([1, 2, 3, 4, 6, 7])
    expect(scrollHour(DEFAULT_CALENDAR_PREFS)).toBe(8.5)
  })

  test('a day off is shaded whole; a working day outside its hours', () => {
    const prefs = DEFAULT_CALENDAR_PREFS
    // Tuesday 13 and Saturday 17 October 2026.
    expect(offHourBands(new Date(2026, 9, 13), prefs, days(prefs))).toEqual([
      [0, 9],
      [17, 24],
    ])
    expect(offHourBands(new Date(2026, 9, 17), prefs, days(prefs))).toEqual([[0, 24]])
    const late = { ...prefs, workStart: 0, workEnd: 24 * 60 }
    expect(offHourBands(new Date(2026, 9, 13), late, days(late))).toEqual([])
    const half = { ...prefs, workStart: 8 * 60 + 30, workEnd: 14 * 60 + 30 }
    expect(offHourBands(new Date(2026, 9, 13), half, days(half))).toEqual([
      [0, 8.5],
      [14.5, 24],
    ])
  })

  for (const [name, day] of [
    ['the clocks go forward (a 23-hour day)', new Date(2026, 2, 29)],
    ['the clocks go back (a 25-hour day)', new Date(2026, 9, 25)],
  ] as const) {
    test(`shading on the day ${name} stays on the wall clock`, () => {
      expect(offHourBands(day, everyDay, days(everyDay))).toEqual([
        [0, 9],
        [17, 24],
      ])
      const [start, end] = workingInstants(day, everyDay, days(everyDay))!
      // Eight working hours, although the day itself is not 24 long.
      expect(end - start).toBe(8 * 3600)
      // The band edges meet the hour rows the grid draws events on.
      expect(hoursIntoDay(start, day)).toBe(9)
      expect(hoursIntoDay(end, day)).toBe(17)
      expect(new Date(start * 1000).getHours()).toBe(9)
    })
  }

  test('a day off has no working instants', () => {
    expect(workingInstants(new Date(2026, 2, 29), DEFAULT_CALENDAR_PREFS, days(DEFAULT_CALENDAR_PREFS))).toBeNull()
  })
})

describe('stored preferences', () => {
  test('fields fall back one by one, and an inverted work day resets as a pair', () => {
    expect(sanitizeCalendarPrefs(null)).toBeNull()
    expect(sanitizeCalendarPrefs([])).toBeNull()
    expect(sanitizeCalendarPrefs({})).toEqual(DEFAULT_CALENDAR_PREFS)
    expect(
      sanitizeCalendarPrefs({
        showWeekNumbers: true,
        workStart: 8 * 60,
        workEnd: 16 * 60,
        workDays: [7, 1, 1, 9, 'x', 2],
        workWeekOnly: 'yes',
        defaultDuration: 30,
        defaultReminder: 15,
        future: 1,
      }),
    ).toEqual({
      showWeekNumbers: true,
      workStart: 480,
      workEnd: 960,
      workDays: [1, 2, 7],
      workWeekOnly: false,
      defaultDuration: 30,
      defaultReminder: 15,
    })
    const inverted = sanitizeCalendarPrefs({ workStart: 18 * 60, workEnd: 8 * 60, workDays: [], defaultReminder: -5 })!
    expect([inverted.workStart, inverted.workEnd]).toEqual([540, 1020])
    expect(inverted.workDays).toBeNull()
    expect(inverted.defaultReminder).toBeNull()
    expect(sanitizeCalendarPrefs({ defaultReminder: null })!.defaultReminder).toBeNull()
  })
})
