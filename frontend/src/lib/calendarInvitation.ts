import type { Account } from '../types'
import { t } from './i18n'

type InvitationFacts = {
  my_response: string
  organizer?: { addr: string } | null
}

/** Whether the account convened the event itself: the organizer is one of its addresses. */
function convenedBy(event: InvitationFacts, account: Pick<Account, 'email' | 'aliases'> | undefined): boolean {
  const organizer = event.organizer?.addr?.trim().toLowerCase()
  if (!organizer || !account) return false
  const own = [account.email, ...(account.aliases ?? []).map((alias) => alias.email)]
  return own.some((address) => address.trim().toLowerCase() === organizer)
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
  return !convenedBy(event, account)
}

/** The reader's answer to a meeting, in the words that mean something to a reader. */
export type MeetingAnswer = 'accepted' | 'declined' | 'tentative' | 'unanswered'

/**
 * Servers answer with their own vocabulary (Exchange `accept`, `none`;
 * Google `accepted`, `needsAction`): these are the three answers and the lack
 * of one. Nothing to answer at all (no value, `unknown`, or Exchange's
 * `organizer`) is `null`.
 */
export function answerOf(response: string): MeetingAnswer | null {
  const normalised = response.trim().toLowerCase()
  if (!normalised || normalised === 'organizer' || normalised === 'unknown') return null
  if (normalised.includes('accept')) return 'accepted'
  if (normalised.includes('decline')) return 'declined'
  if (normalised.includes('tentative')) return 'tentative'
  return 'unanswered'
}

/**
 * The state said beside an event (the Dia panel, ADR-0069 §3): the reader's
 * answer to a meeting someone else convened, and nothing for one of their own
 * (which Google reports as "accepted") or one with nothing to answer.
 */
export function meetingAnswer(
  event: InvitationFacts,
  account: Pick<Account, 'email' | 'aliases'> | undefined,
): MeetingAnswer | null {
  return convenedBy(event, account) ? null : answerOf(event.my_response ?? '')
}

/** What an answer is called, as the event's sheet says it; no answer yet for anything else. */
export function answerLabel(answer: MeetingAnswer | null): string {
  switch (answer) {
    case 'accepted':
      return t('calendar.accepted', { defaultValue: 'Accepted' })
    case 'declined':
      return t('calendar.declined', { defaultValue: 'Declined' })
    case 'tentative':
      return t('calendar.tentative', { defaultValue: 'Tentative' })
    default:
      return t('calendar.noAnswer', { defaultValue: 'No answer yet' })
  }
}
