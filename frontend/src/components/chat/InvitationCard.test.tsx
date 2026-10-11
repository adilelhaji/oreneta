import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { InvitationCard } = await import('./InvitationCard')
const { accounts$ } = await import('../../states/accounts')
const { calendar$ } = await import('../../states/calendar')
const { ui$ } = await import('../../states/ui')

type Call = { command: string; payload: any }

function bridge(answer: (command: string, payload: any) => unknown) {
  const calls: Call[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => (calls.push({ command, payload }), answer(command, payload)),
      },
    },
  }
  return calls
}

const imap = { id: 'bo@example.com', email: 'bo@example.com', sender_name: 'Bo', auth_type: 'password' } as any
const exchange = {
  id: 'cy@corp.example',
  email: 'cy@corp.example',
  auth_type: 'password',
  ews_url: 'https://corp/EWS',
} as any
const home = {
  id: 'local:1',
  name: 'Home',
  kind: 'local',
  read_only: false,
  enabled: true,
  is_default: false,
  synced_at: 0,
  accountId: imap.id,
} as any

const invitation = (method: string, sequence = 2) => ({
  method,
  uid: 'meet@example.com',
  sequence,
  summary: 'Planning',
  location: 'Room 1',
  start: 1_894_265_200,
  end: 1_894_268_800,
  all_day: false,
  repeats: false,
  organizer: { name: 'Ana', addr: 'ana@example.com', response: '' },
  attendees: [{ name: 'Bo', addr: 'bo@example.com', response: 'none' }],
  ics: `BEGIN:VCALENDAR\r\nMETHOD:${method}\r\nEND:VCALENDAR\r\n`,
})

const message = (account: any, method = 'REQUEST', sequence = 2) =>
  ({
    id: 'm1',
    account_id: account.id,
    message_id: 'invite@example.com',
    references: '',
    invitation: invitation(method, sequence),
  }) as any

beforeEach(() => {
  accounts$.set([imap, exchange])
  calendar$.calendars.set([home])
  ui$.toast.set('')
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('answers only when asked, keeps the event in the chosen calendar and sends the reply to the organizer', async () => {
  const calls = bridge((command) => {
    if (command === 'invite.status') return { answer: null, calendars: [] }
    if (command === 'invite.respond')
      return {
        reply: {
          to: 'ana@example.com',
          subject: 'Accepted: Planning',
          ics: 'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR\r\n',
        },
      }
    if (command === 'mail.send') return { ok: true }
    return {}
  })
  const view = render(<InvitationCard message={message(imap)} />)
  expect(view.getByText('Planning')).toBeTruthy()
  expect(view.getByText('Organized by Ana')).toBeTruthy()
  await waitFor(() => expect(calls.some((c) => c.command === 'invite.status')).toBe(true))
  expect(calls.some((c) => c.command === 'invite.respond' || c.command === 'mail.send')).toBe(false)

  fireEvent.click(view.getByRole('button', { name: 'Accept' }))
  await waitFor(() => expect(ui$.toast.get()).toBe('Answer sent to the organizer'))
  const respond = calls.find((c) => c.command === 'invite.respond')!.payload
  expect(respond).toMatchObject({
    account: imap.id,
    response: 'accept',
    calendar: 'local:1',
    me_addr: 'bo@example.com',
    me_name: 'Bo',
  })
  const sent = calls.find((c) => c.command === 'mail.send')!.payload
  expect(JSON.stringify(sent)).toContain('ana@example.com')
  expect(JSON.stringify(sent)).toContain('text/calendar; method=REPLY')
  expect(JSON.stringify(sent)).toContain('Accepted: Planning')
})

it('can answer without keeping the event anywhere', async () => {
  const calls = bridge((command) =>
    command === 'invite.status'
      ? { answer: null, calendars: [] }
      : command === 'invite.respond'
        ? { reply: { to: 'ana@example.com', subject: 'Declined: Planning', ics: 'X' } }
        : { ok: true },
  )
  const view = render(<InvitationCard message={message(imap)} />)
  fireEvent.change(view.getByLabelText('Keep in'), { target: { value: '' } })
  fireEvent.click(view.getByRole('button', { name: 'Decline' }))
  await waitFor(() => expect(calls.some((c) => c.command === 'invite.respond')).toBe(true))
  expect(calls.find((c) => c.command === 'invite.respond')!.payload.calendar).toBe('')
})

it('says so when the calendar was updated but the answer could not be sent', async () => {
  bridge((command) => {
    if (command === 'invite.status') return { answer: null, calendars: [] }
    if (command === 'invite.respond')
      return { reply: { to: 'ana@example.com', subject: 'Accepted: Planning', ics: 'X' } }
    if (command === 'mail.send') return { ok: false, error: 'SMTP said no' }
    return {}
  })
  const view = render(<InvitationCard message={message(imap)} />)
  fireEvent.click(view.getByRole('button', { name: 'Accept' }))
  await waitFor(() => expect(ui$.toast.get()).toContain('the answer was not sent to the organizer'))
  expect(ui$.toast.get()).toContain('SMTP said no')
})

it('leaves Exchange and Google invitations to the account’s own calendar', async () => {
  const calls = bridge(() => ({ answer: null, calendars: [] }))
  const view = render(<InvitationCard message={message(exchange)} />)
  expect(view.getByText(/answer it there/)).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Accept' })).toBeNull()
  await waitFor(() => expect(calls.length).toBeGreaterThan(0))
})

it('an older version of an answered invitation offers nothing to press', async () => {
  bridge(() => ({
    answer: { sequence: 5, response: 'accept', calendar_id: 'local:1', answered_at: 1 },
    calendars: ['local:1'],
  }))
  const view = render(<InvitationCard message={message(imap, 'REQUEST', 2)} />)
  await waitFor(() => expect(view.getByText(/newer version of this invitation/)).toBeTruthy())
  expect(view.queryByRole('button', { name: 'Accept' })).toBeNull()
})

it('a cancellation removes the meeting from the calendar holding it, when asked', async () => {
  const calls = bridge((command) =>
    command === 'invite.status' ? { answer: null, calendars: ['local:1'] } : { removed: 1 },
  )
  const view = render(<InvitationCard message={message(imap, 'CANCEL', 3)} />)
  expect(view.getByText('Cancelled: Planning')).toBeTruthy()
  fireEvent.click(await view.findByRole('button', { name: 'Remove from my calendar' }))
  await waitFor(() => expect(calls.some((c) => c.command === 'invite.cancel')).toBe(true))
  expect(ui$.toast.get()).toBe('Removed from your calendar')
})
