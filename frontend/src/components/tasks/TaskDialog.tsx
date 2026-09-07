import { useEffect, useState } from 'react'
import { ListTodo, Trash2 } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { deleteTask, getTask, saveTask } from '../../states/tasks'
import { ui$ } from '../../states/ui'
import { Dialog } from '../dialog/Dialog'
import { Button } from '../button/Button'
import { TextInput } from '../field/Field'

function toDateInput(unixSeconds: number | null): string {
  if (!unixSeconds) return ''
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

function fromDateInput(value: string): number | null {
  if (!value) return null
  const ms = Date.parse(`${value}T00:00:00`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/**
 * Turns a conversation into a task, or edits the one already open on it.
 *
 * A due date and a note, nothing more — the same fields the core stores.
 * Deleting is only offered when editing a real task; creating one has
 * nothing yet to delete.
 */
export function TaskDialog() {
  const { t } = useTranslation()
  const state = ui$.taskEditor.get()
  const editing = !!state && state.id > 0
  const [dueAt, setDueAt] = useState(() => toDateInput(state?.dueAt ?? null))
  const [note, setNote] = useState(() => state?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [loadingExisting, setLoadingExisting] = useState(editing)

  // The card only ever carries the id and due date, never the note, so an
  // existing task's real fields are fetched fresh rather than trusting a
  // blank note that would overwrite the real one on save.
  useEffect(() => {
    if (!editing || !state) return
    let live = true
    void getTask(state.id).then((task) => {
      if (!live) return
      if (task) {
        setDueAt(toDateInput(task.due_at))
        setNote(task.note)
      }
      setLoadingExisting(false)
    })
    return () => {
      live = false
    }
  }, [editing, state?.id])

  if (!state) return null

  const close = () => ui$.taskEditor.set(null)

  const submit = async () => {
    setBusy(true)
    try {
      await saveTask(state.threadId, { dueAt: fromDateInput(dueAt), note: note.trim() })
      close()
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
            <Button variant="danger" size="sm" onClick={() => void remove()} disabled={busy} className="mr-auto">
              <Trash2 size={13} />
              {t('buttons.delete')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
            {t('buttons.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy || loadingExisting}>
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
        <div className="flex flex-col gap-1.5">
          <label htmlFor="task-due" className="text-caption font-bold uppercase tracking-wide text-secondary">
            {t('tasks.dueDate')}
          </label>
          <TextInput
            id="task-due"
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
            fieldSize="md"
            surface="app"
            disabled={loadingExisting}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="task-note" className="text-caption font-bold uppercase tracking-wide text-secondary">
            {t('tasks.note')}
          </label>
          <textarea
            id="task-note"
            autoFocus
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('tasks.notePlaceholder')}
            disabled={loadingExisting}
            className="w-full resize-none rounded-control-sm border border-border bg-app px-3 py-2 text-sm text-primary placeholder-secondary outline-none focus:border-accent disabled:opacity-60"
          />
        </div>
      </form>
    </Dialog>
  )
}
