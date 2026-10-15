import { useEffect, useState } from 'react'
import { CalendarDays, ListTodo, Loader2 } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { agendaQueryWindow, buildAgenda, type AgendaGroup, type AgendaItem } from '../../lib/agenda'
import { accounts$ } from '../../states/accounts'
import {
  allDayLocalDays,
  isFeedAccount,
  openCalendarOn,
  openEvent,
  startOfDay,
  type CalendarEvent,
} from '../../states/calendar'
import { tasks$, type Task } from '../../states/tasks'
import { ui$ } from '../../states/ui'

type Agenda = { groups: AgendaGroup[]; incomplete: boolean }

/**
 * Reads the coming week: every account's enabled calendars (the core leaves
 * out disabled ones) and every open task. A source that cannot be read is
 * said, never shown as an empty day.
 */
export async function readAgenda(now: number, refresh: boolean): Promise<Agenda> {
  const { from, to } = agendaQueryWindow(now)
  let incomplete = false
  const accounts = accounts$.peek().filter((account) => !isFeedAccount(account.id))
  const [perAccount, tasks] = await Promise.all([
    Promise.all(
      accounts.map(async (account) => {
        try {
          const res = await invoke<{ events?: CalendarEvent[] }>('calendar.events', {
            account_id: account.id,
            from,
            to,
            refresh,
          })
          return (res?.events ?? []).map((event) => ({ ...event, accountId: account.id }))
        } catch {
          incomplete = true
          return [] as CalendarEvent[]
        }
      }),
    ),
    invoke<{ tasks?: Task[] }>('tasks.list', { include_completed: false }).then(
      (res) => res?.tasks ?? [],
      () => {
        incomplete = true
        return [] as Task[]
      },
    ),
  ])
  return { groups: buildAgenda(perAccount.flat(), tasks, now), incomplete }
}

/**
 * Opens an event where it lives: its day in the calendar, with the event
 * open. An all-day event's day is its date, not the instant it is stored at.
 */
function openAgendaEvent(event: CalendarEvent) {
  openCalendarOn(event.all_day ? new Date(allDayLocalDays(event)[0]) : new Date(event.start * 1000))
  openEvent(event)
}

/** Milliseconds from `now` to just after the next local midnight. */
export function untilNextDay(now: number): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() - now + 50
}

/** Opens a task itself, in its editor, over whatever is on screen. */
function openAgendaTask(task: Task) {
  ui$.taskEditor.set({
    threadId: task.linked === false ? '' : task.thread_id,
    id: task.id,
    dueAt: task.due_at,
    note: task.note,
  })
}

/**
 * The sidebar's agenda (#212, ADR-0059): upcoming events and due tasks for
 * the next seven days, overdue tasks first, each opening the item itself.
 */
export function SidebarAgenda({ now = () => Date.now() }: { now?: () => number }) {
  const { t } = useTranslation()
  const [agenda, setAgenda] = useState<Agenda | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let current = true
    let latest = 0
    const read = (refresh: boolean) => {
      // Only the newest read lands: an older, slower answer never replaces it.
      const ticket = ++latest
      return readAgenda(now(), refresh).then(
        (answer) => {
          if (!current || ticket !== latest) return
          setFailed(false)
          setAgenda(answer)
        },
        () => current && ticket === latest && setFailed(true),
      )
    }
    void read(true)
    // A calendar refresh behind the first read lands later; read the cache
    // again then, as the calendar view does.
    const eventsOn = (window as any).runtime?.EventsOn
    const off = eventsOn?.('calendar.synced', () => void read(false))
    // A task edited or completed from here, or anywhere else, changes the list.
    const offEditor = ui$.taskEditor.onChange(({ value }) => {
      if (value === null) void read(false)
    })
    const offTasks = tasks$.items.onChange(() => void read(false))
    // Today and Tomorrow move at midnight, and what was overdue with them.
    let timer: ReturnType<typeof setTimeout>
    const atMidnight = () => {
      timer = setTimeout(() => {
        void read(false)
        atMidnight()
      }, untilNextDay(now()))
    }
    atMidnight()
    return () => {
      current = false
      if (typeof off === 'function') off()
      offEditor()
      offTasks()
      clearTimeout(timer)
    }
    // `now` is a clock, not an input: reading again on every render would loop.
  }, [])

  if (failed && !agenda)
    return (
      <p role="alert" className="p-4 text-caption text-danger">
        {t('sidebar.agendaFailed')}
      </p>
    )
  if (!agenda)
    return (
      <div className="flex justify-center p-6">
        <Loader2 size={18} className="animate-spin text-secondary" strokeWidth={1.75} aria-label={t('common.loading')} />
      </div>
    )

  const today = startOfDay(new Date(now())).getTime()
  const tomorrow = startOfDay(new Date(today + 36 * 3_600_000)).getTime()
  const heading = (key: AgendaGroup['key']) =>
    key === 'overdue'
      ? t('tasks.due.overdue')
      : key === today
        ? t('calendar.today')
        : key === tomorrow
          ? t('sidebar.agendaTomorrow')
          : new Date(key).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  const time = (seconds: number) =>
    new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const section = 'px-4 pt-3 pb-1 text-2xs font-semibold uppercase tracking-wide text-secondary'
  const row = 'flex w-full items-center gap-2 px-4 py-1.5 text-left text-caption hover:bg-hover cursor-pointer'

  const label = (item: AgendaItem) =>
    item.kind === 'task'
      ? t('sidebar.agendaTask')
      : item.allDay
        ? t('calendar.allDay')
        : // An event under way since an earlier day shows the day it began.
          item.at * 1000 < today
          ? new Date(item.at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
          : time(item.at)

  return (
    <div className="pb-3">
      {agenda.incomplete && (
        <p role="status" className="mx-4 mt-3 rounded-control-sm bg-warning-soft px-3 py-2 text-caption text-primary">
          {t('sidebar.agendaIncomplete')}
        </p>
      )}
      {agenda.groups.length === 0 ? (
        <p className="px-4 py-3 text-caption text-secondary">{t('sidebar.agendaEmpty')}</p>
      ) : (
        agenda.groups.map((group) => (
          <section key={String(group.key)} aria-labelledby={`agenda-${group.key}`}>
            <h4 id={`agenda-${group.key}`} className={section}>
              {heading(group.key)}
            </h4>
            <ul>
              {group.items.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    className={row}
                    onClick={() => (item.kind === 'event' ? openAgendaEvent(item.event) : openAgendaTask(item.task))}
                  >
                    {item.kind === 'event' ? (
                      <CalendarDays size={14} strokeWidth={1.75} className="shrink-0 text-accent" aria-hidden="true" />
                    ) : (
                      <ListTodo size={14} strokeWidth={1.75} className="shrink-0 text-accent" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-primary">
                      {item.title || t('chat.noSubject', { defaultValue: '(no subject)' })}
                    </span>
                    <span className="shrink-0 text-secondary">{label(item)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}
