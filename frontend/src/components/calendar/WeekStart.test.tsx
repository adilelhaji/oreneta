import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import i18n from '../../lib/i18n'
import { calendar$, newEvent, viewRange } from '../../states/calendar'
import { settings$ } from '../../states/settings'
import { DEFAULT_CALENDAR_PREFS } from '../../lib/calendarWeek'
import { WeekView } from './WeekView'
import { MonthView } from './MonthView'
import { CalendarView } from './CalendarView'

// Calendar → General (SET-18, ADR-0051) as the views draw it.

// Tuesday 13 October 2026.
const ANCHOR = new Date(2026, 9, 13).getTime()

beforeEach(() => {
  calendar$.events.set([])
  calendar$.calendars.set([])
  calendar$.anchor.set(ANCHOR)
  calendar$.view.set('week')
  settings$.calendarWeekStart.set('monday')
  settings$.calendar.set(DEFAULT_CALENDAR_PREFS)
  ;(window as any).go = { main: { App: { Invoke: async () => ({ ok: true, calendars: [], events: [] }) } } }
})

afterEach(async () => {
  cleanup()
  settings$.calendarWeekStart.set('locale')
  settings$.calendar.set(DEFAULT_CALENDAR_PREFS)
  delete (window as any).go
  await i18n.changeLanguage('en')
})

const headings = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('[data-day-heading]')).map(
    (el) => new Date(Number(el.dataset.dayHeading)),
  )

it('lists the week from the chosen first day, and follows a change', async () => {
  const view = render(<WeekView days={7} onEventMenu={() => {}} />)
  expect(headings(view.container).map((d) => d.getDate())).toEqual([12, 13, 14, 15, 16, 17, 18])
  await act(async () => settings$.calendarWeekStart.set('sunday'))
  expect(headings(view.container).map((d) => d.getDate())).toEqual([11, 12, 13, 14, 15, 16, 17])
  expect(headings(view.container)[0].getDay()).toBe(0)
  await act(async () => settings$.calendarWeekStart.set('saturday'))
  expect(headings(view.container).map((d) => d.getDate())).toEqual([10, 11, 12, 13, 14, 15, 16])
})

it('shades hours outside work and whole days off', async () => {
  const view = render(<WeekView days={7} onEventMenu={() => {}} />)
  const columns = Array.from(view.container.querySelectorAll<HTMLElement>('[data-day-column]'))
  const bands = (column: HTMLElement) =>
    Array.from(column.querySelectorAll<HTMLElement>('[data-off-hours]')).map((band) => band.dataset.offHours)
  // Monday 12 … Sunday 18: Monday to Friday work 9–17 (the default week of
  // every locale with a Saturday–Sunday weekend), the weekend is off.
  expect(columns.map((column) => column.dataset.workday)).toEqual([
    'true',
    'true',
    'true',
    'true',
    'true',
    'false',
    'false',
  ])
  expect(bands(columns[0])).toEqual(['0-9', '17-24'])
  expect(bands(columns[6])).toEqual(['0-24'])
  // Bands sit at their wall-clock hour: 52 px per hour.
  const evening = columns[0].querySelector<HTMLElement>('[data-off-hours="17-24"]')!
  expect(evening.style.top).toBe(`${17 * 52}px`)
  expect(evening.style.height).toBe(`${7 * 52}px`)

  await act(async () => settings$.calendar.set({ ...DEFAULT_CALENDAR_PREFS, workStart: 7 * 60, workEnd: 15 * 60 + 30 }))
  expect(bands(columns[0])).toEqual(['0-7', '15.5-24'])
})

it('shows only the working days when asked, in week order', async () => {
  settings$.calendarWeekStart.set('sunday')
  settings$.calendar.set({ ...DEFAULT_CALENDAR_PREFS, workWeekOnly: true, workDays: [7, 1, 2, 3, 4] })
  const view = render(<WeekView days={7} onEventMenu={() => {}} />)
  expect(headings(view.container).map((d) => d.getDate())).toEqual([11, 12, 13, 14, 15])
  // The day view is never cut down.
  cleanup()
  calendar$.anchor.set(new Date(2026, 9, 17).getTime())
  const day = render(<WeekView days={1} onEventMenu={() => {}} />)
  expect(headings(day.container).map((d) => d.getDate())).toEqual([17])
  expect(day.container.querySelector('[data-off-hours]')?.getAttribute('data-off-hours')).toBe('0-24')
})

it('scrolls to the start of the work day', async () => {
  const tops: number[] = []
  const original = HTMLElement.prototype.scrollTo
  HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) {
    if (typeof options === 'object' && options.top !== undefined) tops.push(options.top)
  } as typeof original
  try {
    settings$.calendar.set({ ...DEFAULT_CALENDAR_PREFS, workStart: 7 * 60 })
    render(<WeekView days={7} onEventMenu={() => {}} />)
    expect(tops.at(-1)).toBe(6.5 * 52)
  } finally {
    HTMLElement.prototype.scrollTo = original
  }
})

it('numbers the weeks only when asked: ISO for Monday weeks', async () => {
  const view = render(<WeekView days={7} onEventMenu={() => {}} />)
  expect(view.container.querySelector('[data-week-number]')).toBeNull()
  await act(async () => settings$.calendar.set({ ...DEFAULT_CALENDAR_PREFS, showWeekNumbers: true }))
  expect(view.container.querySelector('[data-week-number]')?.textContent).toBe('W42')
})

it('month view: weekday headings, grid and week numbers follow the first day', async () => {
  calendar$.anchor.set(new Date(2026, 0, 15).getTime())
  settings$.calendarWeekStart.set('sunday')
  settings$.calendar.set({ ...DEFAULT_CALENDAR_PREFS, showWeekNumbers: true })
  const view = render(<MonthView onEventMenu={() => {}} />)
  expect(view.getAllByText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/).map((el) => el.textContent)).toEqual([
    'Sun',
    'Mon',
    'Tue',
    'Wed',
    'Thu',
    'Fri',
    'Sat',
  ])
  // January 2026 starts on a Thursday; the Sunday grid opens on 28 December,
  // which is in week 1 of 2026 under the Sunday rule.
  const weeks = Array.from(view.container.querySelectorAll<HTMLElement>('[data-week-number]')).map(
    (el) => el.dataset.weekNumber,
  )
  expect(weeks).toEqual(['1', '2', '3', '4', '5', '6'])
  await act(async () => settings$.calendarWeekStart.set('monday'))
  expect(view.getAllByText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/)[0].textContent).toBe('Mon')
  // ISO: the Monday grid opens on 29 December 2025, which is week 1 of 2026.
  expect(view.container.querySelector<HTMLElement>('[data-week-number]')?.dataset.weekNumber).toBe('1')
})

it('loads the window the week view draws', () => {
  settings$.calendarWeekStart.set('sunday')
  const [from, to] = viewRange('week', ANCHOR)
  expect(new Date(from * 1000)).toEqual(new Date(2026, 9, 11))
  expect(new Date(to * 1000)).toEqual(new Date(2026, 9, 18))
})

it('the toolbar toggles the work week and the header names the days shown', async () => {
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<CalendarView />)
  })
  const toggle = view.getByRole('button', { name: 'Work week' })
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  expect(view.getByRole('heading', { level: 1 }).textContent).toBe('12 – Oct 18, 2026')
  await act(async () => fireEvent.click(toggle))
  expect(settings$.calendar.get().workWeekOnly).toBe(true)
  expect(view.getByRole('button', { name: 'Work week' }).getAttribute('aria-pressed')).toBe('true')
  expect(view.getByRole('heading', { level: 1 }).textContent).toBe('12 – Oct 16, 2026')
  expect(headings(view.container)).toHaveLength(5)
})

it('a new event takes the default length and reminder', () => {
  calendar$.calendars.set([
    {
      id: 'c',
      name: 'Local',
      is_default: true,
      enabled: true,
      kind: 'local',
      read_only: false,
      synced_at: 0,
      accountId: 'a',
    },
  ])
  const start = Math.floor(new Date(2026, 9, 13, 10).getTime() / 1000)
  const plain = newEvent(start)!
  expect(plain.end - plain.start).toBe(3600)
  expect(plain.reminder_minutes).toBeUndefined()
  settings$.calendar.set({ ...DEFAULT_CALENDAR_PREFS, defaultDuration: 30, defaultReminder: 15 })
  const draft = newEvent(start)!
  expect(draft.end - draft.start).toBe(1800)
  expect(draft.reminder_minutes).toBe(15)
  calendar$.editing.set(null)
})
