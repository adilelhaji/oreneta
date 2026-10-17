import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import i18n from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import {
  calendar$,
  clearCalendarSyncError,
  noteCalendarSyncError,
} from '../../states/calendar'
import type { Account } from '../../types'
import { CalendarView } from './CalendarView'

// #244: a calendar refresh the server refused is said per account, with the
// cause when the core names one, and one account's good refresh does not
// hide another's failure.

const account = (id: string, email: string, auth_type: string) =>
  ({ id, email, display_name: id, provider: 'imap', auth_type, paused: false }) as Account

// The sentence the core sends with it (meron-core/src/calendar/google.rs).
const API_DISABLED =
  'calendar sync: Google refused the calendar: the Google Calendar API is not enabled in the Google Cloud project this build signs in with, so no account can read its calendar until it is (Google said: Google Calendar API has not been used in project 42 before or it is disabled.)'

beforeEach(async () => {
  ;(window as any).go = { main: { App: { Invoke: async () => ({ ok: true, calendars: [], events: [] }) } } }
  await i18n.changeLanguage('en')
  accounts$.set([account('gmail', 'me@gmail.com', 'gmail_oauth'), account('work', 'me@work.example', 'password')])
  calendar$.events.set([])
  calendar$.calendars.set([])
  calendar$.syncErrors.set({})
  calendar$.view.set('agenda')
})

afterEach(async () => {
  cleanup()
  calendar$.syncErrors.set({})
  accounts$.set([])
  delete (window as any).go
  await i18n.changeLanguage('en')
})

const notices = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('[data-sync-error]')).map((line) => ({
    reason: line.dataset.syncError,
    text: line.textContent ?? '',
    title: line.title,
  }))

it('names a Calendar API switched off in the project, for the account it refused', async () => {
  const view = render(<CalendarView />)
  expect(notices(view.container)).toEqual([])

  await act(async () => noteCalendarSyncError({ account: 'gmail', message: API_DISABLED, reason: 'api_disabled' }))
  const [notice, ...rest] = notices(view.container)
  expect(rest).toEqual([])
  expect(notice.reason).toBe('api_disabled')
  expect(notice.text).toContain('me@gmail.com')
  expect(notice.text).toContain('Google Calendar API is not enabled')
  expect(notice.text).toContain('Reconnecting the account does not fix it')
  // The core's own words stay reachable, for whoever diagnoses it.
  expect(notice.title).toBe(API_DISABLED)
})

it("keeps one account's failure when another account's refresh lands", async () => {
  const view = render(<CalendarView />)
  await act(async () => {
    noteCalendarSyncError({ account: 'gmail', message: API_DISABLED, reason: 'api_disabled' })
    noteCalendarSyncError({ account: 'work', message: 'calendar sync: timed out after 30s' })
  })
  expect(notices(view.container).map((notice) => notice.reason)).toEqual(['api_disabled', 'other'])
  // Before #244 the Exchange account's good sync cleared the only error
  // there was, and the Gmail refusal vanished with it.
  await act(async () => clearCalendarSyncError('work'))
  expect(notices(view.container).map((notice) => notice.reason)).toEqual(['api_disabled'])
  await act(async () => clearCalendarSyncError('gmail'))
  expect(notices(view.container)).toEqual([])
})

it('drops the notice of an account that is gone, and a sync naming no account clears them all', async () => {
  const view = render(<CalendarView />)
  await act(async () => {
    noteCalendarSyncError({ account: 'gmail', message: API_DISABLED, reason: 'api_disabled' })
    noteCalendarSyncError({ account: 'work', message: 'x' })
  })
  await act(async () => accounts$.set([account('work', 'me@work.example', 'password')]))
  expect(notices(view.container).map((notice) => notice.reason)).toEqual(['other'])
  await act(async () => clearCalendarSyncError())
  expect(calendar$.syncErrors.peek()).toEqual({})
  expect(notices(view.container)).toEqual([])
})

it('says what to do for each cause, and falls back for one it does not know', async () => {
  const view = render(<CalendarView />)
  await act(async () => noteCalendarSyncError({ account: 'gmail', message: 'x', reason: 'needs_consent' }))
  expect(notices(view.container)[0].text).toContain('has not given this app access to its calendars')
  await act(async () => noteCalendarSyncError({ account: 'gmail', message: 'x', reason: 'needs_reconnect' }))
  expect(notices(view.container)[0].text).toContain('is no longer accepted')
  // A reason this build has never heard of, or none from an older core.
  await act(async () => noteCalendarSyncError({ account: 'gmail', message: 'x', reason: 'something_new' }))
  expect(notices(view.container)[0].reason).toBe('other')
  expect(notices(view.container)[0].text).toContain('could not be refreshed')
  await act(async () => noteCalendarSyncError({ account: 'gmail', message: 'x' }))
  expect(notices(view.container)[0].reason).toBe('other')
})

it('says it in Catalan, the main language', async () => {
  await i18n.changeLanguage('ca')
  const view = render(<CalendarView />)
  await act(async () => noteCalendarSyncError({ account: 'gmail', message: API_DISABLED, reason: 'api_disabled' }))
  const [notice] = notices(view.container)
  expect(notice.text).toContain('del compte me@gmail.com')
  expect(notice.text).toContain('no està activada')
})
