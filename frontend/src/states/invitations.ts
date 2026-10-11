// Meeting invitations that arrive by mail (#102, ADR-0019). Nothing here runs
// on its own: each answer, and each change to a calendar, is a button the
// person pressed.
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import type { Account, Invitation, Message } from '../types'
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
