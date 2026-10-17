// Where people are fetched from: CardDAV address books, and the books of
// Google and Exchange accounts.
//
// The core owns the sources and their passwords (in the keyring, never here).
// This is the settings screen's view of them and the calls it makes.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'

export type ContactSource = {
  id: string
  kind: 'carddav' | 'google' | 'exchange'
  account: string
  url: string
  username: string
  name: string
  enabled: boolean
  lastSyncAt: number
  /** Why the last sync failed; empty when it did not. */
  lastError: string
  /** Whether the server lets this account write to it; null when it has not said. */
  writable?: boolean | null
}

/**
 * The books a new contact can be saved to on a server: writable CardDAV
 * books (ADR-0012), and an Exchange account's Contacts folder and the
 * contact folders under it (ADR-0064).
 */
export function writableBooks(sources: ContactSource[]): ContactSource[] {
  return sources.filter(
    (source) => source.enabled && (source.kind === 'exchange' || (source.kind === 'carddav' && source.writable !== false)),
  )
}

/**
 * A contact folder under an Exchange account's Contacts folder: read with
 * the account's book, and removed with it rather than on its own (ADR-0064).
 */
export function isExchangeFolderBook(source: ContactSource): boolean {
  return source.kind === 'exchange' && source.url !== ''
}

/**
 * The books a new contact group can be kept in: writable CardDAV books, and
 * an Exchange account's book, whose groups are its distribution lists
 * (ADR-0058).
 */
export function groupBooks(sources: ContactSource[]): ContactSource[] {
  return sources.filter(
    (source) => source.enabled && (source.kind === 'exchange' || (source.kind === 'carddav' && source.writable !== false)),
  )
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

/**
 * Read a Google account's contacts with the token it already holds.
 *
 * One source per account: asking again re-reads rather than doubling
 * everybody. Returns why it failed, or null — and a token from before the
 * contacts permission existed fails with a sentence that says to reconnect.
 */
export async function syncGoogleContacts(accountId: string, name: string): Promise<string | null> {
  const res = await invoke<{ ok: boolean; error: string | null }>('google.contacts.sync', {
    account: accountId,
    name,
  })
  await loadContactSources()
  return res.ok ? null : (res.error ?? 'sync failed')
}

/**
 * Read an Exchange account's Contacts folder and its distribution lists
 * (ADR-0058) with the account's own sign-in, and each contact folder under
 * it as a book of its own (ADR-0064). Returns why it failed, or null.
 */
export async function syncExchangeContacts(accountId: string, name: string): Promise<string | null> {
  const res = await invoke<{ ok: boolean; error: string | null }>('exchange.contacts.sync', {
    account: accountId,
    name,
  })
  await loadContactSources()
  return res.ok ? null : (res.error ?? 'sync failed')
}
