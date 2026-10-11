// The address book as the Personas view reads it, and the local book it can
// write to (ADR-0012). Synced books — a CardDAV server's, Google's — stay
// read-only here until writing back to them exists.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { showToast } from './ui'
import type { Person } from '../types'

export const people$ = observable({
  people: [] as Person[],
  loaded: false,
  loading: false,
  query: '',
  selectedId: '',
  /** The person being written, or null when the editor is closed. */
  editing: null as PersonEditing | null,
})

/** What the editor holds: the fields, and which copy they were read from. */
export type PersonDraft = Pick<Person, 'name' | 'organisation' | 'note' | 'emails' | 'phones'>

export type PersonEditing = {
  /** Absent for a new person. */
  id?: string
  /** The version the draft was read at; absent for a new person. */
  version?: string
  draft: PersonDraft
  /**
   * Set when saving found the person changed elsewhere: nothing was saved,
   * and this is the copy that is there now (null if it was deleted).
   */
  conflict?: { current: (PersonDraft & { id: string; version: string }) | null }
}

export function emptyDraft(): PersonDraft {
  return { name: '', organisation: '', note: '', emails: [{ addr: '', label: '' }], phones: [] }
}

export function draftOf(person: Person): PersonDraft {
  return {
    name: person.name,
    organisation: person.organisation,
    note: person.note,
    emails: person.emails.map((email) => ({ ...email })),
    phones: person.phones.map((phone) => ({ ...phone })),
  }
}

type WriteAnswer = {
  ok?: boolean
  id?: string
  version?: string
  conflict?: boolean
  current?: (PersonDraft & { id: string; version: string }) | null
}

/**
 * Saves what the editor holds. On a conflict nothing is saved and the editor
 * stays open showing both copies; the reader chooses (ADR-0012).
 */
export async function savePerson(editing: PersonEditing): Promise<'saved' | 'conflict' | 'failed'> {
  try {
    const answer = await invoke<WriteAnswer>('people.save', {
      ...(editing.id ? { id: editing.id, version: editing.version ?? '' } : {}),
      person: editing.draft,
    })
    if (answer?.conflict) {
      people$.editing.set({ ...editing, conflict: { current: answer.current ?? null } })
      return 'conflict'
    }
    people$.editing.set(null)
    if (answer?.id) people$.selectedId.set(answer.id)
    await loadPeople()
    return 'saved'
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : t('people.saveFailed', { defaultValue: 'Could not save the contact.' }),
      'error',
    )
    return 'failed'
  }
}

/** Keeps this window's copy over the one saved elsewhere: saved from that version now. */
export function keepMine(editing: PersonEditing) {
  const current = editing.conflict?.current
  // Deleted elsewhere: keeping mine creates it again.
  return savePerson(current ? { ...editing, version: current.version, conflict: undefined } : { draft: editing.draft })
}

/** Drops this window's changes and shows the copy saved elsewhere. */
export async function keepSaved() {
  people$.editing.set(null)
  await loadPeople()
}

export async function deletePerson(person: Person): Promise<boolean> {
  try {
    const answer = await invoke<WriteAnswer>('people.delete', { id: person.id, version: person.version ?? '' })
    if (answer?.conflict) {
      showToast(
        t('people.deleteConflict', {
          defaultValue: 'This contact was changed in another window, so it was not deleted. Look at it again first.',
        }),
        'error',
      )
      await loadPeople()
      return false
    }
    people$.selectedId.set('')
    await loadPeople()
    return true
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : t('people.deleteFailed', { defaultValue: 'Could not delete the contact.' }),
      'error',
    )
    return false
  }
}

/** Read the book, or the part of it matching the query. */
export async function loadPeople(query = people$.query.peek()) {
  people$.loading.set(true)
  try {
    const res = await invoke<{ people?: Person[] }>('people.list', { query, limit: 2000 })
    // A stale answer to an earlier query must not overwrite a newer one.
    if (people$.query.peek() !== query) return
    people$.people.set(res?.people ?? [])
    people$.loaded.set(true)
  } catch {
    // An unreadable book is not an empty book: the list keeps what it had.
  } finally {
    if (people$.query.peek() === query) people$.loading.set(false)
  }
}

/** A short, honest name for where a person came from. */
export function sourceLabel(source: string): 'carddav' | 'google' | 'exchange' | 'local' {
  return source === 'carddav' || source === 'google' || source === 'exchange' ? source : 'local'
}
