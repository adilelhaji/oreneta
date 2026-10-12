import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { conflictsText, findConflicts, type Conflict } from '../../states/conflicts'

/**
 * Says which of the person's own events a time overlaps (ADR-0043), checked
 * against the calendars kept here. Says nothing when nothing does.
 */
export function ConflictNote({
  start,
  end,
  allDay,
  exclude,
  className = '',
}: {
  start: number
  end: number
  allDay: boolean
  exclude: string[]
  className?: string
}) {
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const key = exclude.join('\n')

  useEffect(() => {
    let live = true
    void findConflicts(start, end, allDay, exclude).then((found) => live && setConflicts(found))
    return () => {
      live = false
    }
    // `key` stands for `exclude`, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, allDay, key])

  const text = conflictsText(conflicts)
  if (!text) return null
  return (
    <p role="status" className={`flex items-start gap-1.5 text-caption text-warning ${className}`}>
      <TriangleAlert size={13} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  )
}
