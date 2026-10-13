import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { NotificationsGroup } from './NotificationsGroup'
import { hydrateSettings, settings$ } from '../../states/settings'
import { notificationClock } from '../../states/notifications'
import { soundPlayer } from '../../lib/notificationSounds'
import { DEFAULT_NOTIFICATION_PREFS } from '../../lib/quietHours'
import { settingsDestinations } from '../../lib/settingsDestinations'
import { t } from '../../lib/i18n'

const NOW = new Date(2026, 9, 13, 10, 0)
const realPlay = soundPlayer.play
const realNow = notificationClock.now
const saves: { key: string; value: any }[] = []
let played: Array<[string, number]> = []

beforeEach(() => {
  saves.length = 0
  played = []
  notificationClock.now = () => NOW
  soundPlayer.play = (id, volume) => {
    played.push([id, volume])
    return true
  }
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          if (command === 'app.prefsSet') saves.push(payload)
          return { ok: true }
        },
      },
    },
  }
  saves.length = 0
})

afterEach(() => {
  cleanup()
  soundPlayer.play = realPlay
  notificationClock.now = realNow
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  delete (window as any).go
})

it('sounds are off by default; turning one on offers a choice, a volume and Play', async () => {
  const screen = render(<NotificationsGroup />)
  const mail = screen.getByRole('switch', { name: 'Play a sound for new mail' })
  expect(mail.getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByRole('slider', { name: 'Volume' })).toBeNull()

  await act(async () => fireEvent.click(mail))
  const choice = screen.getByRole('combobox', { name: 'New mail sound' })
  await act(async () => fireEvent.change(choice, { target: { value: 'marimba' } }))
  await act(async () => fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '25' } }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play New mail sound' })))

  expect(played).toEqual([['marimba', 25]])
  expect(saves.at(-1)).toEqual({
    key: 'notification_prefs',
    value: { ...DEFAULT_NOTIFICATION_PREFS, mailSound: true, mailSoundId: 'marimba', volume: 25 },
  })
})

it('pauses for an hour and resumes from the same row', async () => {
  const screen = render(<NotificationsGroup />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'For 1 hour' })))
  expect(settings$.notifications.peek().pause).toEqual({ until: NOW.getTime() + 3600_000 })
  expect(screen.getByText(/Do not disturb until/)).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resume' })))
  expect(settings$.notifications.peek().pause).toBeNull()
  expect(screen.getByRole('button', { name: 'Until turned off' })).toBeTruthy()
})

it('quiet hours: times, days and the reminders checkbox', async () => {
  const screen = render(<NotificationsGroup />)
  const reminders = screen.getByRole('switch', { name: 'Still show reminders while quiet' })
  expect(reminders.getAttribute('aria-checked')).toBe('true')
  await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Quiet hours' })))
  await act(async () => fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '21:30' } }))
  // An incomplete value typed into the field is not kept.
  await act(async () => fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '' } }))
  const days = screen.getByRole('group', { name: 'Days' }).querySelectorAll('button')
  expect(days).toHaveLength(7)
  // The last button is Sunday (the week starts on Monday here).
  await act(async () => fireEvent.click(days[6]))
  await act(async () => fireEvent.click(reminders))
  expect(settings$.notifications.peek().schedule).toEqual({
    enabled: true,
    start: '21:30',
    end: '07:00',
    days: [1, 2, 3, 4, 5, 6],
  })
  expect(settings$.notifications.peek().remindersWhileQuiet).toBe(false)
  expect(days[6].getAttribute('aria-pressed')).toBe('false')
})

it('hydrates from the stored row, and is findable in settings search', () => {
  hydrateSettings({ notification_prefs: { mailSound: true, volume: 15, schedule: { enabled: true } } })
  expect(settings$.notifications.peek()).toMatchObject({ mailSound: true, volume: 15 })
  expect(settings$.notifications.peek().schedule.start).toBe('22:00')
  const item = settingsDestinations([], t).find((entry) => entry.id === 'settings.section.notifications')
  expect(item?.section).toBe('notifications')
  expect(item?.keywords).toContain('do not disturb')
})
