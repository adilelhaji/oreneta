// Breaking a list of messages into the stretches of time people think in.
//
// "Today", "Yesterday", "Earlier this week" — the divisions a reader already
// uses when they say when something arrived. A list of forty rows each with
// its own date is forty dates to read; the same list under four headings is
// four.
//
// Only meaningful when the list is in date order. Grouping a list sorted by
// sender under date headings would produce headings that repeat and mean
// nothing, so the caller is told to ask first.

/** A stretch of time, named by what a reader would call it. */
export type DateGroup =
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'lastWeek'
  | 'thisMonth'
  | 'earlier'
  | 'unknown'

const DAY = 86_400

/** Local midnight of the day an instant falls in, as epoch seconds. */
function startOfDay(at: Date): number {
  const midnight = new Date(at)
  midnight.setHours(0, 0, 0, 0)
  return Math.floor(midnight.getTime() / 1000)
}

/**
 * Which stretch a message falls in.
 *
 * Measured against the reader's own midnights, not against a count of hours:
 * something that arrived at eleven last night is "yesterday" at nine this
 * morning, even though it is ten hours old, because that is what yesterday
 * means to the person reading.
 *
 * A message with no date at all is its own group. It is rare — a server that
 * sent no date, a row cached before one was parsed — and putting it under
 * "earlier" would be asserting something nobody knows.
 */
export function dateGroup(dateSeconds: number, now = new Date()): DateGroup {
  if (!dateSeconds || dateSeconds <= 0) return 'unknown'

  const today = startOfDay(now)
  if (dateSeconds >= today) return 'today'
  if (dateSeconds >= today - DAY) return 'yesterday'

  // The week starts on Monday, which is what "earlier this week" means to a
  // working calendar. `getDay()` is Sunday-based, so Sunday is six days in.
  const weekday = (now.getDay() + 6) % 7
  const weekStart = today - weekday * DAY
  if (dateSeconds >= weekStart) return 'thisWeek'
  if (dateSeconds >= weekStart - 7 * DAY) return 'lastWeek'

  const monthStart = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1))
  if (dateSeconds >= monthStart) return 'thisMonth'
  return 'earlier'
}

/** One heading and the messages under it. */
export type Grouped<T> = { group: DateGroup; items: T[] }

/**
 * Splits a date-ordered list into its stretches, keeping the order it came in.
 *
 * Consecutive runs only — the list is already ordered, so a group is a run,
 * and gathering scattered rows under one heading would silently reorder the
 * list under the reader.
 */
export function groupByDate<T>(items: T[], dateOf: (item: T) => number, now = new Date()): Grouped<T>[] {
  const out: Grouped<T>[] = []
  for (const item of items) {
    const group = dateGroup(dateOf(item), now)
    const last = out[out.length - 1]
    if (last && last.group === group) last.items.push(item)
    else out.push({ group, items: [item] })
  }
  return out
}
