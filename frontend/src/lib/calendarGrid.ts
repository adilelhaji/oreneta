/**
 * Positions on a day column, in hours from the top, by the wall clock.
 *
 * A day column is drawn as 24 hour rows. On the days the clocks change the
 * day lasts 23 or 25 hours, so counting elapsed seconds from midnight put
 * everything after the change an hour off its row (a 10:00 meeting drawn at
 * 11:00 on the last Sunday of October in Europe) and a double-click an hour
 * off the row clicked. Reading the time of day avoids that.
 */
export function hoursIntoDay(epochSeconds: number, day: Date): number {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() / 1000
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime() / 1000
  if (epochSeconds <= start) return 0
  if (epochSeconds >= end) return 24
  const at = new Date(epochSeconds * 1000)
  return at.getHours() + at.getMinutes() / 60 + at.getSeconds() / 3600
}

/** The instant at a whole hour of the day's wall clock. */
export function instantAtHour(day: Date, hour: number): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime() / 1000
}
