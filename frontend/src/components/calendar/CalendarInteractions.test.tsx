// Moving and resizing events on the grid (#266) and creating them from it
// (#267), through the keyboard, the slot menu and a pointer range: what each
// entry point writes, asks or refuses. Pointer drags of events are covered
// end to end by the startup suite, where there is a real layout; here the
// same move is driven by the keyboard alternative, which goes through the
// same settling and writing.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { calendar$, type CalendarEvent } from '../../states/calendar'
import { accounts$ } from '../../states/accounts'
import { settings$ } from '../../states/settings'
import { ui$ } from '../../states/ui'
import { cancelMove, clickFollowsDrop, markDrop, move$ } from '../../states/calendarMove'
import { DEFAULT_CALENDAR_PREFS } from '../../lib/calendarWeek'
import { CalendarDnd } from './CalendarDnd'
import { MiniCalendar } from './MiniCalendar'
import { MoveQuestions, MoveStatus } from './MoveQuestions'
import { WeekView } from './WeekView'

const calls: { command: string; payload: any }[] = []
let updateError = ''
let details: any = { attendees: [], description: '' }
let detailsError = false

const at = (d: number, h: number, min = 0) => new Date(2020, 9, d, h, min).getTime() / 1000
const clock = (seconds: number) => {
  const date = new Date(seconds * 1000)
  return `${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
}

const event = (patch: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'ev1',
  calendar_id: 'local:home',
  change_key: '7',
  subject: 'Planning',
  start: at(13, 10),
  end: at(13, 11),
  all_day: false,
  is_recurring: false,
  is_cancelled: false,
  free_busy: 'busy',
  my_response: '',
  organizer: null,
  attendees: [],
  accountId: 'a1',
  ...patch,
})

const updates = () => calls.filter((call) => call.command === 'calendar.update')

beforeEach(() => {
  calls.length = 0
  updateError = ''
  details = { attendees: [], description: '' }
  detailsError = false
  ui$.toast.set('')
  cancelMove()
  settings$.calendarWeekStart.set('monday')
  settings$.calendar.set(DEFAULT_CALENDAR_PREFS)
  accounts$.set([
    { id: 'a1', email: 'ana@example.com', auth_type: 'password', provider: 'imap' } as any,
    { id: 'g1', email: 'ana@gmail.com', auth_type: 'gmail_oauth', provider: 'gmail' } as any,
    { id: 'x1', email: 'ana@corp.example', auth_type: 'password', provider: 'exchange' } as any,
  ])
  calendar$.anchor.set(new Date(2020, 9, 13).getTime())
  calendar$.view.set('week')
  calendar$.from.set(0)
  calendar$.to.set(0)
  calendar$.calendars.set([
    { id: 'local:home', name: 'Home', accountId: 'a1', kind: 'local', enabled: true, is_default: true } as any,
    { id: 'holidays', name: 'Holidays', accountId: 'a1', kind: 'subscribed', enabled: true, read_only: true } as any,
    { id: 'primary', name: 'Work', accountId: 'g1', kind: 'account', enabled: true } as any,
    { id: 'ews-cal', name: 'Office', accountId: 'x1', kind: 'account', enabled: true } as any,
  ])
  calendar$.events.set([event()])
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          if (command === 'calendar.conflicts') return { conflicts: [] }
          calls.push({ command, payload: structuredClone(payload) })
          if (command === 'calendar.update' && updateError) throw new Error(updateError)
          if (command === 'calendar.eventDetails') {
            if (detailsError) throw new Error('offline')
            return details
          }
          if (command === 'calendar.events') return { events: [] }
          return { ok: true }
        },
      },
    },
  }
})

afterEach(() => {
  cleanup()
  cancelMove()
  calendar$.editing.set(null)
  calendar$.events.set([])
  settings$.calendarWeekStart.set('locale')
  settings$.calendar.set(DEFAULT_CALENDAR_PREFS)
  delete (window as any).go
})

const view = (days: 1 | 7 = 7) =>
  render(
    <>
      <MoveStatus />
      <MoveQuestions />
      <CalendarDnd>
        <MiniCalendar />
        <WeekView days={days} onEventMenu={() => {}} />
      </CalendarDnd>
    </>,
  )

const eventButton = (screen: ReturnType<typeof view>, key = 'a1:ev1') =>
  screen.container.querySelector<HTMLElement>(`[data-calendar-event="${key}"]`)!

const press = async (element: HTMLElement, key: string, modifiers: Partial<KeyboardEventInit> = {}) => {
  await act(async () => {
    fireEvent.keyDown(element, { key, ...modifiers })
  })
}

describe('moving and resizing from the keyboard (#266)', () => {
  it('moves a grid step, says where it would land, and writes it on Enter with the version it was read at', async () => {
    const screen = view()
    const button = eventButton(screen)
    await press(button, 'ArrowDown', { altKey: true })
    await press(button, 'ArrowDown', { altKey: true })
    expect(clock(move$.moving.peek()!.start)).toBe('13 10:30')
    expect(screen.container.querySelector('[data-move-ghost]')).not.toBeNull()
    expect(screen.container.querySelector('[data-move-status]')?.textContent).toContain('Press Enter to save the change')
    expect(updates()).toHaveLength(0)

    await press(button, 'Enter')
    await waitFor(() => expect(updates()).toHaveLength(1))
    const sent = updates()[0].payload
    expect(clock(sent.event.start)).toBe('13 10:30')
    expect(sent.event.end - sent.event.start).toBe(3600)
    expect(sent.event.change_key).toBe('7')
    expect(sent.scope).toBe('occurrence')
    expect(sent.notify).toBe(false)
    await waitFor(() => expect(move$.moving.peek()).toBeNull())
  })

  it('moves to the next day in reading order and changes the end with Shift', async () => {
    const screen = view()
    const button = eventButton(screen)
    await press(button, 'ArrowRight', { altKey: true })
    await press(button, 'ArrowDown', { altKey: true, shiftKey: true })
    const moving = move$.moving.peek()!
    expect(clock(moving.start)).toBe('14 10:00')
    expect(clock(moving.end)).toBe('14 11:15')
  })

  it('gives the move up with Escape, and nothing is written', async () => {
    const screen = view()
    const button = eventButton(screen)
    await press(button, 'ArrowUp', { altKey: true })
    expect(move$.moving.peek()).not.toBeNull()
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(move$.moving.peek()).toBeNull()
    await press(button, 'Enter')
    expect(updates()).toHaveLength(0)
  })

  it('refuses an event on a read-only calendar and says why', async () => {
    calendar$.events.set([event({ calendar_id: 'holidays' })])
    const screen = view()
    await press(eventButton(screen), 'ArrowDown', { altKey: true })
    expect(move$.moving.peek()).toBeNull()
    expect(ui$.toast.peek()).toBe('The calendar Holidays is read-only: its events cannot be moved or changed here.')
    expect(calls).toHaveLength(0)
  })

  it('refuses an event whose calendar is not loaded rather than assume it is writable', async () => {
    calendar$.events.set([event({ calendar_id: 'gone' })])
    const screen = view()
    await press(eventButton(screen), 'ArrowDown', { altKey: true })
    expect(move$.moving.peek()).toBeNull()
    expect(ui$.toast.peek()).toContain('is not loaded yet')
  })

  it('asks about a series, and writes the answer', async () => {
    calendar$.events.set([event({ is_recurring: true, series_id: 'series-1' })])
    const screen = view()
    const button = eventButton(screen)
    await press(button, 'ArrowDown', { altKey: true })
    await press(button, 'Enter')
    const ask = within(await screen.findByRole('dialog'))
    expect(updates()).toHaveLength(0)
    await act(async () => {
      fireEvent.click(ask.getByRole('button', { name: 'The whole series' }))
    })
    await waitFor(() => expect(updates()).toHaveLength(1))
    expect(updates()[0].payload.scope).toBe('series')
  })

  it('gives a series move up when its question is cancelled', async () => {
    calendar$.events.set([event({ is_recurring: true, series_id: 'series-1' })])
    const screen = view()
    const button = eventButton(screen)
    await press(button, 'ArrowDown', { altKey: true })
    await press(button, 'Enter')
    const ask = within(await screen.findByRole('dialog'))
    await act(async () => {
      fireEvent.click(ask.getByRole('button', { name: 'Cancel' }))
    })
    expect(move$.moving.peek()).toBeNull()
    expect(updates()).toHaveLength(0)
  })

  it('says a conflict with a newer server change, writes nothing more and reads the window again', async () => {
    updateError = 'this event was changed or removed on the server; refresh and try again'
    calendar$.from.set(at(12, 0))
    calendar$.to.set(at(19, 0))
    const screen = view()
    const button = eventButton(screen)
    await press(button, 'ArrowDown', { altKey: true })
    await press(button, 'Enter')
    await waitFor(() => expect(ui$.toast.peek()).toContain('The event was not moved: this event was changed'))
    expect(updates()).toHaveLength(1)
    const reread = calls.filter((call) => call.command === 'calendar.events')
    expect(reread.length).toBeGreaterThan(0)
    expect(reread.every((call) => call.payload.refresh === true)).toBe(true)
    await waitFor(() => expect(move$.moving.peek()).toBeNull())
  })

  it('moves the same way in the day view and in the work week', async () => {
    let screen = view(1)
    await press(eventButton(screen), 'ArrowDown', { altKey: true })
    await press(eventButton(screen), 'Enter')
    await waitFor(() => expect(updates()).toHaveLength(1))
    cleanup()
    // Tuesday 13 is a working day; the week shows Monday to Friday.
    settings$.calendar.set({ ...DEFAULT_CALENDAR_PREFS, workWeekOnly: true })
    screen = view()
    expect(screen.container.querySelectorAll('[data-day-column]')).toHaveLength(5)
    await press(eventButton(screen), 'ArrowRight', { altKey: true })
    await press(eventButton(screen), 'Enter')
    await waitFor(() => expect(updates()).toHaveLength(2))
    expect(clock(updates()[1].payload.event.start)).toBe('14 10:00')
  })

  it('refuses an Exchange event for now, and says why, writing nothing', async () => {
    calendar$.events.set([event({ calendar_id: 'ews-cal', accountId: 'x1' })])
    const screen = view()
    await press(eventButton(screen, 'x1:ev1'), 'ArrowDown', { altKey: true })
    expect(move$.moving.peek()).toBeNull()
    expect(ui$.toast.peek()).toContain('Events of the Exchange calendar Office cannot be dragged yet')
    expect(calls).toHaveLength(0)
  })

  it('does not start a move for Alt+Shift with a left or right arrow', async () => {
    const screen = view()
    await press(eventButton(screen), 'ArrowRight', { altKey: true, shiftKey: true })
    expect(move$.moving.peek()).toBeNull()
  })

  it('writes a Google event with its guests and notes read again, and asks to tell them', async () => {
    details = { attendees: [{ name: 'Bo', addr: 'bo@example.com', response: '' }], description: 'Agenda' }
    calendar$.events.set([
      event({
        calendar_id: 'primary',
        accountId: 'g1',
        // What the window had; the server's copy since lost a guest.
        attendees: [{ name: 'Cy', addr: 'cy@example.com', response: '' }],
        description: 'Old notes',
      }),
    ])
    const screen = view()
    const button = eventButton(screen, 'g1:ev1')
    await press(button, 'ArrowDown', { altKey: true })
    await press(button, 'Enter')
    const ask = within(await screen.findByRole('alertdialog'))
    expect(ask.getByText('bo@example.com')).toBeTruthy()
    await act(async () => {
      fireEvent.click(ask.getByRole('button', { name: 'Save without telling anyone' }))
    })
    await waitFor(() => expect(updates()).toHaveLength(1))
    const sent = updates()[0].payload
    expect(sent.event.attendees.map((person: any) => person.addr)).toEqual(['bo@example.com'])
    expect(sent.event.description).toBe('Agenda')
    expect(sent.notify).toBe(false)
  })

  it('refuses to move an account event whose guests and notes cannot be read', async () => {
    detailsError = true
    calendar$.events.set([event({ calendar_id: 'primary', accountId: 'g1' })])
    const screen = view()
    const button = eventButton(screen, 'g1:ev1')
    await press(button, 'ArrowDown', { altKey: true })
    await press(button, 'Enter')
    await waitFor(() => expect(ui$.toast.peek()).toContain('its guests and notes could not be read'))
    expect(updates()).toHaveLength(0)
    expect(move$.moving.peek()).toBeNull()
  })

  it('writes nothing for a move back to where it started', async () => {
    const screen = view()
    const button = eventButton(screen)
    await press(button, 'ArrowDown', { altKey: true })
    await press(button, 'ArrowUp', { altKey: true })
    await press(button, 'Enter')
    expect(updates()).toHaveLength(0)
    expect(move$.moving.peek()).toBeNull()
  })
})

describe('the mini calendar (#266)', () => {
  it('shows the calendar month and opens a day in the view on screen', async () => {
    const screen = view()
    const nav = within(screen.getByRole('navigation', { name: 'Month at a glance' }))
    expect(nav.getByText('October 2020')).toBeTruthy()
    await act(async () => {
      fireEvent.click(nav.getByRole('button', { name: 'Tuesday, October 20, 2020' }))
    })
    expect(calendar$.anchor.peek()).toBe(new Date(2020, 9, 20).getTime())
    expect(calendar$.view.peek()).toBe('week')
    await act(async () => {
      fireEvent.click(nav.getByRole('button', { name: 'Next month' }))
    })
    expect(nav.getByText('November 2020')).toBeTruthy()
  })
})

describe('creating events on the grid (#267)', () => {
  const column = (screen: ReturnType<typeof view>, day: number) =>
    screen.container.querySelector<HTMLElement>(`[data-day-column="${new Date(2020, 9, day).getTime()}"]`)!
  const slot = (screen: ReturnType<typeof view>) => screen.container.querySelector<HTMLButtonElement>('[data-time-slot]')!
  const slotTimes = (screen: ReturnType<typeof view>) => slot(screen).dataset.timeSlot!.split('-').map(Number)

  it('opens the editor on a range dragged across a column, from line to line', async () => {
    const screen = view()
    const target = column(screen, 14)
    // happy-dom lays nothing out: the column starts at 0, 52 px an hour.
    await act(async () => {
      fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientY: 14 * 52 + 5 })
    })
    await act(async () => {
      fireEvent.pointerMove(target, { pointerId: 1, clientY: 15.4 * 52 })
    })
    expect(screen.container.querySelector('[data-new-range]')?.getAttribute('data-new-range')).toBe(`${at(14, 14)}-${at(14, 15, 30)}`)
    await act(async () => {
      fireEvent.pointerUp(target, { pointerId: 1, clientY: 15.4 * 52 })
    })
    const draft = calendar$.editing.peek()!
    expect(clock(draft.start)).toBe('14 14:00')
    expect(clock(draft.end)).toBe('14 15:30')
    expect(draft.all_day).toBe(false)
  })

  it('does not create anything for a click, or for a range given up with Escape', async () => {
    const screen = view()
    const target = column(screen, 14)
    await act(async () => {
      fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientY: 600 })
    })
    await act(async () => {
      fireEvent.pointerUp(target, { pointerId: 1, clientY: 601 })
    })
    expect(calendar$.editing.peek()).toBeNull()
    await act(async () => {
      fireEvent.pointerDown(target, { button: 0, pointerId: 2, clientY: 600 })
    })
    await act(async () => {
      fireEvent.pointerMove(target, { pointerId: 2, clientY: 700 })
    })
    expect(screen.container.querySelector('[data-new-range]')).not.toBeNull()
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(screen.container.querySelector('[data-new-range]')).toBeNull()
    await act(async () => {
      fireEvent.pointerUp(target, { pointerId: 2, clientY: 700 })
    })
    expect(calendar$.editing.peek()).toBeNull()
  })

  it('offers a new event and a new all-day event on a right click of an empty slot', async () => {
    const screen = view()
    await act(async () => {
      fireEvent.contextMenu(column(screen, 15), { clientX: 10, clientY: 9 * 52 + 20 })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New event' }))
    })
    const timed = calendar$.editing.peek()!
    expect(clock(timed.start)).toBe('15 9:15')
    expect(timed.end - timed.start).toBe(DEFAULT_CALENDAR_PREFS.defaultDuration * 60)
    calendar$.editing.set(null)

    await act(async () => {
      fireEvent.contextMenu(column(screen, 15), { clientX: 10, clientY: 9 * 52 + 20 })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New all-day event' }))
    })
    const allDay = calendar$.editing.peek()!
    expect(allDay.all_day).toBe(true)
    expect(allDay.start).toBe(Date.UTC(2020, 9, 15) / 1000)
    expect(allDay.end - allDay.start).toBe(86400)
  })

  it('keeps the menu of an event for the event', async () => {
    const screen = view()
    await act(async () => {
      fireEvent.contextMenu(eventButton(screen), { clientX: 10, clientY: 10 })
    })
    expect(screen.queryByRole('button', { name: 'New all-day event' })).toBeNull()
  })

  it('moves the keyboard slot in grid steps and days, and creates with Enter or Shift+Enter', async () => {
    const screen = view()
    // Starts at the work day's start, on today if shown, else the first day.
    const [start, end] = slotTimes(screen)
    expect(clock(start)).toBe('12 9:00')
    expect(end - start).toBe(3600)
    expect(slot(screen).getAttribute('aria-label')).toContain('Monday, October 12')

    await press(slot(screen), 'ArrowDown')
    await press(slot(screen), 'ArrowRight')
    await press(slot(screen), 'ArrowDown', { shiftKey: true })
    const [moved, movedEnd] = slotTimes(screen)
    expect(clock(moved)).toBe('13 9:15')
    expect(clock(movedEnd)).toBe('13 10:30')

    await press(slot(screen), 'Enter')
    const draft = calendar$.editing.peek()!
    expect(clock(draft.start)).toBe('13 9:15')
    expect(clock(draft.end)).toBe('13 10:30')
    calendar$.editing.set(null)

    await press(slot(screen), 'Enter', { shiftKey: true })
    const allDay = calendar$.editing.peek()!
    expect(allDay.all_day).toBe(true)
    expect(allDay.start).toBe(Date.UTC(2020, 9, 13) / 1000)
  })

  it('opens the slot menu from the keyboard menu key, keeping the length chosen', async () => {
    const screen = view()
    await press(slot(screen), 'ArrowDown', { shiftKey: true })
    await act(async () => {
      fireEvent.contextMenu(slot(screen))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New event' }))
    })
    const draft = calendar$.editing.peek()!
    expect(clock(draft.start)).toBe('12 9:00')
    expect(clock(draft.end)).toBe('12 10:15')
  })
})

describe('the click a drop leaves behind', () => {
  it('is swallowed for the event that was dropped only', () => {
    markDrop('a1:ev1')
    expect(clickFollowsDrop({ accountId: 'a1', id: 'ev1' })).toBe(true)
    expect(clickFollowsDrop({ accountId: 'a1', id: 'ev2' })).toBe(false)
  })
})
