// The address book as the Personas view reads it, and the local book it can
// write to (ADR-0012). Synced books — a CardDAV server's, Google's — stay
// read-only here until writing back to them exists.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { showToast } from './ui'
import type { ContactGroup, Person } from '../types'
import { clearBookNames } from './contactNames'

export const people$ = observable({
  people: [] as Person[],
  loaded: false,
  loading: false,
  query: '',
  selectedId: '',
  /** The person being written, or null when the editor is closed. */
  editing: null as PersonEditing | null,
  /** A .vcf read and waiting for the reader to confirm, or null. */
  importing: null as VcfImport | null,
  /** People who share an address and may be one person (ADR-0012). */
  duplicates: [] as DuplicateGroup[],
  duplicatesOpen: false,
  /** Contact groups (ADR-0052), and the one the list is showing ('' for everybody). */
  groups: [] as ContactGroup[],
  groupsLoaded: false,
  groupFilter: '',
  /** The group being named, or null when that dialog is closed. */
  groupEditing: null as GroupEditing | null,
})

/** A group being created or renamed. */
export type GroupEditing = {
  /** Absent for a new group. */
  id?: string
  version?: string
  name: string
  /** Where a new group is kept: a CardDAV source's id, or '' for this computer. */
  book: string
  members: string[]
}

export type DuplicateGroup = { id: string; name: string; source: string; book: string; emails: { addr: string }[] }[]

/**
 * The list as the reader sees it: people linked as one show once, by the
 * first of them in the list's order. The others stay reachable from the card.
 */
export function collapseLinked(people: Person[]): Person[] {
  const seen = new Set<string>()
  return people.filter((person) => {
    if (!person.link) return true
    if (seen.has(person.link)) return false
    seen.add(person.link)
    return true
  })
}

export async function loadDuplicates() {
  try {
    const res = await invoke<{ groups?: DuplicateGroup[] }>('people.duplicates', {})
    people$.duplicates.set(res?.groups ?? [])
  } catch {
    people$.duplicates.set([])
  }
}

async function linkCall(method: string, payload: Record<string, unknown>) {
  try {
    await invoke(method, payload)
    await Promise.all([loadPeople(), loadDuplicates()])
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : t('people.saveFailed', { defaultValue: 'Could not save the contact.' }),
      'error',
    )
  }
}

export const linkPeople = (ids: string[]) => linkCall('people.link', { ids })
export const unlinkPerson = (id: string) => linkCall('people.unlink', { id })
export const notTheSame = (ids: string[]) => linkCall('people.dismissDuplicate', { ids })

/** What a .vcf would bring in (ADR-0012): nothing is stored until confirmed. */
export type VcfImport = {
  path: string
  people: { name: string; organisation: string; emails: { addr: string; label: string }[] }[]
  skipped: number
  /** Where they go: a CardDAV source's id, or empty for this computer. */
  book: string
}

/** Picks a .vcf and shows what it holds. */
export async function startVcfImport() {
  try {
    const res = await invoke<Partial<VcfImport> & { cancelled?: boolean }>('people.importVcf', {})
    if (!res || res.cancelled || !res.path) return
    people$.importing.set({ path: res.path, people: res.people ?? [], skipped: res.skipped ?? 0, book: '' })
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : t('people.importFailed', { defaultValue: 'Could not read the file.' }),
      'error',
    )
  }
}

/** Stores the previewed people, then says how it went. */
export async function confirmVcfImport(pending: VcfImport) {
  try {
    const res = await invoke<{ imported?: number; duplicates?: number; skipped?: number; stopped?: string | null }>(
      'people.importVcf',
      { path: pending.path, confirm: true, book: pending.book },
    )
    people$.importing.set(null)
    await loadPeople()
    const summary = t('people.importDone', {
      imported: res?.imported ?? 0,
      duplicates: res?.duplicates ?? 0,
      defaultValue:
        '{imported, plural, one {# contact imported} other {# contacts imported}}{duplicates, plural, =0 {} other {; # already there}}.',
    })
    if (res?.stopped)
      showToast(
        `${summary} ${t('people.importStopped', { reason: res.stopped, defaultValue: 'Then it stopped: {reason}' })}`,
        'error',
      )
    else showToast(summary)
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : t('people.importFailed', { defaultValue: 'Could not read the file.' }),
      'error',
    )
  }
}

/** Writes the given people (everybody when none) to a .vcf the reader picks. */
export async function exportVcf(ids?: string[]) {
  try {
    const res = await invoke<{ saved?: boolean; count?: number }>('people.exportVcf', ids ? { ids } : {})
    if (res?.saved) {
      showToast(
        t('people.exportDone', {
          count: res.count ?? 0,
          defaultValue: '{count, plural, one {# contact exported} other {# contacts exported}}.',
        }),
      )
    }
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : t('people.exportFailed', { defaultValue: 'Could not export.' }),
      'error',
    )
  }
}

/** What the editor holds: the fields, and which copy they were read from. */
export type PersonDraft = Pick<Person, 'name' | 'organisation' | 'note' | 'emails' | 'phones'> & {
  given: string
  family: string
}

export type PersonEditing = {
  /** Absent for a new person. */
  id?: string
  /**
   * Where a new person is saved: a CardDAV or Exchange source's id, or
   * absent for the local book. An existing person stays in the book it is in.
   */
  book?: string
  /** For an existing person in a server book: that book's source id. */
  serverBook?: string
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
  return { name: '', given: '', family: '', organisation: '', note: '', emails: [{ addr: '', label: '' }], phones: [] }
}

export function draftOf(person: Person): PersonDraft {
  return {
    name: person.name,
    given: person.given ?? '',
    family: person.family ?? '',
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
      ...(!editing.id && editing.book ? { book: editing.book } : {}),
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
  // Deleted elsewhere: keeping mine creates it again, in the book it was in.
  return savePerson(
    current
      ? { ...editing, version: current.version, conflict: undefined }
      : { draft: editing.draft, book: editing.book ?? editing.serverBook },
  )
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
    // A name may have changed: the mail list asks the book again.
    clearBookNames()
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

// ---- Groups (ADR-0052) -------------------------------------------------------

export async function loadGroups() {
  try {
    const res = await invoke<{ groups?: ContactGroup[] }>('people.groups', {})
    people$.groups.set(res?.groups ?? [])
    people$.groupsLoaded.set(true)
  } catch {
    // Unreadable is not empty: the list keeps what it had.
  }
}

/** The groups a person can be added to: their own book's, and every local one. */
export function groupsFor(person: Person, groups: ContactGroup[]): ContactGroup[] {
  return groups.filter((group) => group.editable && (group.source === 'local' || group.book === person.book))
}

type GroupAnswer = { ok?: boolean; id?: string; version?: string; conflict?: boolean }

function groupConflict() {
  showToast(
    t('people.groupConflict', {
      defaultValue: 'This group was changed somewhere else, so nothing was saved. Look at it again and retry.',
    }),
    'error',
  )
}

function groupFailed(error: unknown) {
  showToast(
    error instanceof Error ? error.message : t('people.groupSaveFailed', { defaultValue: 'Could not save the group.' }),
    'error',
  )
}

/**
 * Creates a group or renames one and sets its members, from the version it
 * was read at. A change made elsewhere meanwhile saves nothing (ADR-0012).
 */
export async function saveGroup(editing: GroupEditing): Promise<boolean> {
  try {
    const answer = await invoke<GroupAnswer>('people.groupSave', {
      ...(editing.id ? { id: editing.id, version: editing.version ?? '' } : editing.book ? { book: editing.book } : {}),
      name: editing.name.trim(),
      members: editing.members,
    })
    await loadGroups()
    if (answer?.conflict) {
      groupConflict()
      return false
    }
    if (answer?.id && !editing.id) people$.groupFilter.set(answer.id)
    return true
  } catch (error) {
    groupFailed(error)
    return false
  }
}

/** Adds a person to a group or takes them out of it. */
export function setMembership(group: ContactGroup, personId: string, member: boolean) {
  const ids = group.members.map((m) => m.id).filter((id) => id !== personId)
  return saveGroup({
    id: group.id,
    version: group.version,
    name: group.name,
    book: group.book,
    members: member ? [...ids, personId] : ids,
  })
}

export async function deleteGroup(group: ContactGroup): Promise<boolean> {
  try {
    const answer = await invoke<GroupAnswer>('people.groupDelete', { id: group.id, version: group.version })
    await loadGroups()
    if (answer?.conflict) {
      groupConflict()
      return false
    }
    if (people$.groupFilter.peek() === group.id) people$.groupFilter.set('')
    return true
  } catch (error) {
    groupFailed(error)
    return false
  }
}

/** The recipients a group expands to: each member's first address, once. */
export function groupRecipients(
  group: ContactGroup,
): { name: string; given?: string; family?: string; addr: string }[] {
  const seen = new Set<string>()
  return group.members.filter((member) => {
    const key = member.addr.trim().toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
