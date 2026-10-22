// Standalone notes (#104, ADR-0015): kept on this computer, owned by no
// account. Every save names the revision it was made from; a note changed
// elsewhere meanwhile is not overwritten — both versions are shown instead
// (the ADR-0012 policy).
import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { showToast } from './ui'

export type NoteSummary = {
  id: string
  title: string
  preview: string
  tags: string[]
  pinned: boolean
  revision: number
  updated_at: number
  deleted_at: number | null
}

export type Note = {
  id: string
  title: string
  html: string
  text: string
  tags: string[]
  pinned: boolean
  revision: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export type NoteFields = { title: string; html: string; tags: string[]; pinned: boolean }

export type NoteWrite =
  | { status: 'saved'; note: Note }
  | { status: 'conflict'; stored: Note }
  | { status: 'gone' }
  | { status: 'failed'; message: string }

/** `'new'` while a note being written has not been stored yet. */
export type NoteSelection = string | 'new' | null

export const notes$ = observable({
  items: [] as NoteSummary[],
  tags: [] as { tag: string; count: number }[],
  loaded: false,
  search: '',
  tag: '',
  trash: false,
  selected: null as NoteSelection,
})

/** Shown in lists where a note has no title of its own. */
export function noteTitle(note: Pick<NoteSummary, 'title' | 'preview'>): string {
  return note.title || note.preview.slice(0, 60) || t('notes.untitled', { defaultValue: 'Untitled note' })
}

/** Tags as typed in one box: commas or spaces between them, `#` optional. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[,\s]+/)) {
    const tag = raw.replace(/^#+/, '').trim()
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
  }
  return out
}

// Each load's reply may come back after a later one's (the core answers each
// request on its own task); only the latest load may fill the list.
let loadSeq = 0

export async function loadNotes() {
  const seq = ++loadSeq
  try {
    // The trash is not filtered by tag (#335): the tags are not offered there,
    // so a tag chosen before is kept for the way back and not applied.
    const trash = notes$.trash.peek()
    const res = await invoke<{ notes: NoteSummary[]; tags: { tag: string; count: number }[] }>('notes.list', {
      search: notes$.search.peek(),
      tag: trash ? '' : notes$.tag.peek(),
      trash,
    })
    if (seq !== loadSeq) return
    const tags = res?.tags ?? []
    notes$.items.set(res?.notes ?? [])
    notes$.tags.set(tags)
    // A chosen tag that no note carries any more (its last note was edited or
    // trashed) would leave the list empty with no row to clear it from: drop
    // it, which loads every note again. The tags are counted over all notes,
    // whatever the search, so this only happens when the tag is really gone.
    const chosen = notes$.tag.peek()
    if (!trash && chosen && !tags.some((entry) => entry.tag === chosen)) notes$.tag.set('')
  } catch {
    if (seq !== loadSeq) return
    showToast(t('notes.couldNotLoad', { defaultValue: 'Could not load notes' }), 'error')
  } finally {
    notes$.loaded.set(true)
  }
}

export async function getNote(id: string): Promise<Note | null> {
  const res = await invoke<{ note: Note | null }>('notes.get', { id })
  return res?.note ?? null
}

function failure(error: unknown): NoteWrite {
  return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
}

/** Stores a new note, or an edit made from `revision`. */
export async function writeNote(id: string | null, revision: number, fields: NoteFields): Promise<NoteWrite> {
  try {
    if (!id) {
      const res = await invoke<{ note: Note }>('notes.create', { note: fields })
      return { status: 'saved', note: res.note }
    }
    return await invoke<NoteWrite>('notes.update', { id, revision, note: fields })
  } catch (error) {
    return failure(error)
  }
}

async function act(command: string, payload: Record<string, unknown>, failed: string) {
  try {
    await invoke(command, payload)
    return true
  } catch {
    showToast(failed, 'error')
    return false
  } finally {
    await loadNotes()
  }
}

export async function pinNote(id: string, pinned: boolean) {
  return act('notes.pin', { id, pinned }, t('notes.couldNotSave', { defaultValue: 'Could not save the note' }))
}

export async function trashNote(id: string) {
  const done = await act(
    'notes.trash',
    { id },
    t('notes.couldNotDelete', { defaultValue: 'Could not delete the note' }),
  )
  if (done) {
    if (notes$.selected.peek() === id) notes$.selected.set(null)
    showToast(t('notes.trashed', { defaultValue: 'Moved to the trash' }))
  }
  return done
}

export async function restoreNote(id: string) {
  const done = await act(
    'notes.restore',
    { id },
    t('notes.couldNotRestore', { defaultValue: 'Could not restore the note' }),
  )
  if (done && notes$.selected.peek() === id) notes$.selected.set(null)
  return done
}

export async function purgeNote(id: string) {
  const done = await act(
    'notes.purge',
    { id },
    t('notes.couldNotDelete', { defaultValue: 'Could not delete the note' }),
  )
  if (done && notes$.selected.peek() === id) notes$.selected.set(null)
  return done
}
