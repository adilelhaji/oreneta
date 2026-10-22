import { useEffect, useState } from 'react'
import { useValue } from '@legendapp/state/react'
import {
  BriefcaseBusiness,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import i18n, { useTranslation } from '../../lib/i18n'
import {
  calendar$,
  calendarAccountLabel,
  calendarSyncErrorText,
  loadCalendars,
  loadCurrentView,
  navigateCalendar,
  newEvent,
  setCalendarView,
  startOfWeek,
  workDays,
  type CalendarEvent,
  type CalendarViewMode,
  retrySync,
} from '../../states/calendar'
import { AgendaList } from './AgendaView'
import { MonthView } from './MonthView'
import { WeekView } from './WeekView'
import { EventEditor } from './EventEditor'
import { EventDetails } from './EventDetails'
import { CalendarList } from './CalendarList'
import { CalendarDnd } from './CalendarDnd'
import { MiniCalendar } from './MiniCalendar'
import { MoveQuestions, MoveStatus } from './MoveQuestions'
import { CompactNavigation } from '../sidenav/CompactNavigation'
import { FOLDER_PANE_MIN_WINDOW, FolderPane } from '../shell/FolderPane'
import { useWideWindow } from '../resizer/useElementWidth'
import { useFolderPaneFocus } from '../shell/folderPaneFocus'
import { EventContextMenu, type EventContextMenuState } from './EventContextMenu'
import { settings$ } from '../../states/settings'
import { accounts$ } from '../../states/accounts'
import { isoWeekday } from '../../lib/calendarWeek'

/// The calendar surface: one header — period, navigation, view switcher — over
/// whichever view is chosen. The editor and the context menu live here so
/// every view gets them for free.
///
/// Its calendars and month at a glance are the "folders" region. From 1025 px
/// they are the common folder pane, beside the whole module: the list is its
/// body and the month its footer (ADR-0068 §4), at the width every module
/// shares. Below that the pane is not drawn, and they keep their column
/// beside the views, as before.
export function CalendarView() {
  const { t } = useTranslation()
  const view = useValue(calendar$.view)
  const anchor = useValue(calendar$.anchor)
  const loading = useValue(calendar$.loading)
  // Only for accounts still here: a removed account never syncs again to
  // clear its notice. Re-read so a notice names its account by its address.
  const accountIds = new Set(useValue(accounts$).map((account) => account.id))
  const syncErrors = Object.entries(useValue(calendar$.syncErrors)).filter(([id]) => accountIds.has(id))
  // Read so the header follows a change of the week's first day or work week.
  useValue(settings$.calendarWeekStart)
  const calendarPrefs = useValue(settings$.calendar)
  const [menu, setMenu] = useState<EventContextMenuState | null>(null)
  const inPane = useWideWindow(FOLDER_PANE_MIN_WINDOW)
  useFolderPaneFocus(inPane)
  const calendarsName = t('calendar.calendars')

  useEffect(() => {
    void loadCalendars()
    void loadCurrentView()
  }, [])

  const onEventMenu = (x: number, y: number, event: CalendarEvent) => setMenu({ x, y, event })

  const views: { mode: CalendarViewMode; label: string }[] = [
    { mode: 'agenda', label: t('calendar.viewAgenda', { defaultValue: 'Agenda' }) },
    { mode: 'day', label: t('calendar.viewDay', { defaultValue: 'Day' }) },
    { mode: 'week', label: t('calendar.viewWeek', { defaultValue: 'Week' }) },
    { mode: 'month', label: t('calendar.viewMonth', { defaultValue: 'Month' }) },
  ]

  return (
    // One drag and drop for the views and the mini calendar, in the pane or in
    // the column, so an event held in the week can be dropped on a day of
    // another month.
    <CalendarDnd>
      {inPane && (
        <FolderPane title={calendarsName} footer={<MiniCalendar inFooter />}>
          {/* The list fills the pane's body, as it filled the column: the
              colour menu of its last calendar opens over that room instead
              of scrolling the list. */}
          <div className="flex h-full flex-col">
            <CalendarList />
          </div>
        </FolderPane>
      )}
      <div data-region="content" className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
        <EventEditor />
        <EventDetails />
        {menu && <EventContextMenu state={menu} onClose={() => setMenu(null)} />}
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-header px-4 py-3">
          <CompactNavigation />
          <CalendarDays size={20} className="shrink-0 text-accent-fg" strokeWidth={1.75} />
          <h1 className="min-w-0 wrap-anywhere text-heading-sm font-bold text-primary">
            {periodLabel(view, anchor, t)}
          </h1>
          {loading && <RefreshCw size={14} className="shrink-0 animate-spin text-secondary" strokeWidth={1.75} />}

          <div className="ms-auto flex min-w-0 max-w-full flex-wrap items-center gap-2">
            {view !== 'agenda' && (
              <div className="flex items-center gap-0.5">
                <NavButton label={t('calendar.previousPeriod')} onClick={() => navigateCalendar(-1)}>
                  <ChevronLeft size={14} strokeWidth={1.75} />
                </NavButton>
                <button
                  type="button"
                  onClick={() => navigateCalendar(0)}
                  className="rounded-control-sm px-2 py-1 text-caption font-medium text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
                >
                  {t('calendar.today', { defaultValue: 'Today' })}
                </button>
                <NavButton label={t('calendar.nextPeriod')} onClick={() => navigateCalendar(1)}>
                  <ChevronRight size={14} strokeWidth={1.75} />
                </NavButton>
              </div>
            )}

            {view === 'week' && (
              <button
                type="button"
                aria-pressed={calendarPrefs.workWeekOnly}
                onClick={() => settings$.calendar.set({ ...calendarPrefs, workWeekOnly: !calendarPrefs.workWeekOnly })}
                title={t('calendar.workWeekHint', { defaultValue: 'Show only the working days of the week' })}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-control-sm px-2.5 py-1 text-caption font-medium transition-colors cursor-pointer ${
                  calendarPrefs.workWeekOnly
                    ? 'bg-active text-accent-fg ring-1 ring-accent/30'
                    : 'text-secondary hover:bg-hover hover:text-primary'
                }`}
              >
                <BriefcaseBusiness size={14} strokeWidth={1.75} />
                {t('calendar.workWeek', { defaultValue: 'Work week' })}
              </button>
            )}

            <div className="flex max-w-full flex-wrap items-center gap-0.5 rounded-control border border-border bg-raised p-0.5">
              {views.map(({ mode, label }) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={view === mode}
                  onClick={() => setCalendarView(mode)}
                  className={`min-h-8 rounded-control-sm px-2.5 py-1 text-caption font-medium transition-colors cursor-pointer ${
                    view === mode
                      ? 'bg-chats text-primary shadow-sm ring-1 ring-border/80'
                      : 'text-secondary hover:text-primary'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => newEvent()}
              aria-label={t('calendar.newEvent', { defaultValue: 'New event' })}
              className="inline-flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-caption font-semibold text-on-accent transition-opacity hover:opacity-90 cursor-pointer"
            >
              <Plus size={14} strokeWidth={1.75} />
              <span>{t('calendar.newEvent', { defaultValue: 'New event' })}</span>
            </button>
          </div>
        </header>

        {/* A refresh that failed. Said where the agenda is, because what is
            wrong is the agenda: it still shows what it last knew, which looks
            exactly like being current. One line per account, naming it and,
            when the core knows it, the cause (#244). */}
        {syncErrors.length > 0 && (
          <div
            role="status"
            className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/30 bg-warning-soft px-4 py-2"
          >
            <TriangleAlert size={14} className="shrink-0 text-warning" strokeWidth={1.75} />
            <div className="min-w-0 flex-1 basis-40">
              {syncErrors.map(([accountId, error]) => (
                <p
                  key={accountId}
                  data-sync-error={error.reason}
                  title={error.message}
                  className="wrap-anywhere text-caption text-warning"
                >
                  {calendarSyncErrorText(error, calendarAccountLabel(accountId))}
                </p>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void retrySync()}
              className="shrink-0 rounded-control-sm px-2 py-1 text-caption font-semibold text-accent-fg transition-colors hover:bg-accent/10 cursor-pointer"
            >
              {t('calendar.retry', { defaultValue: 'Try again' })}
            </button>
          </div>
        )}

        <div className="relative shrink-0">
          <MoveStatus />
        </div>
        <MoveQuestions />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col min-[769px]:flex-row">
          {!inPane && (
            <nav
              data-region="folders"
              // The column stands in for the pane below 1025 px: focus goes back here (#341).
              data-focus-return
              aria-label={calendarsName}
              className="flex shrink-0 flex-col border-border bg-raised min-[769px]:w-48 min-[769px]:border-e"
            >
              <MiniCalendar />
              <CalendarList />
            </nav>
          )}
          {view === 'agenda' && <AgendaList onEventMenu={onEventMenu} />}
          {view === 'month' && <MonthView onEventMenu={onEventMenu} />}
          {view === 'week' && <WeekView days={7} onEventMenu={onEventMenu} />}
          {view === 'day' && <WeekView days={1} onEventMenu={onEventMenu} />}
        </div>
      </div>
    </CalendarDnd>
  )
}

function NavButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
    >
      {children}
    </button>
  )
}

/// What the header calls the period on screen.
function periodLabel(view: CalendarViewMode, anchorMs: number, t: ReturnType<typeof useTranslation>['t']): string {
  const anchor = new Date(anchorMs)
  if (view === 'month') {
    const label = anchor.toLocaleDateString(i18n.language.replace('_', '-'), { month: 'long', year: 'numeric' })
    return label.charAt(0).toUpperCase() + label.slice(1)
  }
  if (view === 'week') {
    const weekFirst = startOfWeek(anchor)
    let shown = Array.from(
      { length: 7 },
      (_, i) => new Date(weekFirst.getFullYear(), weekFirst.getMonth(), weekFirst.getDate() + i),
    )
    if (settings$.calendar.peek().workWeekOnly) {
      const working = workDays()
      const kept = shown.filter((date) => working.includes(isoWeekday(date)))
      if (kept.length > 0) shown = kept
    }
    // The first and last day on screen, whichever weekdays those are.
    const firstShown = shown[0]
    const lastShown = shown[shown.length - 1]
    const sameMonth = firstShown.getMonth() === lastShown.getMonth()
    const from = firstShown.toLocaleDateString(i18n.language.replace('_', '-'), {
      day: 'numeric',
      month: sameMonth ? undefined : 'short',
    })
    const to = lastShown.toLocaleDateString(i18n.language.replace('_', '-'), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
    return `${from} – ${to}`
  }
  if (view === 'day') {
    const label = anchor.toLocaleDateString(i18n.language.replace('_', '-'), {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
    return label.charAt(0).toUpperCase() + label.slice(1)
  }
  return t('calendar.title', { defaultValue: 'Calendar' })
}
