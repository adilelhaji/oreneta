import { useEffect, useMemo, useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { useDroppable } from '@dnd-kit/core'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import i18n, { useTranslation } from '../../lib/i18n'
import {
  calendar$,
  firstDayOfWeek,
  loadCurrentView,
  setCalendarView,
  startOfDay,
  startOfWeek,
} from '../../states/calendar'
import { settings$ } from '../../states/settings'
import type { CalendarDrop } from '../../states/calendarMove'

/// A month at a glance beside the calendar (#266): a day opens it in the view
/// on screen, and an event dragged onto a day moves there keeping its time.
/// It follows the day the calendar is on, and can be paged on its own.
///
/// From 1025 px it is the footer of the common folder pane, which draws the
/// divider above it (`inFooter`); below that, it heads the column beside the
/// views and draws its own divider under it (ADR-0068 §4).
export function MiniCalendar({ inFooter = false }: { inFooter?: boolean }) {
  const { t } = useTranslation()
  const anchorMs = useValue(calendar$.anchor)
  const view = useValue(calendar$.view)
  const weekStart = useValue(settings$.calendarWeekStart)
  const anchor = new Date(anchorMs)
  const [month, setMonth] = useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1).getTime())

  // Back to the calendar's month whenever the calendar moves.
  useEffect(() => {
    const at = new Date(anchorMs)
    setMonth(new Date(at.getFullYear(), at.getMonth(), 1).getTime())
  }, [anchorMs])

  const shown = new Date(month)
  const firstDay = firstDayOfWeek(weekStart)
  const gridStart = startOfWeek(shown, firstDay)
  const days = useMemo(
    () =>
      Array.from(
        { length: 42 },
        (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i),
      ),
    [gridStart.getTime()],
  )
  const language = i18n.language.replace('_', '-')
  const todayMs = startOfDay(new Date()).getTime()
  const page = (step: -1 | 1) => setMonth(new Date(shown.getFullYear(), shown.getMonth() + step, 1).getTime())

  const open = (date: Date) => {
    calendar$.anchor.set(date.getTime())
    // The agenda has no day to show; the day view does.
    if (view === 'agenda') setCalendarView('day')
    else void loadCurrentView()
  }

  return (
    <nav
      aria-label={t('calendar.miniCalendar', { defaultValue: 'Month at a glance' })}
      data-mini-calendar
      className={`hidden shrink-0 px-2 pb-2 pt-3 min-[769px]:block ${inFooter ? '' : 'border-b border-border'}`}
    >
      <div className="mb-1 flex items-center gap-1 px-1">
        <p className="min-w-0 flex-1 truncate text-caption font-semibold text-primary">
          {shown.toLocaleDateString(language, { month: 'long', year: 'numeric' })}
        </p>
        <button
          type="button"
          onClick={() => page(-1)}
          aria-label={t('calendar.previousMonth', { defaultValue: 'Previous month' })}
          className="flex h-6 w-6 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
        >
          <ChevronLeft size={14} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={() => page(1)}
          aria-label={t('calendar.nextMonth', { defaultValue: 'Next month' })}
          className="flex h-6 w-6 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
        >
          <ChevronRight size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center">
        {days.slice(0, 7).map((date) => (
          <span key={`name-${date.getDay()}`} aria-hidden className="text-2xs font-semibold text-secondary">
            {date.toLocaleDateString(language, { weekday: 'narrow' })}
          </span>
        ))}
        {days.map((date) => (
          <MiniDay
            key={date.getTime()}
            date={date}
            label={date.toLocaleDateString(language, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
            inMonth={date.getMonth() === shown.getMonth()}
            today={date.getTime() === todayMs}
            selected={date.getTime() === startOfDay(anchor).getTime()}
            onOpen={open}
          />
        ))}
      </div>
    </nav>
  )
}

function MiniDay({
  date,
  label,
  inMonth,
  today,
  selected,
  onOpen,
}: {
  date: Date
  label: string
  inMonth: boolean
  today: boolean
  selected: boolean
  onOpen: (date: Date) => void
}) {
  const drop: CalendarDrop = { area: 'mini', day: date.getTime() }
  const { setNodeRef, isOver } = useDroppable({ id: `mini:${date.getTime()}`, data: drop })
  return (
    <button
      ref={setNodeRef}
      type="button"
      data-mini-day={date.getTime()}
      aria-label={label}
      aria-current={today ? 'date' : undefined}
      aria-pressed={selected}
      onClick={() => onOpen(date)}
      // At most 1.5 rem, as before, and no wider than its seventh of the
      // month: the folder pane is in px, so at the app's 200 % the days
      // shrink to fit it instead of running past its edge (ADR-0068 §7).
      className={`mx-auto flex aspect-square w-full max-w-6 items-center justify-center rounded-full text-2xs tabular-nums transition-colors cursor-pointer ${
        isOver
          ? 'bg-accent text-on-accent ring-2 ring-accent/40'
          : today
            ? 'bg-accent text-on-accent font-semibold'
            : selected
              ? 'font-semibold text-primary ring-1 ring-accent'
              : inMonth
                ? 'text-primary hover:bg-hover'
                : 'text-secondary hover:bg-hover'
      }`}
    >
      {date.getDate()}
    </button>
  )
}
