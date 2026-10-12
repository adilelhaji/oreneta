// Sends a person still has to settle.
//
// The core writes every send down before it goes and after the server
// answers. Two outcomes need a person: the server took the message in full
// and never said whether it accepted it, and the server accepted it but no
// copy could be filed in Sent. Neither is retried on its own — sending again
// could deliver twice — and neither is dropped, which could lose a message.
// This module is the view of that record and the two things a person can
// do about it: send again, deliberately, or mark it settled.
//
// Kept apart from compose.ts (which dispatches sends) and scheduledSends.ts
// (which shows what is waiting): both read this, so it cannot import either.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { showToast } from './ui'

/** One send as the core recorded it. */
export type OutgoingAttempt = {
  id: string
  account: string
  /** Whether it was sent at once or from the schedule. */
  kind: 'now' | 'scheduled'
  messageId: string
  subject: string
  to: string
  /** `uncertain`: no answer came back. `accepted`: it went, but see `archiveError`. */
  state: 'uncertain' | 'accepted'
  error: string
  /** Why the Sent copy could not be filed; empty when it could. */
  archiveError: string
  createdAt: number
  updatedAt: number
  /** The send request itself, so it can be sent again without the reader
   * having to write it twice. Null when the core could not read it back. */
  message: Record<string, unknown> | null
}

/** What `mail.send` answers. `ok: false` with an outcome is not an error:
 * it is the core declining to call something a failure that may not be. */
export type SendResult = {
  ok?: boolean
  outcome?: string
  attempt_id?: string
  error?: string
} | null

export const outgoing$ = observable({
  attempts: [] as OutgoingAttempt[],
})

/** Whether a send result is one only a person can settle. */
export function isUnsettledOutcome(result: SendResult): boolean {
  return !!result && result.ok === false && (result.outcome === 'uncertain' || result.outcome === 'already_attempted')
}

/** What to tell the reader about an unsettled outcome. */
export function unsettledOutcomeMessage(result: SendResult): string {
  return result?.outcome === 'already_attempted' ? t('outgoing.toast.alreadyAttempted') : t('outgoing.toast.uncertain')
}

/** What the core still has for a person to look at. */
export async function refreshOutgoingAttempts(accountId = '') {
  try {
    const res = await invoke<{ attempts?: OutgoingAttempt[] }>('mail.outgoingAttempts', { account_id: accountId })
    outgoing$.attempts.set(res?.attempts ?? [])
  } catch {
    // A list that cannot be read is not an empty list: keep what was last
    // known rather than tell the reader nothing needs them.
  }
}

type Listener = (attemptId: string) => void
const settledListeners = new Set<Listener>()

/**
 * Called when an attempt stops needing a person — sent again and accepted,
 * or marked settled — with its id, which for an immediate send is the
 * message's own Message-ID. The conversation uses this to update the bubble
 * it drew for the send.
 */
export function onOutgoingAttemptSettled(listener: Listener): () => void {
  settledListeners.add(listener)
  return () => {
    settledListeners.delete(listener)
  }
}

function settled(attemptId: string) {
  outgoing$.attempts.set(outgoing$.attempts.peek().filter((attempt) => attempt.id !== attemptId))
  for (const listener of settledListeners) listener(attemptId)
}

/**
 * The stored request, in the shape the bridge takes.
 *
 * The core keeps the request as it received it, under the core's own field
 * names; the bridge names the account differently and the rest the same.
 * No passphrase travels: the core never stored one, so a message that was
 * to be signed with a passphrase-protected key will be refused here and
 * must be written again from the composer.
 */
export function resendPayload(message: Record<string, unknown>): Record<string, unknown> {
  const { account, ...rest } = message
  return { ...rest, account_id: account ?? rest.account_id ?? '', resend: true }
}

/**
 * Sends an attempt again, on purpose.
 *
 * The reader has been told the first try may have gone; this is their call.
 * The core replaces the old record with the new try, so an accepted resend
 * leaves the list on its own; a second doubt stays in it.
 */
export async function resendOutgoingAttempt(id: string): Promise<boolean> {
  const attempt = outgoing$.attempts.peek().find((entry) => entry.id === id)
  if (!attempt?.message) return false
  try {
    const res = await invoke<SendResult>('mail.send', resendPayload(attempt.message))
    if (res && res.ok === false) {
      if (isUnsettledOutcome(res)) showToast(unsettledOutcomeMessage(res), 'error')
      else showToast(res.error || t('sendLater.toast.sendFailed'), 'error')
      await refreshOutgoingAttempts()
      return false
    }
    settled(id)
    showToast(t('sendLater.toast.sent'), 'success')
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : t('sendLater.toast.sendFailed')
    showToast(message, 'error')
    await refreshOutgoingAttempts()
    return false
  }
}

/** Marks an attempt as looked at and settled. Nothing is sent. */
export async function settleOutgoingAttempt(id: string): Promise<void> {
  await invoke('mail.resolveOutgoing', { id })
  settled(id)
}
