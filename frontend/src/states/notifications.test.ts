import { afterEach, beforeEach, expect, it } from 'bun:test'
import { soundPlayer } from '../lib/notificationSounds'
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '../lib/quietHours'
import { settings$ } from './settings'
import {
  currentQuietState,
  mayShowMailToast,
  notificationClock,
  previewSound,
  startNotifications,
} from './notifications'

const NOW = new Date(2026, 9, 13, 23, 0) // a Tuesday evening, local
const realPlay = soundPlayer.play
const realNow = notificationClock.now
let played: Array<[string, number]>
let requests: Array<{ command: string; payload: any }>
let handlers: Map<string, (detail: unknown) => void>
let stop: (() => void) | null = null

const setPrefs = (patch: Partial<NotificationPrefs>) =>
  settings$.notifications.set({ ...structuredClone(DEFAULT_NOTIFICATION_PREFS), ...patch })
const emit = (name: string, detail?: unknown) => handlers.get(name)?.(detail)
const quietPushes = () => requests.filter((r) => r.command === 'notify.setQuiet').map((r) => r.payload)

beforeEach(() => {
  played = []
  requests = []
  handlers = new Map()
  soundPlayer.play = (id, volume) => {
    played.push([id, volume])
    return true
  }
  notificationClock.now = () => NOW
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          requests.push({ command, payload: structuredClone(payload) })
          return { ok: true }
        },
      },
    },
  }
  ;(window as any).runtime = {
    EventsOn: (name: string, handler: (detail: unknown) => void) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
  }
  stop = startNotifications()
})

afterEach(() => {
  stop?.()
  stop = null
  soundPlayer.play = realPlay
  notificationClock.now = realNow
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  delete (window as any).go
  delete (window as any).runtime
})

it('is silent by default', () => {
  emit('mail.newMessages', { account: 'a', count: 1 })
  emit('calendar.reminder', { subject: 'Stand-up' })
  expect(played).toEqual([])
})

it('plays the chosen sounds at the chosen volume, but not for a muted account', () => {
  setPrefs({ mailSound: true, mailSoundId: 'marimba', reminderSound: true, reminderSoundId: 'bell', volume: 35 })
  emit('mail.newMessages', { account: 'a', count: 2 })
  emit('mail.newMessages', { account: 'b', count: 1, muted: true })
  emit('calendar.reminder', { subject: 'Stand-up' })
  emit('tasks.reminder', { title: 'Pay rent' })
  expect(played).toEqual([
    ['marimba', 35],
    ['bell', 35],
    ['bell', 35],
  ])
})

it('quiet hours silence mail sounds and the toast; reminders follow their checkbox', () => {
  const schedule = { enabled: true, start: '22:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] }
  setPrefs({ mailSound: true, reminderSound: true, schedule })
  expect(currentQuietState().quiet).toBe(true)
  expect(mayShowMailToast()).toBe(false)
  emit('mail.newMessages', { account: 'a' })
  emit('calendar.reminder', {})
  expect(played).toEqual([['bell', 60]])

  played = []
  setPrefs({ mailSound: true, reminderSound: true, schedule, remindersWhileQuiet: false })
  emit('calendar.reminder', {})
  expect(played).toEqual([])
})

it('the preview plays even while quiet', () => {
  setPrefs({ pause: { until: null }, volume: 80 })
  previewSound('pop')
  expect(played).toEqual([['pop', 80]])
})

it('pushes the quiet plan to the bridge on start and on every change, not on repeats', async () => {
  expect(quietPushes().at(-1)).toEqual({ intervals: [], indefinite: false, remindersWhileQuiet: true, quiet: false })
  setPrefs({ pause: { until: null } })
  expect(quietPushes().at(-1)).toMatchObject({ indefinite: true, quiet: true })
  const count = quietPushes().length
  settings$.notifications.set({ ...settings$.notifications.peek() })
  expect(quietPushes()).toHaveLength(count)
})

it('the tray item toggles do not disturb on and off', () => {
  emit('tray.doNotDisturb')
  expect(settings$.notifications.peek().pause).toEqual({ until: null })
  expect(currentQuietState().quiet).toBe(true)
  emit('tray.doNotDisturb')
  expect(settings$.notifications.peek().pause).toBeNull()
  expect(currentQuietState().quiet).toBe(false)
})
