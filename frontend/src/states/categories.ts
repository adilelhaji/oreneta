// Inbox categories (#91, ADR-0023): tabs the reader defines, where every
// conversation is and why, and the reader's corrections.
//
// The core decides and remembers; this only asks it. A category is neither a
// label (several per conversation, may be linked to a server) nor priority
// (the "worth interrupting for" filter): its facet is its own, `category:<id>`,
// and `category:none` is Other, which is always offered.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { loadThreads, mail$ } from './mail'
import { showToast, ui$, type FilterFacet } from './ui'
import { unifiedAccounts } from './accounts'
import { UNIFIED_ACCOUNT } from '../lib/unifiedFolders'

export type ConditionField = 'from' | 'to' | 'cc' | 'recipient' | 'subject'
export type ConditionOp = 'contains' | 'notContains' | 'is' | 'startsWith' | 'endsWith'
export type CategoryCondition = { field: ConditionField; op: ConditionOp; value: string }

export type Category = {
  id: string
  name: string
  colour: string
  matchMode: 'any' | 'all'
  conditions: CategoryCondition[]
}

export type CategoryReason =
  | { kind: 'conversation' }
  | { kind: 'sender'; addr: string }
  | { kind: 'conditions'; held: number[] }
  | { kind: 'nothingMatched' }

export type CategoryVerdict = { category: string; reason: CategoryReason; sender: string }

export type CategoryCount = { category: string; conversations: number; unread: number }
export type CategoryCounts = { counts: CategoryCount[]; conversations: number; messages: number }

export const MAX_CATEGORIES = 12
/** The facet of Other, which the core reads as the empty category. */
export const OTHER = 'none'

export const categories$ = observable({
  list: [] as Category[],
  loaded: false,
  counts: null as CategoryCounts | null,
})

export function newCategory(existing: Category[]): Category {
  const colours = ['#2056dd', '#0f9d58', '#e8830c', '#c2255c', '#7048e8', '#0b7285', '#5c7cfa', '#868e96']
  return {
    id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    colour: colours[existing.length % colours.length],
    matchMode: 'any',
    conditions: [],
  }
}

/** Why a set cannot be saved, as the core would say it, before asking it. */
export function categoryProblem(list: Category[]): 'tooMany' | 'name' | 'sameName' | 'emptyCondition' | null {
  if (list.length > MAX_CATEGORIES) return 'tooMany'
  const names = new Set<string>()
  for (const category of list) {
    const name = category.name.trim().toLowerCase()
    if (!name) return 'name'
    if (names.has(name)) return 'sameName'
    names.add(name)
    if (category.conditions.some((c) => !c.value.trim())) return 'emptyCondition'
  }
  return null
}

export async function loadCategories() {
  try {
    const res = await invoke<{ categories?: Category[] }>('categories.list', {})
    categories$.list.set(res?.categories ?? [])
    categories$.loaded.set(true)
    dropStaleFacet()
  } catch {
    // Not read is not none: the tabs stay as they were.
  }
}

export async function saveCategories(list: Category[]): Promise<boolean> {
  try {
    const res = await invoke<{ categories?: Category[] }>('categories.save', { categories: list })
    categories$.list.set(res?.categories ?? list)
    dropStaleFacet()
    await refreshCategoryCounts()
    await loadThreads(false)
    return true
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : t('categories.saveFailed', { defaultValue: 'Could not save the categories' }),
      'error',
    )
    return false
  }
}

/** The category facet in a filter set: an id, OTHER, or null for all. */
export function activeCategory(filters: FilterFacet[]): string | null {
  const facet = filters.find((f) => f.startsWith('category:'))
  return facet ? facet.slice('category:'.length) : null
}

/** Shows one category (or Other), or all with `null`, keeping other facets. */
export function showCategory(id: string | null) {
  const rest = ui$.filters.peek().filter((f) => !f.startsWith('category:'))
  ui$.filters.set(id === null ? rest : [...rest, `category:${id}` as FilterFacet])
}

/** A tab whose category is gone, or a tab where tabs are not shown, filters nothing anyone can see. */
export function dropStaleFacet(tabsShown = true) {
  const active = activeCategory(ui$.filters.peek())
  if (active === null) return
  const known = active === OTHER || categories$.list.peek().some((c) => c.id === active)
  if (!tabsShown || !known) showCategory(null)
}

function inboxOf(accountId: string): string | null {
  const folders = mail$.foldersByAccount[accountId].peek() ?? []
  const inbox = folders.find((f) => f.role === 'inbox' || f.id.toLowerCase() === 'inbox')
  return inbox?.id ?? null
}

/** Counts for the inbox in view; for the unified inbox, every account's inbox together. */
export async function refreshCategoryCounts() {
  const account = ui$.selectedAccount.peek()
  const scopes: { account: string; folder: string }[] =
    account === UNIFIED_ACCOUNT
      ? unifiedAccounts().flatMap((a) => {
          const folder = inboxOf(a.id)
          return folder ? [{ account: a.id, folder }] : []
        })
      : [{ account, folder: ui$.selectedFolder.peek() }]
  try {
    const all = await Promise.all(scopes.map((scope) => invoke<CategoryCounts>('categories.counts', scope)))
    const merged = new Map<string, CategoryCount>()
    for (const counts of all) {
      for (const count of counts.counts) {
        const seen = merged.get(count.category) ?? { category: count.category, conversations: 0, unread: 0 }
        merged.set(count.category, {
          category: count.category,
          conversations: seen.conversations + count.conversations,
          unread: seen.unread + count.unread,
        })
      }
    }
    categories$.counts.set({
      counts: [...merged.values()],
      conversations: all.reduce((sum, c) => sum + c.conversations, 0),
      messages: all.reduce((sum, c) => sum + c.messages, 0),
    })
  } catch {
    // Counts that cannot be read are shown as unknown, not as zero.
    categories$.counts.set(null)
  }
}

export async function categoryReason(threadId: string): Promise<CategoryVerdict | null> {
  try {
    return await invoke<CategoryVerdict>('categories.reason', { thread_id: threadId })
  } catch {
    return null
  }
}

/**
 * Puts a conversation, or everything from its sender, in a category ('' is
 * Other); `null` hands it back to the rules.
 */
export async function assignCategory(threadId: string, category: string | null, scope: 'conversation' | 'sender') {
  try {
    await invoke('categories.assign', { thread_id: threadId, category, scope })
    await refreshCategoryCounts()
    await loadThreads(false)
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : t('categories.assignFailed', { defaultValue: 'Could not move it' }),
      'error',
    )
  }
}

const FIELD_WORDS: Record<ConditionField, string> = {
  from: 'From',
  to: 'To',
  cc: 'Cc',
  recipient: 'Any recipient',
  subject: 'Subject',
}
const OP_WORDS: Record<ConditionOp, string> = {
  contains: 'contains',
  notContains: 'does not contain',
  is: 'is',
  startsWith: 'starts with',
  endsWith: 'ends with',
}

export const fieldLabel = (field: ConditionField) =>
  t(`categories.field.${field}`, { defaultValue: FIELD_WORDS[field] ?? field })
export const opLabel = (op: ConditionOp) => t(`categories.op.${op}`, { defaultValue: OP_WORDS[op] ?? op })
