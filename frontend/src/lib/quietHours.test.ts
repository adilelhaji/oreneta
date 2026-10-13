import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  DEFAULT_NOTIFICATION_PREFS,
  pauseForOneHour,
  pauseUntilTomorrow,
  parseHm,
  quietIntervals,
  quietStateAt,
  resumeNotifications,
  sanitizeNotificationPrefs,
  scheduledPeriodAt,
  shouldShowNotification,
  soundFor,
  type NotificationPrefs,
} from './quietHours'

// Local wall-clock times in Madrid, which changes to summer time on
// 2026-03-29 (02:00 → 03:00) and back on 2026-10-25 (03:00 → 02:00).
let zone: string | undefined
beforeEach(() => {
  zone = process.env.TZ
  process.env.TZ = 'Europe/Madrid'
})
afterEach(() => {
  process.env.TZ = zone
})

/** A local date-time: new Date(y, m-1, d, h, min). */
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min)

const prefs = (patch: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATION_PREFS,
  ...patch,
})
const nightly = (patch: Partial<NotificationPrefs['schedule']> = {}) =>
  prefs({ schedule: { enabled: true, start: '22:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6], ...patch } })

describe('parseHm', () => {
  it('reads HH:MM and rejects anything else', () => {
    expect(parseHm('00:00')).toBe(0)
    expect(parseHm('22:30')).toBe(22 * 60 + 30)
    expect(parseHm('24:00')).toBeNull()
    expect(parseHm('7:00')).toBeNull()
    expect(parseHm(420)).toBeNull()
  })
})

describe('quiet hours crossing midnight', () => {
  // 2026-10-13 is a Tuesday.
  it('is quiet late in the evening and early the next morning, not in the day', () => {
    const p = nightly()
    expect(quietStateAt(p, local(2026, 10, 13, 21, 59)).quiet).toBe(false)
    expect(quietStateAt(p, local(2026, 10, 13, 22, 0))).toEqual({
      quiet: true,
      reason: 'schedule',
      until: local(2026, 10, 14, 7, 0).getTime(),
    })
    expect(quietStateAt(p, local(2026, 10, 14, 0, 0)).quiet).toBe(true)
    expect(quietStateAt(p, local(2026, 10, 14, 6, 59)).quiet).toBe(true)
    expect(quietStateAt(p, local(2026, 10, 14, 7, 0)).quiet).toBe(false)
  })

  it('a period within one day does not wrap', () => {
    const p = nightly({ start: '12:00', end: '13:30' })
    expect(quietStateAt(p, local(2026, 10, 13, 11, 59)).quiet).toBe(false)
    expect(quietStateAt(p, local(2026, 10, 13, 13, 0)).quiet).toBe(true)
    expect(quietStateAt(p, local(2026, 10, 13, 13, 30)).quiet).toBe(false)
  })

  it('equal start and end is the whole day', () => {
    const p = nightly({ start: '09:00', end: '09:00', days: [2] })
    expect(quietStateAt(p, local(2026, 10, 13, 9, 0)).quiet).toBe(true)
    expect(quietStateAt(p, local(2026, 10, 14, 8, 59)).quiet).toBe(true)
    expect(quietStateAt(p, local(2026, 10, 14, 9, 0)).quiet).toBe(false)
  })

  it('does nothing while turned off', () => {
    expect(quietStateAt(nightly({ enabled: false }), local(2026, 10, 13, 23)).quiet).toBe(false)
  })
})

describe('days of the week', () => {
  // Weeknights only: Monday to Friday evenings (1–5).
  const weeknights = nightly({ days: [1, 2, 3, 4, 5] })

  it('the day is the one the period starts on', () => {
    // Friday 2026-10-16 23:00 is quiet, and so is Saturday 03:00 (Friday's night)...
    expect(quietStateAt(weeknights, local(2026, 10, 16, 23)).quiet).toBe(true)
    expect(quietStateAt(weeknights, local(2026, 10, 17, 3)).quiet).toBe(true)
    // ...but Saturday night and Sunday early morning are not.
    expect(quietStateAt(weeknights, local(2026, 10, 17, 23)).quiet).toBe(false)
    expect(quietStateAt(weeknights, local(2026, 10, 18, 3)).quiet).toBe(false)
    // Sunday night is not; Monday 03:00 belongs to Sunday's night, so not either.
    expect(quietStateAt(weeknights, local(2026, 10, 19, 3)).quiet).toBe(false)
    expect(quietStateAt(weeknights, local(2026, 10, 19, 23)).quiet).toBe(true)
  })

  it('no days means never', () => {
    expect(quietStateAt(nightly({ days: [] }), local(2026, 10, 13, 23)).quiet).toBe(false)
  })
})

describe('DST change days', () => {
  it('spring forward: the night is an hour shorter but ends at 07:00 on the wall', () => {
    const period = scheduledPeriodAt(nightly().schedule, local(2026, 3, 29, 1, 30))!
    expect(period.start).toBe(local(2026, 3, 28, 22).getTime())
    expect(period.end).toBe(local(2026, 3, 29, 7).getTime())
    expect(period.end - period.start).toBe(8 * 3600_000)
    expect(quietStateAt(nightly(), local(2026, 3, 29, 6, 59)).quiet).toBe(true)
    expect(quietStateAt(nightly(), local(2026, 3, 29, 7, 0)).quiet).toBe(false)
  })

  it('fall back: the night is an hour longer, still 22:00 to 07:00', () => {
    const period = scheduledPeriodAt(nightly().schedule, local(2026, 10, 25, 2, 30))!
    expect(period.end - period.start).toBe(10 * 3600_000)
    expect(quietStateAt(nightly(), local(2026, 10, 25, 7, 0)).quiet).toBe(false)
  })

  it('a start inside the skipped hour lands just after it', () => {
    const p = nightly({ start: '02:30', end: '04:00' })
    const period = scheduledPeriodAt(p.schedule, local(2026, 3, 29, 3, 45))!
    expect(new Date(period.start).getHours()).toBe(3)
    expect(quietStateAt(p, local(2026, 3, 29, 3, 59)).quiet).toBe(true)
  })

  it('one hour is sixty minutes even across the change', () => {
    const now = local(2026, 10, 25, 1, 30)
    const { until } = pauseForOneHour(now)
    expect(until - now.getTime()).toBe(3600_000)
  })
})

describe('pauses', () => {
  it('"until tomorrow" ends tomorrow at 08:00 local, also from just before midnight', () => {
    expect(pauseUntilTomorrow(local(2026, 10, 13, 23, 50)).until).toBe(local(2026, 10, 14, 8).getTime())
    expect(pauseUntilTomorrow(local(2026, 10, 14, 0, 10)).until).toBe(local(2026, 10, 15, 8).getTime())
    // Across the DST change it is still 08:00 on the wall.
    expect(new Date(pauseUntilTomorrow(local(2026, 10, 24, 20)).until).getHours()).toBe(8)
  })

  it('a pause is quiet until it ends, and "until turned off" until resumed', () => {
    const now = local(2026, 10, 13, 10)
    const p = prefs({ pause: pauseForOneHour(now) })
    expect(quietStateAt(p, now)).toEqual({ quiet: true, reason: 'pause', until: now.getTime() + 3600_000 })
    expect(quietStateAt(p, local(2026, 10, 13, 11)).quiet).toBe(false)
    expect(quietStateAt(prefs({ pause: { until: null } }), local(2030, 1, 1))).toEqual({
      quiet: true,
      reason: 'pause',
      until: null,
    })
  })

  it('resume drops the pause and skips only the rest of the running scheduled period', () => {
    const p = { ...nightly(), pause: { until: null } }
    const now = local(2026, 10, 13, 23)
    const after = resumeNotifications(p, now)
    expect(after.pause).toBeNull()
    expect(after.scheduleResumedUntil).toBe(local(2026, 10, 14, 7).getTime())
    expect(quietStateAt(after, now).quiet).toBe(false)
    expect(quietStateAt(after, local(2026, 10, 14, 6)).quiet).toBe(false)
    // The next night is quiet again.
    expect(quietStateAt(after, local(2026, 10, 14, 22)).quiet).toBe(true)
  })
})

describe('what is shown and heard', () => {
  const quietNow = local(2026, 10, 13, 23)

  it('quiet holds back mail; reminders follow their checkbox', () => {
    const p = nightly()
    expect(shouldShowNotification(p, quietNow, 'mail')).toBe(false)
    expect(shouldShowNotification(p, quietNow, 'reminder')).toBe(true)
    expect(shouldShowNotification({ ...p, remindersWhileQuiet: false }, quietNow, 'reminder')).toBe(false)
    expect(shouldShowNotification(p, local(2026, 10, 13, 12), 'mail')).toBe(true)
  })

  it('sounds need to be on, a volume, an unmuted account and no quiet', () => {
    const on = prefs({ mailSound: true, reminderSound: true, mailSoundId: 'pop', reminderSoundId: 'bell' })
    const day = local(2026, 10, 13, 12)
    expect(soundFor(DEFAULT_NOTIFICATION_PREFS, day, 'mail')).toBeNull()
    expect(soundFor(on, day, 'mail')).toBe('pop')
    expect(soundFor(on, day, 'mail', true)).toBeNull()
    expect(soundFor({ ...on, volume: 0 }, day, 'mail')).toBeNull()
    expect(soundFor(on, day, 'reminder')).toBe('bell')
    const quiet = { ...on, schedule: nightly().schedule }
    expect(soundFor(quiet, quietNow, 'mail')).toBeNull()
    expect(soundFor(quiet, quietNow, 'reminder')).toBe('bell')
    expect(soundFor({ ...quiet, remindersWhileQuiet: false }, quietNow, 'reminder')).toBeNull()
  })
})

describe('quietIntervals for the bridge', () => {
  it('lists the coming nights, clipped by Resume, and an open pause as indefinite', () => {
    const now = local(2026, 10, 13, 23)
    const resumed = resumeNotifications(nightly(), now)
    const plan = quietIntervals(resumed, now, 2)
    expect(plan.indefinite).toBe(false)
    expect(plan.quiet).toBe(false)
    // Tonight's period is skipped; the next two remain.
    expect(plan.intervals).toEqual([
      [local(2026, 10, 14, 22).getTime(), local(2026, 10, 15, 7).getTime()],
      [local(2026, 10, 15, 22).getTime(), local(2026, 10, 16, 7).getTime()],
    ])
    const open = quietIntervals(prefs({ pause: { until: null } }), now)
    expect(open).toEqual({ intervals: [], indefinite: true, remindersWhileQuiet: true, quiet: true })
  })

  it('a timed pause does not change as the clock moves', () => {
    const now = local(2026, 10, 13, 10)
    const p = prefs({ pause: pauseForOneHour(now) })
    expect(quietIntervals(p, now)).toEqual(quietIntervals(p, new Date(now.getTime() + 30_000)))
    expect(quietIntervals(p, new Date(now.getTime() + 3600_000)).intervals).toEqual([])
  })
})

describe('sanitizeNotificationPrefs', () => {
  it('keeps valid fields and replaces bad ones one by one', () => {
    expect(sanitizeNotificationPrefs(null)).toBeNull()
    expect(sanitizeNotificationPrefs([])).toBeNull()
    expect(
      sanitizeNotificationPrefs({
        mailSound: true,
        mailSoundId: 'airhorn',
        volume: 140,
        pause: { until: 'later' },
        schedule: { enabled: true, start: '25:00', end: '06:30', days: [5, 1, 1, 9, 'x'] },
        remindersWhileQuiet: false,
      }),
    ).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      mailSound: true,
      volume: 100,
      schedule: { enabled: true, start: '22:00', end: '06:30', days: [1, 5] },
      remindersWhileQuiet: false,
    })
    expect(sanitizeNotificationPrefs({ pause: { until: null } })?.pause).toEqual({ until: null })
  })
})
