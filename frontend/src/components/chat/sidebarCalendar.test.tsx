import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useSidebarCalendarReading } from './sidebarCalendar'
import { calendar$, type CalendarEvent } from '../../states/calendar'

// How the sidebar's Agenda and Dia panels keep their reading of the calendars
// current (#212, ADR-0059; #362, ADR-0069 §3): the hook both share.

const NOW = new Date(2026, 9, 15, 10).getTime()

const meeting: CalendarEvent = {
  id: 'meeting',
  calendar_id: 'cal',
  subject: 'Meeting',
  start: NOW / 1000,
  end: NOW / 1000 + 3600,
  all_day: false,
  is_recurring: false,
  is_cancelled: false,
  free_busy: 'busy',
  my_response: '',
  attendees: [],
  accountId: 'work',
}

let listeners: Record<string, (detail?: unknown) => void> = {}

function Probe({ read }: { read: (refresh: boolean) => Promise<string> }) {
  const { answer } = useSidebarCalendarReading(read, { now: () => NOW, covering: () => ({ from: 0, to: 1 }) })
  return <p data-testid="answer">{answer ?? 'nothing yet'}</p>
}

beforeEach(() => {
  listeners = {}
  ;(window as any).runtime = {
    EventsOn: (name: string, callback: (detail?: unknown) => void) => {
      listeners[name] = callback
      return () => delete listeners[name]
    },
  }
})

afterEach(() => {
  cleanup()
  delete (window as any).runtime
  calendar$.events.set([])
  calendar$.calendars.set([])
  calendar$.viewing.set(null)
  calendar$.editing.set(null)
})

describe('a sidebar panel’s reading of the calendars', () => {
  it('lands only the newest read: a slow first read overtaken by the one after a sync stays out', async () => {
    const asked: boolean[] = []
    let first: (answer: string) => void = () => {}
    const read = (refresh: boolean) => {
      asked.push(refresh)
      return refresh ? new Promise<string>((resolve) => (first = resolve)) : Promise.resolve('after the sync')
    }
    const screen = render(<Probe read={read} />)
    act(() => listeners['calendar.synced']())
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toBe('after the sync'))
    // The first read, with its refresh, lands last: it is older, and stays out.
    await act(async () => first('before the sync'))
    expect(screen.getByTestId('answer').textContent).toBe('after the sync')
    expect(asked).toEqual([true, false])
  })

  // A delete, a local calendar's save, a calendar hidden, an answer to an
  // invitation: none of them syncs, so no calendar.synced follows.
  it('reads the cache again when the app changes events or calendars, or closes a sheet or editor, without looping', async () => {
    const asked: boolean[] = []
    const read = async (refresh: boolean) => {
      asked.push(refresh)
      return `read ${asked.length}`
    }
    const screen = render(<Probe read={read} />)
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toBe('read 1'))
    act(() => calendar$.events.set([meeting]))
    act(() =>
      calendar$.calendars.set([
        {
          id: 'cal',
          name: 'Work',
          is_default: true,
          enabled: false,
          kind: 'account',
          read_only: false,
          synced_at: 0,
          accountId: 'work',
        },
      ]),
    )
    // Opening a sheet or the editor changes nothing; closing it may have.
    act(() => calendar$.viewing.set(meeting))
    act(() => calendar$.viewing.set(null))
    act(() => calendar$.editing.set({ ...meeting }))
    act(() => calendar$.editing.set(null))
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toBe('read 5'))
    expect(asked).toEqual([true, false, false, false, false])
    // Reading writes none of that state back: nothing reads on by itself.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(asked).toHaveLength(5)
    // Gone with the panel.
    screen.unmount()
    act(() => calendar$.events.set([]))
    expect(asked).toHaveLength(5)
  })
})
