import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
  accountGroups$,
  createGroup,
  deleteGroup,
  forgetAccountInGroups,
  hydrateAccountGroups,
  inUnifiedScope,
  showAccountGroup,
  updateGroup,
} from './accountGroups'
import { accounts$, unifiedAccounts } from './accounts'
import { threadListViewKey } from './mail'
import { ui$ } from './ui'
import type { Account } from '../types'

const writes: any[] = []
const account = (id: string, included = true) =>
  ({
    id,
    email: `${id}@x.test`,
    display_name: id,
    provider: 'imap',
    auth_type: 'password',
    included_in_unified: included,
  }) as Account

beforeEach(() => {
  writes.length = 0
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => (command === 'app.prefsSet' && writes.push(payload), {}),
      },
    },
  }
  accounts$.set([account('work'), account('home'), account('old', false)])
  accountGroups$.groups.set([])
  accountGroups$.active.set(null)
  ui$.selectedAccount.set('unified')
})
afterEach(() => {
  delete (window as any).go
})

it('without a group the unified view is the included accounts; with one, exactly its accounts', () => {
  expect(unifiedAccounts().map((a) => a.id)).toEqual(['work', 'home'])
  const id = createGroup('Mixed', ['home', 'old'])!
  showAccountGroup(id)
  // A group names its accounts, even one left out of the unified inbox.
  expect(unifiedAccounts().map((a) => a.id)).toEqual(['home', 'old'])
  expect(inUnifiedScope(account('work'))).toBe(false)
})

it('each group is its own view, so a list loaded for one is never shown for another', () => {
  const a = threadListViewKey('unified', 'inbox', '', '', 'date', 'group:a')
  const b = threadListViewKey('unified', 'inbox', '', '', 'date', 'group:b')
  const all = threadListViewKey('unified', 'inbox', '', '', 'date', null)
  expect(new Set([a, b, all]).size).toBe(3)
  // An account view is not affected by a group.
  expect(threadListViewKey('work', 'inbox', '', '', 'date', 'group:a')).toBe(
    threadListViewKey('work', 'inbox', '', '', 'date', null),
  )
})

it('leaving the unified view leaves the group', () => {
  showAccountGroup(createGroup('Work', ['work']))
  expect(accountGroups$.active.get()).not.toBeNull()
  ui$.selectedAccount.set('home')
  expect(accountGroups$.active.get()).toBeNull()
})

it('names are required and unique; groups are saved and read back', () => {
  expect(createGroup('  ', ['work'])).toBeNull()
  const id = createGroup('Work', ['work', 'work'])!
  expect(createGroup('work', [])).toBeNull()
  expect(updateGroup(id, { name: '' })).toBe(false)
  expect(updateGroup(id, { name: 'Office', accounts: ['work', 'home'] })).toBe(true)
  const saved = writes.at(-1)
  expect(saved.key).toBe('account_groups')
  accountGroups$.groups.set([])
  hydrateAccountGroups({ account_groups: saved.value })
  expect(accountGroups$.groups.get()).toEqual([{ id, name: 'Office', accounts: ['work', 'home'] }])
  // Damaged data reads as no groups rather than breaking the view.
  hydrateAccountGroups({ account_groups: '{not json' })
  expect(accountGroups$.groups.get()).toEqual([])
})

it('a removed account leaves every group, and deleting the shown group shows all accounts', () => {
  const id = createGroup('Work', ['work', 'home'])!
  forgetAccountInGroups('work')
  expect(accountGroups$.groups.get()[0].accounts).toEqual(['home'])
  showAccountGroup(id)
  deleteGroup(id)
  expect(accountGroups$.active.get()).toBeNull()
  expect(unifiedAccounts().map((a) => a.id)).toEqual(['work', 'home'])
})
