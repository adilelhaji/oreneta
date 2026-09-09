import type { Account } from '../types'

export function isReadOnlyMail(account: Pick<Account, 'auth_type'> | undefined): boolean {
  return account?.auth_type === 'graph_oauth'
}

export function readOnlyTarget(accounts: Account[], id: string): boolean {
  return accounts.some((account) => isReadOnlyMail(account) && (account.id === id || id.startsWith(`${account.id}#`)))
}
