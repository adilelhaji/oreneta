import type { Account } from '../types'

// Two levels for a Microsoft Graph account (#141, docs/design/graph-message-actions.md):
//
// - Managing a mailbox — sending, drafts on the server, folders, emptying a
//   folder, junk, "mark all read", saving as .eml — is not supported on Graph
//   at all. `isReadOnlyMail` / `readOnlyTarget` answer that.
// - Changing messages — read state, flag, move, archive, delete, copy within
//   the account — is supported once the reader allowed it and Microsoft granted
//   it. `messageChangesBlocked` answers that.

export function isReadOnlyMail(account: Pick<Account, 'auth_type'> | undefined): boolean {
  return account?.auth_type === 'graph_oauth'
}

function matches(account: Account, id: string): boolean {
  return account.id === id || id.startsWith(`${account.id}#`)
}

export function readOnlyTarget(accounts: Account[], id: string): boolean {
  return accounts.some((account) => isReadOnlyMail(account) && matches(account, id))
}

/** Whether this account's messages can be changed: always for IMAP/EWS, and
 * for Graph only with the change permission granted. */
export function canChangeMessages(account: Pick<Account, 'auth_type' | 'graph_writes'> | undefined): boolean {
  return !isReadOnlyMail(account) || !!account?.graph_writes
}

export function messageChangesBlocked(accounts: Account[], id: string): boolean {
  return accounts.some((account) => !canChangeMessages(account) && matches(account, id))
}

/** Copying is a message change within one account; across accounts it needs
 * raw messages, which Graph does not provide in either direction. */
export function copyBlocked(accounts: Account[], sourceId: string, targetAccountId: string): boolean {
  const source = accounts.find((account) => matches(account, sourceId))
  if (source && source.id === targetAccountId) return messageChangesBlocked(accounts, sourceId)
  return readOnlyTarget(accounts, sourceId) || readOnlyTarget(accounts, targetAccountId)
}
