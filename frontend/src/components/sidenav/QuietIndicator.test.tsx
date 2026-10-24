import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { QuietIndicator } from './QuietIndicator'
import { AppMenuButton } from '../shell/AppMenu'
import { accounts$ } from '../../states/accounts'
import { settings$ } from '../../states/settings'
import { notificationClock, quietClock$ } from '../../states/notifications'
import { DEFAULT_NOTIFICATION_PREFS } from '../../lib/quietHours'

let now = new Date(2026, 9, 13, 21, 59)
const realNow = notificationClock.now

beforeEach(() => {
  now = new Date(2026, 9, 13, 21, 59)
  notificationClock.now = () => now
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  ;(window as any).go = { main: { App: { Invoke: async () => ({ ok: true }) } } }
})

afterEach(() => {
  cleanup()
  accounts$.set([])
  notificationClock.now = realNow
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  delete (window as any).go
})

it('shows nothing while notifications are not quiet', () => {
  const screen = render(<QuietIndicator />)
  expect(screen.queryByRole('status')).toBeNull()
})

it('appears for a pause and one click resumes', async () => {
  const screen = render(<QuietIndicator />)
  await act(async () => settings$.notifications.pause.set({ until: null }))
  expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Do not disturb is on until you turn it off')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resume notifications' })))
  expect(screen.queryByRole('status')).toBeNull()
  expect(settings$.notifications.peek().pause).toBeNull()
})

it('follows the clock into scheduled quiet hours, and Resume skips the rest of tonight', async () => {
  settings$.notifications.schedule.set({ enabled: true, start: '22:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] })
  const screen = render(<QuietIndicator />)
  expect(screen.queryByRole('status')).toBeNull()
  now = new Date(2026, 9, 13, 22, 1)
  await act(async () => quietClock$.set(now.getTime()))
  expect(screen.getByRole('status').getAttribute('aria-label')).toMatch(/^Quiet hours until /)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resume notifications' })))
  expect(screen.queryByRole('status')).toBeNull()
  expect(settings$.notifications.peek().scheduleResumedUntil).toBe(new Date(2026, 9, 14, 7).getTime())
})

// The rail's More menu went with the rail (#354): the app menu offers the
// same pauses, then Resume.
it('the app menu offers the pauses, then Resume', async () => {
  accounts$.set([
    {
      id: 'a',
      email: 'a@example.test',
      display_name: 'A',
      provider: 'imap',
      auth_type: 'password',
      imap_host: 'imap.example.test',
      imap_port: 993,
      smtp_host: 'smtp.example.test',
      smtp_port: 465,
      tls: true,
    },
  ])
  const screen = render(<AppMenuButton />)
  const button = screen.getByRole('button', { name: 'App menu' })
  fireEvent.click(button)
  await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Do not disturb until tomorrow' })))
  expect(settings$.notifications.peek().pause).toEqual({ until: new Date(2026, 9, 14, 8).getTime() })
  fireEvent.click(button)
  expect(screen.getByRole('menuitem', { name: 'Resume notifications' })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: 'Do not disturb until tomorrow' })).toBeNull()
})
