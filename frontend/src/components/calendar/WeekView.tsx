import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useValue } from '@legendapp/state/react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { CalendarDays, Plus } from 'lucide-react'
import i18n, { useTranslation } from '../../lib/i18n'
import {
  allDayLocalDays,
  calendar$,
  eventColor,
  openEvent,
  newEvent,
  setCalendarView,
  startOfDay,
  firstDayOfWeek,
  localeWeek,
  startOfWeek,
  workDays,
  writableCalendars,
  changeRefusal,
  type CalendarEvent,
} from '../../states/calendar'
import {
  cancelMove,
  clickFollowsDrop,
  eventKey,
  move$,
  previewMove,
  settleMove,
  startMove,
  type CalendarDrag,
  type CalendarDrop,
  type EventMove,
} from '../../states/calendarMove'
import { settings$ } from '../../states/settings'
import { formatTime } from './AgendaView'
import { hoursIntoDay, instantAtHour } from '../../lib/calendarGrid'
import { isoWeekday, offHourBands, scrollHour, weekNumber, weekNumberRule } from '../../lib/calendarWeek'
import {
  SNAP_MINUTES,
  instantAtMinute,
  nudgedTimes,
  selectedRange,
  slotStart,
  type DragEdge,
  type Nudge,
} from '../../lib/calendarDrag'
import { elementDirection, inlineArrowStep, startEdgeX } from '../../lib/direction'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { FloatingContextMenu } from '../menu/FloatingContextMenu'
import { MenuItem } from '../menu/MenuItem'

/// Pixels per hour. Tall enough that a half-hour meeting still fits a line of
/// text, short enough that a working day fits a laptop screen.
export const HOUR_PX = 52

const DAY_MINUTES = 24 * 60

/// How far a pointer must travel across an empty column before it selects a
/// range rather than being a click.
const SELECT_THRESHOLD_PX = 4

/// Shown in the all-day strip: a true all-day event, or a timed one that
/// lasts a day or more and has no single hour to sit at.
const inStrip = (event: Pick<CalendarEvent, 'all_day' | 'start' | 'end'>) =>
  event.all_day || event.end - event.start >= 24 * 3600

/// Whether a pointer or key landed on an event rather than on the grid behind it.
const onEvent = (target: EventTarget | null) => target instanceof Element && target.closest('[data-calendar-event]') !== null

/// A range being dragged out across an empty column (#267), in minutes past
/// the column's midnight.
type Selection = { day: number; from: number; to: number; pointerId: number; startY: number; active: boolean }

/// The grid slot the keyboard is on (#267): a day, a start minute and a length.
type Slot = { day: number; minute: number; length: number }

/// The menu of an empty slot: where it opens and what it would create.
/// `end` is set when it opens from the keyboard slot, whose length was chosen.
type SlotMenu = { x: number; y: number; start: number; end?: number; day: Date }

/// The week (or a single day) as an hour grid.
///
/// Events sit at their hour and share the column width when they overlap.
/// The strip above the grid holds all-day events, which have no hour to sit
/// at. The first render scrolls to the start of the work day rather than to
/// midnight. Hours and days outside work (Calendar → General, ADR-0051) are
/// shaded, and the week can be cut down to its working days.
///
/// An event is dragged to move it and by its top or bottom edge to change when
/// it starts or ends, or moved from the keyboard (#266); where it would land is
/// drawn while it is held, and the move goes through `states/calendarMove`.
/// An event is created by double-clicking an hour, dragging across a range,
/// from the menu of an empty slot, or from the keyboard slot (#267).
export function WeekView({
  days,
  onEventMenu,
}: {
  days: 1 | 7
  onEventMenu: (x: number, y: number, event: CalendarEvent) => void
}) {
  const { t } = useTranslation()
  const anchorMs = useValue(calendar$.anchor)
  const events = useValue(calendar$.events)
  const calendars = useValue(calendar$.calendars)
  const weekStart = useValue(settings$.calendarWeekStart)
  const prefs = useValue(settings$.calendar)
  const moving = useValue(move$.moving)
  const scroller = useRef<HTMLDivElement | null>(null)
  const slotButton = useRef<HTMLButtonElement | null>(null)
  const [selection, setShownSelection] = useState<Selection | null>(null)
  // The range as the pointer handlers read it: a press, a move and a release
  // can all arrive before the view draws again.
  const selecting = useRef<Selection | null>(null)
  const setSelection = (next: Selection | null) => {
    selecting.current = next
    setShownSelection(next)
  }
  const [menu, setMenu] = useState<SlotMenu | null>(null)
  const [slot, setSlot] = useState<Slot | null>(null)
  const hintId = useId()

  const firstDay = firstDayOfWeek(weekStart)
  const working = workDays(prefs)
  const first = days === 7 ? startOfWeek(new Date(anchorMs), firstDay) : startOfDay(new Date(anchorMs))
  const workWeekOnly = days === 7 && prefs.workWeekOnly
  const columns = useMemo(() => {
    const all = Array.from({ length: days }, (_, i) => {
      return new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)
    })
    // A week with no working day at all is shown whole rather than empty.
    const kept = workWeekOnly ? all.filter((date) => working.includes(isoWeekday(date))) : all
    return kept.length > 0 ? kept : all
  }, [first.getTime(), days, workWeekOnly, working.join()])
  const todayMs = startOfDay(new Date()).getTime()
  const week = prefs.showWeekNumbers ? weekNumber(first, weekNumberRule(firstDay, localeWeek())).week : null

  useEffect(() => {
    scroller.current?.scrollTo({ top: scrollHour(prefs) * HOUR_PX })
  }, [days, anchorMs, prefs.workStart])

  // A keyboard move is given up by Escape wherever the focus went, and by a
  // press of the pointer anywhere: nothing is saved that Enter did not save.
  const keyboardMove = moving?.via === 'keyboard' && !moving.settled
  useEscapeKey(cancelMove, keyboardMove)
  useEffect(() => {
    if (!keyboardMove) return
    const giveUp = () => cancelMove()
    window.addEventListener('pointerdown', giveUp, true)
    return () => window.removeEventListener('pointerdown', giveUp, true)
  }, [keyboardMove])

  // Escape drops a range being dragged out, and nothing is created.
  useEscapeKey(() => setSelection(null), Boolean(selection?.active))

  const colorOf = (event: CalendarEvent) => eventColor(event, calendars)

  const byColumn = useMemo(
    () =>
      columns.map((date) => {
        const dayStart = date.getTime() / 1000
        const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() / 1000
        const timed = events.filter((event) => !inStrip(event) && event.start < dayEnd && event.end > dayStart)
        return { date, dayStart, dayEnd, lanes: placeInLanes(timed) }
      }),
    [columns, events],
  )

  const allDayByColumn = useMemo(
    () =>
      columns.map((date) => {
        const key = date.getTime()
        const dayStart = key / 1000
        const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() / 1000
        return events.filter((event) => coversDay(event, key, dayStart, dayEnd))
      }),
    [columns, events],
  )

  // Where the event in hand would land, once it would land somewhere new.
  const landing =
    moving && (moving.start !== moving.event.start || moving.end !== moving.event.end)
      ? { ...moving.event, start: moving.start, end: moving.end }
      : null
  const movingKey = moving ? eventKey(moving.event) : null

  // The keyboard slot: where it was left, or the start of the work day on
  // today (or the first day shown), as long as the default length.
  const step = SNAP_MINUTES
  const defaultLength = Math.min(Math.max(step, Math.ceil(prefs.defaultDuration / step) * step), DAY_MINUTES)
  const shownSlot: Slot =
    slot && columns.some((date) => date.getTime() === slot.day)
      ? slot
      : {
          day: (columns.find((date) => date.getTime() === todayMs) ?? columns[0]).getTime(),
          minute: Math.min(Math.floor(prefs.workStart / step) * step, DAY_MINUTES - defaultLength),
          length: defaultLength,
        }
  const slotColumn = Math.max(
    0,
    columns.findIndex((date) => date.getTime() === shownSlot.day),
  )
  const slotDay = columns[slotColumn]
  const slotTimes = {
    start: instantAtMinute(slotDay, shownSlot.minute),
    end: instantAtMinute(slotDay, shownSlot.minute + shownSlot.length),
  }
  const language = i18n.language.replace('_', '-')
  const slotWhen = `${slotDay.toLocaleDateString(language, { weekday: 'long', day: 'numeric', month: 'long' })}, ${formatTime(slotTimes.start)}–${formatTime(slotTimes.end)}`

  // Follows the slot down the day when the keyboard moves it.
  useEffect(() => {
    const button = slotButton.current
    if (button && document.activeElement === button) button.scrollIntoView?.({ block: 'nearest' })
  }, [shownSlot.day, shownSlot.minute, shownSlot.length])

  const createAt = (start: number, end: number) => newEvent(start, { end })
  const createAllDay = (day: Date) => newEvent(undefined, { allDay: day })

  const onSlotKey = (key: KeyboardEvent<HTMLButtonElement>) => {
    if (key.altKey || key.ctrlKey || key.metaKey) return
    const vertical = key.key === 'ArrowUp' ? -1 : key.key === 'ArrowDown' ? 1 : 0
    const across = inlineArrowStep(key.key, elementDirection(key.currentTarget))
    if (vertical !== 0) {
      if (key.shiftKey) {
        const length = Math.min(Math.max(shownSlot.length + vertical * step, step), DAY_MINUTES - shownSlot.minute)
        setSlot({ ...shownSlot, length })
      } else {
        const minute = Math.min(Math.max(shownSlot.minute + vertical * step, 0), DAY_MINUTES - shownSlot.length)
        setSlot({ ...shownSlot, minute })
      }
    } else if (across !== 0) {
      const next = columns[Math.min(Math.max(slotColumn + across, 0), columns.length - 1)]
      setSlot({ ...shownSlot, day: next.getTime() })
    } else if (key.key === 'Enter') {
      if (key.shiftKey) createAllDay(slotDay)
      else createAt(slotTimes.start, slotTimes.end)
    } else {
      return
    }
    key.preventDefault()
    key.stopPropagation()
  }

  // Dragging across an empty column selects a range and opens a new event on
  // it; a press that does not travel is a click, and the double-click behind it
  // still starts one at the hour.
  const minuteAt = (column: HTMLElement, clientY: number) =>
    Math.min(Math.max(((clientY - column.getBoundingClientRect().top) / HOUR_PX) * 60, 0), DAY_MINUTES)
  const selectDown = (date: Date) => (pointer: PointerEvent<HTMLDivElement>) => {
    if (pointer.button !== 0 || onEvent(pointer.target)) return
    const minute = minuteAt(pointer.currentTarget, pointer.clientY)
    try {
      // Keeps the range following a pointer that leaves the column.
      pointer.currentTarget.setPointerCapture(pointer.pointerId)
    } catch {
      // A pointer the browser no longer tracks: the range still follows it
      // while it stays over the column.
    }
    setSelection({
      day: date.getTime(),
      from: minute,
      to: minute,
      pointerId: pointer.pointerId,
      startY: pointer.clientY,
      active: false,
    })
  }
  const selectMove = (pointer: PointerEvent<HTMLDivElement>) => {
    const selection = selecting.current
    if (!selection || selection.pointerId !== pointer.pointerId) return
    const to = minuteAt(pointer.currentTarget, pointer.clientY)
    const active = selection.active || Math.abs(pointer.clientY - selection.startY) > SELECT_THRESHOLD_PX
    if (to !== selection.to || active !== selection.active) setSelection({ ...selection, to, active })
  }
  const selectUp = (date: Date) => (pointer: PointerEvent<HTMLDivElement>) => {
    const selection = selecting.current
    if (!selection || selection.pointerId !== pointer.pointerId) return
    setSelection(null)
    if (!selection.active) return
    const range = selectedRange(date, selection.from, minuteAt(pointer.currentTarget, pointer.clientY))
    createAt(range.start, range.end)
  }

  const hours = Array.from({ length: 24 }, (_, hour) => hour)
  const canCreate = writableCalendars(calendars).length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <span id={`${hintId}-slot`} className="sr-only">
        {t('calendar.timeSlotHint', {
          defaultValue:
            'Up and down arrows choose the time, left and right arrows the day, and Shift with the up and down arrows the length. Enter creates an event; Shift+Enter creates an all-day event; the context menu key offers both.',
        })}
      </span>
      <span id={`${hintId}-event`} className="sr-only">
        {t('calendar.moveHint', {
          defaultValue:
            'Alt with the arrow keys moves it; Alt+Shift with the up and down arrows changes when it ends. Enter saves the change; Escape cancels it.',
        })}
      </span>
      {/* Day headings, and the all-day strip beneath them. */}
      <div className="shrink-0 border-b border-border pe-3">
        <div className="grid" style={{ gridTemplateColumns: `3.5rem repeat(${columns.length}, 1fr)` }}>
          {week === null ? (
            <div />
          ) : (
            <div
              data-week-number={week}
              title={t('calendar.weekNumberTitle', { defaultValue: 'Week {week}', week })}
              className="self-center pe-2 text-end text-2xs font-semibold tabular-nums text-secondary"
            >
              {t('calendar.weekNumberShort', { defaultValue: 'W{week}', week })}
            </div>
          )}
          {columns.map((date) => (
            <button
              key={date.getTime()}
              type="button"
              data-day-heading={date.getTime()}
              data-workday={working.includes(isoWeekday(date))}
              onClick={() => {
                calendar$.anchor.set(date.getTime())
                setCalendarView('day')
              }}
              className="flex items-baseline justify-center gap-1.5 px-1 py-2 cursor-pointer transition-colors hover:bg-hover"
            >
              <span className="text-2xs font-semibold uppercase tracking-wide text-secondary">
                {date.toLocaleDateString(language, { weekday: 'short' })}
              </span>
              <span
                className={`rounded-md px-1 text-ui font-semibold tabular-nums ${
                  date.getTime() === todayMs ? 'bg-accent text-on-accent' : 'text-primary'
                }`}
              >
                {date.getDate()}
              </span>
            </button>
          ))}
          <div className="row-start-2 pb-1 pe-1 text-end text-2xs uppercase tracking-wide text-secondary/70">
            {t('calendar.allDay', { defaultValue: 'All day' })}
          </div>
          {allDayByColumn.map((dayEvents, i) => {
            const date = columns[i]
            const key = date.getTime()
            const ghost =
              landing && inStrip(landing) && coversDay(landing, key, key / 1000, nextMidnight(date)) ? landing : null
            return (
              <AllDayCell
                key={key}
                date={date}
                onMenu={(x, y) =>
                  setMenu({ x, y, start: instantAtMinute(date, Math.floor(prefs.workStart / step) * step), day: date })
                }
              >
                {dayEvents.map((event) => (
                  <AllDayChip
                    key={eventKey(event)}
                    event={event}
                    day={key}
                    color={colorOf(event)}
                    held={movingKey === eventKey(event) && landing !== null}
                    hintId={changeRefusal(event, calendars) === null ? `${hintId}-event` : undefined}
                    onEventMenu={onEventMenu}
                  />
                ))}
                {ghost && (
                  <span
                    aria-hidden
                    data-move-ghost={key}
                    className="truncate rounded border border-dashed border-accent bg-accent/15 px-1.5 py-px text-2xs font-medium text-primary"
                  >
                    {ghost.subject || t('calendar.noSubject', { defaultValue: '(no subject)' })}
                  </span>
                )}
              </AllDayCell>
            )
          })}
        </div>
      </div>

      {/* The hour grid. Every cell is placed by its column, so the keyboard
          slot can sit over any day without the days moving to make room. */}
      <div ref={scroller} data-hour-grid className="min-h-0 flex-1 select-none overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: `3.5rem repeat(${columns.length}, 1fr)` }}>
          <div className="relative" style={{ height: 24 * HOUR_PX, gridColumn: 1, gridRow: 1 }}>
            {hours.map((hour) => (
              <span
                key={hour}
                className="absolute end-2 -translate-y-1/2 text-2xs tabular-nums text-secondary/80"
                style={{ top: hour * HOUR_PX }}
              >
                {hour === 0 ? '' : `${String(hour).padStart(2, '0')}:00`}
              </span>
            ))}
          </div>
          {byColumn.map(({ date, dayStart, dayEnd, lanes }, index) => {
            const ghost = landing && !inStrip(landing) && landing.start < dayEnd && landing.end > dayStart ? landing : null
            const range =
              selection?.active && selection.day === date.getTime()
                ? selectedRange(date, selection.from, selection.to)
                : null
            return (
              <DayColumn
                key={date.getTime()}
                date={date}
                index={index}
                working={working.includes(isoWeekday(date))}
                onPointerDown={selectDown(date)}
                onPointerMove={selectMove}
                onPointerUp={selectUp(date)}
                onPointerCancel={() => setSelection(null)}
                onLostPointerCapture={() => {
                  // A release outside the window, or the browser taking the
                  // pointer back: the range is dropped, nothing is created.
                  if (selecting.current) setSelection(null)
                }}
                onDoubleClick={(mouse) => {
                  if (onEvent(mouse.target)) return
                  const hour = Math.floor(minuteAt(mouse.currentTarget, mouse.clientY) / 60)
                  newEvent(instantAtHour(date, Math.min(hour, 23)))
                }}
                onContextMenu={(mouse) => {
                  if (onEvent(mouse.target)) return
                  mouse.preventDefault()
                  const start = slotStart(date, minuteAt(mouse.currentTarget, mouse.clientY))
                  setMenu({ x: mouse.clientX, y: mouse.clientY, start, day: date })
                }}
              >
                {offHourBands(date, prefs, working).map(([from, to]) => (
                  <div
                    key={from}
                    aria-hidden
                    data-off-hours={`${from}-${to}`}
                    className="pointer-events-none absolute inset-x-0 bg-raised/70"
                    style={{ top: from * HOUR_PX, height: (to - from) * HOUR_PX }}
                  />
                ))}
                {hours.map((hour) => (
                  <div
                    key={hour}
                    className="pointer-events-none absolute inset-x-0 border-t border-border/40"
                    style={{ top: hour * HOUR_PX }}
                  />
                ))}
                {lanes.map(({ event, lane, laneCount }) => (
                  <TimedEvent
                    key={eventKey(event)}
                    event={event}
                    date={date}
                    dayStart={dayStart}
                    dayEnd={dayEnd}
                    lane={lane}
                    laneCount={laneCount}
                    color={colorOf(event)}
                    held={movingKey === eventKey(event) && landing !== null}
                    hintId={changeRefusal(event, calendars) === null ? `${hintId}-event` : undefined}
                    onEventMenu={onEventMenu}
                  />
                ))}
                {ghost && <Ghost event={ghost} date={date} />}
                {range && (
                  <div
                    aria-hidden
                    data-new-range={`${range.start}-${range.end}`}
                    className="pointer-events-none absolute inset-x-0.5 rounded-md border border-accent bg-accent/15 px-1.5 py-0.5 text-2xs tabular-nums text-primary"
                    style={{
                      top: hoursIntoDay(range.start, date) * HOUR_PX,
                      height: Math.max((hoursIntoDay(range.end, date) - hoursIntoDay(range.start, date)) * HOUR_PX, 4),
                    }}
                  >
                    {formatTime(range.start)}–{formatTime(range.end)}
                  </div>
                )}
              </DayColumn>
            )
          })}
          {/* The keyboard's way into the grid: one stop, moved with the arrow
              keys. Invisible to the pointer and drawn only while focused. */}
          <div
            className="pointer-events-none relative"
            style={{ height: 24 * HOUR_PX, gridColumn: slotColumn + 2, gridRow: 1 }}
          >
            <button
              ref={slotButton}
              type="button"
              data-time-slot={`${slotTimes.start}-${slotTimes.end}`}
              aria-label={t('calendar.timeSlot', { when: slotWhen, defaultValue: 'Time slot: {when}' })}
              aria-describedby={`${hintId}-slot`}
              onKeyDown={onSlotKey}
              onClick={() => createAt(slotTimes.start, slotTimes.end)}
              onContextMenu={(menuKey) => {
                // The menu key (or Shift+F10) on the slot: its menu, beside it.
                menuKey.preventDefault()
                menuKey.stopPropagation()
                const box = menuKey.currentTarget.getBoundingClientRect()
                setMenu({ x: startEdgeX(box), y: box.bottom, start: slotTimes.start, end: slotTimes.end, day: slotDay })
              }}
              className="absolute inset-x-0.5 rounded-md opacity-0 outline-none focus-visible:opacity-100 bg-accent/10 ring-2 ring-accent"
              style={{
                top: (shownSlot.minute / 60) * HOUR_PX,
                height: (shownSlot.length / 60) * HOUR_PX,
              }}
            />
          </div>
        </div>
      </div>

      {menu && (
        <FloatingContextMenu
          x={menu.x}
          y={menu.y}
          // Named after the day it creates on (#289).
          label={menu.day.toLocaleDateString(language, { weekday: 'long', day: 'numeric', month: 'long' })}
          onClose={() => setMenu(null)}
          overlay
          overlayClassName="fixed inset-0 z-[60]"
          className="fixed z-[61] min-w-[180px] rounded-control border border-border bg-header p-1 shadow-overlay"
        >
          <MenuItem
            icon={<Plus size={14} className="text-accent" strokeWidth={1.75} />}
            label={t('calendar.newEvent', { defaultValue: 'New event' })}
            disabled={!canCreate}
            onClick={() => {
              setMenu(null)
              newEvent(menu.start, menu.end === undefined ? {} : { end: menu.end })
            }}
          />
          <MenuItem
            icon={<CalendarDays size={14} strokeWidth={1.75} />}
            label={t('calendar.newAllDayEvent', { defaultValue: 'New all-day event' })}
            disabled={!canCreate}
            onClick={() => {
              setMenu(null)
              createAllDay(menu.day)
            }}
          />
        </FloatingContextMenu>
      )}
    </div>
  )
}

/// Local midnight after a day, as epoch seconds.
function nextMidnight(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() / 1000
}

/// Whether an event shown in the all-day strip covers a day. A true all-day
/// event covers dates, and its dates are read as dates; a long timed event is
/// still a span of instants.
function coversDay(
  event: Pick<CalendarEvent, 'all_day' | 'start' | 'end'>,
  key: number,
  dayStart: number,
  dayEnd: number,
): boolean {
  return event.all_day
    ? allDayLocalDays(event as CalendarEvent).includes(key)
    : inStrip(event) && event.start < dayEnd && event.end > dayStart
}

/// A column of the hour grid, and the drop target that stands for its day.
function DayColumn({
  date,
  index,
  working,
  children,
  ...handlers
}: {
  date: Date
  index: number
  working: boolean
  children: React.ReactNode
  onPointerDown: (pointer: PointerEvent<HTMLDivElement>) => void
  onPointerMove: (pointer: PointerEvent<HTMLDivElement>) => void
  onPointerUp: (pointer: PointerEvent<HTMLDivElement>) => void
  onPointerCancel: () => void
  onLostPointerCapture: () => void
  onDoubleClick: (mouse: React.MouseEvent<HTMLDivElement>) => void
  onContextMenu: (mouse: React.MouseEvent<HTMLDivElement>) => void
}) {
  const drop: CalendarDrop = { area: 'grid', day: date.getTime() }
  const { setNodeRef } = useDroppable({ id: `grid:${date.getTime()}`, data: drop })
  return (
    <div
      ref={setNodeRef}
      data-day-column={date.getTime()}
      data-workday={working}
      className="relative border-s border-border/60"
      style={{ height: 24 * HOUR_PX, gridColumn: index + 2, gridRow: 1 }}
      {...handlers}
    >
      {children}
    </div>
  )
}

/// A day's cell of the all-day strip, and the drop target that moves an event
/// to that day keeping its time.
function AllDayCell({
  date,
  onMenu,
  children,
}: {
  date: Date
  onMenu: (x: number, y: number) => void
  children: React.ReactNode
}) {
  const drop: CalendarDrop = { area: 'allDay', day: date.getTime() }
  const { setNodeRef, isOver } = useDroppable({ id: `allDay:${date.getTime()}`, data: drop })
  return (
    <div
      ref={setNodeRef}
      data-all-day-cell={date.getTime()}
      onContextMenu={(mouse) => {
        if (onEvent(mouse.target)) return
        mouse.preventDefault()
        onMenu(mouse.clientX, mouse.clientY)
      }}
      className={`row-start-2 flex min-h-6 min-w-0 flex-col gap-0.5 px-0.5 pb-1 ${isOver ? 'bg-accent/10' : ''}`}
    >
      {children}
    </div>
  )
}

/// The keyboard alternative to dragging an event (#266): Alt with the arrows
/// moves it a grid step or a day, Alt+Shift with the up and down arrows moves
/// its end. The event stays where it is and where it would land is drawn;
/// Enter saves it there, Escape gives it up.
function onEventKey(key: KeyboardEvent<HTMLElement>, event: CalendarEvent) {
  const moving: EventMove | null = move$.moving.peek()
  const mine = moving !== null && !moving.settled && moving.via === 'keyboard' && eventKey(moving.event) === eventKey(event)
  if (mine && key.key === 'Enter') {
    key.preventDefault()
    key.stopPropagation()
    void settleMove()
    return
  }
  if (!key.altKey || key.ctrlKey || key.metaKey) return
  const vertical = key.key === 'ArrowUp' ? -1 : key.key === 'ArrowDown' ? 1 : 0
  const across = inlineArrowStep(key.key, elementDirection(key.currentTarget))
  if (vertical === 0 && across === 0) return
  // Alt+Shift changes the end, which only the up and down arrows do.
  if (key.shiftKey && vertical === 0) return
  key.preventDefault()
  key.stopPropagation()
  if (!mine && !startMove(event, 'keyboard')) return
  const current = move$.moving.peek()
  if (!current) return
  const nudge: Nudge = key.shiftKey
    ? { edge: 'end', days: 0, steps: vertical }
    : { edge: 'move', days: across, steps: vertical }
  previewMove(nudgedTimes(event, current, nudge))
}

/// An event in the hour grid: dragged by its body to move it and by its top
/// or bottom edge to change when it starts or ends. Only the edges that fall
/// in this column can be held.
function TimedEvent({
  event,
  date,
  dayStart,
  dayEnd,
  lane,
  laneCount,
  color,
  held,
  hintId,
  onEventMenu,
}: {
  event: CalendarEvent
  date: Date
  dayStart: number
  dayEnd: number
  lane: number
  laneCount: number
  color: string
  held: boolean
  hintId: string | undefined
  onEventMenu: (x: number, y: number, event: CalendarEvent) => void
}) {
  const { t } = useTranslation()
  const key = eventKey(event)
  const drag: CalendarDrag = { edge: 'move', event, day: date.getTime(), origin: 'grid' }
  const { setNodeRef, listeners } = useDraggable({ id: `move:${key}:${date.getTime()}`, data: drag })
  const top = hoursIntoDay(event.start, date) * HOUR_PX
  const bottom = hoursIntoDay(event.end, date) * HOUR_PX
  return (
    <button
      ref={setNodeRef}
      type="button"
      data-calendar-event={key}
      aria-describedby={hintId}
      {...listeners}
      onClick={() => {
        if (!clickFollowsDrop(event)) openEvent(event)
      }}
      onKeyDown={(press) => onEventKey(press, event)}
      onContextMenu={(mouse) => {
        mouse.preventDefault()
        onEventMenu(mouse.clientX, mouse.clientY, event)
      }}
      className={`absolute overflow-hidden rounded-md border-s-2 px-1.5 py-0.5 text-start text-2xs leading-tight transition-opacity hover:opacity-90 cursor-pointer ${
        event.is_cancelled ? 'line-through opacity-55' : ''
      } ${held ? 'opacity-40' : ''}`}
      style={{
        top,
        height: Math.max(bottom - top, 20),
        insetInlineStart: `calc(${(lane / laneCount) * 100}% + 2px)`,
        width: `calc(${100 / laneCount}% - 4px)`,
        backgroundColor: `${color}26`,
        borderInlineStartColor: color,
      }}
    >
      {event.start >= dayStart && <EdgeHandle edge="start" event={event} date={date} />}
      <span dir="auto" className="block truncate font-medium text-primary">
        {event.subject || t('calendar.noSubject', { defaultValue: '(no subject)' })}
      </span>
      <span className="block truncate tabular-nums text-secondary">
        {formatTime(event.start)}–{formatTime(event.end)}
      </span>
      {event.end <= dayEnd && <EdgeHandle edge="end" event={event} date={date} />}
    </button>
  )
}

/// The top or bottom edge of an event, held to resize it. Pointer only: the
/// keyboard changes the end with Alt+Shift and the arrows.
function EdgeHandle({ edge, event, date }: { edge: Exclude<DragEdge, 'move'>; event: CalendarEvent; date: Date }) {
  const drag: CalendarDrag = { edge, event, day: date.getTime(), origin: 'grid' }
  const { setNodeRef, listeners } = useDraggable({ id: `${edge}:${eventKey(event)}`, data: drag })
  return (
    <span
      ref={setNodeRef}
      aria-hidden
      data-resize-edge={edge}
      {...listeners}
      className={`absolute inset-x-0 block h-1.5 cursor-ns-resize ${edge === 'start' ? 'top-0' : 'bottom-0'}`}
    />
  )
}

/// An event in the all-day strip: dragged to another day, or onto the mini
/// calendar, it moves by whole days.
function AllDayChip({
  event,
  day,
  color,
  held,
  hintId,
  onEventMenu,
}: {
  event: CalendarEvent
  day: number
  color: string
  held: boolean
  hintId: string | undefined
  onEventMenu: (x: number, y: number, event: CalendarEvent) => void
}) {
  const { t } = useTranslation()
  const key = eventKey(event)
  const drag: CalendarDrag = { edge: 'move', event, day, origin: 'allDay' }
  const { setNodeRef, listeners } = useDraggable({ id: `move:${key}:${day}`, data: drag })
  return (
    <button
      ref={setNodeRef}
      type="button"
      data-calendar-event={key}
      aria-describedby={hintId}
      {...listeners}
      onClick={() => {
        if (!clickFollowsDrop(event)) openEvent(event)
      }}
      onKeyDown={(press) => onEventKey(press, event)}
      onContextMenu={(mouse) => {
        mouse.preventDefault()
        onEventMenu(mouse.clientX, mouse.clientY, event)
      }}
      dir="auto"
      className={`truncate rounded px-1.5 py-px text-2xs font-medium text-white cursor-pointer hover:opacity-90 ${
        held ? 'opacity-40' : ''
      }`}
      style={{ backgroundColor: color }}
    >
      {event.subject || t('calendar.noSubject', { defaultValue: '(no subject)' })}
    </button>
  )
}

/// Where the event in hand would land in this column.
function Ghost({ event, date }: { event: CalendarEvent; date: Date }) {
  const { t } = useTranslation()
  const top = hoursIntoDay(event.start, date) * HOUR_PX
  const bottom = hoursIntoDay(event.end, date) * HOUR_PX
  return (
    <div
      aria-hidden
      data-move-ghost={`${event.start}-${event.end}`}
      className="pointer-events-none absolute inset-x-0.5 overflow-hidden rounded-md border border-dashed border-accent bg-accent/15 px-1.5 py-0.5 text-2xs leading-tight"
      style={{ top, height: Math.max(bottom - top, 20) }}
    >
      <span dir="auto" className="block truncate font-medium text-primary">
        {event.subject || t('calendar.noSubject', { defaultValue: '(no subject)' })}
      </span>
      <span className="block truncate tabular-nums text-secondary">
        {formatTime(event.start)}–{formatTime(event.end)}
      </span>
    </div>
  )
}

/// Assigns overlapping events to side-by-side lanes, greedily: each event
/// takes the first lane free at its start. Events in one overlap cluster share
/// the column width evenly.
function placeInLanes(events: CalendarEvent[]): { event: CalendarEvent; lane: number; laneCount: number }[] {
  const sorted = [...events].sort((a, b) => a.start - b.start || b.end - a.end)
  const placed: { event: CalendarEvent; lane: number; laneCount: number }[] = []
  let cluster: { event: CalendarEvent; lane: number; laneCount: number }[] = []
  let laneEnds: number[] = []
  let clusterEnd = -Infinity

  const closeCluster = () => {
    for (const entry of cluster) entry.laneCount = laneEnds.length
    placed.push(...cluster)
    cluster = []
    laneEnds = []
  }

  for (const event of sorted) {
    if (cluster.length > 0 && event.start >= clusterEnd) closeCluster()
    let lane = laneEnds.findIndex((end) => end <= event.start)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(event.end)
    } else {
      laneEnds[lane] = event.end
    }
    cluster.push({ event, lane, laneCount: 0 })
    clusterEnd = Math.max(clusterEnd, event.end)
  }
  closeCluster()
  return placed
}
