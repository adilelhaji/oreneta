// Local, message-tied to-dos: load the list, and record what the reader does
// with one. Message-tied only — every task carries the conversation it hangs
// off, there is no freestanding task unconnected to any mail.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { showToast } from './ui'
import { t } from '../lib/i18n'

export type Task = {
  id: number
  thread_id: string
  account_id: string
  folder_id: string
  note: string
  due_at: number | null
  completed_at: number | null
  created_at: number
  subject: string
  from_name: string
  from_addr: string
}

export const tasks$ = observable({
  items: [] as Task[],
  loaded: false,
  loading: false,
  /** Whether the list currently includes finished tasks. */
  includeCompleted: false,
})

export async function loadTasks(includeCompleted = tasks$.includeCompleted.get()) {
  tasks$.loading.set(true)
  try {
    const res = await invoke<{ tasks?: Task[] }>('tasks.list', { include_completed: includeCompleted })
    tasks$.items.set(res?.tasks ?? [])
    tasks$.includeCompleted.set(includeCompleted)
    tasks$.loaded.set(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('tasks.loadFailed'), 'error')
  } finally {
    tasks$.loading.set(false)
  }
}

/**
 * One task's own due date and note — the card only ever carries the id and
 * due date, so the editor asks for the rest before opening on an existing
 * task, rather than starting from a blank note that would overwrite the
 * real one on save.
 */
export async function getTask(id: number): Promise<{ due_at: number | null; note: string } | null> {
  try {
    return await invoke('tasks.get', { id })
  } catch {
    return null
  }
}

/**
 * Creates a task on a conversation, or edits the one already open on it —
 * the core makes this idempotent, so the caller never has to know which.
 */
export async function saveTask(threadId: string, fields: { dueAt: number | null; note: string }) {
  try {
    await invoke('tasks.save', {
      thread_id: threadId,
      ...(fields.dueAt === null ? {} : { due_at: fields.dueAt }),
      note: fields.note,
    })
    await loadTasks()
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('tasks.saveFailed'), 'error')
    throw error
  }
}

export async function setTaskCompleted(id: number, completed: boolean) {
  try {
    await invoke('tasks.setCompleted', { id, completed })
    await loadTasks()
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('tasks.saveFailed'), 'error')
  }
}

export async function deleteTask(id: number) {
  try {
    await invoke('tasks.delete', { id })
    tasks$.items.set(tasks$.items.get().filter((task) => task.id !== id))
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('tasks.saveFailed'), 'error')
  }
}
