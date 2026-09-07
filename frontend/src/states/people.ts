// The address book as the Personas view reads it.
//
// Everything here is a read: the books are somebody else's — a CardDAV
// server's, Google's — and writing back to them is its own feature. What the
// view can do is find people, look at them, and write to them.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import type { Person } from '../types'

export const people$ = observable({
  people: [] as Person[],
  loaded: false,
  loading: false,
  query: '',
  selectedId: '',
})

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
