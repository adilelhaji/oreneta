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
import { instantAtOffset, landingTimes, type DropTarget } from '../../lib/calendarDrag'
import {
  cancelMove,
  eventKey,
  markDrop,
  move$,
  previewMove,
  settleMove,
  startMove,
  type CalendarDrag,
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
/// The grid scrolls when a held event nears its top or bottom, within a
/// narrow band, so a drag across the visible hours does not set it off.
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
    const target = over?.data.current as DropTarget | undefined
    const to = target?.area === 'grid' ? gridInstant(target.day, current.y) : null
    const drag = { edge: current.drag.edge, event, day: current.drag.day, from: current.from }
    previewMove(landingTimes(drag, target, to) ?? { start: event.start, end: event.end })
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
      autoScroll={{ threshold: { x: 0, y: 0.08 } }}
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
      onDragEnd={({ active, over }) => {
        update(over)
        const wasHeld = held.current !== null
        held.current = null
        // Also after a refused drag: the click it leaves behind does not open the event.
        dropped(active.data.current)
        if (wasHeld && move$.moving.peek()?.via === 'pointer') void settleMove()
      }}
      onDragCancel={({ active }) => {
        const wasHeld = held.current !== null
        held.current = null
        dropped(active.data.current)
        if (wasHeld) cancelMove()
      }}
    >
      {children}
    </DndContext>
  )
}

/// Notes the end of a drag on the event it held.
function dropped(data: unknown) {
  const drag = data as CalendarDrag | undefined
  if (drag) markDrop(eventKey(drag.event))
}

/// The instant under the pointer in the hour-grid column of a day, read from
/// where the column is on screen now. Null when the column is not shown, or
/// when the pointer is outside the visible part of the grid: the column is
/// taller than its scrolled pane, and a drop on the headings above it is not a
/// drop at midnight.
function gridInstant(day: number, clientY: number): number | null {
  const column = document.querySelector(`[data-day-column="${day}"]`)
  if (!column) return null
  const pane = column.closest('[data-hour-grid]')?.getBoundingClientRect()
  if (pane && (clientY < pane.top || clientY > pane.bottom)) return null
  return instantAtOffset(new Date(day), clientY - column.getBoundingClientRect().top, HOUR_PX)
}
