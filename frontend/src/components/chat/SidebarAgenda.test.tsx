import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { SidebarAgenda, untilNextDay } from './SidebarAgenda'
import { accounts$ } from '../../states/accounts'
import { calendar$, type CalendarEvent } from '../../states/calendar'
import type { Task } from '../../states/tasks'
import { ui$ } from '../../states/ui'

const at = (day: number, hour = 0, minute = 0, second = 0) => new Date(2026, 9, day, hour, minute, second).getTime()
const sec = (ms: number) => Math.floor(ms / 1000)
const NOW = at(15, 10)
// All-day events are dates stored at midnight UTC (states/calendar allDayLocalDays).
const utcDay = (day: number) => Date.UTC(2026, 9, day)

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

const task = (id: number, due: number, extra: Partial<Task> = {}): Task => ({
  id,
  thread_id: '',
  account_id: '',
  folder_id: '',
  note: '',
  due_at: sec(due),
  completed_at: null,
  created_at: 0,
  subject: '',
  from_name: '',
  from_addr: '',
  linked: false,
  title: `task ${id}`,
  priority: 1,
  ...extra,
})

let requests: { command: string; payload: any }[] = []
let replies: Record<string, (payload: any) => unknown> = {}

beforeEach(() => {
  requests = []
  accounts$.set([
    { id: 'work', email: 'me@work.test' } as any,
    { id: 'home', email: 'me@home.test' } as any,
    { id: 'rss:news', email: '' } as any,
  ])
  replies = {
    'calendar.events': (p) =>
      p.account_id === 'work'
        ? { events: [event('Design review', at(15, 14), at(15, 15)), event('Offsite', utcDay(16), utcDay(17), { all_day: true })] }
        : { events: [event('Dentist', at(15, 11), at(15, 12))] },
    'tasks.list': () => ({
      tasks: [
        task(1, at(12), { title: 'Send the invoice' }),
        task(2, at(16), { title: 'Book flights', thread_id: 'work#INBOX#t9', linked: true, note: 'window seat' }),
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
          return reply(payload)
        },
      },
    },
  }
})

afterEach(() => {
  cleanup()
  delete (window as any).go
  delete (window as any).runtime
  calendar$.viewing.set(null)
  ui$.calendarOpen.set(false)
  ui$.tasksOpen.set(false)
  ui$.taskEditor.set(null)
})

describe('sidebar agenda widget (#212)', () => {
  it('lists overdue tasks, then each day of every enabled calendar and task list, in order', async () => {
    const screen = render(<SidebarAgenda now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Design review')).toBeTruthy())
    // Every account with mail is asked for the week ahead; a feed is not.
    const asked = requests.filter((r) => r.command === 'calendar.events')
    expect(asked.map((r) => r.payload.account_id).sort()).toEqual(['home', 'work'])
    // The days shown and one more on each side, for all-day dates stored at midnight UTC.
    expect(asked[0].payload).toMatchObject({ from: sec(at(15)) - 86_400, to: sec(at(22)) + 86_400, refresh: true })
    expect(requests.find((r) => r.command === 'tasks.list')?.payload).toEqual({ include_completed: false })

    const headings = screen.getAllByRole('heading').map((h) => h.textContent)
    expect(headings).toEqual(['Overdue', 'Today', 'Tomorrow'])
    expect(within(screen.getByRole('region', { name: 'Overdue' })).getByText('Send the invoice')).toBeTruthy()
    const today = within(screen.getByRole('region', { name: 'Today' }))
      .getAllByRole('button')
      .map((b) => b.querySelector('span')?.textContent)
    expect(today).toEqual(['Dentist', 'Design review'])
    const tomorrow = within(screen.getByRole('region', { name: 'Tomorrow' })).getAllByRole('button')
    expect(tomorrow.map((b) => b.querySelector('span')?.textContent)).toEqual(['Offsite', 'Book flights'])
    expect(tomorrow[0].textContent).toContain('All day')
    expect(tomorrow[1].textContent).toContain('Task')
    expect(screen.getAllByRole('button')).toHaveLength(5)
  })

  it('opens an event on its day in the calendar, with the event shown', async () => {
    ui$.tasksOpen.set(true)
    const screen = render(<SidebarAgenda now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Dentist/ }))
    expect(ui$.calendarOpen.get()).toBe(true)
    expect(ui$.tasksOpen.get()).toBe(false)
    expect(calendar$.view.get()).toBe('day')
    expect(calendar$.anchor.get()).toBe(at(15))
    expect(calendar$.viewing.get()).toMatchObject({ subject: 'Dentist', accountId: 'home' })
    // An all-day event opens on its date, not on the day its UTC instant falls on here.
    fireEvent.click(screen.getByRole('button', { name: /Offsite/ }))
    expect(calendar$.anchor.get()).toBe(at(16))
    expect(calendar$.viewing.get()).toMatchObject({ subject: 'Offsite' })
  })

  it('opens a task in its editor, keeping its conversation', async () => {
    const screen = render(<SidebarAgenda now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Book flights')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Book flights/ }))
    expect(ui$.taskEditor.get()).toEqual({ threadId: 'work#INBOX#t9', id: 2, dueAt: sec(at(16)), note: 'window seat' })
    fireEvent.click(screen.getByRole('button', { name: /Send the invoice/ }))
    expect(ui$.taskEditor.get()).toEqual({ threadId: '', id: 1, dueAt: sec(at(12)), note: '' })
  })

  it('makes every item a native button that takes focus (the browser gives it Enter and Space)', async () => {
    const screen = render(<SidebarAgenda now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
    for (const button of screen.getAllByRole('button')) {
      expect(button.tagName).toBe('BUTTON')
      expect(button.getAttribute('type')).toBe('button')
      button.focus()
      expect(document.activeElement).toBe(button)
    }
    // Enter on a focused item is checked in the production entry (e2e), where
    // the browser turns it into the click a test DOM does not synthesize.
  })

  it('reads the tasks again when the task editor closes', async () => {
    const screen = render(<SidebarAgenda now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Book flights')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Book flights/ }))
    replies['tasks.list'] = () => ({ tasks: [task(2, at(17), { title: 'Book flights (moved)' })] })
    ui$.taskEditor.set(null)
    await waitFor(() => expect(screen.getByText('Book flights (moved)')).toBeTruthy())
    expect(screen.queryByText('Send the invoice')).toBeNull()
  })

  it('moves Today and Tomorrow on at local midnight', async () => {
    let clock = at(15, 23, 59, 59) + 900
    expect(untilNextDay(clock)).toBe(150)
    const screen = render(<SidebarAgenda now={() => clock} />)
    await waitFor(() => expect(screen.getByRole('region', { name: 'Tomorrow' })).toBeTruthy())
    expect(within(screen.getByRole('region', { name: 'Tomorrow' })).getByText('Offsite')).toBeTruthy()
    clock = at(16, 0, 0, 1)
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Today' })).getByText('Offsite')).toBeTruthy(), {
      timeout: 2000,
    })
    expect(screen.queryByRole('region', { name: 'Tomorrow' })).toBeNull()
  })

  it('says when a calendar could not be read instead of showing a shorter week as complete', async () => {
    const original = replies['calendar.events']
    replies['calendar.events'] = (p) => {
      if (p.account_id === 'home') throw new Error('locked')
      return original(p)
    }
    const screen = render(<SidebarAgenda now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Design review')).toBeTruthy())
    expect(screen.getByRole('status').textContent).toContain('could not be read')
    expect(screen.queryByText('Dentist')).toBeNull()
  })

  it('says so when there is nothing in the week', async () => {
    replies['calendar.events'] = () => ({ events: [] })
    replies['tasks.list'] = () => ({ tasks: [] })
    const screen = render(<SidebarAgenda now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Nothing scheduled or due in the next 7 days.')).toBeTruthy())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('reads the cache again when a calendar refresh lands', async () => {
    const listeners: Record<string, () => void> = {}
    ;(window as any).runtime = {
      EventsOn: (name: string, callback: () => void) => {
        listeners[name] = callback
        return () => delete listeners[name]
      },
    }
    const screen = render(<SidebarAgenda now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
    replies['calendar.events'] = (p) =>
      p.account_id === 'home' ? { events: [event('Moved dentist', at(15, 16), at(15, 17))] } : { events: [] }
    listeners['calendar.synced']()
    await waitFor(() => expect(screen.getByText('Moved dentist')).toBeTruthy())
    expect(requests.filter((r) => r.command === 'calendar.events').at(-1)?.payload.refresh).toBe(false)
    screen.unmount()
    expect(listeners['calendar.synced']).toBeUndefined()
  })

  it('says the agenda may be out of date while a calendar refresh has failed, until a later sync of the week lands', async () => {
    const listeners: Record<string, (detail?: unknown) => void> = {}
    ;(window as any).runtime = {
      EventsOn: (name: string, callback: (detail?: unknown) => void) => {
        listeners[name] = callback
        return () => delete listeners[name]
      },
    }
    const screen = render(<SidebarAgenda now={() => NOW} />)
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy())
    expect(screen.queryByRole('status')).toBeNull()
    // The cache answered; the server behind it did not.
    act(() => listeners['calendar.syncError']({ account: 'home', message: 'calendar sync: connection refused' }))
    expect(screen.getByRole('status').textContent).toContain('may be out of date')
    // The cached events stay on screen, marked rather than hidden.
    expect(screen.getByText('Dentist')).toBeTruthy()
    const week = { from: sec(at(15)) - 86_400, to: sec(at(22)) + 86_400 }
    // Another account's sync, or this account's for one hour, does not vouch for it.
    act(() => listeners['calendar.synced']({ account: 'work', ...week }))
    act(() => listeners['calendar.synced']({ account: 'home', from: sec(at(15, 11)), to: sec(at(15, 12)) }))
    await waitFor(() => expect(requests.filter((r) => r.command === 'calendar.events').length).toBeGreaterThan(4))
    expect(screen.getByRole('status').textContent).toContain('may be out of date')
    // Its own week synced: current again.
    act(() => listeners['calendar.synced']({ account: 'home', ...week }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    screen.unmount()
    expect(listeners['calendar.syncError']).toBeUndefined()
  })
})
