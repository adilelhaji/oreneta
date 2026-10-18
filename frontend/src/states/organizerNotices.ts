// The organizer of a meeting in a local or CalDAV calendar telling the people
// on it (2026-10-12). Neither kind of calendar has a server that mails anyone,
// so after the person confirms who is told, the core builds the iTIP update
// (REQUEST) or cancellation (CANCEL) from the event as stored and it leaves
// here as an ordinary message, like an answer to an invitation does. Google
// and Exchange tell people themselves and never come here.
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { canSendFrom } from '../lib/mailCapabilities'
import type { Account, Alias } from '../types'
import { accountIdentities, isSendableAccount } from './accounts'
import type { Calendar, CalendarEvent, EditScope, Participant } from './calendar'
import { sendComposed } from './compose'
import { showToast } from './ui'

/// Whether people on an event in this kind of calendar are told by mail from
/// here: a local calendar has no server, and a CalDAV one does not mail.
export function mailsNotices(kind: Calendar['kind'] | undefined): boolean {
  return kind === 'local' || kind === 'caldav'
}

/// Who a notice goes out from: an account that can send and the identity of
/// it that organizes the meeting.
export type NoticeSender = { account: Account; identity: Alias }

function same(a: string | undefined, b: string | undefined) {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
}

/// The account a notice about this event is sent from, or null when none
/// can be: someone else organizes it, or no account sends mail.
///
/// An organizer already named must be one of the person's own identities, on
/// an account that sends. With none named yet (a meeting just given guests),
/// the calendar's own account sends when it can, else the first one that
/// can; the editor then names that identity as the organizer before saving.
export function noticeSender(
  event: Pick<CalendarEvent, 'accountId' | 'organizer'>,
  accounts: Account[],
): NoticeSender | null {
  const senders = accounts.filter((account) => isSendableAccount(account) && canSendFrom(account))
  const organizer = event.organizer?.addr?.trim()
  if (organizer) {
    for (const account of senders) {
      const identity = accountIdentities(account).find((one) => same(one.email, organizer))
      if (identity) return { account, identity }
    }
    return null
  }
  const account = senders.find((one) => one.id === event.accountId) ?? senders[0]
  return account ? { account, identity: accountIdentities(account)[0] } : null
}

/// The organizer a meeting is saved with: the one it has, or the sender.
export function organizerFor(event: Pick<CalendarEvent, 'organizer'>, sender: NoticeSender): Participant {
  if (event.organizer?.addr?.trim()) return event.organizer
  return { name: sender.identity.name ?? '', addr: sender.identity.email, response: '' }
}

/// The people a notice would go to: everyone on it with an address, the
/// sender (who organizes it) left out.
export function noticeRecipients(event: Pick<CalendarEvent, 'attendees'>, sender: NoticeSender | null): string[] {
  const seen = new Set<string>()
  const people: string[] = []
  for (const person of event.attendees) {
    const addr = person.addr.trim()
    const key = addr.toLowerCase()
    if (!addr || seen.has(key) || (sender && same(addr, sender.identity.email))) continue
    seen.add(key)
    people.push(addr)
  }
  return people
}

/// Who a change to an event can be told to, and the event as it is saved for
/// that. An account's own calendar (Exchange, Google) tells the people on it
/// itself; a local or CalDAV one tells them by mail from here, which needs an
/// account that sends as the organizer (`canNotify` is false without one, and
/// then nobody is asked about). Only people with an address can be told. A
/// meeting told by mail is saved naming its organizer: the identity the notice
/// goes out from, when it names none yet. Shared by the editor and by moving
/// an event on the grid (#266), so both ask the same question.
export function noticePlan<T extends Pick<CalendarEvent, 'accountId' | 'organizer' | 'attendees'>>(
  event: T,
  kind: Calendar['kind'] | undefined,
  accounts: Account[],
): { sender: NoticeSender | null; canNotify: boolean; invitees: string[]; toSave: T } {
  const byMail = mailsNotices(kind)
  const sender = byMail ? noticeSender(event, accounts) : null
  const canNotify = !byMail || sender !== null
  const invitees = !canNotify
    ? []
    : byMail
      ? noticeRecipients(event, sender)
      : event.attendees.map((person) => person.addr.trim()).filter(Boolean)
  const toSave: T =
    byMail && sender && event.attendees.length > 0 ? { ...event, organizer: organizerFor(event, sender) } : event
  return { sender, canNotify, invitees, toSave }
}

export type Notice = { method: 'REQUEST' | 'CANCEL'; to: string[]; subject: string; sequence: number; ics: string }

/// Builds the notice for an event as stored: after a save, its new version;
/// before a delete, the one about to go. `people` are those the person was
/// shown; the core refuses to build one for anyone else.
export async function buildNotice(
  event: Pick<CalendarEvent, 'id' | 'accountId' | 'calendar_id'>,
  scope: EditScope,
  method: 'request' | 'cancel',
  sender: NoticeSender,
  people: string[],
): Promise<Notice> {
  const res = await invoke<{ notice: Notice }>('invite.notify', {
    account: event.accountId,
    calendar: event.calendar_id,
    event: event.id,
    scope,
    method,
    me_name: sender.identity.name ?? '',
    me_addr: sender.identity.email,
    people,
  })
  return res.notice
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/// Mails a built notice to its people, with the calendar part attached as
/// iMIP has it (RFC 6047): `text/calendar` naming the method.
export async function sendNotice(sender: NoticeSender, notice: Notice): Promise<void> {
  const cancel = notice.method === 'CANCEL'
  await sendComposed({
    accountId: sender.account.id,
    // The identity that organizes it, when it is an alias of the account.
    from: same(sender.identity.email, sender.account.email) ? undefined : sender.identity.email,
    to: notice.to.join(', '),
    subject: notice.subject,
    rich: false,
    content: cancel
      ? t('calendar.noticeSaidCancel', { defaultValue: 'This meeting has been cancelled.' })
      : t('calendar.noticeSaidRequest', { defaultValue: 'The details of this meeting are attached.' }),
    attachments: [
      {
        id: `invitation-${notice.method.toLowerCase()}`,
        filename: cancel ? 'cancel.ics' : 'invite.ics',
        mime: `text/calendar; method=${notice.method}; charset=utf-8`,
        size: notice.ics.length,
        data: base64(notice.ics),
      },
    ],
  })
}

function reason(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error ?? '')
}

/// After a save: builds and sends the update. A failure is said, not
/// swallowed; the event itself stays saved either way.
export async function notifyAfterSave(
  event: Pick<CalendarEvent, 'id' | 'accountId' | 'calendar_id'>,
  scope: EditScope,
  sender: NoticeSender,
  people: string[],
): Promise<boolean> {
  try {
    const notice = await buildNotice(event, scope, 'request', sender, people)
    await sendNotice(sender, notice)
  } catch (error) {
    showToast(
      t('calendar.noticeNotSent', {
        reason: reason(error),
        defaultValue: 'The event was saved, but the people on it were not told: {reason}',
      }),
      'error',
    )
    return false
  }
  showToast(t('calendar.noticeSent', { defaultValue: 'The people on it were sent the new details' }))
  return true
}

export function cancellationNotSent(error: unknown) {
  showToast(
    t('calendar.cancelNotSent', {
      reason: reason(error),
      defaultValue: 'The event was deleted, but the cancellation was not sent: {reason}',
    }),
    'error',
  )
}

export function cancellationSent() {
  showToast(t('calendar.cancelSent', { defaultValue: 'Cancellation sent' }))
}
