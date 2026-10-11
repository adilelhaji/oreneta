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
  /** Whether the conversation was found in the local cache; `folder_id` is
   * where it was found. Absent from older cores, which never said. */
  located?: boolean
  /** ADR-0013. False for a standalone task, which has no conversation. */
  linked?: boolean
  list_id?: string
  /** A standalone task's own title; empty for one tied to a conversation. */
  title?: string
  /** 0 low, 1 normal, 2 high. */
  priority?: number
  reminder_at?: number | null
  revision?: number
}

export type TaskList = { id: string; name: string; position: number; open: number }

/** The fields a task is written with (ADR-0013). */
export type TaskFields = {
  list_id: string
  title: string
  note: string
  due_at: number | null
  reminder_at: number | null
  priority: number
}

/** The list every task made from a conversation goes to; it cannot be deleted. */
export const MAIL_LIST = 'mail'

export const tasks$ = observable({
  items: [] as Task[],
  loaded: false,
  loading: false,
  /** Whether the list currently includes finished tasks. */
  includeCompleted: false,
  lists: [] as TaskList[],
  /** Which list is shown: 'all', or a list's id. */
  selectedList: 'all',
  search: '',
})

/** A list's name as the reader sees it: the mail list's is translated. */
export function listName(list: TaskList): string {
  return list.id === MAIL_LIST ? t('tasks.mailList', { defaultValue: 'Mail follow-up' }) : list.name
}

/** A task's title: its own, or for one tied to mail, its conversation's subject. */
export function taskTitle(task: Task): string {
  return task.title || task.subject || t('tasks.noSubject')
}

export async function loadTaskLists() {
  try {
    const res = await invoke<{ lists?: TaskList[] }>('tasks.lists', {})
    tasks$.lists.set(res?.lists ?? [])
  } catch {
    // Unreadable lists are not no lists; what was shown stays.
  }
}

async function listCall(method: string, payload: Record<string, unknown>) {
  try {
    const res = await invoke<{ id?: string }>(method, payload)
    await loadTaskLists()
    return res
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('tasks.saveFailed'), 'error')
    return null
  }
}

export async function createTaskList(name: string) {
  const res = await listCall('tasks.createList', { name })
  if (res?.id) tasks$.selectedList.set(res.id)
}

export const renameTaskList = (id: string, name: string) => listCall('tasks.renameList', { id, name })

export async function deleteTaskList(id: string) {
  await listCall('tasks.deleteList', { id })
  tasks$.selectedList.set('all')
  await loadTasks()
}

export type TaskWrite =
  | { kind: 'saved' }
  | { kind: 'failed' }
  | { kind: 'conflict'; current: (TaskFields & { revision: number }) | null }

/** A standalone task in a list. */
export async function createTask(fields: TaskFields): Promise<TaskWrite> {
  try {
    await invoke('tasks.create', { task: fields })
    await Promise.all([loadTasks(), loadTaskLists()])
    return { kind: 'saved' }
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('tasks.saveFailed'), 'error')
    return { kind: 'failed' }
  }
}

/**
 * Edits a task from the revision it was read at. If it changed in another
 * window, nothing is saved and the current copy comes back (ADR-0012).
 */
export async function updateTask(id: number, revision: number, fields: TaskFields): Promise<TaskWrite> {
  try {
    const res = await invoke<{ conflict?: boolean; current?: (TaskFields & { revision: number }) | null }>(
      'tasks.update',
      { id, revision, task: fields },
    )
    if (res?.conflict) return { kind: 'conflict', current: res.current ?? null }
    await Promise.all([loadTasks(), loadTaskLists()])
    return { kind: 'saved' }
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('tasks.saveFailed'), 'error')
    return { kind: 'failed' }
  }
}

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
export type StoredTask = Partial<TaskFields> & {
  due_at: number | null
  note: string
  revision?: number
  linked?: boolean
}

export async function getTask(id: number): Promise<StoredTask | null | 'failed'> {
  try {
    return await invoke('tasks.get', { id })
  } catch {
    // Not the same as "no such task": the caller must not go on as if the
    // note were blank, or saving would overwrite the real one.
    return 'failed'
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
