import { Fragment, useEffect, useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { intlLocale, useTranslation } from '../../lib/i18n'
import { answerLabel, meetingAnswer } from '../../lib/calendarInvitation'
import { buildDay, dayOf, dayQueryWindow, shiftDay, startingDay, type DayItem } from '../../lib/dayPanel'
import { accounts$ } from '../../states/accounts'
import { calendar$, calendarAccountLabel, eventColor, loadCalendars, type CalendarEvent } from '../../states/calendar'
import { ui$ } from '../../states/ui'
import { Button } from '../button/Button'
import { IconButton } from '../button/IconButton'
import { openSidebarEvent, readCalendarEvents, useSidebarCalendarReading } from './sidebarCalendar'

type DayReading = { day: number; events: CalendarEvent[]; incomplete: boolean }

/**
 * Reads one day: every account's enabled calendars, as the agenda reads its
 * week (sidebarCalendar), over the day and one more on each side for all-day
 * dates stored at midnight UTC. A calendar that cannot be read is said.
 */
export async function readDay(day: number, refresh: boolean): Promise<DayReading> {
  const { from, to } = dayQueryWindow(day)
  const { events, incomplete } = await readCalendarEvents(from, to, refresh)
  return { day, events, incomplete }
}

/**
 * The sidebar's Dia panel (ADR-0069 §3): one day of the enabled calendars of
 * every account, all-day events on top and the rest by start, today's time as
 * a line. It opens on the day selected in Calendar, or today elsewhere, and
 * does not follow the calendar after that; previous day, next day and Today
 * move it, and so does midnight while it shows today. What could not be read
 * is said, and «No events» only after every
 * read went well. Each event is a native button named in full (title, time,
 * calendar and the reader's answer), opening it in the calendar on this day.
 */
export function SidebarDay({ now = () => Date.now() }: { now?: () => number }) {
  const { t } = useTranslation()
  // Taken once, as the panel opens (owner decision 3 of ADR-0069).
  const [day, setDay] = useState(() => startingDay(ui$.module.peek() === 'calendar', calendar$.anchor.peek(), now()))
  const calendars = useValue(calendar$.calendars)
  const accounts = useValue(accounts$)
  // The cache of the day, refreshed behind it, read again when a sync lands,
  // at midnight and for each day moved to; a refresh that failed marks it out
  // of date until a sync of that account covers the day (sidebarCalendar).
  const { answer, failed, stale } = useSidebarCalendarReading((refresh) => readDay(day, refresh), {
    now,
    covering: () => dayQueryWindow(day),
    key: day,
  })

  // The calendars' names, which the events' names say.
  useEffect(() => {
    if (calendar$.calendars.peek().length === 0) void loadCalendars()
  }, [])

  // On today, the line of the current time moves with the minutes, and at
  // midnight the panel moves on to the new today. Another day stays shown.
  const today = dayOf(now())
  const [, tick] = useState(0)
  useEffect(() => {
    if (day !== today) return
    let timer: ReturnType<typeof setTimeout>
    const next = () => {
      timer = setTimeout(
        () => {
          const current = dayOf(now())
          if (current !== day) return setDay(current)
          tick((count) => count + 1)
          next()
        },
        60_000 - (now() % 60_000) + 50,
      )
    }
    next()
    return () => clearTimeout(timer)
    // `now` is a clock, not an input.
  }, [day, today])

  const time = (seconds: number) =>
    new Date(seconds * 1000).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })
  // An end of the meeting on another day says which.
  const dated = (seconds: number) =>
    new Date(seconds * 1000).toLocaleString(intlLocale(), {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  const when = (item: DayItem) =>
    item.allDay
      ? t('calendar.allDay')
      : `${item.startsBefore ? dated(item.event.start) : time(item.event.start)}–${
          item.endsAfter ? dated(item.event.end) : time(item.event.end)
        }`
  const calendarName = (event: CalendarEvent) =>
    calendars.find((calendar) => calendar.accountId === event.accountId && calendar.id === event.calendar_id)?.name ||
    calendarAccountLabel(event.accountId)
  const state = (event: CalendarEvent) => {
    const reply = meetingAnswer(
      event,
      accounts.find((account) => account.id === event.accountId),
    )
    return reply ? answerLabel(reply) : ''
  }

  const date = new Date(day).toLocaleDateString(intlLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(new Date(day).getFullYear() !== new Date(today).getFullYear() ? { year: 'numeric' } : {}),
  })
  const heading = day === today ? `${t('calendar.today')} · ${date}` : date

  const reading = answer?.day === day ? answer : null
  const content = reading ? buildDay(reading.events, day, now()) : null
  const nowLabel = t('sidebar.dayNow', { time: time(now() / 1000) })
  // «No events» only when every read went well: no calendar left unread, and
  // no refresh that failed.
  const complete = reading !== null && !reading.incomplete && stale.size === 0
  const notice = 'mx-4 mt-3 rounded-control-sm bg-warning-soft px-3 py-2 text-caption text-primary'
  const row = 'flex w-full items-center gap-2 px-4 py-1.5 text-start text-caption hover:bg-hover cursor-pointer'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border py-1 ps-4 pe-2">
        {/* Said again when the day moves, for a reader who stays on the buttons. */}
        <h3
          aria-live="polite"
          className="min-w-0 flex-1 truncate text-caption font-semibold text-primary first-letter:uppercase"
        >
          {heading}
        </h3>
        <IconButton
          icon={ChevronLeft}
          size="sm"
          radius="lg"
          label={t('sidebar.dayPrevious')}
          onClick={() => setDay((shown) => shiftDay(shown, -1))}
        />
        <Button variant="ghost" size="sm" onClick={() => setDay(dayOf(now()))}>
          {t('calendar.today')}
        </Button>
        <IconButton
          icon={ChevronRight}
          size="sm"
          radius="lg"
          label={t('sidebar.dayNext')}
          onClick={() => setDay((shown) => shiftDay(shown, 1))}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {!content ? (
          failed ? (
            <p role="alert" className="p-4 text-caption text-danger">
              {t('sidebar.dayFailed')}
            </p>
          ) : (
            <div className="flex justify-center p-6">
              <Loader2
                size={18}
                className="animate-spin text-secondary"
                strokeWidth={1.75}
                aria-label={t('common.loading')}
              />
            </div>
          )
        ) : (
          <>
            {stale.size > 0 && (
              <p role="status" className={notice}>
                {t('calendar.staleWarning')}
              </p>
            )}
            {reading!.incomplete && (
              <p role="status" className={notice}>
                {t('sidebar.dayIncomplete')}
              </p>
            )}
            {content.items.length === 0 && complete && (
              <p className="px-4 py-3 text-caption text-secondary">{t('sidebar.dayEmpty')}</p>
            )}
            {(content.items.length > 0 || content.now !== null) && (
              <ul className="pt-1">
                {content.items.map((item, index) => {
                  const title = item.event.subject || t('calendar.noSubject')
                  const at = when(item)
                  const calendar = calendarName(item.event)
                  const answered = state(item.event)
                  return (
                    <Fragment key={item.key}>
                      {content.now === index && <NowLine label={nowLabel} />}
                      <li>
                        <button
                          type="button"
                          // Its full name, as the calendar's grid gives one: what,
                          // when, in which calendar, and the reader's answer.
                          aria-label={
                            answered
                              ? t('sidebar.dayEventNameState', { title, time: at, calendar, state: answered })
                              : t('sidebar.dayEventName', { title, time: at, calendar })
                          }
                          className={row}
                          onClick={() => openSidebarEvent(item.event, day)}
                        >
                          <span
                            aria-hidden="true"
                            className="h-8 w-1 shrink-0 rounded-full"
                            style={{ backgroundColor: eventColor(item.event, calendars) }}
                          />
                          <span className="min-w-0 flex-1">
                            <bdi className="block truncate text-primary">{title}</bdi>
                            <span className="block truncate text-2xs text-secondary">
                              {answered ? `${calendar} · ${answered}` : calendar}
                            </span>
                          </span>
                          <span className="shrink-0 tabular-nums text-secondary">{at}</span>
                        </button>
                      </li>
                    </Fragment>
                  )
                })}
                {content.now === content.items.length && <NowLine label={nowLabel} />}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Today's time, as a line between what has begun and what has not. */
function NowLine({ label }: { label: string }) {
  return (
    <li data-now-line className="flex items-center gap-2 px-4 py-1">
      <span className="shrink-0 text-2xs font-semibold tabular-nums text-accent-fg">{label}</span>
      <span aria-hidden="true" className="h-0.5 min-w-0 flex-1 rounded-full bg-accent-fg" />
    </li>
  )
}
