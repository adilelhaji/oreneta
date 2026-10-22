import { useValue } from '@legendapp/state/react'
import { intlLocale, useTranslation } from '../../lib/i18n'
import { firstDayOfWeek, type Frequency, type Recurrence } from '../../states/calendar'
import { settings$ } from '../../states/settings'
import { weekdayOrder } from '../../lib/calendarWeek'

type T = ReturnType<typeof useTranslation>['t']

const defaultInputClass =
  'w-full rounded-control border border-border bg-raised px-3 py-2 text-xs text-primary outline-none transition-all focus:border-transparent focus:bg-chats focus:ring-1 focus:ring-accent-fg'

/// How an event or a task repeats: the frequency, the days for a weekly rule,
/// the day of a monthly one, and when it stops. One editor for both, so a
/// rule means the same in the calendar and in the task list (ADR-0053).
/// Absent unless the reader asks for it, since most things happen once.
///
/// `start` is what the rule counts from: the event's start, the task's due
/// date. `monthlyByWeekday` offers "the second Tuesday" beside "day 13" for
/// a monthly rule; the calendar backends do not write that yet, the task
/// list does.
export function RepeatFields({
  rule,
  start,
  onChange,
  monthlyByWeekday = false,
  yearlyOnlyEveryYear = false,
  inputClass = defaultInputClass,
  idPrefix = 'repeat',
}: {
  rule: Recurrence | null
  start: number
  onChange: (rule: Recurrence | null) => void
  monthlyByWeekday?: boolean
  /** A yearly rule can only repeat every year (Exchange tasks, ADR-0058). */
  yearlyOnlyEveryYear?: boolean
  inputClass?: string
  idPrefix?: string
}) {
  const { t } = useTranslation()
  // Listed from the week's first day (Calendar → General); the numbering stays
  // 0 = Monday, which is what the rule carries.
  const weekStart = useValue(settings$.calendarWeekStart)
  const startDate = new Date(start * 1000)
  const startWeekday = (startDate.getDay() + 6) % 7
  const days = rule?.weekdays?.length ? rule.weekdays : [startWeekday]
  const nth = Math.floor((startDate.getDate() - 1) / 7) + 1
  const isLastWeek = startDate.getDate() + 7 > daysInMonth(startDate)

  const setFreq = (freq: string) => {
    if (freq === '') return onChange(null)
    onChange({
      freq: freq as Frequency,
      interval: rule?.interval ?? 1,
      weekdays: freq === 'weekly' ? days : [],
      until: rule?.until ?? null,
      count: rule?.count ?? null,
    })
  }

  const toggleDay = (day: number) => {
    if (!rule) return
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort()
    // A weekly rule with no day at all falls back to the start's own, which is
    // what the server would do anyway.
    onChange({ ...rule, weekdays: next.length > 0 ? next : [startWeekday] })
  }

  const ends: 'never' | 'on' | 'after' = rule?.until ? 'on' : rule?.count ? 'after' : 'never'
  const monthlyMode = rule?.month_week === -1 ? 'last' : rule?.month_week ? 'nth' : 'day'
  const weekdayName = startDate.toLocaleDateString(intlLocale(), { weekday: 'long' })

  return (
    <div className="flex flex-col gap-2.5">
      <label className="flex w-full flex-col gap-1.5">
        <span className="ps-0.5 text-caption font-semibold text-secondary">
          {t('calendar.repeat', { defaultValue: 'Repeats' })}
        </span>
        <select
          id={`${idPrefix}-freq`}
          value={rule?.freq ?? ''}
          onChange={(e) => setFreq(e.target.value)}
          className={inputClass}
        >
          <option value="">{t('calendar.repeatNever', { defaultValue: 'Does not repeat' })}</option>
          <option value="daily">{t('calendar.repeatDaily', { defaultValue: 'Every day' })}</option>
          <option value="weekly">{t('calendar.repeatWeekly', { defaultValue: 'Every week' })}</option>
          <option value="monthly">{t('calendar.repeatMonthly', { defaultValue: 'Every month' })}</option>
          <option value="yearly">{t('calendar.repeatYearly', { defaultValue: 'Every year' })}</option>
        </select>
      </label>

      {rule && (
        <>
          {rule.freq === 'weekly' && (
            <div className="flex gap-1">
              {weekdayOrder(firstDayOfWeek(weekStart)).map((iso) => {
                const day = iso - 1
                const initial = WEEKDAY_INITIALS[day]
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDay(day)}
                    aria-pressed={days.includes(day)}
                    aria-label={weekdayLabel(day)}
                    className={`h-7 w-7 rounded-full text-2xs font-semibold transition-colors cursor-pointer ${
                      days.includes(day) ? 'bg-accent text-on-accent' : 'bg-raised text-secondary hover:text-primary'
                    }`}
                  >
                    {initial}
                  </button>
                )
              })}
            </div>
          )}

          {rule.freq === 'monthly' && monthlyByWeekday && (
            <select
              aria-label={t('calendar.repeatMonthlyOn', { defaultValue: 'Which day of the month' })}
              value={monthlyMode}
              onChange={(e) => {
                const mode = e.target.value
                if (mode === 'day') onChange({ ...rule, month_week: null, month_day: null, weekdays: [] })
                else
                  onChange({
                    ...rule,
                    month_week: mode === 'last' ? -1 : Math.min(nth, 4),
                    month_day: null,
                    weekdays: [startWeekday],
                  })
              }}
              className={`${inputClass} w-auto`}
            >
              <option value="day">
                {t('calendar.repeatOnDay', { day: startDate.getDate(), defaultValue: 'On day {day}' })}
              </option>
              {nth <= 4 && (
                <option value="nth">
                  {t('calendar.repeatOnNthWeekday', {
                    ordinal: ordinalLabel(nth, t),
                    weekday: weekdayName,
                    defaultValue: 'On the {ordinal} {weekday}',
                  })}
                </option>
              )}
              {isLastWeek && (
                <option value="last">
                  {t('calendar.repeatOnNthWeekday', {
                    ordinal: ordinalLabel(-1, t),
                    weekday: weekdayName,
                    defaultValue: 'On the {ordinal} {weekday}',
                  })}
                </option>
              )}
            </select>
          )}

          <div className="flex items-center gap-2">
            <span className="text-caption font-semibold text-secondary">
              {t('calendar.repeatEvery', { defaultValue: 'Every' })}
            </span>
            <input
              type="number"
              min={1}
              max={yearlyOnlyEveryYear && rule.freq === 'yearly' ? 1 : 99}
              disabled={yearlyOnlyEveryYear && rule.freq === 'yearly'}
              title={
                yearlyOnlyEveryYear && rule.freq === 'yearly'
                  ? t('tasks.exchangeYearly', { defaultValue: 'Exchange repeats a task at most once a year' })
                  : undefined
              }
              aria-label={t('calendar.repeatInterval', { defaultValue: 'Repeat interval' })}
              value={yearlyOnlyEveryYear && rule.freq === 'yearly' ? 1 : rule.interval}
              onChange={(e) => onChange({ ...rule, interval: Math.max(1, Number(e.target.value)) })}
              className={`${inputClass} w-16`}
            />
            <span className="text-caption text-secondary">{intervalUnit(rule.freq, rule.interval, t)}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t('calendar.repeatEnds', { defaultValue: 'Ends' })}
              value={ends}
              onChange={(e) => {
                const choice = e.target.value
                if (choice === 'never') onChange({ ...rule, until: null, count: null })
                else if (choice === 'on') onChange({ ...rule, until: start + 30 * 24 * 3600, count: null })
                else onChange({ ...rule, until: null, count: 10 })
              }}
              className={`${inputClass} w-auto`}
            >
              <option value="never">{t('calendar.endsNever', { defaultValue: 'Forever' })}</option>
              <option value="on">{t('calendar.endsOn', { defaultValue: 'Until a date' })}</option>
              <option value="after">{t('calendar.endsAfter', { defaultValue: 'After a number of times' })}</option>
            </select>

            {ends === 'on' && (
              <input
                type="date"
                aria-label={t('calendar.endsOn', { defaultValue: 'Until a date' })}
                value={toDateInput(rule.until ?? start)}
                onChange={(e) => onChange({ ...rule, until: fromDateInput(e.target.value, rule.until ?? start) })}
                className={`${inputClass} w-auto`}
              />
            )}
            {ends === 'after' && (
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={999}
                  aria-label={t('calendar.times', { defaultValue: 'times' })}
                  value={rule.count ?? 10}
                  onChange={(e) => onChange({ ...rule, count: Math.max(1, Number(e.target.value)) })}
                  className={`${inputClass} w-20`}
                />
                <span className="text-caption text-secondary">{t('calendar.times', { defaultValue: 'times' })}</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/// Monday first, matching the weekday numbering used throughout.
const WEEKDAY_INITIALS = ['L', 'M', 'X', 'J', 'V', 'S', 'D']

/// A weekday's full name in the reader's language, 0 = Monday. 5 January
/// 2026 was a Monday.
function weekdayLabel(day: number): string {
  return new Date(2026, 0, 5 + day).toLocaleDateString(intlLocale(), { weekday: 'long' })
}

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
}

function ordinalLabel(n: number, t: T): string {
  switch (n) {
    case 1:
      return t('calendar.ordinalFirst', { defaultValue: 'first' })
    case 2:
      return t('calendar.ordinalSecond', { defaultValue: 'second' })
    case 3:
      return t('calendar.ordinalThird', { defaultValue: 'third' })
    case 4:
      return t('calendar.ordinalFourth', { defaultValue: 'fourth' })
    default:
      return t('calendar.ordinalLast', { defaultValue: 'last' })
  }
}

/// The unit that follows "every N". Singular and plural are separate keys
/// rather than one plural rule: the catalogue reads a lone word in braces as a
/// placeholder, and a word is all these are.
export function intervalUnit(freq: Frequency, count: number, t: T): string {
  const unit = freq === 'daily' ? 'Day' : freq === 'weekly' ? 'Week' : freq === 'monthly' ? 'Month' : 'Year'
  const single = count === 1
  return t(`calendar.unit${unit}${single ? 'One' : 'Many'}`, {
    defaultValue: single ? unit.toLowerCase() : `${unit.toLowerCase()}s`,
  })
}

/// A rule in a few words, for a list row: "Every 2 weeks", "Every month".
export function describeRecurrence(rule: Recurrence, t: T): string {
  if (rule.interval <= 1) {
    switch (rule.freq) {
      case 'daily':
        return t('calendar.repeatDaily', { defaultValue: 'Every day' })
      case 'weekly':
        return t('calendar.repeatWeekly', { defaultValue: 'Every week' })
      case 'monthly':
        return t('calendar.repeatMonthly', { defaultValue: 'Every month' })
      default:
        return t('calendar.repeatYearly', { defaultValue: 'Every year' })
    }
  }
  return `${t('calendar.repeatEvery', { defaultValue: 'Every' })} ${rule.interval} ${intervalUnit(rule.freq, rule.interval, t)}`
}

function toDateInput(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/// The end date as the last minute of that day on this machine's clock, which
/// is what "until this date, inclusive" means to the core.
function fromDateInput(text: string, fallback: number): number {
  const [year, month, day] = text.split('-').map(Number)
  if (!year || !month || !day) return fallback
  return Math.floor(new Date(year, month - 1, day, 23, 59, 0, 0).getTime() / 1000)
}
