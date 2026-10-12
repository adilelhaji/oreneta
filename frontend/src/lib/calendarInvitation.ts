import type { Account } from '../types'

type InvitationFacts = {
  my_response: string
  organizer?: { addr: string } | null
}

/**
 * Whether an event is an invitation this account can answer: someone else
 * convened it, this account is on the list, and the calendar can be written.
 *
 * Exchange reports the organizer's own response as "organizer", and Google
 * reports an organizer's own event as "accepted": both used to show the
 * organizer Accept and Decline buttons for a meeting of their own. A
 * read-only calendar cannot carry an answer at all.
 */
export function isAnswerableInvitation(
  event: InvitationFacts,
  attendeeCount: number,
  account: Pick<Account, 'email' | 'aliases'> | undefined,
  readOnly: boolean,
): boolean {
  if (readOnly || attendeeCount === 0 || !event.my_response) return false
  if (/^organizer$/i.test(event.my_response.trim())) return false
  const organizer = event.organizer?.addr?.trim().toLowerCase()
  if (organizer && account) {
    const own = [account.email, ...(account.aliases ?? []).map((alias) => alias.email)]
    if (own.some((address) => address.trim().toLowerCase() === organizer)) return false
  }
  return true
}
