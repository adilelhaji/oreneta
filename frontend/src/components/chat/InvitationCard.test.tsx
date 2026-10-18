import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'

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

// ---- Proposing another time (ADR-0043) -------------------------------------

const { EventEditor } = await import('../calendar/EventEditor')

const conflict = (subject: string) => ({
  account: imap.id,
  calendar_id: 'local:1',
  event_id: subject,
  subject,
  start: 0,
  end: 1,
  all_day: false,
})

it('proposes another time only when sent, with the times and note chosen, and says what overlaps', async () => {
  const inv = invitation('REQUEST')
  const at = (base: number, hours: number) => {
    const next = new Date(base * 1000)
    next.setHours(hours, new Date(base * 1000).getMinutes(), 0, 0)
    return Math.floor(next.getTime() / 1000)
  }
  const start = at(inv.start, 15)
  const calls = bridge((command, payload) => {
    if (command === 'invite.status') return { answer: null, calendars: [] }
    if (command === 'calendar.conflicts')
      return {
        conflicts: payload.start === start ? ['Dentist', 'Standup', 'Gym', 'Call'].map(conflict) : [conflict('Review')],
      }
    if (command === 'invite.counter')
      return {
        proposal: {
          to: 'ana@example.com',
          subject: 'New time proposed: Planning',
          ics: 'BEGIN:VCALENDAR\r\nMETHOD:COUNTER\r\nEND:VCALENDAR\r\n',
        },
      }
    if (command === 'mail.send') return { ok: true }
    return {}
  })
  const view = render(<InvitationCard message={message(imap)} />)
  // The invitation's own time against the person's schedule, the meeting itself left out.
  await waitFor(() => expect(view.getByText('Overlaps: Review')).toBeTruthy())
  expect(calls.find((c) => c.command === 'calendar.conflicts')!.payload).toMatchObject({
    start: inv.start,
    end: inv.end,
    all_day: false,
    exclude: ['meet@example.com'],
  })

  fireEvent.click(view.getByRole('button', { name: 'Propose a new time' }))
  const [startHour, endHour] = view.getAllByLabelText('hh')
  fireEvent.change(startHour, { target: { value: '15' } })
  await waitFor(() => expect(view.getByText('Overlaps: Dentist, Standup, Gym and 1 more')).toBeTruthy())

  // An end before the start cannot be sent.
  fireEvent.change(endHour, { target: { value: '14' } })
  expect(view.getByText('The proposed end must be after its start.')).toBeTruthy()
  expect((view.getByRole('button', { name: 'Send proposal' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(endHour, { target: { value: '17' } })
  const end = at(start, 17)
  expect((view.getByRole('button', { name: 'Send proposal' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.change(view.getByLabelText('Note to the organizer (optional)'), { target: { value: 'After lunch?' } })
  expect(calls.some((c) => c.command === 'invite.counter' || c.command === 'mail.send')).toBe(false)

  fireEvent.click(view.getByRole('button', { name: 'Send proposal' }))
  await waitFor(() => expect(ui$.toast.get()).toBe('Proposal sent to the organizer'))
  expect(calls.find((c) => c.command === 'invite.counter')!.payload).toEqual({
    account: imap.id,
    ics: inv.ics,
    me_name: 'Bo',
    me_addr: 'bo@example.com',
    start,
    end,
    comment: 'After lunch?',
  })
  const sent = JSON.stringify(calls.find((c) => c.command === 'mail.send')!.payload)
  expect(sent).toContain('ana@example.com')
  expect(sent).toContain('text/calendar; method=COUNTER')
  expect(sent).toContain('New time proposed: Planning')
  expect(calls.some((c) => c.command === 'invite.respond')).toBe(false)
})

it('says exactly what failed when a proposal is not sent, and can be sent again', async () => {
  let refuse = true
  const calls = bridge((command) => {
    if (command === 'invite.status') return { answer: null, calendars: [] }
    if (command === 'invite.counter')
      return { proposal: { to: 'ana@example.com', subject: 'New time proposed: Planning', ics: 'X' } }
    if (command === 'mail.send') return refuse ? { ok: false, error: 'SMTP said no' } : { ok: true }
    return {}
  })
  const view = render(<InvitationCard message={message(imap)} />)
  fireEvent.click(view.getByRole('button', { name: 'Propose a new time' }))
  fireEvent.click(view.getByRole('button', { name: 'Send proposal' }))
  await waitFor(() => expect(ui$.toast.get()).toContain('The proposal was not sent to the organizer'))
  expect(ui$.toast.get()).toContain('SMTP said no')
  refuse = false
  fireEvent.click(view.getByRole('button', { name: 'Send proposal' }))
  await waitFor(() => expect(ui$.toast.get()).toBe('Proposal sent to the organizer'))
  expect(calls.filter((c) => c.command === 'mail.send').length).toBe(2)
})

it('shows the core’s reason when a proposal is refused', async () => {
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string) => {
          if (command === 'invite.counter') throw new Error('this meeting was cancelled; there is no time to propose')
          return command === 'invite.status' ? { answer: null, calendars: [] } : {}
        },
      },
    },
  }
  const view = render(<InvitationCard message={message(imap)} />)
  fireEvent.click(view.getByRole('button', { name: 'Propose a new time' }))
  fireEvent.click(view.getByRole('button', { name: 'Send proposal' }))
  await waitFor(() => expect(ui$.toast.get()).toContain('cancelled'))
})

const proposal = (overrides: Record<string, unknown> = {}) =>
  ({
    ...message(imap, 'COUNTER'),
    invitation: {
      ...invitation('COUNTER'),
      start: 1_894_280_000,
      end: 1_894_283_600,
      organizer: { name: 'Bo', addr: 'bo@example.com', response: '' },
      attendees: [{ name: 'Cy', addr: 'cy@example.com', response: '' }],
      comment: 'After lunch?',
      ...overrides,
    },
  }) as any

const kept = {
  id: 'local:import:meet@example.com@1894265200',
  calendar_id: 'local:1',
  subject: 'Planning',
  start: 1_894_265_200,
  end: 1_894_268_800,
  all_day: false,
  is_recurring: false,
  is_cancelled: false,
  free_busy: '',
  my_response: '',
  organizer: { name: 'Bo', addr: 'bo@example.com', response: '' },
  attendees: [{ name: 'Cy', addr: 'cy@example.com', response: 'accept' }],
}

it('lets the organizer decline a proposal, sending the refusal to whoever proposed it', async () => {
  const calls = bridge((command) => {
    if (command === 'invite.status') return { answer: null, calendars: [] }
    if (command === 'invite.counterStatus') return { organizer: true, event: kept, sequence: 2, outdated: false }
    if (command === 'calendar.conflicts') return { conflicts: [conflict('Lunch')] }
    if (command === 'invite.declineCounter')
      return {
        reply: {
          to: 'cy@example.com',
          subject: 'Proposed time declined: Planning',
          ics: 'BEGIN:VCALENDAR\r\nMETHOD:DECLINECOUNTER\r\nEND:VCALENDAR\r\n',
        },
      }
    if (command === 'mail.send') return { ok: true }
    return {}
  })
  const view = render(<InvitationCard message={proposal()} />)
  expect(view.getByText('Cy proposes a new time:')).toBeTruthy()
  expect(view.getByText('“After lunch?”')).toBeTruthy()
  await waitFor(() => expect(view.getByText('Overlaps: Lunch')).toBeTruthy())
  expect(view.getByText(/When you save, it asks whether to send the new time/)).toBeTruthy()
  expect(calls.find((c) => c.command === 'invite.counterStatus')!.payload).toMatchObject({
    account: imap.id,
    me_addr: 'bo@example.com',
  })
  expect(calls.some((c) => c.command === 'invite.declineCounter' || c.command === 'mail.send')).toBe(false)

  fireEvent.change(view.getByLabelText('Note if you decline (optional)'), { target: { value: 'The room is taken' } })
  fireEvent.click(view.getByRole('button', { name: 'Decline proposal' }))
  await waitFor(() => expect(view.getByText('You declined this proposal')).toBeTruthy())
  expect(calls.find((c) => c.command === 'invite.declineCounter')!.payload).toMatchObject({
    account: imap.id,
    me_addr: 'bo@example.com',
    comment: 'The room is taken',
  })
  const sent = JSON.stringify(calls.find((c) => c.command === 'mail.send')!.payload)
  expect(sent).toContain('cy@example.com')
  expect(sent).toContain('text/calendar; method=DECLINECOUNTER')
})

it('opens the organizer’s event in the editor with the proposed time, saving through the ordinary update', async () => {
  const calls = bridge((command, payload) => {
    if (command === 'invite.status') return { answer: null, calendars: [] }
    if (command === 'invite.counterStatus') return { organizer: true, event: kept, sequence: null, outdated: false }
    if (command === 'calendar.conflicts')
      return { conflicts: payload.exclude?.includes(kept.id) ? [conflict('Gym'), conflict('Call')] : [] }
    if (command === 'invite.notify')
      return {
        notice: {
          method: 'REQUEST',
          to: payload.people,
          subject: 'Updated invitation: Planning',
          sequence: 3,
          ics: 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n',
        },
      }
    return { ok: true }
  })
  const view = render(<InvitationCard message={proposal()} />)
  fireEvent.click(await view.findByRole('button', { name: 'Open in editor' }))
  const { calendar$: cal } = await import('../../states/calendar')
  expect(ui$.module.get()).toBe('calendar')
  expect(cal.editing.get()).toMatchObject({
    id: kept.id,
    calendar_id: 'local:1',
    accountId: imap.id,
    start: 1_894_280_000,
    end: 1_894_283_600,
  })
  expect(calls.some((c) => c.command === 'calendar.update' || c.command === 'mail.send')).toBe(false)

  const editor = render(<EventEditor />)
  await waitFor(() => expect(editor.getByText('Overlaps: Gym, Call')).toBeTruthy())
  fireEvent.click(editor.getByRole('button', { name: 'Save' }))
  // A local calendar has no server to tell the people invited, so the editor
  // asks, naming them, and the new time goes out by mail from here.
  expect(within(editor.getByRole('alertdialog')).getByText('cy@example.com')).toBeTruthy()
  await act(async () => {
    fireEvent.click(editor.getByRole('button', { name: 'Send it' }))
  })
  await waitFor(() => expect(calls.some((c) => c.command === 'mail.send')).toBe(true))
  const update = calls.find((c) => c.command === 'calendar.update')!.payload
  expect(update.notify).toBe(false)
  expect(update.event).toMatchObject({ id: kept.id, start: 1_894_280_000, end: 1_894_283_600 })
  expect(calls.find((c) => c.command === 'invite.notify')!.payload).toMatchObject({
    event: kept.id,
    method: 'request',
    me_addr: 'bo@example.com',
    people: ['cy@example.com'],
  })
  const sent = calls.find((c) => c.command === 'mail.send')!.payload
  expect(sent.to).toBe('cy@example.com')
  expect(sent.attachments[0].mime).toBe('text/calendar; method=REQUEST; charset=utf-8')
  ui$.module.set('mail')
  cal.editing.set(null)
})

it('an outdated proposal, or one about a meeting not organized here, offers nothing to press', async () => {
  bridge((command) =>
    command === 'invite.counterStatus'
      ? { organizer: true, event: kept, sequence: 5, outdated: true }
      : { answer: null, calendars: [] },
  )
  const old = render(<InvitationCard message={proposal()} />)
  await waitFor(() => expect(old.getByText(/older version of the meeting/)).toBeTruthy())
  expect(old.queryByRole('button', { name: 'Open in editor' })).toBeNull()
  expect(old.queryByRole('button', { name: 'Decline proposal' })).toBeNull()
  cleanup()

  bridge((command) =>
    command === 'invite.counterStatus'
      ? { organizer: false, event: null, sequence: null, outdated: false }
      : { answer: null, calendars: [] },
  )
  const info = render(<InvitationCard message={proposal()} />)
  await waitFor(() => expect(info.getByText(/for information only/)).toBeTruthy())
  expect(info.queryByRole('button', { name: 'Decline proposal' })).toBeNull()
})

it('a refused proposal only says so', async () => {
  const calls = bridge(() => ({ answer: null, calendars: [] }))
  const view = render(
    <InvitationCard
      message={proposal({
        method: 'DECLINECOUNTER',
        start: 0,
        end: 0,
        comment: 'The room is taken',
        ics: 'BEGIN:VCALENDAR\r\nMETHOD:DECLINECOUNTER\r\nEND:VCALENDAR\r\n',
      })}
    />,
  )
  expect(view.getByText('The organizer declined your proposed time.')).toBeTruthy()
  expect(view.getByText('“The room is taken”')).toBeTruthy()
  expect(view.queryAllByRole('button')).toEqual([])
  await waitFor(() => expect(calls.length).toBeGreaterThan(0))
  expect(calls.some((c) => c.command === 'invite.counterStatus')).toBe(false)
})

it('formats both ends of the meeting range in the interface language', async () => {
  const { when } = await import('./InvitationCard')
  const { default: i18n, intlLocale } = await import('../../lib/i18n')
  await i18n.changeLanguage('ca')
  try {
    const start = Date.UTC(2026, 9, 20, 9, 0) / 1000
    const end = Date.UTC(2026, 9, 21, 17, 30) / 1000
    const range = when(start, end, false)
    const to = new Date(end * 1000).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
    expect(range.endsWith(` – ${to}`)).toBe(true)
    expect(range).not.toMatch(/\b(AM|PM|Oct)\b/)
  } finally {
    await i18n.changeLanguage('en')
  }
})
