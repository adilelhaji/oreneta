import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SidebarDay } from './SidebarDay'
import { intlLocale } from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import { calendar$, startOfDay, type CalendarEvent } from '../../states/calendar'
import { sidebar$ } from '../../states/sidebar'
import { ui$ } from '../../states/ui'

// The sidebar's Dia panel (ADR-0069 §3, #362).

const at = (day: number, hour = 0, minute = 0, second = 0) => new Date(2026, 9, day, hour, minute, second).getTime()
const sec = (ms: number) => Math.floor(ms / 1000)
const NOW = at(15, 10)
// All-day events are dates stored at midnight UTC (states/calendar allDayLocalDays).
const utcDay = (day: number) => Date.UTC(2026, 9, day)
// What the core is asked for one day: the day and one more on each side.
const windowOf = (day: number) => ({ from: sec(at(day)) - 86_400, to: sec(at(day + 1)) + 86_400 })

const time = (ms: number) => new Date(ms).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })
const range = (from: number, to: number) => `${time(from)}–${time(to)}`
const dateOf = (ms: number) =>
  new Date(ms).toLocaleDateString(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long' })

const event = (id: string, start: number, end: number, extra: Partial<CalendarEvent> = {}) => ({
  id,
  calendar_id: 'cal',
  subject: id,
  start: sec(start),
  end: sec(end),
  all_day: false,
  is_recurring: false,
  is_cancelled: false,
  free_busy: 'busy',
  my_response: '',
  attendees: [],
  ...extra,
})

let requests: { command: string; payload: any }[] = []
let replies: Record<string, (payload: any) => unknown> = {}
let listeners: Record<string, (detail?: unknown) => void> = {}

const dayReads = () => requests.filter((request) => request.command === 'calendar.events')
const eventButtons = (screen: ReturnType<typeof render>) =>
  screen.getAllByRole('button').filter((button) => button.closest('li'))
const rows = (screen: ReturnType<typeof render>) =>
  [...screen.container.querySelectorAll('li')].map((li) =>
    li.hasAttribute('data-now-line') ? 'now' : li.querySelector('bdi')?.textContent,
  )

beforeEach(() => {
  requests = []
  listeners = {}
  accounts$.set([
    { id: 'work', email: 'me@work.test' } as any,
    { id: 'home', email: 'me@home.test' } as any,
    { id: 'rss:news', email: '' } as any,
  ])
  calendar$.calendars.set([])
  replies = {
    'calendar.events': (p) =>
      p.account_id === 'work'
        ? {
            events: [
              event('Design review', at(15, 14), at(15, 15), {
                my_response: 'tentative',
                organizer: { name: 'Ana', addr: 'ana@work.test', response: '' },
              }),
              event('Holiday', utcDay(15), utcDay(16), { all_day: true }),
              event('Offsite', utcDay(16), utcDay(17), { all_day: true }),
              event('Night shift', at(14, 22), at(15, 2)),
              event('Cancelled call', at(15, 16), at(15, 17), { is_cancelled: true }),
            ],
          }
        : { events: [event('Dentist', at(15, 11), at(15, 12))] },
    // One calendar per account, named; each account's events are in it.
    'calendar.list': (p) => ({
      calendars: [
        {
          id: `${p.account_id}-cal`,
          name: p.account_id === 'work' ? 'Work' : 'Family',
          is_default: true,
          enabled: true,
          kind: 'account',
          read_only: false,
          synced_at: 0,
        },
      ],
    }),
  }
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          requests.push({ command, payload })
          const reply = replies[command]
          if (!reply) throw new Error(`unexpected ${command}`)
          const answer: any = await reply(payload)
          if (command !== 'calendar.events') return answer
          return {
            events: answer.events.map((e: CalendarEvent) => ({ ...e, calendar_id: `${payload.account_id}-cal` })),
          }
        },
      },
    },
  }
  ;(window as any).runtime = {
    EventsOn: (name: string, callback: (detail?: unknown) => void) => {
      listeners[name] = callback
      return () => delete listeners[name]
    },
  }
})

afterEach(() => {
  cleanup()
  delete (window as any).go
  delete (window as any).runtime
  calendar$.viewing.set(null)
  calendar$.calendars.set([])
  calendar$.anchor.set(startOfDay(new Date()).getTime())
  calendar$.view.set('agenda')
  sidebar$.overlay.set(false)
  ui$.module.set('mail')
})

describe('the day panel (ADR-0069 §3, #362)', () => {
  it('lists the day of every enabled calendar: all-day first, then by start, with the time now as a line', async () => {
    const screen = render(<SidebarDay now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
    // Every account with mail is asked for the day, refreshed behind the cache; a feed is not.
    expect(
      dayReads()
        .map((r) => r.payload.account_id)
        .sort(),
    ).toEqual(['home', 'work'])
    expect(dayReads()[0].payload).toMatchObject({ ...windowOf(15), refresh: true })
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(`Today · ${dateOf(at(15))}`)
    // The holiday on its date; the night shift since yesterday, by its start;
    // the time now after what has begun; no cancelled call; not tomorrow's offsite.
    expect(rows(screen)).toEqual(['Holiday', 'Night shift', 'now', 'Dentist', 'Design review'])
    expect(screen.container.querySelector('[data-now-line]')!.textContent).toBe(`Now, ${time(NOW)}`)
    expect(screen.queryByText('Cancelled call')).toBeNull()
    expect(screen.queryByText('Offsite')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText('No events')).toBeNull()
  })

  // Keyboard: native buttons named in full, as the calendar grid's.
  it('makes each event a native button named by its title, time, calendar and answer', async () => {
    const screen = render(<SidebarDay now={() => NOW} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^Dentist, / })).toBeTruthy())
    await waitFor(() => expect(screen.getByRole('button', { name: /^Dentist, .*, Family$/ })).toBeTruthy())
    const names = eventButtons(screen).map((button) => button.getAttribute('aria-label'))
    expect(names).toEqual([
      'Holiday, All day, Work',
      // Since yesterday: its start says which day.
      `Night shift, ${new Date(at(14, 22)).toLocaleString(intlLocale(), {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })}–${time(at(15, 2))}, Work`,
      `Dentist, ${range(at(15, 11), at(15, 12))}, Family`,
      // Someone else's meeting, answered tentatively.
      `Design review, ${range(at(15, 14), at(15, 15))}, Work, Tentative`,
    ])
    for (const button of screen.getAllByRole('button')) {
      expect(button.tagName).toBe('BUTTON')
      expect(button.getAttribute('type')).toBe('button')
      button.focus()
      expect(document.activeElement).toBe(button)
    }
    // The day's controls come first, in reading order, then the events.
    expect(
      screen
        .getAllByRole('button')
        .slice(0, 3)
        .map((button) => button.textContent || button.getAttribute('aria-label')),
    ).toEqual(['Previous day', 'Today', 'Next day'])
    // Enter on a focused event is checked in the production entry (e2e),
    // where the browser turns it into the click a test DOM does not synthesize.
  })

  it('says no answer for a meeting of the account itself, and an answer still due as such', async () => {
    replies['calendar.events'] = (p) =>
      p.account_id === 'work'
        ? {
            events: [
              // Google says "accepted" of the organizer's own event.
              event('Own meeting', at(15, 9), at(15, 10), {
                my_response: 'accepted',
                organizer: { name: 'Me', addr: 'ME@work.test', response: '' },
              }),
              event('Exchange own', at(15, 11), at(15, 12), { my_response: 'organizer' }),
              event('Invitation', at(15, 13), at(15, 14), {
                my_response: 'none',
                organizer: { name: 'Ana', addr: 'ana@work.test', response: '' },
              }),
            ],
          }
        : { events: [] }
    const screen = render(<SidebarDay now={() => NOW} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Invitation, .*, Work, No answer yet$/ })).toBeTruthy(),
    )
    expect(screen.getByRole('button', { name: /^Own meeting, .*, Work$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Exchange own, .*, Work$/ })).toBeTruthy()
    // Said on screen too, beside the calendar.
    expect(screen.getByText('Work · No answer yet')).toBeTruthy()
  })

  it('opens an event in the calendar on the day shown, with its sheet', async () => {
    ui$.module.set('tasks')
    const screen = render(<SidebarDay now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Dentist, / }))
    expect(ui$.module.get()).toBe('calendar')
    expect(calendar$.view.get()).toBe('day')
    expect(calendar$.anchor.get()).toBe(at(15))
    expect(calendar$.viewing.get()).toMatchObject({ subject: 'Dentist', accountId: 'home' })
    // One that began yesterday opens on the day it was chosen on.
    fireEvent.click(screen.getByRole('button', { name: /^Night shift, / }))
    expect(calendar$.anchor.get()).toBe(at(15))
    expect(calendar$.viewing.get()).toMatchObject({ subject: 'Night shift', accountId: 'work' })
    // An all-day event on its date, in any zone.
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    await waitFor(() => expect(screen.getByText('Offsite')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Offsite, / }))
    expect(calendar$.anchor.get()).toBe(at(16))
    expect(calendar$.viewing.get()).toMatchObject({ subject: 'Offsite' })
  })

  // In Calendar the module does not change, so nothing else closes the app
  // sidebar's overlay, whose module is inert under it: the event does, as
  // the agenda's (#361).
  it('closes the app sidebar overlay before it opens an event in the calendar under it', async () => {
    ui$.module.set('calendar')
    calendar$.anchor.set(at(15))
    sidebar$.overlay.set(true)
    const screen = render(<SidebarDay now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Dentist, / }))
    expect(sidebar$.overlay.get()).toBe(false)
    expect(calendar$.viewing.get()).toMatchObject({ subject: 'Dentist' })
  })

  it('opens in Calendar on the day selected there, and does not follow it after', async () => {
    ui$.module.set('calendar')
    calendar$.anchor.set(at(16))
    const screen = render(<SidebarDay now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Offsite')).toBeTruthy())
    expect(dayReads()[0].payload).toMatchObject(windowOf(16))
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(dateOf(at(16)))
    // Not today: no line.
    expect(screen.container.querySelector('[data-now-line]')).toBeNull()
    // The calendar moves on; the panel stays where it is, and reads nothing new.
    const asked = dayReads().length
    act(() => calendar$.anchor.set(at(20)))
    await Promise.resolve()
    expect(dayReads()).toHaveLength(asked)
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(dateOf(at(16)))
    expect(screen.getByText('Offsite')).toBeTruthy()
  })

  it('opens on today in the other modules, whatever day the calendar is on', async () => {
    for (const module of ['mail', 'tasks', 'people', 'notes'] as const) {
      ui$.module.set(module)
      calendar$.anchor.set(at(20))
      requests = []
      const screen = render(<SidebarDay now={() => NOW} />)
      await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
      expect(dayReads()[0].payload, module).toMatchObject(windowOf(15))
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(`Today · ${dateOf(at(15))}`)
      cleanup()
    }
  })

  it('goes to the previous day, the next day and today, reading each with a refresh behind it', async () => {
    const screen = render(<SidebarDay now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
    const heading = () => screen.getByRole('heading', { level: 3 })
    // Said again as the day moves.
    expect(heading().getAttribute('aria-live')).toBe('polite')

    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
    await waitFor(() => expect(heading().textContent).toBe(dateOf(at(14))))
    await waitFor(() => expect(screen.getByText('Night shift')).toBeTruthy())
    expect(dayReads().at(-1)!.payload).toMatchObject({ ...windowOf(14), refresh: true })
    expect(screen.queryByText('Dentist')).toBeNull()
    expect(screen.container.querySelector('[data-now-line]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    await waitFor(() => expect(heading().textContent).toBe(dateOf(at(16))))
    await waitFor(() => expect(screen.getByText('Offsite')).toBeTruthy())
    expect(dayReads().at(-1)!.payload).toMatchObject({ ...windowOf(16), refresh: true })
    expect(rows(screen)).toEqual(['Offsite'])

    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    await waitFor(() => expect(heading().textContent).toBe(`Today · ${dateOf(at(15))}`))
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
    expect(rows(screen)).toEqual(['Holiday', 'Night shift', 'now', 'Dentist', 'Design review'])
  })

  it('never shows a slower answer for the day it left on the day it moved to', async () => {
    let release: () => void = () => {}
    const original = replies['calendar.events']
    replies['calendar.events'] = (p) =>
      p.from === windowOf(15).from
        ? new Promise((resolve) => (release = () => resolve(original(p))))
        : { events: [event(`Day ${p.account_id}`, at(16, 9), at(16, 10))] }
    const screen = render(<SidebarDay now={() => NOW} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    await waitFor(() => expect(screen.getByText('Day work')).toBeTruthy())
    await act(async () => release())
    expect(screen.queryByText('Dentist')).toBeNull()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(dateOf(at(16)))
  })
})

describe('what the day panel cannot read, it says (ADR-0069 §3)', () => {
  it('says the day may be incomplete when a calendar could not be read, never «No events»', async () => {
    replies['calendar.events'] = (p) => {
      if (p.account_id === 'home') throw new Error('locked')
      return { events: [] }
    }
    const screen = render(<SidebarDay now={() => NOW} />)
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(screen.getByRole('status').textContent).toBe(
      'Some calendars could not be read, so this day may be incomplete.',
    )
    expect(screen.queryByText('No events')).toBeNull()
    expect(screen.queryByText('Dentist')).toBeNull()
  })

  it('shows what was read beside the warning', async () => {
    const original = replies['calendar.events']
    replies['calendar.events'] = (p) => {
      if (p.account_id === 'home') throw new Error('locked')
      return original(p)
    }
    const screen = render(<SidebarDay now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Design review')).toBeTruthy())
    expect(screen.getByRole('status').textContent).toContain('may be incomplete')
    expect(screen.queryByText('Dentist')).toBeNull()
  })

  it('says «No events» only once every read went well', async () => {
    replies['calendar.events'] = () => ({ events: [] })
    const screen = render(<SidebarDay now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('No events')).toBeTruthy())
    expect(screen.queryByRole('status')).toBeNull()
    // A refresh that failed: the cache may not hold the day's events.
    act(() => listeners['calendar.syncError']({ account: 'home', message: 'calendar sync: connection refused' }))
    expect(screen.getByRole('status').textContent).toContain('may be out of date')
    expect(screen.queryByText('No events')).toBeNull()
    act(() => listeners['calendar.synced']({ account: 'home', ...windowOf(15) }))
    await waitFor(() => expect(screen.getByText('No events')).toBeTruthy())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says the day may be out of date after a failed refresh, until a sync of that account covers the day', async () => {
    const screen = render(<SidebarDay now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
    expect(screen.queryByRole('status')).toBeNull()
    // The cache answered; the server behind it did not.
    act(() => listeners['calendar.syncError']({ account: 'home', message: 'calendar sync: connection refused' }))
    expect(screen.getByRole('status').textContent).toBe('Could not reach the server; what you see may be out of date.')
    // The cached events stay on screen, marked rather than hidden.
    expect(screen.getByText('Dentist')).toBeTruthy()
    // Another account's sync, this account's for one hour, or its sync of another day does not vouch for it.
    act(() => listeners['calendar.synced']({ account: 'work', ...windowOf(15) }))
    act(() => listeners['calendar.synced']({ account: 'home', from: sec(at(15, 11)), to: sec(at(15, 12)) }))
    act(() => listeners['calendar.synced']({ account: 'home', ...windowOf(20) }))
    await waitFor(() => expect(dayReads().length).toBeGreaterThan(4))
    expect(screen.getByRole('status').textContent).toContain('may be out of date')
    // Still out of date on the next day, until a sync covers that one.
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    await waitFor(() => expect(screen.getByText('Offsite')).toBeTruthy())
    expect(screen.getByRole('status').textContent).toContain('may be out of date')
    act(() => listeners['calendar.synced']({ account: 'home', ...windowOf(16) }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('reads the cache again when a refresh lands, and at midnight, keeping its day', async () => {
    const screen = render(<SidebarDay now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
    replies['calendar.events'] = (p) =>
      p.account_id === 'home' ? { events: [event('Moved dentist', at(15, 16), at(15, 17))] } : { events: [] }
    act(() => listeners['calendar.synced']())
    await waitFor(() => expect(screen.getByText('Moved dentist')).toBeTruthy())
    expect(dayReads().at(-1)!.payload.refresh).toBe(false)
    screen.unmount()
    expect(listeners['calendar.synced']).toBeUndefined()
    expect(listeners['calendar.syncError']).toBeUndefined()
  })

  it('takes the line away at midnight and stays on its day', async () => {
    let clock = at(15, 23, 59, 59) + 900
    const screen = render(<SidebarDay now={() => clock} />)
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
    expect(screen.container.querySelector('[data-now-line]')).toBeTruthy()
    const asked = dayReads().length
    clock = at(16, 0, 0, 1)
    await waitFor(() => expect(dayReads().length).toBeGreaterThan(asked), { timeout: 2000 })
    await waitFor(() => expect(screen.container.querySelector('[data-now-line]')).toBeNull())
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(dateOf(at(15)))
    expect(dayReads().at(-1)!.payload).toMatchObject({ ...windowOf(15), refresh: false })
  })
})
