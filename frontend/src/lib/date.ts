// Pure date helpers shared across the UI and state layers. The sidecar sends
// `date` as Unix epoch seconds (0 when unknown); these format it for display in
// the user's local time.

/** Convert epoch seconds to a Date, or null when unknown (0/falsy). */
function fromEpochSeconds(epochSeconds: number): Date | null {
  if (!epochSeconds) return null
  return new Date(epochSeconds * 1000)
}

/** Gmail-style thread-list timestamp: time today, month/day this year, else month/day/year. */
export function formatThreadDate(epochSeconds: number): string {
  const date = fromEpochSeconds(epochSeconds)
  if (!date) return ''
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  const options: Intl.DateTimeFormatOptions =
    date.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  return date.toLocaleDateString([], options)
}

/**
 * The hour a deferred action lands on, so "tomorrow" is not left to the
 * imagination.
 *
 * Today's is given as a time alone; any other day carries its weekday, because
 * "08:00" without a day is a promise the reader cannot check.
 */
export function formatDeferredWhen(at: number, now = new Date()): string {
  const date = new Date(at * 1000)
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(undefined, {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
}

/** Where a task's due date sits relative to today — a date, never a time. */
export type DueStatus = 'overdue' | 'today' | 'tomorrow' | 'upcoming'

export function dueStatus(dueAtEpochSeconds: number, now = new Date()): DueStatus {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const days = Math.round(
    (startOfDay(new Date(dueAtEpochSeconds * 1000)).getTime() - startOfDay(now).getTime()) / 86_400_000,
  )
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return 'upcoming'
}

/** A due date past tomorrow, as a plain date — never a time of day. */
export function formatDueDate(dueAtEpochSeconds: number, now = new Date()): string {
  const date = new Date(dueAtEpochSeconds * 1000)
  const options: Intl.DateTimeFormatOptions =
    date.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  return date.toLocaleDateString(undefined, options)
}
