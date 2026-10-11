// The search box's grammar as fields (#43, ADR-0021). The core reads and
// writes it; this side only edits the parts, so a search built here means
// exactly what the same search typed would.
import { invoke } from '../lib/bridge'

export type SearchFlag = 'unread' | 'read' | 'starred' | 'hasAttachment'

export type SearchQuery = {
  text: string
  from: string[]
  to: string[]
  subject: string[]
  flags: SearchFlag[]
  label: string | null
  /** UTC midnight of the first day, seconds. */
  after: number | null
  /** UTC midnight of the day after the last, seconds. */
  before: number | null
}

export const EMPTY_QUERY: SearchQuery = {
  text: '',
  from: [],
  to: [],
  subject: [],
  flags: [],
  label: null,
  after: null,
  before: null,
}

export async function readQuery(text: string): Promise<SearchQuery> {
  const res = await invoke<{ query: SearchQuery }>('search.parse', { query: text })
  return { ...EMPTY_QUERY, ...res.query }
}

export async function writeQuery(query: SearchQuery): Promise<string> {
  const res = await invoke<{ text: string }>('search.compose', { query })
  return res.text
}

/** A day picked in a date field (`YYYY-MM-DD`) as the core counts days. */
export function dayToSeconds(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const at = Date.parse(`${day}T00:00:00Z`)
  return Number.isNaN(at) ? null : at / 1000
}

export function secondsToDay(at: number | null): string {
  return at === null ? '' : new Date(at * 1000).toISOString().slice(0, 10)
}
