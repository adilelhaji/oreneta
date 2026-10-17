import { useEffect, useRef, type ReactNode } from 'react'
import {
  DndContext,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type Over,
} from '@dnd-kit/core'
import { useTranslation } from '../../lib/i18n'
import {
  daysBetween,
  draggedTimes,
  instantAtOffset,
  movedToDay,
  shiftedByDays,
  type Times,
} from '../../lib/calendarDrag'
import {
  cancelMove,
  move$,
  previewMove,
  settleMove,
  startMove,
  type CalendarDrag,
  type CalendarDrop,
} from '../../states/calendarMove'
import { HOUR_PX } from './WeekView'

/// A press must travel this far before it drags, so a click still opens the
/// event.
const DRAG_DISTANCE_PX = 4

/// The drag and drop of events across the calendar (#266), with `@dnd-kit`
/// as the kanban board and the side navigation use it: the hour grid and the
/// all-day strip hold the events, and they and the mini calendar take them.
///
/// Where an event would land is worked out from the pointer itself, read
/// against the column under it as it is now: the grid scrolls under a held
/// event, so a distance travelled since the press would put it at the wrong
/// hour. Escape gives the drag up (the pointer sensor's own key) and nothing
/// is written; a drop settles the move through `states/calendarMove`.
export function CalendarDnd({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } }))
  // The drag in hand: what it holds, the instant under the pointer when it was
  // picked up from the grid (none from the all-day strip), and the pointer.
  const held = useRef<{ drag: CalendarDrag; from: number | null; y: number } | null>(null)
  // Where the last press was: a drag starts a few pixels later, and what it
  // holds is what was under the press.
  const press = useRef({ y: 0 })

  useEffect(() => {
    const down = (pointer: PointerEvent) => {
      press.current = { y: pointer.clientY }
    }
    const follow = (pointer: PointerEvent) => {
      if (held.current) held.current.y = pointer.clientY
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', follow, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', follow, true)
    }
  }, [])

  const update = (over: Over | null) => {
    const current = held.current
    if (!current) return
    const event = current.drag.event
    previewMove(landing(current, over?.data.current as CalendarDrop | undefined) ?? { start: event.start, end: event.end })
  }

  const subjectOf = (data: unknown) =>
    (data as CalendarDrag | undefined)?.event.subject || t('calendar.noSubject', { defaultValue: '(no subject)' })
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t('calendar.dragStarted', { subject: subjectOf(active.data.current), defaultValue: 'Moving {subject}.' }),
    onDragOver: () => undefined,
    onDragEnd: () => undefined,
    onDragCancel: () => t('calendar.dragCancelled', { defaultValue: 'Move cancelled; nothing was changed.' }),
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: t('calendar.moveHint', {
            defaultValue:
              'Alt with the arrow keys moves it; Alt+Shift with the up and down arrows changes when it ends. Enter saves the change; Escape cancels it.',
          }),
        },
      }}
      onDragStart={({ active }) => {
        const drag = active.data.current as CalendarDrag | undefined
        held.current = null
        if (!drag || !startMove(drag.event, 'pointer')) return
        const y = press.current.y
        held.current = { drag, from: drag.origin === 'grid' ? gridInstant(drag.day, y) : null, y }
      }}
      onDragMove={({ over }) => update(over)}
      onDragOver={({ over }) => update(over)}
      onDragEnd={({ over }) => {
        update(over)
        const wasHeld = held.current !== null
        held.current = null
        if (wasHeld && move$.moving.peek()?.via === 'pointer') void settleMove()
      }}
      onDragCancel={() => {
        const wasHeld = held.current !== null
        held.current = null
        if (wasHeld) cancelMove()
      }}
    >
      {children}
    </DndContext>
  )
}

/// The instant under the pointer in the hour-grid column of a day, read from
/// where the column is on screen now. Null when the column is not shown.
function gridInstant(day: number, clientY: number): number | null {
  const column = document.querySelector(`[data-day-column="${day}"]`)
  if (!column) return null
  return instantAtOffset(new Date(day), clientY - column.getBoundingClientRect().top, HOUR_PX)
}

/// Where a held event would land on what is under the pointer, or null for
/// where it already is.
///
/// - On a day of the mini calendar: that day, keeping its time.
/// - On a column of the hour grid, picked up from the grid: the pointer's
///   instant, on the grid line nearest the edge held (`draggedTimes`).
/// - Elsewhere — the all-day strip, or a strip event over the grid — by whole
///   days from the day it was picked up on. Only a move goes there; an edge
///   held over anything but the grid stays where it was.
function landing(held: { drag: CalendarDrag; from: number | null; y: number }, target: CalendarDrop | undefined): Times | null {
  if (!target) return null
  const { edge, event, day, origin } = held.drag
  if (target.area === 'mini') return edge === 'move' ? movedToDay(event, new Date(target.day)) : null
  if (target.area === 'grid' && origin === 'grid' && held.from !== null) {
    const to = gridInstant(target.day, held.y)
    return to === null ? null : draggedTimes(edge, event, held.from, to)
  }
  if (edge !== 'move') return null
  return shiftedByDays(event, daysBetween(new Date(day), new Date(target.day)))
}
