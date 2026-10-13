import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { CalendarGeneralGroup } from './CalendarGeneralGroup'
import { hydrateSettings, settings$ } from '../../states/settings'
import { DEFAULT_CALENDAR_PREFS, type CalendarPrefs } from '../../lib/calendarWeek'
import { settingsDestinations } from '../../lib/settingsDestinations'
import { filterCommands } from '../palette/paletteCommands'
import { t } from '../../lib/i18n'

// Calendar → General (SET-18, ADR-0051).

const saves: { key: string; value: unknown }[] = []

beforeEach(() => {
  settings$.calendarWeekStart.set('locale')
  settings$.calendar.set(DEFAULT_CALENDAR_PREFS)
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          if (command === 'app.prefsSet') saves.push(payload)
          return { ok: true }
        },
      },
    },
  }
  saves.length = 0
})

afterEach(() => {
  cleanup()
  settings$.calendarWeekStart.set('locale')
  settings$.calendar.set(DEFAULT_CALENDAR_PREFS)
  delete (window as any).go
})

it('changes the first day of the week and persists it as a flat row', async () => {
  const screen = render(<CalendarGeneralGroup />)
  const select = screen.getByRole('combobox', { name: 'First day of the week' }) as HTMLSelectElement
  expect(select.value).toBe('locale')
  // The regional default names the day it means.
  expect(select.options[0].textContent).toMatch(/^Regional default \((Sunday|Monday|Saturday|Friday)\)$/)
  expect(
    Array.from(select.options)
      .map((option) => option.textContent)
      .slice(1),
  ).toEqual(['Sunday', 'Monday', 'Saturday'])
  await act(async () => fireEvent.change(select, { target: { value: 'sunday' } }))
  expect(settings$.calendarWeekStart.get()).toBe('sunday')
  expect(saves.at(-1)).toEqual({ key: 'calendar_week_start', value: 'sunday' })
  // The working-day buttons follow the new first day.
  const days = screen.getByRole('group', { name: 'Working days' })
  expect(Array.from(days.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'))).toEqual([
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ])
})

it('edits work hours, days and new-event defaults as one calendar_general row', async () => {
  settings$.calendarWeekStart.set('monday')
  const screen = render(<CalendarGeneralGroup />)
  await act(async () =>
    fireEvent.change(screen.getByRole('combobox', { name: 'Work day starts' }), { target: { value: '480' } }),
  )
  await act(async () =>
    fireEvent.change(screen.getByRole('combobox', { name: 'Work day ends' }), { target: { value: '990' } }),
  )
  const days = screen.getByRole('group', { name: 'Working days' })
  const buttons = Array.from(days.querySelectorAll('button'))
  // Monday to Friday are on by default (the locale's weekend is off).
  expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
    'true',
    'true',
    'true',
    'true',
    'true',
    'false',
    'false',
  ])
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Friday' })))
  await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Show week numbers' })))
  await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Week view shows only working days' })))
  await act(async () =>
    fireEvent.change(screen.getByRole('combobox', { name: 'New events last' }), { target: { value: '30' } }),
  )
  await act(async () =>
    fireEvent.change(screen.getByRole('combobox', { name: 'New events remind' }), { target: { value: '15' } }),
  )
  const expected: CalendarPrefs = {
    showWeekNumbers: true,
    workStart: 480,
    workEnd: 990,
    workDays: [1, 2, 3, 4],
    workWeekOnly: true,
    defaultDuration: 30,
    defaultReminder: 15,
  }
  expect(settings$.calendar.get()).toEqual(expected)
  expect(saves.at(-1)).toEqual({ key: 'calendar_general', value: expected })
  // The end can only be chosen after the start.
  const ends = screen.getByRole('combobox', { name: 'Work day ends' }) as HTMLSelectElement
  expect(ends.options[0].textContent).toBe('08:30')
  expect(ends.options[ends.options.length - 1].textContent).toBe('24:00')
  await act(async () =>
    fireEvent.change(screen.getByRole('combobox', { name: 'New events remind' }), { target: { value: '' } }),
  )
  expect(settings$.calendar.get().defaultReminder).toBeNull()
})

it('moves the end along when the start passes it, and keeps one working day', async () => {
  settings$.calendarWeekStart.set('monday')
  settings$.calendar.set({ ...DEFAULT_CALENDAR_PREFS, workDays: [3] })
  const screen = render(<CalendarGeneralGroup />)
  await act(async () =>
    fireEvent.change(screen.getByRole('combobox', { name: 'Work day starts' }), { target: { value: '1200' } }),
  )
  expect(settings$.calendar.get()).toMatchObject({ workStart: 1200, workEnd: 1230 })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Wednesday' })))
  expect(settings$.calendar.get().workDays).toEqual([3])
})

it('loads stored rows, and hydration does not echo them back', async () => {
  hydrateSettings({
    calendar_week_start: 'saturday',
    calendar_general: { showWeekNumbers: true, workStart: 600, workEnd: 540, defaultDuration: 45 },
  })
  expect(settings$.calendarWeekStart.get()).toBe('saturday')
  // An end before the start resets both; the rest survives.
  expect(settings$.calendar.get()).toEqual({ ...DEFAULT_CALENDAR_PREFS, showWeekNumbers: true, defaultDuration: 45 })
  hydrateSettings({ calendar_week_start: 'tuesday' })
  expect(settings$.calendarWeekStart.get()).toBe('saturday')
  const screen = render(<CalendarGeneralGroup />)
  expect((screen.getByRole('combobox', { name: 'First day of the week' }) as HTMLSelectElement).value).toBe('saturday')
  expect(saves.filter((save) => save.key.startsWith('calendar_'))).toEqual([])
})

it('is a settings search destination', () => {
  for (const query of ['week start', 'work hours', 'calendar', 'week numbers']) {
    const found = filterCommands(settingsDestinations([], t), query)
    expect(found.map((item) => item.id)).toContain('settings.section.calendarGeneral')
  }
  const item = settingsDestinations([], t).find((entry) => entry.id === 'settings.section.calendarGeneral')
  expect(item?.label).toBe('Calendar')
  expect(item?.section).toBe('calendarGeneral')
})
