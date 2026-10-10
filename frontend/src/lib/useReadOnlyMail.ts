import { useValue } from '@legendapp/state/react'
import { accounts$ } from '../states/accounts'
import { messageChangesBlocked, readOnlyTarget, sendBlocked } from './mailCapabilities'

/** Managing this account's mailbox is not supported (Microsoft Graph). */
export function useReadOnlyMail(accountId: string): boolean {
  return readOnlyTarget(useValue(accounts$), accountId)
}

/** This account's messages cannot be changed (Graph without the permission). */
export function useMessageChangesBlocked(accountId: string): boolean {
  return messageChangesBlocked(useValue(accounts$), accountId)
}

/** This account cannot send (Graph without Mail.Send, #143). */
export function useSendBlocked(accountId: string): boolean {
  return sendBlocked(useValue(accounts$), accountId)
}
