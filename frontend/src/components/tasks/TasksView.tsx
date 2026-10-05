import { useEffect } from 'react'
import { CalendarClock, Check, ListTodo, Pencil, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { dueStatus, formatDueDate } from '../../lib/date'
import { deleteTask, loadTasks, setTaskCompleted, tasks$, type Task } from '../../states/tasks'
import { openMailAccount } from '../../states/kanban'
import { ui$ } from '../../states/ui'
import { EmptyState } from '../empty-state/EmptyState'
import { LoadingState } from '../empty-state/StateViews'
import { CompactNavigation } from '../sidenav/CompactNavigation'

const DUE_TONE: Record<ReturnType<typeof dueStatus>, string> = {
  overdue: 'text-danger ',
  today: 'text-warning ',
  tomorrow: 'text-secondary',
  upcoming: 'text-secondary',
}

function DueChip({ dueAt }: { dueAt: number }) {
  const { t } = useTranslation()
  const status = dueStatus(dueAt)
  const label =
    status === 'overdue'
      ? t('tasks.due.overdue')
      : status === 'today'
        ? t('tasks.due.today')
        : status === 'tomorrow'
          ? t('tasks.due.tomorrow')
          : formatDueDate(dueAt)
  return (
    <span className={clsx('flex items-center gap-1 text-2xs font-semibold', DUE_TONE[status])}>
      <CalendarClock size={14} strokeWidth={1.75} />
      {label}
    </span>
  )
}

/**
 * Every local task, across every account — a to-do list, not a mailbox.
 *
 * Each row is a conversation the reader flagged for follow-up: opening one
 * leaves this view and goes straight to that conversation, the same as
 * opening any other search result. Completing or deleting a task never
 * touches the mail it points at.
 */
export function TasksView() {
  const { t } = useTranslation()
  const items = useValue(tasks$.items)
  const loaded = useValue(tasks$.loaded)
  const loading = useValue(tasks$.loading)
  const includeCompleted = useValue(tasks$.includeCompleted)

  useEffect(() => {
    if (!loaded) void loadTasks()
  }, [loaded])

  const open = (task: Task) => {
    ui$.tasksOpen.set(false)
    openMailAccount(task.account_id, task.folder_id, false)
    ui$.selectedThread.set(task.thread_id)
    ui$.mobilePane.set('conversation')
  }

  const edit = (event: React.MouseEvent, task: Task) => {
    event.stopPropagation()
    ui$.taskEditor.set({ threadId: task.thread_id, id: task.id, dueAt: task.due_at, note: task.note })
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-header px-4 py-3">
        <CompactNavigation />
        <h1 className="flex items-center gap-2 text-heading-sm font-bold text-primary">
          <ListTodo size={20} strokeWidth={1.75} />
          {t('tasks.title')}
        </h1>
        <label className="flex items-center gap-1.5 text-caption text-secondary">
          <input
            type="checkbox"
            checked={includeCompleted}
            onChange={(event) => void loadTasks(event.target.checked)}
          />
          {t('tasks.showCompleted')}
        </label>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded && loading ? (
          <LoadingState title={t('tasks.loading')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('tasks.emptyTitle')} text={t('tasks.emptyText')} />
        ) : (
          <ul className="mx-auto flex max-w-2xl flex-col gap-1.5 p-4">
            {items.map((task) => {
              const done = !!task.completed_at
              return (
                <li
                  key={task.id}
                  className="flex flex-wrap items-start gap-2 rounded-panel border border-border bg-chats p-3 transition-colors hover:border-accent/40"
                >
                  <button
                    type="button"
                    title={done ? t('tasks.markNotDone') : t('tasks.markDone')}
                    aria-label={done ? t('tasks.markNotDone') : t('tasks.markDone')}
                    onClick={(event) => {
                      event.stopPropagation()
                      void setTaskCompleted(task.id, !done)
                    }}
                    className={clsx(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-control border transition-colors cursor-pointer',
                      done
                        ? 'border-accent bg-accent text-on-accent'
                        : 'border-border text-transparent hover:border-accent',
                    )}
                  >
                    <Check size={14} strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={() => open(task)}
                    className="min-w-0 flex-1 basis-40 rounded-control-sm text-left cursor-pointer"
                  >
                    <span
                      className={clsx(
                        'block wrap-anywhere text-ui font-semibold',
                        done ? 'text-secondary line-through' : 'text-primary',
                      )}
                    >
                      {task.subject || t('tasks.noSubject')}
                    </span>
                    <span className="block wrap-anywhere text-caption text-secondary">
                      {task.from_name || task.from_addr}
                      {task.note && ` · ${task.note}`}
                    </span>
                    {!done && task.due_at && <DueChip dueAt={task.due_at} />}
                  </button>
                  <button
                    type="button"
                    title={t('tasks.editAction')}
                    aria-label={t('tasks.editAction')}
                    onClick={(event) => edit(event, task)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
                  >
                    <Pencil size={14} strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    title={t('tasks.remove')}
                    aria-label={t('tasks.remove')}
                    onClick={(event) => {
                      event.stopPropagation()
                      void deleteTask(task.id)
                    }}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-danger-soft hover:text-danger cursor-pointer"
                  >
                    <Trash2 size={14} strokeWidth={1.75} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
