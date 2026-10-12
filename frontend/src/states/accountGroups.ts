// Account groups (#99, ADR-0040): named views over chosen accounts. A group
// is shown through the unified view, limited to its own accounts; it moves,
// copies and stores nothing, and an account can be in several groups.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import type { Account } from '../types'
import { ui$ } from './ui'

export type AccountGroup = { id: string; name: string; accounts: string[] }

export const ACCOUNT_GROUPS_KEY = 'account_groups'
export const ACCOUNT_GROUP_KEYS = [ACCOUNT_GROUPS_KEY]

export const accountGroups$ = observable({
  groups: [] as AccountGroup[],
  /** The group the unified view is limited to; null shows every included account. */
  active: null as string | null,
})

function parseGroups(value: unknown): AccountGroup[] {
  const list = typeof value === 'string' ? safeParse(value) : value
  if (!Array.isArray(list)) return []
  return list
    .filter(
      (g): g is AccountGroup =>
        !!g &&
        typeof g.id === 'string' &&
        typeof g.name === 'string' &&
        Array.isArray(g.accounts) &&
        g.accounts.every((a: unknown) => typeof a === 'string'),
    )
    .map((g) => ({ id: g.id, name: g.name, accounts: [...new Set(g.accounts)] }))
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function hydrateAccountGroups(prefs: Record<string, unknown>) {
  accountGroups$.groups.set(parseGroups(prefs[ACCOUNT_GROUPS_KEY]))
}

function persist() {
  void invoke('app.prefsSet', { key: ACCOUNT_GROUPS_KEY, value: accountGroups$.groups.peek() }).catch(() => {})
}

export function activeGroup(): AccountGroup | null {
  const id = accountGroups$.active.get()
  return (id && accountGroups$.groups.get().find((g) => g.id === id)) || null
}

/**
 * Whether an account belongs in the unified view as it is now: in the active
 * group when one is chosen (whatever its unified-inbox setting, since the
 * group names it), otherwise when it is included in the unified inbox.
 */
export function inUnifiedScope(account: Pick<Account, 'id' | 'included_in_unified'>): boolean {
  const group = activeGroup()
  if (group) return group.accounts.includes(account.id)
  return account.included_in_unified !== false
}

/** Accounts of a group that still exist, in the order the sidebar shows them. */
export function groupAccounts<T extends Pick<Account, 'id'>>(group: AccountGroup, accounts: T[]): T[] {
  return accounts.filter((account) => group.accounts.includes(account.id))
}

export function createGroup(name: string, accounts: string[]): string | null {
  const clean = name.trim()
  if (!clean) return null
  if (accountGroups$.groups.peek().some((g) => g.name.toLowerCase() === clean.toLowerCase())) return null
  const id = `group:${crypto.randomUUID()}`
  accountGroups$.groups.set([...accountGroups$.groups.peek(), { id, name: clean, accounts: [...new Set(accounts)] }])
  persist()
  return id
}

export function updateGroup(id: string, changes: { name?: string; accounts?: string[] }): boolean {
  const groups = accountGroups$.groups.peek()
  const name = changes.name?.trim()
  if (changes.name !== undefined && !name) return false
  if (name && groups.some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase())) return false
  accountGroups$.groups.set(
    groups.map((g) =>
      g.id === id
        ? { ...g, name: name ?? g.name, accounts: changes.accounts ? [...new Set(changes.accounts)] : g.accounts }
        : g,
    ),
  )
  persist()
  return true
}

export function deleteGroup(id: string) {
  accountGroups$.groups.set(accountGroups$.groups.peek().filter((g) => g.id !== id))
  if (accountGroups$.active.peek() === id) accountGroups$.active.set(null)
  persist()
}

/** Forgets a removed account in every group. */
export function forgetAccountInGroups(accountId: string) {
  const groups = accountGroups$.groups.peek()
  if (!groups.some((g) => g.accounts.includes(accountId))) return
  accountGroups$.groups.set(groups.map((g) => ({ ...g, accounts: g.accounts.filter((a) => a !== accountId) })))
  persist()
}

// Leaving the unified view leaves its group; coming back starts from all
// accounts unless a group is chosen again.
ui$.selectedAccount.onChange(({ value }) => {
  if (value !== 'unified' && accountGroups$.active.peek() !== null) accountGroups$.active.set(null)
})

/** Shows one group's accounts together, or every included account with null. */
export function showAccountGroup(id: string | null) {
  ui$.selectedAccount.set('unified')
  accountGroups$.active.set(id && accountGroups$.groups.peek().some((g) => g.id === id) ? id : null)
}
