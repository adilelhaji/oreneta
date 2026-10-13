// General → Notifications (SET-01, ADR-0049): notification sounds, do not
// disturb and the daily quiet hours. Everything here is pure and takes `now`,
// so the decisions can be tested at any instant — midnight, a DST change, a
// Sunday night. states/notifications.ts reads `settings$.notifications` and
// hands it in; the Go bridge gets the quiet intervals computed here
// (`quietIntervals`) so the OS notifications it raises follow the same rules
// without a second implementation of the schedule.
//
// All wall-clock times are local: a schedule of 22:00–07:00 means 22:00 on the
// clock on the wall, whatever the offset is that day. Dates are built with the
// local Date constructor, which already lands on the right instant across a
// DST change (a 02:30 that does not exist becomes 03:30).

/** The sounds Oreneta ships: synthesized with WebAudio, so no audio files. */
export const NOTIFICATION_SOUNDS = ['chime', 'bell', 'pop', 'marimba'] as const
export type NotificationSoundId = (typeof NOTIFICATION_SOUNDS)[number]

export type QuietSchedule = {
  enabled: boolean
  /** 'HH:MM', local. */
  start: string
  /** 'HH:MM', local. Before or equal to start means it ends the next day. */
  end: string
  /** Days the quiet period *starts* on, 0 = Sunday … 6 = Saturday. */
  days: number[]
}

export type NotificationPrefs = {
  mailSound: boolean
  mailSoundId: NotificationSoundId
  reminderSound: boolean
  reminderSoundId: NotificationSoundId
  /** 0–100. */
  volume: number
  /**
   * A do-not-disturb pause the person turned on. `until` is epoch ms, or null
   * for "until turned off". Null when there is no pause.
   */
  pause: { until: number | null } | null
  schedule: QuietSchedule
  /**
   * "Resume" pressed during a scheduled quiet period: the schedule is ignored
   * until this instant (the end of that period), then applies again.
   */
  scheduleResumedUntil: number | null
  /** Calendar and task reminders still show (and sound) while quiet. */
  remindersWhileQuiet: boolean
}

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  mailSound: false,
  mailSoundId: 'chime',
  reminderSound: false,
  reminderSoundId: 'bell',
  volume: 60,
  pause: null,
  schedule: { enabled: false, start: '22:00', end: '07:00', days: ALL_DAYS },
  scheduleResumedUntil: null,
  // Reminders are time-critical: missing a meeting because the evening was
  // quiet is worse than one popup.
  remindersWhileQuiet: true,
}

/** Hour of "until tomorrow". */
export const TOMORROW_HOUR = 8

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Minutes since midnight for 'HH:MM', or null. */
export function parseHm(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = HM.exec(value)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Read a stored value back, field by field: an invalid field falls back to its
 * default without costing the person their other choices.
 */
export function sanitizeNotificationPrefs(raw: unknown): NotificationPrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const d = DEFAULT_NOTIFICATION_PREFS
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  const sound = (v: unknown, fallback: NotificationSoundId) =>
    NOTIFICATION_SOUNDS.includes(v as NotificationSoundId) ? (v as NotificationSoundId) : fallback
  const volume = isTime(value.volume) ? Math.round(Math.min(100, Math.max(0, value.volume))) : d.volume
  let pause: NotificationPrefs['pause'] = null
  if (value.pause && typeof value.pause === 'object') {
    const until = (value.pause as Record<string, unknown>).until
    if (until === null) pause = { until: null }
    else if (isTime(until)) pause = { until }
  }
  const rawSchedule =
    value.schedule && typeof value.schedule === 'object' ? (value.schedule as Record<string, unknown>) : {}
  const days = Array.isArray(rawSchedule.days)
    ? [...new Set(rawSchedule.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort(
        (a, b) => a - b,
      )
    : d.schedule.days
  return {
    mailSound: bool(value.mailSound, d.mailSound),
    mailSoundId: sound(value.mailSoundId, d.mailSoundId),
    reminderSound: bool(value.reminderSound, d.reminderSound),
    reminderSoundId: sound(value.reminderSoundId, d.reminderSoundId),
    volume,
    pause,
    schedule: {
      enabled: bool(rawSchedule.enabled, d.schedule.enabled),
      start: parseHm(rawSchedule.start) === null ? d.schedule.start : (rawSchedule.start as string),
      end: parseHm(rawSchedule.end) === null ? d.schedule.end : (rawSchedule.end as string),
      days,
    },
    scheduleResumedUntil: isTime(value.scheduleResumedUntil) ? value.scheduleResumedUntil : null,
    remindersWhileQuiet: bool(value.remindersWhileQuiet, d.remindersWhileQuiet),
  }
}

/** Local midnight `offset` days from the day of `date`. */
function localDay(date: Date, offset: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset)
}

function atMinutes(day: Date, minutes: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60)
}

/**
 * The scheduled quiet period that starts on local `day` (any time that day),
 * or null if the schedule does not run that weekday. A period whose end is not
 * after its start ends the next day; equal start and end is the whole day.
 */
export function scheduledPeriodOn(schedule: QuietSchedule, day: Date): { start: number; end: number } | null {
  const start = parseHm(schedule.start)
  const end = parseHm(schedule.end)
  if (start === null || end === null) return null
  const midnight = localDay(day, 0)
  if (!schedule.days.includes(midnight.getDay())) return null
  const from = atMinutes(midnight, start)
  const to = end > start ? atMinutes(midnight, end) : atMinutes(localDay(midnight, 1), end)
  return { start: from.getTime(), end: to.getTime() }
}

/** The scheduled period containing `now`, ignoring "Resume", or null. */
export function scheduledPeriodAt(schedule: QuietSchedule, now: Date): { start: number; end: number } | null {
  if (!schedule.enabled) return null
  const t = now.getTime()
  // A period that crossed midnight started yesterday.
  for (const offset of [0, -1]) {
    const period = scheduledPeriodOn(schedule, localDay(now, offset))
    if (period && period.start <= t && t < period.end) return period
  }
  return null
}

export type QuietState =
  | { quiet: false }
  | {
      quiet: true
      reason: 'pause' | 'schedule'
      /** When it ends on its own (epoch ms), or null for "until turned off". */
      until: number | null
    }

/** Whether notifications are quiet at `now`, and why. */
export function quietStateAt(prefs: NotificationPrefs, now: Date): QuietState {
  const t = now.getTime()
  if (prefs.pause && (prefs.pause.until === null || t < prefs.pause.until)) {
    return { quiet: true, reason: 'pause', until: prefs.pause.until }
  }
  const period = scheduledPeriodAt(prefs.schedule, now)
  if (period && !(prefs.scheduleResumedUntil !== null && t < prefs.scheduleResumedUntil)) {
    return { quiet: true, reason: 'schedule', until: period.end }
  }
  return { quiet: false }
}

export type NotificationKind = 'mail' | 'reminder'

/** Whether a popup of this kind may be shown at `now`. */
export function shouldShowNotification(prefs: NotificationPrefs, now: Date, kind: NotificationKind): boolean {
  if (!quietStateAt(prefs, now).quiet) return true
  return kind === 'reminder' && prefs.remindersWhileQuiet
}

/**
 * The sound to play for a notification of this kind, or null for silence: the
 * sound is on, the account is not muted, and nothing quiet stands in the way.
 * A reminder shown while quiet keeps its sound — it is shown because it matters.
 */
export function soundFor(
  prefs: NotificationPrefs,
  now: Date,
  kind: NotificationKind,
  muted = false,
): NotificationSoundId | null {
  if (muted) return null
  const enabled = kind === 'mail' ? prefs.mailSound : prefs.reminderSound
  if (!enabled || prefs.volume <= 0) return null
  if (!shouldShowNotification(prefs, now, kind)) return null
  return kind === 'mail' ? prefs.mailSoundId : prefs.reminderSoundId
}

/** One hour from now: a duration, not a wall-clock time. */
export function pauseForOneHour(now: Date): { until: number } {
  return { until: now.getTime() + 60 * 60 * 1000 }
}

/** Tomorrow (the next calendar day) at {@link TOMORROW_HOUR}:00 local. */
export function pauseUntilTomorrow(now: Date): { until: number } {
  const tomorrow = localDay(now, 1)
  return { until: atMinutes(tomorrow, TOMORROW_HOUR * 60).getTime() }
}

export function pauseUntilTurnedOff(): { until: null } {
  return { until: null }
}

/**
 * Turn quiet off now: drop the pause and, if a scheduled period is running,
 * skip the rest of it. The next scheduled period applies as usual.
 */
export function resumeNotifications(prefs: NotificationPrefs, now: Date): NotificationPrefs {
  const period = scheduledPeriodAt(prefs.schedule, now)
  return {
    ...prefs,
    pause: null,
    scheduleResumedUntil: period ? period.end : prefs.scheduleResumedUntil,
  }
}

/**
 * What the Go bridge needs to gate OS notifications on its own, even when the
 * window's timers are throttled: the quiet intervals (epoch ms, [start, end))
 * from now over the next `days` days, whether there is an open-ended pause,
 * and whether reminders still go through.
 */
export function quietIntervals(
  prefs: NotificationPrefs,
  now: Date,
  days = 8,
): { intervals: [number, number][]; indefinite: boolean; remindersWhileQuiet: boolean; quiet: boolean } {
  const t = now.getTime()
  const intervals: [number, number][] = []
  let indefinite = false
  if (prefs.pause) {
    if (prefs.pause.until === null) indefinite = true
    // From 0 rather than from now: the pause has already begun, and a start
    // that moved with the clock would make every push look like a change.
    else if (t < prefs.pause.until) intervals.push([0, prefs.pause.until])
  }
  if (prefs.schedule.enabled) {
    for (let offset = -1; offset <= days; offset++) {
      const period = scheduledPeriodOn(prefs.schedule, localDay(now, offset))
      if (!period) continue
      let start = period.start
      if (prefs.scheduleResumedUntil !== null) start = Math.max(start, prefs.scheduleResumedUntil)
      if (start < period.end && period.end > t) intervals.push([start, period.end])
    }
  }
  return {
    intervals,
    indefinite,
    remindersWhileQuiet: prefs.remindersWhileQuiet,
    quiet: quietStateAt(prefs, now).quiet,
  }
}
