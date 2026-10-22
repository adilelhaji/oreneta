import { Fragment, useEffect, useState } from 'react'
import {
  Bell,
  CalendarClock,
  Check,
  Flag,
  ListTodo,
  Pencil,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  Trash2,
  AlertTriangle,
} from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { intlLocale, useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { dueStatus, formatDueDate } from '../../lib/date'
import {
  MAIL_LIST,
  accountEntryOf,
  createTaskList,
  deleteTask,
  deleteTaskList,
  isRemoteList,
  listName,
  loadTaskLists,
  loadTasks,
  onTaskListsChanged,
  renameTaskList,
  repeats,
  resolveTaskConflict,
  setTaskCompleted,
  syncTaskLists,
  taskTitle,
  tasks$,
  waitingAccountLists,
  type Task,
  type TaskList,
} from '../../states/tasks'
import { AccountListNotices, AddAccountListMenu, WaitingAccountLists } from './AccountTaskLists'
import { openMailAccount } from '../../states/kanban'
import { accounts$ } from '../../states/accounts'
import { confirmAction, showToast, ui$ } from '../../states/ui'
import { Button } from '../button/Button'
import { EmptyState } from '../empty-state/EmptyState'
import { LoadingState } from '../empty-state/StateViews'
import { CompactNavigation } from '../sidenav/CompactNavigation'
import { FOLDER_PANE_MIN_WINDOW, FolderPane } from '../shell/FolderPane'
import { useWideWindow } from '../resizer/useElementWidth'
import { TaskListsPane } from './TaskListsPane'
import { CalDavTaskListDialog } from './CalDavTaskListDialog'
import { describeRecurrence } from '../calendar/RepeatFields'
import { handleGroupArrowKeys } from '../../lib/direction'

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
 *
 * Its lists are the "folders" region. From 1025 px they are the common folder
 * pane, beside the whole module, at the width every module shares (ADR-0068
 * §4); below that the pane is not drawn and they keep their place in the row
 * under the header, as tabs, as before.
 */
export function TasksView() {
  const { t } = useTranslation()
  const items = useValue(tasks$.items)
  const loaded = useValue(tasks$.loaded)
  const loading = useValue(tasks$.loading)
  const includeCompleted = useValue(tasks$.includeCompleted)
  const lists = useValue(tasks$.lists)
  const selectedList = useValue(tasks$.selectedList)
  const search = useValue(tasks$.search)
  const [newList, setNewList] = useState<string | null>(null)
  const [addingCalDav, setAddingCalDav] = useState(false)
  // A repeating task whose check box was pressed: completing it asks whether
  // this occurrence is done or the repetition is over (ADR-0053).
  const [choosing, setChoosing] = useState<number | null>(null)
  const inPane = useWideWindow(FOLDER_PANE_MIN_WINDOW)
  const syncing = useValue(tasks$.syncing)
  const accountLists = useValue(tasks$.accountLists)
  const listsById = new Map(lists.map((list) => [list.id, list]))
  // An account whose lists have not been read is never «no tasks» (ADR-0070).
  const waiting = waitingAccountLists(accountLists)

  useEffect(() => {
    if (!loaded) void loadTasks()
  }, [loaded])
  useEffect(() => {
    // Lists kept on a server are synced each time the view opens (ADR-0039),
    // and the accounts' lists that wait are read then (ADR-0070).
    void loadTaskLists().then(() => {
      if (tasks$.lists.get().some(isRemoteList) || waitingAccountLists(tasks$.accountLists.get()).length > 0)
        void syncTaskLists()
    })
    // A list of an account read behind the view arrives while it is open.
    return onTaskListsChanged(() => void Promise.all([loadTaskLists(), loadTasks()]))
  }, [])

  const needle = search.trim().toLowerCase()
  const shown = items.filter(
    (task) =>
      (selectedList === 'all' || (task.list_id ?? MAIL_LIST) === selectedList) &&
      (!needle ||
        [taskTitle(task), task.note, task.from_name, task.from_addr].some((text) =>
          text?.toLowerCase().includes(needle),
        )),
  )
  const current = lists.find((list) => list.id === selectedList)

  const newTask = () =>
    ui$.taskEditor.set({
      threadId: '',
      id: 0,
      dueAt: null,
      note: '',
      listId: selectedList === 'all' ? MAIL_LIST : selectedList,
    })

  const renameList = async () => {
    if (!current) return
    const name = window.prompt(t('tasks.renameList', { defaultValue: 'Rename list' }), current.name)
    if (name?.trim()) await renameTaskList(current.id, name)
  }

  const removeList = async (): Promise<boolean> => {
    if (!current) return false
    // A list of an account does not come back on its own, and is added
    // again from «Afegeix una llista»; only a CalDAV one has a password of
    // its own to say goes with it (ADR-0070, §5).
    const ofAccount = !!accountEntryOf(accountLists, current.id)
    const confirmed = await confirmAction({
      title: t('tasks.deleteListTitle', { defaultValue: 'Delete list?' }),
      message: ofAccount
        ? current.remote_url
          ? t('tasks.deleteAccountListPasswordText', {
              name: current.name,
              defaultValue:
                '{name} and its tasks will be removed from this computer, with its saved password. Nothing is deleted on the server. It does not come back on its own: add it again from “Add a list”.',
            })
          : t('tasks.deleteAccountListText', {
              name: current.name,
              defaultValue:
                '{name} and its tasks will be removed from this computer. Nothing is deleted on the server. It does not come back on its own: add it again from “Add a list”.',
            })
        : isRemoteList(current)
          ? t('tasks.deleteRemoteListText', {
              name: current.name,
              defaultValue:
                '{name} and its tasks will be removed from this computer, with its saved password. Nothing is deleted on the server: the tasks stay there.',
            })
          : t('tasks.deleteListText', {
              name: current.name,
              count: current.open,
              defaultValue: '{name} and every task in it will be deleted.',
            }),
      confirmLabel: t('buttons.delete'),
      tone: 'danger',
    })
    if (confirmed) await deleteTaskList(current.id)
    return confirmed
  }

  const open = (task: Task) => {
    // A standalone task has no conversation to go to; opening it edits it.
    if (task.linked === false) {
      ui$.taskEditor.set({ threadId: '', id: task.id, dueAt: task.due_at, note: task.note })
      return
    }
    // Opening a folder the conversation is not in showed an empty reader and
    // no reason. Say so instead, and stay on the list.
    if (task.located === false) {
      showToast(
        t('tasks.notFound', {
          defaultValue:
            'This conversation is no longer in the local copy of your mail (moved or deleted). The task is kept.',
        }),
        'error',
      )
      return
    }
    ui$.module.set('mail')
    openMailAccount(task.account_id, task.folder_id, false)
    ui$.selectedThread.set(task.thread_id)
    ui$.mobilePane.set('conversation')
  }

  const edit = (event: React.MouseEvent, task: Task) => {
    event.stopPropagation()
    ui$.taskEditor.set({ threadId: task.thread_id, id: task.id, dueAt: task.due_at, note: task.note })
  }

  return (
    <>
      {inPane && (
        <FolderPane title={t('tasks.taskLists', { defaultValue: 'Task lists' })}>
          <TaskListsPane
            onRename={() => void renameList()}
            onDelete={removeList}
            onAddCalDav={() => setAddingCalDav(true)}
          />
        </FolderPane>
      )}
      <div data-region="content" className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
        <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-header px-4 py-3">
          <CompactNavigation />
          <h1 className="flex items-center gap-2 text-heading-sm font-bold text-primary">
            <ListTodo size={20} strokeWidth={1.75} />
            {t('tasks.title')}
          </h1>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-caption text-secondary">
              <input
                type="checkbox"
                checked={includeCompleted}
                onChange={(event) => void loadTasks(event.target.checked)}
              />
              {t('tasks.showCompleted')}
            </label>
            <Button variant="secondary" size="sm" onClick={newTask}>
              <Plus size={14} strokeWidth={1.75} />
              {t('tasks.newTask', { defaultValue: 'New task' })}
            </Button>
          </div>
        </header>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-header px-4 py-2">
          {!inPane && (
            <>
              <div
                role="tablist"
                aria-label={t('tasks.lists', { defaultValue: 'Lists' })}
                className="flex flex-wrap gap-1.5"
                // Arrows move between the lists in reading order (ADR-0061).
                onKeyDown={(event) => handleGroupArrowKeys(event, '[role="tab"]', 'horizontal')}
              >
                {[
                  { id: 'all', label: t('tasks.allLists', { defaultValue: 'All' }), open: -1 },
                  ...lists.map((list) => ({ id: list.id, label: listName(list), open: list.open })),
                ].map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={selectedList === entry.id}
                    onClick={() => tasks$.selectedList.set(entry.id)}
                    className={clsx(
                      'rounded-control-sm px-2.5 py-1 text-caption font-semibold transition-colors cursor-pointer',
                      selectedList === entry.id ? 'bg-accent text-on-accent' : 'text-secondary hover:bg-hover',
                    )}
                  >
                    {entry.label}
                    {entry.open > 0 && <span className="ms-1 tabular-nums">{entry.open}</span>}
                  </button>
                ))}
              </div>
              {newList === null ? (
                <button
                  type="button"
                  onClick={() => setNewList('')}
                  className="rounded-control-sm px-2 py-1 text-caption text-secondary hover:bg-hover cursor-pointer"
                >
                  + {t('tasks.newList', { defaultValue: 'New list' })}
                </button>
              ) : (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (newList.trim()) void createTaskList(newList)
                    setNewList(null)
                  }}
                >
                  <input
                    autoFocus
                    value={newList}
                    aria-label={t('tasks.newListName', { defaultValue: 'New list name' })}
                    onChange={(event) => setNewList(event.target.value)}
                    onBlur={() => !newList.trim() && setNewList(null)}
                    className="w-36 rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary outline-none focus:border-accent-fg"
                  />
                </form>
              )}
              <button
                type="button"
                onClick={() => setAddingCalDav(true)}
                className="rounded-control-sm px-2 py-1 text-caption text-secondary hover:bg-hover cursor-pointer"
              >
                + {t('tasks.addCalDavList', { defaultValue: 'CalDAV task list…' })}
              </button>
              <AddAccountListMenu entries={accountLists} />
              {current && current.id !== MAIL_LIST && (
                <span className="ms-auto flex gap-1">
                  <button
                    type="button"
                    onClick={() => void renameList()}
                    className="rounded-control-sm px-2 py-1 text-caption text-secondary hover:bg-hover cursor-pointer"
                  >
                    {t('tasks.renameList', { defaultValue: 'Rename list' })}
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeList()}
                    className="rounded-control-sm px-2 py-1 text-caption text-secondary hover:bg-danger-soft hover:text-danger cursor-pointer"
                  >
                    {t('tasks.deleteList', { defaultValue: 'Delete list' })}
                  </button>
                </span>
              )}
            </>
          )}
          <div className="flex min-w-40 flex-1 items-center gap-2 rounded-control border border-border bg-chats px-2.5 py-1.5 focus-within:border-accent-fg min-[600px]:max-w-64 min-[600px]:flex-none">
            <Search size={14} className="shrink-0 text-secondary" strokeWidth={1.75} />
            <input
              value={search}
              onChange={(event) => tasks$.search.set(event.target.value)}
              placeholder={t('tasks.search', { defaultValue: 'Search tasks' })}
              aria-label={t('tasks.search', { defaultValue: 'Search tasks' })}
              className="min-w-0 flex-1 bg-transparent text-caption text-primary placeholder-secondary outline-none"
            />
          </div>
        </div>
        {current && isRemoteList(current) && (
          <SyncStatus list={current} syncing={syncing} onSync={() => void syncTaskLists(current.id)} />
        )}
        <WaitingAccountLists entries={accountLists} syncing={syncing} />
        <AccountListNotices entries={accountLists} lists={lists} />
        {addingCalDav && <CalDavTaskListDialog onClose={() => setAddingCalDav(false)} />}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!loaded && loading ? (
            <LoadingState title={t('tasks.loading')} />
          ) : shown.length === 0 && waiting.length > 0 && selectedList === 'all' ? (
            // Not read yet is not «no tasks» (ADR-0070, §3).
            <EmptyState
              title={t('tasks.notReadYet', { defaultValue: 'The tasks of some accounts have not been read yet' })}
              text={t('tasks.notReadYetText', {
                defaultValue: 'They show here once they are read. What stops them, if anything, is said above.',
              })}
            />
          ) : shown.length === 0 ? (
            <EmptyState title={t('tasks.emptyTitle')} text={t('tasks.emptyText')} />
          ) : (
            <ul className="mx-auto flex max-w-2xl flex-col gap-1.5 p-4">
              {shown.map((task) => {
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
                      aria-expanded={repeats(task) ? choosing === task.id : undefined}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (repeats(task)) setChoosing(choosing === task.id ? null : task.id)
                        else void setTaskCompleted(task.id, !done)
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
                      className="min-w-0 flex-1 basis-40 rounded-control-sm text-start cursor-pointer"
                    >
                      <span
                        className={clsx(
                          'block wrap-anywhere text-ui font-semibold',
                          done ? 'text-secondary line-through' : 'text-primary',
                        )}
                      >
                        {task.priority === 2 && (
                          <Flag
                            size={12}
                            strokeWidth={2}
                            className="me-1 inline text-danger"
                            aria-label={t('tasks.priorityHigh', { defaultValue: 'High' })}
                          />
                        )}
                        <bdi>{taskTitle(task)}</bdi>
                      </span>
                      <span className="block wrap-anywhere text-caption text-secondary">
                        {/* Each piece isolated: a Latin name beside an Arabic note keeps its place. */}
                        {(task.linked === false ? [task.note] : [task.from_name || task.from_addr, task.note])
                          .filter(Boolean)
                          .map((piece, index) => (
                            <Fragment key={index}>
                              {index > 0 && ' · '}
                              <bdi>{piece}</bdi>
                            </Fragment>
                          ))}
                      </span>
                      <span className="flex flex-wrap items-center gap-3">
                        {!done && task.due_at && <DueChip dueAt={task.due_at} />}
                        {task.recurrence && !done && (
                          <span className="flex items-center gap-1 text-2xs text-secondary">
                            <Repeat size={12} strokeWidth={1.75} aria-hidden="true" />
                            <span className="sr-only">{t('tasks.repeats', { defaultValue: 'Repeats' })}: </span>
                            {describeRecurrence(task.recurrence, t)}
                          </span>
                        )}
                        {task.recurring && (
                          <span className="flex items-center gap-1 text-2xs text-secondary">
                            <Repeat size={12} strokeWidth={1.75} aria-hidden="true" />
                            {t('tasks.repeatsReadOnly', { defaultValue: 'Repeats · edit it in the app that made it' })}
                          </span>
                        )}
                        {task.pending === 'put' &&
                          !task.conflict &&
                          isRemoteList(listsById.get(task.list_id ?? '')) && (
                            <span className="text-2xs text-secondary">
                              {t('tasks.notSentYet', { defaultValue: 'Not on the server yet' })}
                            </span>
                          )}
                        {!done && task.reminder_at && (
                          <span className="flex items-center gap-1 text-2xs text-secondary">
                            <Bell size={12} strokeWidth={1.75} aria-hidden="true" />
                            {new Date(task.reminder_at * 1000).toLocaleString(intlLocale(), {
                              dateStyle: 'short',
                              timeStyle: 'short',
                            })}
                          </span>
                        )}
                      </span>
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
                    {choosing === task.id && repeats(task) && (
                      <CompleteChoice
                        onChoose={(stopRepeating) => {
                          setChoosing(null)
                          void setTaskCompleted(task.id, true, { stopRepeating })
                        }}
                        onCancel={() => setChoosing(null)}
                      />
                    )}
                    {task.conflict && <ConflictBar task={task} />}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  )
}

/** Completing a repeating task: this occurrence, or the whole series. */
function CompleteChoice({ onChoose, onCancel }: { onChoose: (stopRepeating: boolean) => void; onCancel: () => void }) {
  const { t } = useTranslation()
  return (
    <div
      role="group"
      aria-label={t('tasks.completeRepeating', { defaultValue: 'Complete a repeating task' })}
      className="flex basis-full flex-wrap items-center gap-2 rounded-control bg-raised px-2.5 py-1.5 text-caption text-primary"
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <Repeat size={14} strokeWidth={1.75} className="shrink-0 text-secondary" aria-hidden="true" />
        {t('tasks.completeRepeatingText', {
          defaultValue: 'This task repeats. Complete only this occurrence, or stop repeating and complete it for good.',
        })}
      </span>
      <Button variant="primary" size="sm" onClick={() => onChoose(false)}>
        {t('tasks.completeOccurrence', { defaultValue: 'Complete this occurrence' })}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => onChoose(true)}>
        {t('tasks.stopRepeating', { defaultValue: 'Stop repeating' })}
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        {t('buttons.cancel')}
      </Button>
    </div>
  )
}

/** Where a list kept on a server is, when it last synced, and why the last
 * sync failed if it did (ADR-0039). */
function SyncStatus({ list, syncing, onSync }: { list: TaskList; syncing: boolean; onSync: () => void }) {
  const { t } = useTranslation()
  const accounts = useValue(accounts$)
  // An Exchange account's Tasks folder is named by the account (ADR-0058).
  const exchange =
    list.ews_account && (accounts.find((account) => account.id === list.ews_account)?.email || list.ews_account)
  let host = exchange || list.remote_url || ''
  if (!list.ews_account) {
    try {
      host = new URL(host).host
    } catch {
      // Shown as stored.
    }
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-header px-4 py-2 text-caption text-secondary">
      <span className="min-w-0 flex-1 wrap-anywhere">
        {t('tasks.keptOn', { host, defaultValue: 'Kept on {host}.' })}{' '}
        {list.synced_at
          ? t('tasks.lastSynced', {
              time: new Date(list.synced_at * 1000).toLocaleString(intlLocale(), {
                dateStyle: 'short',
                timeStyle: 'short',
              }),
              defaultValue: 'Last synced {time}.',
            })
          : t('tasks.neverSynced', { defaultValue: 'Not synced yet.' })}
        {(list.conflicts ?? 0) > 0 &&
          ` ${t('tasks.conflictsWaiting', {
            count: list.conflicts,
            defaultValue:
              'Tasks waiting for a choice: {count}. The list’s other changes are sent once they are settled.',
          })}`}
      </span>
      {list.last_error && (
        <span role="alert" className="basis-full wrap-anywhere text-danger">
          {t('tasks.syncError', {
            error: list.last_error,
            defaultValue: 'The last sync failed: {error}. Nothing here was lost; changes are sent on the next sync.',
          })}
        </span>
      )}
      <Button variant="secondary" size="sm" onClick={onSync} disabled={syncing}>
        <RefreshCw size={14} strokeWidth={1.75} className={syncing ? 'animate-spin' : undefined} />
        {syncing ? t('tasks.syncing', { defaultValue: 'Syncing…' }) : t('tasks.sync', { defaultValue: 'Sync' })}
      </Button>
    </div>
  )
}

/** A task changed here and on the server (or deleted there): nothing is
 * overwritten until the person chooses a copy. */
function ConflictBar({ task }: { task: Task }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const settle = async (keep: 'mine' | 'server') => {
    setBusy(true)
    await resolveTaskConflict(task.id, keep)
    setBusy(false)
  }
  // A change Exchange can never take (ADR-0058): nothing to choose between,
  // the task waits to be changed, and the list's other changes went on.
  if (task.conflict?.startsWith('rejected: ')) {
    return (
      <div className="flex basis-full items-center gap-1.5 rounded-control bg-warning-soft px-2.5 py-1.5 text-caption text-primary">
        <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0 text-warning" aria-hidden="true" />
        <span>
          {t('tasks.conflictRejected', {
            reason: task.conflict.slice('rejected: '.length),
            defaultValue: 'The server cannot take this change: {reason}. Change the task to send it.',
          })}
        </span>
      </div>
    )
  }
  const reason =
    task.conflict === 'deleted'
      ? t('tasks.conflictDeleted', { defaultValue: 'Changed here, deleted on the server.' })
      : task.pending === 'delete'
        ? t('tasks.conflictDeletedHere', { defaultValue: 'Deleted here, changed on the server.' })
        : t('tasks.conflictChanged', { defaultValue: 'Changed here and on the server.' })
  return (
    <div className="flex basis-full flex-wrap items-center gap-2 rounded-control bg-warning-soft px-2.5 py-1.5 text-caption text-primary">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 font-semibold">
        <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0 text-warning" aria-hidden="true" />
        <span className="rounded-control-sm border border-warning/40 px-1.5 text-2xs text-warning">
          {t('tasks.conflictBadge', { defaultValue: 'Conflict' })}
        </span>
        <span className="font-normal">{reason}</span>
      </span>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void settle('mine')}>
        {t('tasks.keepMine', { defaultValue: 'Keep mine' })}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void settle('server')}>
        {t('tasks.takeServers', { defaultValue: 'Take the server’s' })}
      </Button>
    </div>
  )
}
