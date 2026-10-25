import { CalendarDays, ListTodo, Loader2 } from 'lucide-react'
import { intlLocale, useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { agendaQueryWindow, buildAgenda, type AgendaGroup, type AgendaItem } from '../../lib/agenda'
import { startOfDay } from '../../states/calendar'
import {
  onTaskListsChanged,
  tasks$,
  waitingAccountLists,
  type AccountTaskList,
  type Task,
  type TaskList,
} from '../../states/tasks'
import { ui$ } from '../../states/ui'
import { AccountListNotices } from '../tasks/AccountTaskLists'
import { openSidebarEvent, readCalendarEvents, useSidebarCalendarReading } from './sidebarCalendar'

export { untilNextDay } from './sidebarCalendar'

type Agenda = {
  groups: AgendaGroup[]
  incomplete: boolean
  /** An account's task list has not been read yet (ADR-0070): its tasks may
   * be missing from the week. */
  tasksWaiting: boolean
  lists: TaskList[]
  accountLists: AccountTaskList[]
}

/**
 * Reads the coming week: every account's enabled calendars (the core leaves
 * out disabled ones) and every open task. A source that cannot be read is
 * said, never shown as an empty day; nor is a task list not read yet.
 */
export async function readAgenda(now: number, refresh: boolean): Promise<Agenda> {
  const { from, to } = agendaQueryWindow(now)
  let incomplete = false
  const [calendars, tasks, taskLists] = await Promise.all([
    readCalendarEvents(from, to, refresh),
    invoke<{ tasks?: Task[] }>('tasks.list', { include_completed: false }).then(
      (res) => res?.tasks ?? [],
      () => {
        incomplete = true
        return [] as Task[]
      },
    ),
    invoke<{ lists?: TaskList[]; account_lists?: AccountTaskList[] }>('tasks.lists', {}).then(
      (res) => ({ lists: res?.lists ?? [], accountLists: res?.account_lists ?? [] }),
      () => {
        incomplete = true
        return { lists: [] as TaskList[], accountLists: [] as AccountTaskList[] }
      },
    ),
  ])
  return {
    groups: buildAgenda(calendars.events, tasks, now),
    incomplete: incomplete || calendars.incomplete,
    tasksWaiting: waitingAccountLists(taskLists.accountLists).length > 0,
    ...taskLists,
  }
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
  // The cache of the week ahead, refreshed behind it, read again when a sync
  // lands and at midnight, when Today and Tomorrow move, and what was overdue
  // with them; a refresh that failed marks the week out of date until a sync
  // of the week lands (sidebarCalendar).
  const {
    answer: agenda,
    failed,
    stale,
  } = useSidebarCalendarReading((refresh) => readAgenda(now(), refresh), {
    now,
    covering: () => agendaQueryWindow(now()),
    subscribe: (reread) => {
      // A task edited or completed from here, or anywhere else, changes the list.
      const offEditor = ui$.taskEditor.onChange(({ value }) => {
        if (value === null) reread()
      })
      const offTasks = tasks$.items.onChange(reread)
      // A list of an account read in the background, or one declined or
      // confirmed in Tasks, changes the week (ADR-0070).
      const offLists = onTaskListsChanged(reread)
      const offAccountLists = tasks$.accountLists.onChange(reread)
      return () => {
        offEditor()
        offTasks()
        offLists()
        offAccountLists()
      }
    },
  })

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
          : new Date(key).toLocaleDateString(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long' })
  const time = (seconds: number) =>
    new Date(seconds * 1000).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })
  const section = 'px-4 pt-3 pb-1 text-2xs font-semibold uppercase tracking-wide text-secondary'
  const row = 'flex w-full items-center gap-2 px-4 py-1.5 text-start text-caption hover:bg-hover cursor-pointer'

  const label = (item: AgendaItem) =>
    item.kind === 'task'
      ? t('sidebar.agendaTask')
      : item.allDay
        ? t('calendar.allDay')
        : // An event under way since an earlier day shows the day it began.
          item.at * 1000 < today
          ? new Date(item.at * 1000).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short' })
          : time(item.at)

  return (
    <div className="pb-3">
      <AccountListNotices entries={agenda.accountLists} lists={agenda.lists} compact />
      {agenda.tasksWaiting && !agenda.incomplete && (
        <p role="status" className="mx-4 mt-3 rounded-control-sm bg-warning-soft px-3 py-2 text-caption text-primary">
          {t('sidebar.agendaTasksWaiting', {
            defaultValue: 'The tasks of some accounts have not been read yet, so this list may be incomplete.',
          })}
        </p>
      )}
      {stale.size > 0 && (
        <p role="status" className="mx-4 mt-3 rounded-control-sm bg-warning-soft px-3 py-2 text-caption text-primary">
          {t('calendar.staleWarning')}
        </p>
      )}
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
                    onClick={() => (item.kind === 'event' ? openSidebarEvent(item.event) : openAgendaTask(item.task))}
                  >
                    {item.kind === 'event' ? (
                      <CalendarDays size={14} strokeWidth={1.75} className="shrink-0 text-accent-fg" aria-hidden="true" />
                    ) : (
                      <ListTodo size={14} strokeWidth={1.75} className="shrink-0 text-accent-fg" aria-hidden="true" />
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
