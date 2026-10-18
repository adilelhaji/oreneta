// General → Notifications at runtime (ADR-0049): what the settings in
// `settings$.notifications` do while the app runs.
//
// - Sounds play here, in the frontend, from the same `mail.newMessages`,
//   `calendar.reminder` and `tasks.reminder` events the Go bridge turns into
//   OS notifications, and when the bridge says it showed the notice of
//   missed reminders (`calendar.missedRemindersShown`, #225), which it can
//   hold back until quiet hours end. The core resolves an account's mute onto each mail
//   event, and a muted account stays silent too.
// - Do not disturb and the quiet hours are decided by lib/quietHours. The Go
//   bridge, which raises the OS popups, gets the quiet intervals pushed to it
//   (`notify.setQuiet`) whenever they change and hourly, so it keeps gating on
//   its own even if this window's timers are throttled in the tray.
// - The tray's "Do not disturb" item comes back as `tray.doNotDisturb`.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { soundPlayer } from '../lib/notificationSounds'
import {
  pauseForOneHour,
  pauseUntilTomorrow,
  pauseUntilTurnedOff,
  quietIntervals,
  quietStateAt,
  resumeNotifications as resumed,
  shouldShowNotification,
  soundFor,
  type NotificationKind,
  type NotificationPrefs,
  type NotificationSoundId,
  type QuietState,
} from '../lib/quietHours'
import { settings$ } from './settings'

/** How often the quiet state is looked at again, so the indicator follows the clock. */
export const QUIET_TICK_MS = 30_000
/** How often the bridge gets fresh intervals even if nothing changed. */
const BRIDGE_REFRESH_MS = 60 * 60 * 1000

/** Overridable for tests. */
export const notificationClock = { now: () => new Date() }

/** The current instant as the UI last looked; ticks every {@link QUIET_TICK_MS}. */
export const quietClock$ = observable(Date.now())

export function notificationPrefs(): NotificationPrefs {
  return settings$.notifications.peek()
}

export function updateNotificationPrefs(patch: Partial<NotificationPrefs>) {
  settings$.notifications.set({ ...notificationPrefs(), ...patch })
}

export function currentQuietState(): QuietState {
  return quietStateAt(notificationPrefs(), notificationClock.now())
}

export type PauseChoice = 'hour' | 'tomorrow' | 'off'

/** Turn on do not disturb for an hour, until tomorrow morning, or until turned off. */
export function pauseNotifications(choice: PauseChoice) {
  const now = notificationClock.now()
  const pause =
    choice === 'hour' ? pauseForOneHour(now) : choice === 'tomorrow' ? pauseUntilTomorrow(now) : pauseUntilTurnedOff()
  updateNotificationPrefs({ pause })
  quietClock$.set(now.getTime())
}

/** End the pause, and the rest of a scheduled quiet period if one is running. */
export function resumeNotifications() {
  const now = notificationClock.now()
  settings$.notifications.set(resumed(notificationPrefs(), now))
  quietClock$.set(now.getTime())
}

/** The tray item: quiet → resume; not quiet → quiet until turned off. */
export function toggleDoNotDisturb() {
  if (currentQuietState().quiet) resumeNotifications()
  else pauseNotifications('off')
}

/** Whether the in-app "new mail" toast may show (it is a popup too). */
export function mayShowMailToast(): boolean {
  return shouldShowNotification(notificationPrefs(), notificationClock.now(), 'mail')
}

/** Play the sound this event calls for, if any. Returns what played. */
export function soundForEvent(kind: NotificationKind, muted = false): NotificationSoundId | null {
  const prefs = notificationPrefs()
  const id = soundFor(prefs, notificationClock.now(), kind, muted)
  if (id) soundPlayer.play(id, prefs.volume)
  return id
}

/** The Play button in Settings: always plays, quiet or not, muted or not. */
export function previewSound(id: NotificationSoundId) {
  soundPlayer.play(id, notificationPrefs().volume)
}

let lastPushed = ''

/** Tell the bridge what is quiet from now on. Deduplicated; never throws. */
export function pushQuietToBridge(force = false) {
  const plan = quietIntervals(notificationPrefs(), notificationClock.now())
  const key = JSON.stringify(plan)
  if (!force && key === lastPushed) return
  lastPushed = key
  void invoke('notify.setQuiet', plan).catch(() => {
    lastPushed = ''
  })
}

/** Wire it all up; returns the teardown. Called once from useAppEffects. */
export function startNotifications(): () => void {
  const offs: Array<() => void> = []
  const eventsOn = (window as any).runtime?.EventsOn
  if (eventsOn) {
    const on = (name: string, handler: (detail: any) => void) => {
      const off = eventsOn(name, handler)
      if (typeof off === 'function') offs.push(off)
    }
    on('mail.newMessages', (detail: { muted?: boolean } | undefined) => {
      soundForEvent('mail', !!detail?.muted)
    })
    on('calendar.reminder', () => soundForEvent('reminder'))
    on('calendar.missedRemindersShown', () => soundForEvent('reminder'))
    on('tasks.reminder', () => soundForEvent('reminder'))
    on('tray.doNotDisturb', () => toggleDoNotDisturb())
  }

  lastPushed = ''
  pushQuietToBridge()
  offs.push(settings$.notifications.onChange(() => pushQuietToBridge()))

  const tick = window.setInterval(() => {
    quietClock$.set(notificationClock.now().getTime())
    // The `quiet` flag in the plan flips when a period starts or ends, which
    // is what the tray's check mark follows.
    pushQuietToBridge()
  }, QUIET_TICK_MS)
  const refresh = window.setInterval(() => pushQuietToBridge(true), BRIDGE_REFRESH_MS)
  offs.push(() => window.clearInterval(tick))
  offs.push(() => window.clearInterval(refresh))
  return () => offs.forEach((off) => off())
}
