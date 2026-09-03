// Where people are fetched from: for now, CardDAV address books.
//
// The core owns the sources and their passwords (in the keyring, never here).
// This is the settings screen's view of them and the calls it makes.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'

export type ContactSource = {
  id: string
  kind: 'carddav'
  account: string
  url: string
  username: string
  name: string
  enabled: boolean
  lastSyncAt: number
  /** Why the last sync failed; empty when it did not. */
  lastError: string
}

export type DiscoveredBook = { url: string; name: string }

export const contactSources$ = observable({
  sources: [] as ContactSource[],
  loaded: false,
})

export async function loadContactSources() {
  try {
    const res = await invoke<{ sources?: ContactSource[] }>('carddav.list', {})
    contactSources$.sources.set(res?.sources ?? [])
    contactSources$.loaded.set(true)
  } catch {
    // Unreadable is not empty: showing none would invite adding them again.
  }
}

/**
 * Ask a server which address books it holds for these credentials.
 *
 * The password goes to the core for this one call and is not kept anywhere
 * until a book is actually added.
 */
export function discoverBooks(server: string, username: string, password: string) {
  return invoke<{ books: DiscoveredBook[] }>('carddav.discover', { server, username, password }).then(
    (res) => res.books,
  )
}

/** Keep a book. Returns the error of the first read, if it failed. */
export async function addBook(book: DiscoveredBook, username: string, password: string): Promise<string | null> {
  const res = await invoke<{ id: string; synced: boolean; error: string | null }>('carddav.add', {
    url: book.url,
    name: book.name,
    username,
    password,
  })
  await loadContactSources()
  return res.synced ? null : (res.error ?? 'sync failed')
}

export async function syncSource(id: string): Promise<string | null> {
  const res = await invoke<{ ok: boolean; error: string | null }>('carddav.sync', { id })
  await loadContactSources()
  return res.ok ? null : (res.error ?? 'sync failed')
}

export async function removeSource(id: string) {
  await invoke('carddav.remove', { id })
  await loadContactSources()
}
