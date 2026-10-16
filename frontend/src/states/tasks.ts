// Local, message-tied to-dos: load the list, and record what the reader does
// with one. Message-tied only — every task carries the conversation it hangs
// off, there is no freestanding task unconnected to any mail.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { showToast } from './ui'
import { t } from '../lib/i18n'
import type { Recurrence } from './calendar'

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
  /** ADR-0039, in a list kept on a server: a change made here not sent yet. */
  pending?: '' | 'put' | 'delete'
  /** Why it waits for a choice: 'changed' (here and on the server) or
   * 'deleted' (on the server); empty when it does not. */
  conflict?: string
  /** It repeats in a way not edited here (ADR-0039, ADR-0053): extra dates,
   * changed occurrences, or a rule beyond the editor's. */
  recurring?: boolean
  /** How it repeats, when the editor can change it (ADR-0053). */
  recurrence?: Recurrence | null
}

export type TaskList = {
  id: string
  name: string
  position: number
  open: number
  /** ADR-0039: the CalDAV collection the list is kept in; empty or absent
   * for a list kept only here. */
  remote_url?: string
  remote_user?: string
  synced_at?: number | null
  last_error?: string
  conflicts?: number
  /** ADR-0058: the Exchange account whose Tasks folder the list is; empty
   * or absent for any other list. */
  ews_account?: string
}

/** One collection a CalDAV server offers. */
export type RemoteTaskCollection = { url: string; name: string; color?: string | null; writable?: boolean | null }

export type TaskListSync = { id: string; ok: boolean; error?: string }

/** The fields a task is written with (ADR-0013). */
export type TaskFields = {
  list_id: string
  title: string
  note: string
  due_at: number | null
  reminder_at: number | null
  priority: number
  /** How it repeats (ADR-0053); null or absent when it does not. */
  recurrence?: Recurrence | null
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
  /** A sync of the lists kept on a server is running. */
  syncing: false,
})

/** Whether a list is kept on a server: a CalDAV collection (ADR-0039) or
 * an Exchange account's Tasks folder (ADR-0058). */
export function isRemoteList(list: TaskList | undefined): boolean {
  return !!list?.remote_url || !!list?.ews_account
}

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

/** Whether a task repeats in a way this app completes one occurrence at a time. */
export function repeats(task: Pick<Task, 'recurrence' | 'completed_at'>): boolean {
  return !!task.recurrence && !task.completed_at
}

/**
 * Completes a task or reopens it. A repeating task completes the occurrence
 * due and moves on to the next one, keeping a completed copy as the record;
 * `stopRepeating` ends the repetition and completes it instead (ADR-0053).
 */
export async function setTaskCompleted(id: number, completed: boolean, options: { stopRepeating?: boolean } = {}) {
  try {
    const res = await invoke<{ next_due?: number | null }>('tasks.setCompleted', {
      id,
      completed,
      ...(options.stopRepeating ? { stop_repeating: true } : {}),
    })
    await loadTasks()
    if (completed && res?.next_due) {
      showToast(
        t('tasks.nextOccurrence', {
          date: new Date(res.next_due * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' }),
          defaultValue: 'Done. Next due {date}.',
        }),
      )
    }
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

// ---- Lists kept on a CalDAV server (ADR-0039) ---------------------------------

/** The collections on a server, for choosing one. Throws with the reason. */
export async function discoverTaskCollections(
  server: string,
  username: string,
  password: string,
): Promise<RemoteTaskCollection[]> {
  const res = await invoke<{ calendars?: RemoteTaskCollection[] }>('tasks.caldavDiscover', {
    server,
    username,
    password,
  })
  return res?.calendars ?? []
}

/** A new list bound to a collection, read once. Throws if it could not be. */
export async function addCalDavTaskList(input: {
  url: string
  name: string
  server: string
  username: string
  password: string
}): Promise<string> {
  const res = await invoke<{ id?: string }>('tasks.caldavAdd', input)
  await Promise.all([loadTaskLists(), loadTasks()])
  if (res?.id) tasks$.selectedList.set(res.id)
  return res?.id ?? ''
}

/**
 * Keeps an Exchange account's Tasks folder as a list (ADR-0058), read once
 * before it is added. Returns the new list's id, or throws why it could not
 * be read.
 */
export async function addExchangeTaskList(account: string, name: string): Promise<string> {
  const res = await invoke<{ id?: string }>('tasks.exchangeAdd', { account, name })
  await Promise.all([loadTaskLists(), loadTasks()])
  if (res?.id) tasks$.selectedList.set(res.id)
  return res?.id ?? ''
}

/**
 * Syncs one list kept on a server, or every one. A failure is kept on the
 * list (`last_error`) and shown there; it is not a toast, since opening the
 * Tasks view offline is not something to interrupt anyone about.
 */
export async function syncTaskLists(listId?: string): Promise<TaskListSync[]> {
  tasks$.syncing.set(true)
  try {
    const res = await invoke<{ lists?: TaskListSync[] }>('tasks.sync', listId ? { list_id: listId } : {})
    const results = res?.lists ?? []
    if (results.length > 0) await Promise.all([loadTaskLists(), loadTasks()])
    return results
  } catch (error) {
    if (listId)
      showToast(
        error instanceof Error ? error.message : t('tasks.syncFailed', { defaultValue: 'Sync failed' }),
        'error',
      )
    return []
  } finally {
    tasks$.syncing.set(false)
  }
}

/** Settles a conflict with one copy, then syncs the list. */
export async function resolveTaskConflict(id: number, keep: 'mine' | 'server') {
  try {
    await invoke('tasks.resolveConflict', { id, keep })
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('tasks.saveFailed'), 'error')
  }
  await Promise.all([loadTaskLists(), loadTasks()])
}
