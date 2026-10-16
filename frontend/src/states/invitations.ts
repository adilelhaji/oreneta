// Meeting invitations that arrive by mail (#102, ADR-0019). Nothing here runs
// on its own: each answer, and each change to a calendar, is a button the
// person pressed.
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import type { Account, Invitation, Message } from '../types'
import { editEvent, openCalendarOn, type CalendarEvent } from './calendar'
import { sendComposed } from './compose'
import { showToast } from './ui'

export type Answer = { sequence: number; response: string; calendar_id: string; answered_at: number }
export type InvitationStatus = { answer: Answer | null; calendars: string[] }
export type Reply = 'accept' | 'tentative' | 'decline'

export async function invitationStatus(accountId: string, uid: string): Promise<InvitationStatus> {
  try {
    return await invoke<InvitationStatus>('invite.status', { account: accountId, uid })
  } catch {
    return { answer: null, calendars: [] }
  }
}

/** An invitation already answered at a later version is shown as outdated. */
export function isOutdated(invitation: Pick<Invitation, 'sequence'>, status: InvitationStatus | null): boolean {
  return !!status?.answer && status.answer.sequence > invitation.sequence
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function reason(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * Answers an invitation: the event goes to (or leaves) the chosen calendar,
 * then the answer is sent to the organizer as an ordinary message with the
 * iTIP reply attached. Returns whether the answer was sent.
 */
export async function answerInvitation(
  account: Pick<Account, 'id' | 'email' | 'sender_name'>,
  message: Pick<Message, 'message_id' | 'references'>,
  invitation: Invitation,
  response: Reply,
  calendarId: string,
): Promise<boolean> {
  let reply: { to: string; subject: string; ics: string }
  try {
    const res = await invoke<{ reply: { to: string; subject: string; ics: string } }>('invite.respond', {
      account: account.id,
      ics: invitation.ics,
      response,
      me_name: account.sender_name ?? '',
      me_addr: account.email,
      calendar: calendarId,
    })
    reply = res.reply
  } catch (error) {
    showToast(reason(error, t('invite.failed', { defaultValue: 'The invitation was not answered' })), 'error')
    return false
  }
  const said = {
    accept: t('invite.saidAccept', { defaultValue: 'I will attend.' }),
    tentative: t('invite.saidTentative', { defaultValue: 'I might attend.' }),
    decline: t('invite.saidDecline', { defaultValue: 'I will not attend.' }),
  }[response]
  try {
    await sendComposed({
      accountId: account.id,
      to: reply.to,
      subject: reply.subject,
      rich: false,
      content: said,
      inReplyTo: message.message_id,
      references: [message.references, message.message_id].filter(Boolean).join(' '),
      attachments: [
        {
          id: 'invitation-reply',
          filename: 'reply.ics',
          mime: 'text/calendar; method=REPLY; charset=utf-8',
          size: reply.ics.length,
          data: base64(reply.ics),
        },
      ],
    })
  } catch (error) {
    // The calendar was updated; the organizer was not told. Said plainly, and
    // pressing the answer again sends it.
    showToast(
      t('invite.notSent', {
        reason: reason(error, ''),
        defaultValue: 'Your calendar was updated, but the answer was not sent to the organizer: {reason}',
      }),
      'error',
    )
    return false
  }
  showToast(t('invite.sent', { defaultValue: 'Answer sent to the organizer' }))
  return true
}

export async function applyCancellation(accountId: string, invitation: Invitation): Promise<number> {
  try {
    const res = await invoke<{ removed: number }>('invite.cancel', { account: accountId, ics: invitation.ics })
    showToast(
      res.removed > 0
        ? t('invite.removed', { defaultValue: 'Removed from your calendar' })
        : t('invite.notInCalendar', { defaultValue: 'It was not in any of your calendars' }),
    )
    return res.removed
  } catch (error) {
    showToast(reason(error, t('invite.failed', { defaultValue: 'The invitation was not answered' })), 'error')
    return 0
  }
}

// ---- Proposing another time (ADR-0043) -------------------------------------

/** Sends an iTIP message as an ordinary mail with the calendar part attached. */
async function sendItip(
  accountId: string,
  message: Pick<Message, 'message_id' | 'references'>,
  item: { to: string; subject: string; ics: string },
  method: 'COUNTER' | 'DECLINECOUNTER',
  content: string,
) {
  await sendComposed({
    accountId,
    to: item.to,
    subject: item.subject,
    rich: false,
    content,
    inReplyTo: message.message_id,
    references: [message.references, message.message_id].filter(Boolean).join(' '),
    attachments: [
      {
        id: `invitation-${method.toLowerCase()}`,
        filename: method === 'COUNTER' ? 'proposal.ics' : 'declined.ics',
        mime: `text/calendar; method=${method}; charset=utf-8`,
        size: item.ics.length,
        data: base64(item.ics),
      },
    ],
  })
}

/**
 * Proposes another time to the organizer (RFC 5546 COUNTER). Nothing in the
 * calendar changes: the organizer decides. Returns whether it was sent.
 */
export async function proposeTime(
  account: Pick<Account, 'id' | 'email' | 'sender_name'>,
  message: Pick<Message, 'message_id' | 'references'>,
  invitation: Invitation,
  start: number,
  end: number,
  comment: string,
): Promise<boolean> {
  let proposal: { to: string; subject: string; ics: string }
  try {
    const res = await invoke<{ proposal: { to: string; subject: string; ics: string } }>('invite.counter', {
      account: account.id,
      ics: invitation.ics,
      me_name: account.sender_name ?? '',
      me_addr: account.email,
      start,
      end,
      comment,
    })
    proposal = res.proposal
  } catch (error) {
    showToast(reason(error, t('invite.proposeFailed', { defaultValue: 'The new time was not proposed' })), 'error')
    return false
  }
  try {
    await sendItip(
      account.id,
      message,
      proposal,
      'COUNTER',
      comment.trim() || t('invite.saidPropose', { defaultValue: 'I propose another time for this meeting.' }),
    )
  } catch (error) {
    showToast(
      t('invite.proposalNotSent', {
        reason: reason(error, ''),
        defaultValue: 'The proposal was not sent to the organizer: {reason}',
      }),
      'error',
    )
    return false
  }
  showToast(t('invite.proposalSent', { defaultValue: 'Proposal sent to the organizer' }))
  return true
}

export type CounterStatus = {
  organizer: boolean
  event: Omit<CalendarEvent, 'accountId'> | null
  sequence: number | null
  outdated: boolean
}

/** Whether this account organizes the meeting a proposal is about, here. */
export async function counterStatus(accountId: string, email: string, ics: string): Promise<CounterStatus> {
  try {
    const res = await invoke<CounterStatus>('invite.counterStatus', { account: accountId, me_addr: email, ics })
    return {
      organizer: !!res?.organizer,
      event: res?.event ?? null,
      sequence: res?.sequence ?? null,
      outdated: !!res?.outdated,
    }
  } catch {
    return { organizer: false, event: null, sequence: null, outdated: false }
  }
}

/** Turns a proposal down (RFC 5546 DECLINECOUNTER); the meeting stays as it was. */
export async function declineProposal(
  account: Pick<Account, 'id' | 'email' | 'sender_name'>,
  message: Pick<Message, 'message_id' | 'references'>,
  proposal: Invitation,
  comment: string,
): Promise<boolean> {
  let reply: { to: string; subject: string; ics: string }
  try {
    const res = await invoke<{ reply: { to: string; subject: string; ics: string } }>('invite.declineCounter', {
      account: account.id,
      ics: proposal.ics,
      me_name: account.sender_name ?? '',
      me_addr: account.email,
      comment,
    })
    reply = res.reply
  } catch (error) {
    showToast(reason(error, t('invite.declineFailed', { defaultValue: 'The proposal was not declined' })), 'error')
    return false
  }
  try {
    await sendItip(
      account.id,
      message,
      reply,
      'DECLINECOUNTER',
      comment.trim() || t('invite.saidDeclineProposal', { defaultValue: 'The meeting stays at its time.' }),
    )
  } catch (error) {
    showToast(
      t('invite.declineNotSent', {
        reason: reason(error, ''),
        defaultValue: 'Nothing was sent to the person who proposed it: {reason}',
      }),
      'error',
    )
    return false
  }
  showToast(t('invite.declineSent', { defaultValue: 'Proposal declined' }))
  return true
}

/**
 * Opens the organizer's own event in the editor with the proposed time in
 * place. Saving goes through the ordinary update, and only that.
 */
export function editWithProposal(accountId: string, event: Omit<CalendarEvent, 'accountId'>, proposal: Invitation) {
  openCalendarOn(new Date(proposal.start * 1000))
  editEvent({ ...event, accountId, start: proposal.start, end: proposal.end })
}
