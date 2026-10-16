import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { NewCalendarDialog } = await import('./NewCalendarDialog')
const { CalendarPanel } = await import('./CalendarPanel')
const { calendar$ } = await import('../../states/calendar')
const { accounts$ } = await import('../../states/accounts')

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

const imap = { id: 'a@example.test', email: 'a@example.test', auth_type: 'password' } as any

beforeEach(() => {
  accounts$.set([imap])
  calendar$.calendars.set([])
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('finds the calendars on a CalDAV server and keeps only the ones chosen', async () => {
  const found = [
    { url: 'https://dav.example/a/work/', name: 'Work', color: '#33aa55', writable: true },
    { url: 'https://dav.example/a/holidays/', name: 'Holidays', color: null, writable: false },
  ]
  const calls = bridge((command) => {
    if (command === 'caldav.discover') return { calendars: found }
    if (command === 'caldav.add') return { ids: ['https://dav.example/a/work/'] }
    if (command === 'calendar.list') return { calendars: [] }
    return {}
  })
  let closed = 0
  const view = render(<NewCalendarDialog onClose={() => closed++} />)
  fireEvent.click(view.getByRole('radio', { name: 'CalDAV server' }))
  fireEvent.change(view.getByLabelText('Server or address'), { target: { value: 'dav.example' } })
  fireEvent.change(view.getByLabelText('User name'), { target: { value: 'a' } })
  fireEvent.change(view.getByLabelText('Password'), { target: { value: 'secret' } })
  fireEvent.click(view.getByRole('button', { name: 'Find calendars' }))
  await waitFor(() => expect(view.getByText('Calendars on this server')).toBeTruthy())
  expect(calls.find((c) => c.command === 'caldav.discover')!.payload).toEqual({
    account: 'a@example.test',
    server: 'dav.example',
    username: 'a',
    password: 'secret',
  })
  // A read-only calendar is offered but not ticked.
  expect((view.getByRole('checkbox', { name: /Work/ }) as HTMLInputElement).checked).toBe(true)
  expect((view.getByRole('checkbox', { name: /Holidays/ }) as HTMLInputElement).checked).toBe(false)
  expect(view.getByText('read-only')).toBeTruthy()

  fireEvent.click(view.getByRole('button', { name: 'Add' }))
  await waitFor(() => expect(closed).toBe(1))
  const added = calls.find((c) => c.command === 'caldav.add')!.payload
  expect(added.account).toBe('a@example.test')
  expect(added.calendars.map((c: any) => c.name)).toEqual(['Work'])
})

it('says why the server was not reached and keeps the dialog open', async () => {
  bridge((command) => {
    if (command === 'caldav.discover') throw new Error('the server refused those credentials')
    return {}
  })
  const view = render(<NewCalendarDialog onClose={() => {}} />)
  fireEvent.click(view.getByRole('radio', { name: 'CalDAV server' }))
  fireEvent.change(view.getByLabelText('Server or address'), { target: { value: 'dav.example' } })
  fireEvent.click(view.getByRole('button', { name: 'Find calendars' }))
  await waitFor(() => expect(view.getByRole('alert').textContent).toContain('refused those credentials'))
})

const base = { is_default: false, enabled: true, read_only: false, synced_at: 0, accountId: imap.id }

it('removing a CalDAV calendar says it stays on its server, even when it is the only one listed', () => {
  const only = { ...base, id: 'https://dav.example/a/work/', name: 'Work', kind: 'caldav' as const }
  calendar$.calendars.set([only])
  const view = render(<CalendarPanel calendar={only} />)
  fireEvent.click(view.getByRole('button', { name: 'Remove calendar' }))
  expect(view.getByText(/stays on its server/)).toBeTruthy()
})

it('an account still keeps its last server calendar', () => {
  const own = { ...base, id: 'cal', name: 'Calendar', kind: 'account' as const }
  calendar$.calendars.set([own, { ...base, id: 'local:1', name: 'Mine', kind: 'local' as const }])
  const view = render(<CalendarPanel calendar={own} />)
  expect(view.getByText('An account keeps at least one calendar.')).toBeTruthy()
})

it('imports a .ics file only after showing what it adds, and offers it only where events can go', async () => {
  const { importIcs, canImportInto } = await import('../../states/calendarFiles')
  const { ui$, settleConfirm } = await import('../../states/ui')
  expect(canImportInto({ kind: 'local', read_only: false })).toBe(true)
  expect(canImportInto({ kind: 'caldav', read_only: false })).toBe(true)
  expect(canImportInto({ kind: 'caldav', read_only: true })).toBe(false)
  expect(canImportInto({ kind: 'subscribed', read_only: true })).toBe(false)
  expect(canImportInto({ kind: 'account', read_only: false })).toBe(false)

  const calls = bridge((_command, payload) =>
    payload.confirm
      ? { summary: { added: 2, duplicates: 1, skipped: 0, series: 1 }, imported: true }
      : { summary: { added: 2, duplicates: 1, skipped: 0, series: 1 }, imported: false, path: '/tmp/a.ics' },
  )
  const pending = importIcs({ accountId: imap.id, id: 'local:1', name: 'Home' })
  await waitFor(() => expect(ui$.confirm.get()).toBeTruthy())
  expect(ui$.confirm.get()!.message).toContain('2 events will be added (1 repeating). 1 already there')
  expect(calls).toHaveLength(1)
  settleConfirm(true)
  await pending
  expect(calls[1].payload).toEqual({ account: imap.id, calendar: 'local:1', path: '/tmp/a.ics', confirm: true })
  expect(ui$.toast.get()).toBe('Imported 2 events')
})

// The calendar kind is a radio group: the sideways arrows follow the reading
// direction (#226, ADR-0061), up and down go through it top to bottom.
it('picks the next calendar kind with the left arrow in right to left', () => {
  document.documentElement.dir = 'rtl'
  try {
    bridge(() => ({}))
    const view = render(<NewCalendarDialog onClose={() => {}} />)
    const radios = view.getAllByRole('radio')
    const checked = () => radios.findIndex((radio) => radio.getAttribute('aria-checked') === 'true')
    const start = checked()
    radios[start].focus()
    fireEvent.keyDown(radios[start], { key: 'ArrowLeft' })
    expect(checked()).toBe((start + 1) % radios.length)
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(checked()).toBe(start)
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(checked()).toBe((start + 1) % radios.length)
  } finally {
    document.documentElement.dir = ''
  }
})
