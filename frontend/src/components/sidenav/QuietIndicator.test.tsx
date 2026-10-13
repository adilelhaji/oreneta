import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { QuietIndicator } from './QuietIndicator'
import { QuickSettingsMenu } from './QuickSettingsMenu'
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

it('the More menu offers the pauses, then Resume', async () => {
  const onClose = () => {}
  const screen = render(<QuickSettingsMenu anchor={{ x: 0, y: 0, placement: 'down' }} onClose={onClose} />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Do not disturb until tomorrow' })))
  expect(settings$.notifications.peek().pause).toEqual({ until: new Date(2026, 9, 14, 8).getTime() })
  expect(screen.getByRole('button', { name: 'Resume notifications' })).toBeTruthy()
})
