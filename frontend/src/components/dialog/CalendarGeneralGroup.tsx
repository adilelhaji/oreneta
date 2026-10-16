import { useValue } from '@legendapp/state/react'
import { BriefcaseBusiness, CalendarClock, CalendarDays, CalendarRange, Clock, Hash, Hourglass } from 'lucide-react'
import i18n, { useTranslation } from '../../lib/i18n'
import {
  DURATION_CHOICES,
  REMINDER_CHOICES,
  formatMinutes,
  weekdayOrder,
  type CalendarPrefs,
  type Weekday,
  type WeekStartChoice,
} from '../../lib/calendarWeek'
import { firstDayOfWeek, workDays } from '../../states/calendar'
import { settings$ } from '../../states/settings'
import { SelectInput } from '../field/Field'
import { reminderLabel } from '../calendar/EventEditor'
import { SettingRow, SettingsGroup, ToggleRow } from './AccountSettingsRows'

/// Half-hour steps for the work day's start and end.
const TIME_STEPS = Array.from({ length: 49 }, (_, i) => i * 30)

/// A weekday's name in the interface language. 2024-01-01 was a Monday.
function weekdayName(day: Weekday, width: 'long' | 'short'): string {
  return new Date(2024, 0, day).toLocaleDateString(i18n.language.replace('_', '-'), { weekday: width })
}

/**
 * Calendar → General (SET-18, ADR-0051): the week's first day, week numbers,
 * work hours and days, and what a new event starts with. Every control writes
 * `settings$.calendarWeekStart` or `settings$.calendar`, which the settings
 * store persists as the rows `calendar_week_start` and `calendar_general`.
 */
export function CalendarGeneralGroup() {
  const { t } = useTranslation()
  const weekStart = useValue(settings$.calendarWeekStart)
  const prefs = useValue(settings$.calendar)
  const set = (partial: Partial<CalendarPrefs>) => settings$.calendar.set({ ...prefs, ...partial })
  const icon = { size: 16, strokeWidth: 1.75 }
  const working = workDays(prefs)
  const selectClass = 'w-44 rounded-control py-1.5 ps-3 font-semibold'

  const select = (
    label: string,
    value: string,
    options: { value: string; label: string }[],
    onChange: (value: string) => void,
  ) => (
    <SelectInput aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
      {options.map((option) => (
        <option key={option.value} value={option.value} className="bg-chats text-primary">
          {option.label}
        </option>
      ))}
    </SelectInput>
  )

  const weekStartLabel = t('settings.calendar.weekStart', { defaultValue: 'First day of the week' })
  const workStartLabel = t('settings.calendar.workStart', { defaultValue: 'Work day starts' })
  const workEndLabel = t('settings.calendar.workEnd', { defaultValue: 'Work day ends' })
  const durationLabel = t('settings.calendar.defaultDuration', { defaultValue: 'New events last' })
  const reminderTitle = t('settings.calendar.defaultReminder', { defaultValue: 'New events remind' })

  const toggleWorkDay = (day: Weekday) => {
    const next = working.includes(day) ? working.filter((d) => d !== day) : [...working, day]
    // At least one working day: a week with none has nothing to shade against.
    if (next.length === 0) return
    set({ workDays: [...next].sort((a, b) => a - b) })
  }

  return (
    <SettingsGroup
      section="calendarGeneral"
      title={t('settings.sections.calendarGeneral', { defaultValue: 'Calendar' })}
    >
      <SettingRow
        icon={<CalendarDays {...icon} />}
        title={weekStartLabel}
        hint={t('settings.calendar.weekStartHint', {
          defaultValue: 'Used by the week and month views, the date pickers and week numbers.',
        })}
        control={select(
          weekStartLabel,
          weekStart,
          [
            {
              value: 'locale',
              label: t('settings.calendar.weekStartLocale', {
                defaultValue: 'Regional default ({day})',
                day: weekdayName(firstDayOfWeek('locale'), 'long'),
              }),
            },
            { value: 'sunday', label: weekdayName(7, 'long') },
            { value: 'monday', label: weekdayName(1, 'long') },
            { value: 'saturday', label: weekdayName(6, 'long') },
          ],
          (value) => settings$.calendarWeekStart.set(value as WeekStartChoice),
        )}
      />
      <ToggleRow
        icon={<Hash {...icon} />}
        title={t('settings.calendar.weekNumbers', { defaultValue: 'Show week numbers' })}
        hint={t('settings.calendar.weekNumbersHint', {
          defaultValue: 'ISO 8601 numbering when the week starts on Monday; otherwise week 1 is the week of 1 January.',
        })}
        checked={prefs.showWeekNumbers}
        onChange={() => set({ showWeekNumbers: !prefs.showWeekNumbers })}
      />
      <SettingRow
        icon={<Clock {...icon} />}
        title={workStartLabel}
        control={select(
          workStartLabel,
          String(prefs.workStart),
          TIME_STEPS.filter((m) => m < 24 * 60).map((m) => ({ value: String(m), label: formatMinutes(m) })),
          (value) => {
            const workStart = Number(value)
            // Keep the day at least half an hour long by moving its end along.
            set({ workStart, workEnd: Math.max(prefs.workEnd, Math.min(24 * 60, workStart + 30)) })
          },
        )}
      />
      <SettingRow
        icon={<Clock {...icon} />}
        title={workEndLabel}
        control={select(
          workEndLabel,
          String(prefs.workEnd),
          TIME_STEPS.filter((m) => m > prefs.workStart).map((m) => ({ value: String(m), label: formatMinutes(m) })),
          (value) => set({ workEnd: Number(value) }),
        )}
      />
      <SettingRow
        icon={<BriefcaseBusiness {...icon} />}
        title={t('settings.calendar.workDays', { defaultValue: 'Working days' })}
        hint={t('settings.calendar.workDaysHint', {
          defaultValue: 'Until changed, every day outside the regional weekend.',
        })}
        control={
          <div
            role="group"
            aria-label={t('settings.calendar.workDays', { defaultValue: 'Working days' })}
            className="flex gap-1"
          >
            {weekdayOrder(firstDayOfWeek(weekStart)).map((day) => (
              <button
                key={day}
                type="button"
                aria-pressed={working.includes(day)}
                aria-label={weekdayName(day, 'long')}
                onClick={() => toggleWorkDay(day)}
                className={`h-7 min-w-9 rounded-md px-1.5 text-2xs font-semibold transition-colors cursor-pointer ${
                  working.includes(day) ? 'bg-accent text-on-accent' : 'bg-active/70 text-secondary hover:text-primary'
                }`}
              >
                {weekdayName(day, 'short')}
              </button>
            ))}
          </div>
        }
      />
      <ToggleRow
        icon={<CalendarRange {...icon} />}
        title={t('settings.calendar.workWeekOnly', { defaultValue: 'Week view shows only working days' })}
        checked={prefs.workWeekOnly}
        onChange={() => set({ workWeekOnly: !prefs.workWeekOnly })}
      />
      <SettingRow
        icon={<Hourglass {...icon} />}
        title={durationLabel}
        control={select(
          durationLabel,
          String(prefs.defaultDuration),
          DURATION_CHOICES.map((minutes) => ({
            value: String(minutes),
            label:
              minutes % 60 === 0
                ? t('settings.calendar.durationHours', { defaultValue: '{count} h', count: minutes / 60 })
                : t('settings.calendar.durationMinutes', { defaultValue: '{count} min', count: minutes }),
          })),
          (value) => set({ defaultDuration: Number(value) }),
        )}
      />
      <SettingRow
        icon={<CalendarClock {...icon} />}
        title={reminderTitle}
        control={select(
          reminderTitle,
          prefs.defaultReminder === null ? '' : String(prefs.defaultReminder),
          [
            { value: '', label: t('calendar.reminderNone', { defaultValue: 'None' }) },
            ...REMINDER_CHOICES.map((minutes) => ({
              value: String(minutes),
              label: reminderLabel(minutes, t),
            })),
          ],
          (value) => set({ defaultReminder: value === '' ? null : Number(value) }),
        )}
      />
    </SettingsGroup>
  )
}
