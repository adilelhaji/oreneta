// Which of the person's own events a time overlaps (ADR-0043): a local
// check over the events kept here, across every account. No server is asked.
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'

export type Conflict = {
  account: string
  calendar_id: string
  event_id: string
  subject: string
  start: number
  end: number
  all_day: boolean
}

/**
 * The overlapping events, earliest first. `exclude` names the event itself
 * (its id, series or UID). A failed check reads as nothing found rather than
 * as an error: it is advice, not a gate.
 */
export async function findConflicts(
  start: number,
  end: number,
  allDay: boolean,
  exclude: string[],
): Promise<Conflict[]> {
  if (!(end > start)) return []
  try {
    const res = await invoke<{ conflicts?: Conflict[] }>('calendar.conflicts', {
      start,
      end,
      all_day: allDay,
      // Where the person is at that time, so an all-day event counts only on
      // its own day there.
      offset: -new Date(start * 1000).getTimezoneOffset() * 60,
      exclude: exclude.filter(Boolean),
    })
    return Array.isArray(res?.conflicts) ? res.conflicts : []
  } catch {
    return []
  }
}

/** "Overlaps: A, B, C and 2 more", or '' when nothing does. */
export function conflictsText(conflicts: Conflict[]): string {
  if (conflicts.length === 0) return ''
  const untitled = t('calendar.untitled', { defaultValue: '(No title)' })
  const names = conflicts.slice(0, 3).map((c) => c.subject.trim() || untitled)
  const more = conflicts.length - names.length
  const list =
    more > 0
      ? t('calendar.conflictsMore', { names: names.join(', '), count: more, defaultValue: '{names} and {count} more' })
      : names.join(', ')
  return t('calendar.conflicts', { list, defaultValue: 'Overlaps: {list}' })
}
