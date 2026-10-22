import { useEffect, useState } from 'react'
import { ListTodo, Repeat, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import {
  MAIL_LIST,
  createTask,
  deleteTask,
  getTask,
  isRemoteList,
  listName,
  loadTaskLists,
  loadTasks,
  saveTask,
  tasks$,
  updateTask,
  type TaskFields,
} from '../../states/tasks'
import { ui$ } from '../../states/ui'
import { Dialog } from '../dialog/Dialog'
import { Button } from '../button/Button'
import { TextInput } from '../field/Field'
import { RepeatFields } from '../calendar/RepeatFields'
import type { Recurrence } from '../../states/calendar'

/** The local date, the same one `fromDateInput` turns back into local
 * midnight. The UTC date (`toISOString`) showed the day before east of UTC,
 * and saving then moved the task a day earlier. */
function toDateInput(unixSeconds: number | null): string {
  if (!unixSeconds) return ''
  const date = new Date(unixSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function fromDateInput(value: string): number | null {
  if (!value) return null
  const ms = Date.parse(`${value}T00:00:00`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** `datetime-local` works in local time, without a zone. */
function toDateTimeInput(unixSeconds: number | null): string {
  if (!unixSeconds) return ''
  const date = new Date(unixSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fromDateTimeInput(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

const labelClass = 'text-caption font-bold uppercase tracking-wide text-secondary'
const selectClass =
  'w-full rounded-control-sm border border-border bg-app px-3 py-2 text-sm text-primary outline-none focus:border-accent-fg disabled:opacity-60'

/**
 * Turns a conversation into a task, writes a standalone task (ADR-0013), or
 * edits either.
 *
 * Editing reads the task's own fields first, never trusting what the card
 * carried, so a blank placeholder cannot overwrite the real note. An edit
 * names the revision it was read at; if another window changed the task
 * meanwhile, nothing is saved and both copies are shown (ADR-0012).
 */
export function TaskDialog() {
  const { t } = useTranslation()
  const state = useValue(ui$.taskEditor)
  const lists = useValue(tasks$.lists)
  const editing = !!state && state.id > 0
  const standalone = !!state && !state.threadId
  const [title, setTitle] = useState('')
  const [listId, setListId] = useState(state?.listId || MAIL_LIST)
  // The list the task was read in: moving it to or from a list kept on a
  // server is not supported yet (ADR-0039).
  const [originalList, setOriginalList] = useState<string | null>(null)
  const [dueAt, setDueAt] = useState(() => toDateInput(state?.dueAt ?? null))
  const [reminderAt, setReminderAt] = useState('')
  const [priority, setPriority] = useState(1)
  // How it repeats (ADR-0053). A task that repeats in a way this app does
  // not change (extra dates, changed occurrences) shows that instead.
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null)
  const [note, setNote] = useState(() => state?.note ?? '')
  const [revision, setRevision] = useState<number | null>(null)
  const [linked, setLinked] = useState(!standalone)
  const [busy, setBusy] = useState(false)
  const [loadingExisting, setLoadingExisting] = useState(editing)
  // The task's own fields could not be read (the core failed, or the task is
  // gone). Saving then would write the blank placeholder over the real note,
  // so the fields stay locked and the reader is told why.
  const [unreadable, setUnreadable] = useState(false)
  const [conflict, setConflict] = useState<(TaskFields & { revision: number }) | null | undefined>(undefined)

  useEffect(() => {
    if (state && lists.length === 0) void loadTaskLists()
  }, [Boolean(state)])

  useEffect(() => {
    if (!editing || !state) return
    let live = true
    void getTask(state.id).then((task) => {
      if (!live) return
      if (task && task !== 'failed') {
        setDueAt(toDateInput(task.due_at))
        setNote(task.note)
        setTitle(task.title ?? '')
        setListId(task.list_id || MAIL_LIST)
        setOriginalList(task.list_id || MAIL_LIST)
        setReminderAt(toDateTimeInput(task.reminder_at ?? null))
        setPriority(task.priority ?? 1)
        setRecurrence(task.recurrence ?? null)
        setRevision(task.revision ?? null)
        setLinked(task.linked ?? !standalone)
        setLoadingExisting(false)
      } else {
        setUnreadable(true)
      }
    })
    return () => {
      live = false
    }
  }, [editing, state?.id])

  const byId = (id: string) => lists.find((list) => list.id === id)
  const moveRefused =
    editing &&
    originalList !== null &&
    listId !== originalList &&
    (isRemoteList(byId(originalList)) || isRemoteList(byId(listId)))

  if (!state) return null

  const lockedRepeat = editing && tasks$.items.peek().some((task) => task.id === state.id && task.recurring)
  const canRepeat = (standalone || (editing && !linked)) && !lockedRepeat
  const dueSeconds = fromDateInput(dueAt)
  // Exchange repeats a task at most once a year (ADR-0058).
  const exchangeList = !!byId(listId)?.ews_account
  const writableRule = (rule: Recurrence | null) =>
    rule && exchangeList && rule.freq === 'yearly' && rule.interval > 1 ? { ...rule, interval: 1 } : rule

  // A rule on "the second Tuesday" follows the due date to its own weekday.
  const changeDue = (value: string) => {
    setDueAt(value)
    const next = fromDateInput(value)
    if (!recurrence?.month_week || next === null) return
    const date = new Date(next * 1000)
    const lastWeek = date.getDate() + 7 > new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
    setRecurrence({
      ...recurrence,
      weekdays: [(date.getDay() + 6) % 7],
      month_week: recurrence.month_week === -1 && lastWeek ? -1 : Math.min(Math.floor((date.getDate() - 1) / 7) + 1, 4),
    })
  }

  // Repeating counts from the due date, so choosing a repetition on a task
  // with none makes it due today.
  const changeRecurrence = (rule: Recurrence | null) => {
    if (rule && !dueAt) setDueAt(toDateInput(Math.floor(Date.now() / 1000)))
    setRecurrence(writableRule(rule))
  }

  const close = () => ui$.taskEditor.set(null)
  const fields = (): TaskFields => ({
    list_id: listId,
    title: title.trim(),
    note: note.trim(),
    due_at: fromDateInput(dueAt),
    reminder_at: fromDateTimeInput(reminderAt),
    priority,
    recurrence: canRepeat ? writableRule(recurrence) : null,
  })
  const finish = (result: Awaited<ReturnType<typeof updateTask>>) => {
    if (result.kind === 'saved') close()
    else if (result.kind === 'conflict') setConflict(result.current)
  }

  const submit = async () => {
    // Enter in the form submits too, so the lock is checked here as well.
    if (loadingExisting) return
    if (standalone && !title.trim()) return
    if (moveRefused) return
    setBusy(true)
    try {
      if (editing && revision !== null) {
        finish(await updateTask(state.id, revision, fields()))
      } else if (editing || !standalone) {
        // A conversation's task, through the one-per-conversation save.
        await saveTask(state.threadId, { dueAt: fromDateInput(dueAt), note: note.trim() })
        close()
      } else {
        finish(await createTask(fields()))
      }
    } catch {
      // saveTask already reported it — leave the dialog open to retry.
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    await deleteTask(state.id)
    setBusy(false)
    close()
  }

  if (conflict !== undefined) {
    const keepMine = async () => {
      setBusy(true)
      try {
        finish(conflict ? await updateTask(state.id, conflict.revision, fields()) : await createTask(fields()))
        setConflict(undefined)
      } finally {
        setBusy(false)
      }
    }
    return (
      <Dialog
        title={t('tasks.conflictTitle', { defaultValue: 'Changed in another window' })}
        icon={ListTodo}
        role="alertdialog"
        width="md"
        onClose={close}
        closeDisabled={busy}
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                close()
                void loadTasks()
              }}
            >
              {conflict
                ? t('tasks.keepSaved', { defaultValue: 'Keep the saved copy' })
                : t('tasks.discardMine', { defaultValue: 'Discard my changes' })}
            </Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void keepMine()}>
              {conflict
                ? t('tasks.keepMine', { defaultValue: 'Keep mine' })
                : t('tasks.createAgain', { defaultValue: 'Create it again' })}
            </Button>
          </>
        }
      >
        <p className="text-ui text-secondary">
          {conflict
            ? t('tasks.conflictText', { defaultValue: 'Nothing was saved. Choose which copy to keep.' })
            : t('tasks.deletedText', { defaultValue: 'This task was deleted in another window. Nothing was saved.' })}
        </p>
        <div className="mt-4 grid gap-3 min-[600px]:grid-cols-2">
          <Summary title={t('tasks.yours', { defaultValue: 'Yours' })} task={fields()} />
          {conflict && <Summary title={t('tasks.savedCopy', { defaultValue: 'Saved' })} task={conflict} />}
        </div>
      </Dialog>
    )
  }

  const locked = loadingExisting && editing

  return (
    <Dialog
      title={editing ? t('tasks.editTitle') : t('tasks.addTitle')}
      icon={ListTodo}
      width="sm"
      onClose={close}
      closeDisabled={busy}
      footer={
        <>
          {editing && (
            <Button variant="danger" size="sm" onClick={() => void remove()} disabled={busy} className="me-auto">
              <Trash2 size={14} strokeWidth={1.75} />
              {t('buttons.delete')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
            {t('buttons.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void submit()}
            disabled={busy || locked || moveRefused || (standalone && !title.trim())}
          >
            {busy ? t('common.loading') : t('buttons.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {unreadable && (
          <p role="alert" className="rounded-control bg-raised px-3 py-2 text-caption text-secondary">
            {t('tasks.unreadable', {
              defaultValue:
                'This task could not be read, so it cannot be edited now. Close and try again; nothing has been changed.',
            })}
          </p>
        )}
        {(standalone || (editing && !linked)) && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="task-title" className={labelClass}>
              {t('tasks.titleField', { defaultValue: 'Title' })}
            </label>
            <TextInput
              id="task-title"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              fieldSize="md"
              surface="app"
              disabled={locked}
            />
          </div>
        )}
        {(standalone || editing) && lists.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="task-list" className={labelClass}>
              {t('tasks.list', { defaultValue: 'List' })}
            </label>
            <select
              id="task-list"
              value={listId}
              onChange={(event) => setListId(event.target.value)}
              className={selectClass}
              disabled={locked}
            >
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {listName(list)}
                </option>
              ))}
            </select>
            {moveRefused && (
              <p role="alert" className="text-caption text-danger">
                {t('tasks.moveRefused', {
                  defaultValue:
                    'A task cannot be moved between a list kept on a server and another list yet. Create it again in the other list instead.',
                })}
              </p>
            )}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="task-due" className={labelClass}>
            {t('tasks.dueDate')}
          </label>
          <TextInput
            id="task-due"
            type="date"
            value={dueAt}
            onChange={(event) => changeDue(event.target.value)}
            fieldSize="md"
            surface="app"
            disabled={locked}
          />
        </div>
        {canRepeat && (
          <RepeatFields
            rule={recurrence}
            start={dueSeconds ?? Math.floor(Date.now() / 1000)}
            onChange={changeRecurrence}
            monthlyByWeekday
            yearlyOnlyEveryYear={exchangeList}
            inputClass={selectClass}
            idPrefix="task-repeat"
          />
        )}
        {lockedRepeat && (
          <p className="flex items-center gap-1.5 text-caption text-secondary">
            <Repeat size={12} strokeWidth={1.75} aria-hidden="true" />
            {t('tasks.repeatsReadOnly', { defaultValue: 'Repeats · edit it in the app that made it' })}
          </p>
        )}
        {(standalone || editing) && (
          <div className="grid gap-3 min-[420px]:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="task-reminder" className={labelClass}>
                {t('tasks.reminder', { defaultValue: 'Reminder' })}
              </label>
              <TextInput
                id="task-reminder"
                type="datetime-local"
                value={reminderAt}
                onChange={(event) => setReminderAt(event.target.value)}
                fieldSize="md"
                surface="app"
                disabled={locked}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="task-priority" className={labelClass}>
                {t('tasks.priority', { defaultValue: 'Priority' })}
              </label>
              <select
                id="task-priority"
                value={priority}
                onChange={(event) => setPriority(Number(event.target.value))}
                className={selectClass}
                disabled={locked}
              >
                <option value={0}>{t('tasks.priorityLow', { defaultValue: 'Low' })}</option>
                <option value={1}>{t('tasks.priorityNormal', { defaultValue: 'Normal' })}</option>
                <option value={2}>{t('tasks.priorityHigh', { defaultValue: 'High' })}</option>
              </select>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="task-note" className={labelClass}>
            {t('tasks.note')}
          </label>
          <textarea
            id="task-note"
            autoFocus={!standalone}
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('tasks.notePlaceholder')}
            disabled={locked}
            className="w-full resize-none rounded-control-sm border border-border bg-app px-3 py-2 text-sm text-primary placeholder-secondary outline-none focus:border-accent-fg disabled:opacity-60"
          />
        </div>
      </form>
    </Dialog>
  )
}

function Summary({ title, task }: { title: string; task: TaskFields }) {
  const lines = [task.title, task.note, task.due_at ? toDateInput(task.due_at) : ''].filter((line) => line.trim())
  return (
    <section className="rounded-control border border-border bg-chats p-3">
      <h3 className={labelClass}>{title}</h3>
      <ul className="mt-2 flex flex-col gap-1 text-ui text-primary">
        {lines.map((line, index) => (
          <li key={index} className="wrap-anywhere">
            {line}
          </li>
        ))}
      </ul>
    </section>
  )
}
