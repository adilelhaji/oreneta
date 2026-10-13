// Calendar → General (SET-18, ADR-0051): the week's first day, week numbers and
// work hours. Pure functions only; states/settings.ts holds the preferences and
// the calendar views read them through states/calendar.ts.
//
// Weekdays are ISO numbers throughout, 1 = Monday … 7 = Sunday: the numbering
// Intl.Locale's week info uses, and Kotlin's DayOfWeek on mobile.

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7
export const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7]

/** What the person chose for the week's first day; 'locale' follows the region. */
export type WeekStartChoice = 'locale' | 'sunday' | 'monday' | 'saturday'
export const WEEK_START_CHOICES: readonly WeekStartChoice[] = ['locale', 'sunday', 'monday', 'saturday']

export type LocaleWeekInfo = {
  firstDay: Weekday
  weekend: Weekday[]
  /**
   * Days of the new year the first week must hold to be week 1. Intl no longer
   * reports it (the field was dropped from the proposal), so it always comes
   * from the CLDR table below.
   */
  minimalDays: number
}

// CLDR supplemental weekData, by region, for engines without Intl week info.
// Regions absent from a list take the default (Monday; Saturday–Sunday weekend;
// one minimal day).
const FIRST_DAY_SUNDAY = new Set(
  'AG AS BD BR BS BT BW BZ CA CN CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW'.split(
    ' ',
  ),
)
const FIRST_DAY_SATURDAY = new Set('AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY'.split(' '))
const FIRST_DAY_FRIDAY = new Set(['MV'])
const WEEKEND: Record<string, Weekday[]> = {
  ...Object.fromEntries(
    'AE BH DZ EG IL IQ JO KW LY OM QA SA SD SY YE'.split(' ').map((region) => [region, [5, 6] as Weekday[]]),
  ),
  AF: [4, 5],
  IR: [5],
  IN: [7],
  UG: [7],
}
const MINIMAL_DAYS_FOUR = new Set(
  'AD AN AT AX BE BG CH CZ DE DK EE ES FI FJ FO FR GB GF GG GI GP GR HU IE IM IS IT JE LI LT LU MC MQ NL NO PL RE RU SE SJ SK SM VA'.split(
    ' ',
  ),
)
// The region a bare language most likely means (CLDR likely subtags), for
// engines that cannot maximize a locale themselves.
const LIKELY_REGION: Record<string, string> = {
  ar: 'EG',
  ca: 'ES',
  cs: 'CZ',
  da: 'DK',
  de: 'DE',
  el: 'GR',
  en: 'US',
  es: 'ES',
  eu: 'ES',
  fa: 'IR',
  fi: 'FI',
  fr: 'FR',
  gl: 'ES',
  he: 'IL',
  hi: 'IN',
  hu: 'HU',
  id: 'ID',
  it: 'IT',
  ja: 'JP',
  ko: 'KR',
  nb: 'NO',
  nl: 'NL',
  pl: 'PL',
  pt: 'BR',
  ro: 'RO',
  ru: 'RU',
  sv: 'SE',
  th: 'TH',
  tr: 'TR',
  uk: 'UA',
  vi: 'VN',
  zh: 'CN',
}

/** The region a locale tag names or most likely means, upper-case; '' if none. */
export function localeRegion(locale: string, useIntl = true): string {
  const tag = locale.replace('_', '-')
  if (useIntl) {
    try {
      const region = new Intl.Locale(tag).maximize().region
      if (region) return region.toUpperCase()
    } catch {
      // Not a valid tag, or no Intl.Locale: read it by hand.
    }
  }
  const parts = tag.split('-')
  const explicit = parts.slice(1).find((part) => /^[A-Za-z]{2}$|^\d{3}$/.test(part))
  if (explicit) return explicit.toUpperCase()
  return LIKELY_REGION[parts[0].toLowerCase()] ?? ''
}

/** CLDR week data for a region, from the table. */
export function regionWeekInfo(region: string): LocaleWeekInfo {
  const firstDay: Weekday = FIRST_DAY_SUNDAY.has(region)
    ? 7
    : FIRST_DAY_SATURDAY.has(region)
      ? 6
      : FIRST_DAY_FRIDAY.has(region)
        ? 5
        : 1
  return {
    firstDay,
    weekend: WEEKEND[region] ?? [6, 7],
    minimalDays: MINIMAL_DAYS_FOUR.has(region) ? 4 : 1,
  }
}

const isWeekday = (value: unknown): value is Weekday => typeof value === 'number' && value >= 1 && value <= 7

/**
 * A locale's week: Intl.Locale's week info where the engine has it (WebView2,
 * WebKitGTK and Bun's JavaScriptCore do), else the CLDR table by region.
 */
export function localeWeekInfo(locale: string, useIntl = true): LocaleWeekInfo {
  const region = localeRegion(locale, useIntl)
  const table = regionWeekInfo(region)
  if (!useIntl) return table
  try {
    const intl = new Intl.Locale(locale.replace('_', '-')) as Intl.Locale & {
      getWeekInfo?: () => { firstDay?: unknown; weekend?: unknown }
      weekInfo?: { firstDay?: unknown; weekend?: unknown }
    }
    const info = intl.getWeekInfo?.() ?? intl.weekInfo
    if (info && isWeekday(info.firstDay)) {
      const weekend = Array.isArray(info.weekend) ? info.weekend.filter(isWeekday) : table.weekend
      return { firstDay: info.firstDay, weekend, minimalDays: table.minimalDays }
    }
  } catch {
    // Fall through to the table.
  }
  return table
}

/** The locale the calendar follows: the system's (with its region), not the UI language. */
export function systemLocale(): string {
  try {
    return navigator.languages?.[0] || navigator.language || 'en-US'
  } catch {
    return 'en-US'
  }
}

/** The weekday the week opens on, for a choice and a locale. */
export function resolveFirstDay(choice: WeekStartChoice, info: LocaleWeekInfo): Weekday {
  if (choice === 'sunday') return 7
  if (choice === 'monday') return 1
  if (choice === 'saturday') return 6
  return info.firstDay
}

/** ISO weekday of a date's local calendar day. */
export function isoWeekday(date: Date): Weekday {
  return (date.getDay() || 7) as Weekday
}

/** The weekdays in the order a week starting on [firstDay] lists them. */
export function weekdayOrder(firstDay: Weekday): Weekday[] {
  return Array.from({ length: 7 }, (_, i) => (((firstDay - 1 + i) % 7) + 1) as Weekday)
}

/** Local midnight of the first day of the week [date] falls in. */
export function weekStartOf(date: Date, firstDay: Weekday): Date {
  const back = (isoWeekday(date) - firstDay + 7) % 7
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - back)
}

// --- Week numbers ---------------------------------------------------------------

/**
 * How weeks are numbered: ISO 8601 (week 1 holds the year's first Thursday)
 * when the week starts on Monday; otherwise the locale's own rule — week 1 is
 * the first week holding at least `minimalDays` days of the year, which for the
 * Sunday- and Saturday-first regions is the week holding 1 January.
 */
export function weekNumberRule(firstDay: Weekday, info: LocaleWeekInfo): { firstDay: Weekday; minimalDays: number } {
  return firstDay === 1 ? { firstDay: 1, minimalDays: 4 } : { firstDay, minimalDays: info.minimalDays }
}

// Days are counted on the UTC timeline of the local calendar date, so a
// daylight-saving change can never make a week 6 or 8 days long.
const DAY_MS = 86_400_000
const dayIndex = (year: number, month: number, day: number) => Math.round(Date.UTC(year, month, day) / DAY_MS)
const weekStartIndex = (index: number, firstDay: Weekday) => {
  const iso = new Date(index * DAY_MS).getUTCDay() || 7
  return index - ((iso - firstDay + 7) % 7)
}

/** The week number of a local date, and the year that week belongs to. */
export function weekNumber(
  date: Date,
  rule: { firstDay: Weekday; minimalDays: number },
): { week: number; year: number } {
  const start = weekStartIndex(dayIndex(date.getFullYear(), date.getMonth(), date.getDate()), rule.firstDay)
  const firstWeek = (year: number) => weekStartIndex(dayIndex(year, 0, rule.minimalDays), rule.firstDay)
  let year = date.getFullYear()
  if (start >= firstWeek(year + 1)) year += 1
  else if (start < firstWeek(year)) year -= 1
  return { week: Math.round((start - firstWeek(year)) / 7) + 1, year }
}

// --- Work hours -----------------------------------------------------------------

export type CalendarPrefs = {
  /** Show week numbers in the week and month views. */
  showWeekNumbers: boolean
  /** Work day start and end, in minutes after local midnight. */
  workStart: number
  workEnd: number
  /** Working days (ISO); null follows the locale: every day but its weekend. */
  workDays: Weekday[] | null
  /** The week view shows working days only. */
  workWeekOnly: boolean
  /** Length of a new event, in minutes. */
  defaultDuration: number
  /** Reminder a new event starts with, in minutes before; null for none. */
  defaultReminder: number | null
}

export const DEFAULT_CALENDAR_PREFS: CalendarPrefs = {
  showWeekNumbers: false,
  workStart: 9 * 60,
  workEnd: 17 * 60,
  workDays: null,
  workWeekOnly: false,
  defaultDuration: 60,
  // None, as before the setting existed: nobody's new events start nagging.
  defaultReminder: null,
}

export const DURATION_CHOICES = [15, 30, 45, 60, 90, 120] as const
export const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 24 * 60] as const

const minutesOfDay = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null

/**
 * Read a stored row back. Each field falls back to its default on its own, so a
 * value written by a newer build never costs the other choices; work hours that
 * end before they start are reset as a pair.
 */
export function sanitizeCalendarPrefs(raw: unknown): CalendarPrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const d = DEFAULT_CALENDAR_PREFS
  let workStart = minutesOfDay(value.workStart, 0, 23 * 60 + 59) ?? d.workStart
  let workEnd = minutesOfDay(value.workEnd, 1, 24 * 60) ?? d.workEnd
  if (workEnd <= workStart) {
    workStart = d.workStart
    workEnd = d.workEnd
  }
  const days = Array.isArray(value.workDays)
    ? [...new Set(value.workDays.filter(isWeekday))].sort((a, b) => a - b)
    : null
  const duration = minutesOfDay(value.defaultDuration, 5, 24 * 60)
  const reminder = value.defaultReminder === null ? null : minutesOfDay(value.defaultReminder, 0, 4 * 7 * 24 * 60)
  return {
    showWeekNumbers: typeof value.showWeekNumbers === 'boolean' ? value.showWeekNumbers : d.showWeekNumbers,
    workStart,
    workEnd,
    workDays: days && days.length > 0 ? days : null,
    workWeekOnly: typeof value.workWeekOnly === 'boolean' ? value.workWeekOnly : d.workWeekOnly,
    defaultDuration: duration ?? d.defaultDuration,
    defaultReminder: value.defaultReminder === undefined ? d.defaultReminder : reminder,
  }
}

/** The working days: the chosen ones, or every day outside the locale's weekend. */
export function effectiveWorkDays(prefs: CalendarPrefs, info: LocaleWeekInfo): Weekday[] {
  return prefs.workDays ?? WEEKDAYS.filter((day) => !info.weekend.includes(day))
}

/**
 * The stretches of a day column outside work, as [from, to) in wall-clock hours
 * (0–24). The grid places everything by the wall clock (lib/calendarGrid), so
 * these are the same on the days the clocks change.
 */
export function offHourBands(date: Date, prefs: CalendarPrefs, workDays: readonly Weekday[]): [number, number][] {
  if (!workDays.includes(isoWeekday(date))) return [[0, 24]]
  const bands: [number, number][] = []
  if (prefs.workStart > 0) bands.push([0, prefs.workStart / 60])
  if (prefs.workEnd < 24 * 60) bands.push([prefs.workEnd / 60, 24])
  return bands
}

/**
 * The instants a working day runs between, in epoch seconds, or null on a day
 * off. Built from the wall clock, so a work day on a clock-change day is still
 * 9:00 to 17:00 — eight hours — although the day itself lasts 23 or 25.
 */
export function workingInstants(
  date: Date,
  prefs: CalendarPrefs,
  workDays: readonly Weekday[],
): [number, number] | null {
  if (!workDays.includes(isoWeekday(date))) return null
  const at = (minutes: number) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minutes).getTime() / 1000
  return [at(prefs.workStart), at(prefs.workEnd)]
}

/** The hour the day and week views open scrolled to: just before work starts. */
export function scrollHour(prefs: CalendarPrefs): number {
  return Math.max(0, prefs.workStart / 60 - 0.5)
}

/** "09:30" for minutes after midnight; 24:00 stays 24:00 (the end of the day). */
export function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}
