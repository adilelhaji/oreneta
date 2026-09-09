import { useValue } from '@legendapp/state/react'
import { accounts$ } from '../states/accounts'
import { readOnlyTarget } from './mailCapabilities'

export function useReadOnlyMail(accountId: string): boolean {
  return readOnlyTarget(useValue(accounts$), accountId)
}
