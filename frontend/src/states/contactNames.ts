// Contact names as the reader chose to see them (SET-19, ADR-0052), and the
// address book's names for senders whose messages carried none.

import { useEffect } from 'react'
import { observable } from '@legendapp/state'
import { useValue } from '@legendapp/state/react'
import { invoke } from '../lib/bridge'
import i18n from '../lib/i18n'
import {
  formatName,
  resolveDisplay,
  resolveSort,
  sortByName,
  type NameDisplay,
  type NameParts,
  type NameSort,
} from '../lib/contactNames'
import { settings$ } from './settings'

function language(): string {
  return i18n.language || 'en'
}

/** The resolved preferences, read now (outside React). */
export function namePrefs(): { display: Exclude<NameDisplay, 'auto'>; sort: Exclude<NameSort, 'auto'> } {
  return {
    display: resolveDisplay(settings$.contactNameDisplay.peek(), language()),
    sort: resolveSort(settings$.contactNameSort.peek(), language()),
  }
}

/** The preferences as a component sees them, with the two things it does with them. */
export function useContactNames() {
  const displayChoice = useValue(settings$.contactNameDisplay)
  const sortChoice = useValue(settings$.contactNameSort)
  const lang = useValue(settings$.language) ?? language()
  const display = resolveDisplay(displayChoice, lang)
  const sort = resolveSort(sortChoice, lang)
  return {
    display,
    sort,
    format: (person: NameParts) => formatName(person, display),
    sorted: <T extends NameParts>(people: T[]) => sortByName(people, sort, lang),
  }
}

// ---- The book's names for senders ------------------------------------------

type BookName = { name: string; given?: string; family?: string }

/** addr (lower-cased) → the book's name, or null when the book has none. */
export const bookNames$ = observable<Record<string, BookName | null>>({})

const pending = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null

async function flush() {
  timer = null
  const addrs = [...pending]
  pending.clear()
  if (addrs.length === 0) return
  try {
    const res = await invoke<{ names?: Record<string, BookName> }>('people.names', { addrs })
    const found = res?.names ?? {}
    const next: Record<string, BookName | null> = {}
    for (const addr of addrs) next[addr] = found[addr] ?? null
    bookNames$.assign(next)
  } catch {
    // Unknown is not "nobody": asked again next time the row is drawn.
  }
}

/** Ask, once and batched with the other rows on screen, for an address's book name. */
export function requestBookName(addr: string) {
  const key = addr.trim().toLowerCase()
  if (!key.includes('@') || key in bookNames$.peek() || pending.has(key)) return
  pending.add(key)
  if (!timer) timer = setTimeout(() => void flush(), 50)
}

/** Forget what was looked up, after the address book changed. */
export function clearBookNames() {
  bookNames$.set({})
}

/**
 * A sender's name for a list: the message's own when it has one (never
 * rewritten), else the address book's in the reader's order, else nothing.
 */
export function useSenderName(headerName: string, addr: string, lookUp = true): string {
  const key = addr.trim().toLowerCase()
  const known = useValue(() => (headerName.trim() || !lookUp ? undefined : bookNames$[key].get()))
  const { format } = useContactNames()
  const ask = !headerName.trim() && lookUp && !!key && known === undefined
  useEffect(() => {
    if (ask) requestBookName(key)
  }, [ask, key])
  if (headerName.trim()) return headerName
  return known ? format(known) : ''
}
