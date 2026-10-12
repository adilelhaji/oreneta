import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { EventEditor } from './EventEditor'
import { EventDetails } from './EventDetails'
import { calendar$, type CalendarEvent } from '../../states/calendar'
import { accounts$ } from '../../states/accounts'

const calls: { command: string; payload: any }[] = []

const base: CalendarEvent = {
  id: '',
  calendar_id: 'primary',
  subject: 'Design review',
  start: 1_791_799_200,
  end: 1_791_802_800,
  all_day: false,
  is_recurring: false,
  is_cancelled: false,
  free_busy: 'busy',
  my_response: '',
  attendees: [],
  accountId: 'g1',
}

beforeEach(() => {
  calls.length = 0
  accounts$.set([
    { id: 'g1', email: 'ana@gmail.com', auth_type: 'gmail_oauth', provider: 'gmail' } as any,
    { id: 'x1', email: 'ana@corp.example', auth_type: 'password', provider: 'exchange' } as any,
  ])
  calendar$.calendars.set([
    { id: 'primary', name: 'Ana', accountId: 'g1', kind: 'account' } as any,
    { id: 'home', name: 'Home', accountId: 'x1', kind: 'local' } as any,
  ])
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          return command === 'calendar.create' ? { event: { meeting_status: 'ready' } } : {}
        },
      },
    },
  }
})
afterEach(() => {
  cleanup()
  calendar$.editing.set(null)
  calendar$.viewing.set(null)
  delete (window as any).go
})

it('a Google Meet is offered on a Google calendar and asked for only when chosen', async () => {
  calendar$.editing.set({ ...base })
  const screen = render(<EventEditor />)
  const choose = screen.getByLabelText('Add a Google Meet when saving') as HTMLInputElement
  expect(choose.checked).toBe(false)
  fireEvent.click(choose)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })
  await waitFor(() => expect(calls.some((c) => c.command === 'calendar.create')).toBe(true))
  expect(calls.find((c) => c.command === 'calendar.create')!.payload.event.add_meeting).toBe('meet')
})

it('elsewhere nothing is offered to create, and a pasted link is what counts', () => {
  calendar$.editing.set({ ...base, calendar_id: 'home', accountId: 'x1' })
  const screen = render(<EventEditor />)
  expect(screen.queryByLabelText('Add a Google Meet when saving')).toBeNull()
  expect(screen.getByText(/A Zoom, Teams or other link pasted into the location or notes is recognised/)).toBeTruthy()
})

it('an event with a meeting shows it, can drop a Meet, and offers to join', async () => {
  // A reload a previous save started may still be landing.
  await new Promise((r) => setTimeout(r, 50))
  calendar$.calendars.set([{ id: 'primary', name: 'Ana', accountId: 'g1', kind: 'account' } as any])
  const meeting = { provider: 'meet', url: 'https://meet.google.com/abc-defg-hij' }
  calendar$.editing.set({ ...base, id: 'ev1', meeting })
  const editor = render(<EventEditor />)
  expect(editor.getByText('Google Meet')).toBeTruthy()
  fireEvent.click(editor.getByRole('button', { name: 'Remove it' }))
  await act(async () => {
    fireEvent.click(editor.getByRole('button', { name: 'Save' }))
  })
  await waitFor(() => expect(calls.some((c) => c.command === 'calendar.update')).toBe(true))
  expect(calls.find((c) => c.command === 'calendar.update')!.payload.event.add_meeting).toBe('none')
  cleanup()

  let opened = ''
  ;(window as any).runtime = { BrowserOpenURL: (url: string) => (opened = url) }
  calendar$.viewing.set({ ...base, id: 'ev2', meeting: { provider: 'zoom', url: 'https://acme.zoom.us/j/81234' } })
  const details = render(<EventDetails />)
  fireEvent.click(details.getByRole('button', { name: 'Join Zoom' }))
  expect(opened).toBe('https://acme.zoom.us/j/81234')
  delete (window as any).runtime
})
