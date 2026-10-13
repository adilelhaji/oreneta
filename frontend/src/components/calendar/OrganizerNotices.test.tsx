// The organizer of a meeting in a local or CalDAV calendar telling the people
// on it (2026-10-12): asked with their names, sent as one message with the
// calendar part, and never sent when the person chose not to — or when no
// account here could send it, in which case the question is not asked.
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { EventEditor } from './EventEditor'
import { calendar$, type CalendarEvent } from '../../states/calendar'
import { accounts$ } from '../../states/accounts'
import { ui$ } from '../../states/ui'

const calls: { command: string; payload: any }[] = []
let mailReply: any = { ok: true }
let noticeError = ''

const guests = [
  { name: 'Bo', addr: 'bo@example.com', response: '' },
  { name: 'Cy', addr: 'cy@example.com', response: 'accept' },
]

const meeting = (calendar_id: string, accountId: string): CalendarEvent => ({
  id: 'ev1@1894269600',
  calendar_id,
  subject: 'Planning',
  start: 1_894_269_600,
  end: 1_894_273_200,
  all_day: false,
  is_recurring: false,
  is_cancelled: false,
  free_busy: 'busy',
  my_response: '',
  organizer: null,
  attendees: guests,
  accountId,
})

const mailAccount = {
  id: 'm1',
  email: 'ana@example.com',
  sender_name: 'Ana',
  auth_type: 'password',
  provider: 'imap',
} as any
const googleAccount = { id: 'g1', email: 'ana@gmail.com', auth_type: 'gmail_oauth', provider: 'gmail' } as any

beforeEach(() => {
  calls.length = 0
  mailReply = { ok: true }
  noticeError = ''
  ui$.toast.set('')
  accounts$.set([mailAccount, googleAccount])
  calendar$.calendars.set([
    { id: 'https://dav.example.com/cal/', name: 'Work', accountId: 'm1', kind: 'caldav', enabled: true } as any,
    { id: 'local:home', name: 'Home', accountId: 'm1', kind: 'local', enabled: true } as any,
    { id: 'primary', name: 'Ana', accountId: 'g1', kind: 'account', enabled: true } as any,
  ])
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          // The overlap check the editor runs on its own is not part of this.
          if (command === 'calendar.conflicts') return { conflicts: [] }
          calls.push({ command, payload })
          if (command === 'invite.notify') {
            if (noticeError) throw new Error(noticeError)
            const method = payload.method === 'cancel' ? 'CANCEL' : 'REQUEST'
            return {
              notice: {
                method,
                to: payload.people,
                subject: method === 'CANCEL' ? 'Cancelled: Planning' : 'Updated invitation: Planning',
                sequence: 1,
                ics: `BEGIN:VCALENDAR\r\nMETHOD:${method}\r\nEND:VCALENDAR\r\n`,
              },
            }
          }
          if (command === 'mail.send') return mailReply
          if (command === 'calendar.create') return { event: { id: 'local:new' } }
          return {}
        },
      },
    },
  }
})

afterEach(() => {
  cleanup()
  calendar$.editing.set(null)
  calendar$.viewing.set(null)
  calendar$.error.set('')
  delete (window as any).go
})

const commands = () => calls.map((call) => call.command)
const mails = () => calls.filter((call) => call.command === 'mail.send')

it('a CalDAV meeting asks with the names and sends one invitation to them', async () => {
  calendar$.editing.set(meeting('https://dav.example.com/cal/', 'm1'))
  const screen = render(<EventEditor />)
  expect(screen.queryByText(/does not notify them/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  // Named, with the address it goes out from.
  const ask = within(screen.getByRole('alertdialog'))
  expect(ask.getByText('bo@example.com')).toBeTruthy()
  expect(ask.getByText('cy@example.com')).toBeTruthy()
  expect(ask.getByText('Sent by mail from ana@example.com')).toBeTruthy()

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send it' }))
  })
  await waitFor(() => expect(mails().length).toBe(1))

  // Saved first (the server is not asked to tell anyone), then built from
  // what was saved, then mailed.
  expect(commands().filter((c) => c !== 'mail.send')).toEqual(['calendar.update', 'invite.notify'])
  const update = calls.find((c) => c.command === 'calendar.update')!.payload
  expect(update.notify).toBe(false)
  expect(update.event.organizer).toEqual({ name: 'Ana', addr: 'ana@example.com', response: '' })
  const notify = calls.find((c) => c.command === 'invite.notify')!.payload
  expect(notify).toMatchObject({
    account: 'm1',
    calendar: 'https://dav.example.com/cal/',
    event: 'ev1@1894269600',
    method: 'request',
    scope: 'occurrence',
    me_addr: 'ana@example.com',
    people: ['bo@example.com', 'cy@example.com'],
  })
  const mail = mails()[0].payload
  expect(mail.account_id).toBe('m1')
  expect(mail.to).toBe('bo@example.com, cy@example.com')
  expect(mail.subject).toBe('Updated invitation: Planning')
  expect(mail.attachments).toHaveLength(1)
  expect(mail.attachments[0].mime).toBe('text/calendar; method=REQUEST; charset=utf-8')
  expect(atob(mail.attachments[0].data)).toContain('METHOD:REQUEST')
})

it('a local meeting saved without telling anyone sends nothing', async () => {
  calendar$.editing.set(meeting('local:home', 'm1'))
  const screen = render(<EventEditor />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save without telling anyone' }))
  })
  await waitFor(() => expect(commands()).toContain('calendar.update'))
  await new Promise((r) => setTimeout(r, 20))
  expect(commands()).toEqual(['calendar.update'])
  expect(calls[0].payload.notify).toBe(false)
})

it('deleting a local meeting builds the cancellation, deletes, then sends it', async () => {
  calendar$.editing.set({
    ...meeting('local:home', 'm1'),
    id: 'local:abc',
    organizer: { name: 'Ana', addr: 'Ana@Example.com', response: '' },
  })
  const screen = render(<EventEditor />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  expect(within(screen.getByRole('alertdialog')).getByText('bo@example.com')).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send a cancellation' }))
  })
  await waitFor(() => expect(mails().length).toBe(1))
  expect(commands()).toEqual(['invite.notify', 'calendar.delete', 'mail.send'])
  expect(calls[0].payload.method).toBe('cancel')
  expect(calls[1].payload.notify).toBe(false)
  const mail = mails()[0].payload
  expect(mail.to).toBe('bo@example.com, cy@example.com')
  expect(mail.attachments[0].mime).toBe('text/calendar; method=CANCEL; charset=utf-8')
  expect(ui$.toast.peek()).toBe('Cancellation sent')
})

it('a cancellation that cannot be prepared deletes nothing and says why', async () => {
  noticeError = 'the server could not be reached'
  calendar$.editing.set({ ...meeting('https://dav.example.com/cal/', 'm1'), id: 'ev2@1894269600' })
  const screen = render(<EventEditor />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send a cancellation' }))
  })
  await waitFor(() => expect(screen.getByText(/could not be prepared: the server could not be reached/)).toBeTruthy())
  expect(commands()).toEqual(['invite.notify'])
})

it('a failed send is said, and the event stays saved', async () => {
  mailReply = { ok: false, error: 'SMTP refused it' }
  calendar$.editing.set(meeting('local:home', 'm1'))
  const screen = render(<EventEditor />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send it' }))
  })
  await waitFor(() => expect(ui$.toast.peek()).toContain('were not told: SMTP refused it'))
  expect(ui$.toastTone.peek()).toBe('error')
  expect(commands()).toEqual(['calendar.update', 'invite.notify', 'mail.send'])
})

it('with no account that can send, nothing is offered and the note stays', async () => {
  accounts$.set([{ id: 'r1', email: 'feeds', provider: 'rss', auth_type: 'rss' } as any])
  calendar$.editing.set(meeting('https://dav.example.com/cal/', 'm1'))
  const screen = render(<EventEditor />)
  expect(screen.getByText('This event has 2 guests. Editing it here does not notify them.')).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })
  expect(screen.queryByRole('button', { name: 'Send it' })).toBeNull()
  await waitFor(() => expect(commands()).toEqual(['calendar.update']))
})

it('a meeting someone else organizes is not offered either', () => {
  calendar$.editing.set({
    ...meeting('local:home', 'm1'),
    organizer: { name: 'Dee', addr: 'dee@elsewhere.org', response: '' },
  })
  const screen = render(<EventEditor />)
  expect(screen.getByText(/does not notify them/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(screen.queryByRole('button', { name: 'Send it' })).toBeNull()
})

it('a Google meeting is still told by Google, not by mail from here', async () => {
  calendar$.editing.set(meeting('primary', 'g1'))
  const screen = render(<EventEditor />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(screen.queryByText(/Sent by mail from/)).toBeNull()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send it' }))
  })
  await waitFor(() => expect(commands()).toContain('calendar.update'))
  await new Promise((r) => setTimeout(r, 20))
  expect(commands()).toEqual(['calendar.update'])
  expect(calls[0].payload.notify).toBe(true)
  expect(calls[0].payload.event.organizer).toBeNull()
})
