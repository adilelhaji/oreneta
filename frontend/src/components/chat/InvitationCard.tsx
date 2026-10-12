import { useEffect, useState } from 'react'
import { CalendarCheck, CalendarX, CalendarClock, CalendarSearch } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import { accountSupportsCalendar, calendar$, loadCalendars } from '../../states/calendar'
import { canImportInto } from '../../states/calendarFiles'
import {
  answerInvitation,
  applyCancellation,
  counterStatus,
  declineProposal,
  editWithProposal,
  invitationStatus,
  isOutdated,
  proposeTime,
  type CounterStatus,
  type InvitationStatus,
  type Reply,
} from '../../states/invitations'
import type { Account, Invitation, Message } from '../../types'
import { Button } from '../button/Button'
import { ConflictNote } from '../calendar/ConflictNote'
import { DateAndTime } from '../calendar/EventEditor'

function when(start: number, end: number, allDay: boolean): string {
  const from = new Date(start * 1000)
  if (allDay) return from.toLocaleDateString(undefined, { dateStyle: 'full' })
  const to = new Date(end * 1000)
  const sameDay = from.toDateString() === to.toDateString()
  return `${from.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })} – ${to.toLocaleString(
    undefined,
    sameDay ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' },
  )}`
}

/**
 * A meeting invitation, cancellation or answer carried by a message (#102),
 * or a proposal of another time and the organizer's refusal of one
 * (ADR-0043).
 *
 * It describes; it does not act. Answering, adding to a calendar, removing a
 * cancelled meeting, proposing a time and declining one are each a button.
 * Exchange and Google keep invitations in the account's own calendar, which
 * is where they are answered, so for those accounts this only says so.
 */
export function InvitationCard({ message }: { message: Message }) {
  const { t } = useTranslation()
  const invitation = message.invitation
  const accounts = useValue(accounts$)
  const calendars = useValue(calendar$.calendars)
  const account = accounts.find((a) => a.id === message.account_id)
  const [status, setStatus] = useState<InvitationStatus | null>(null)
  const [calendarId, setCalendarId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [counter, setCounter] = useState<CounterStatus | null>(null)
  const [declined, setDeclined] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!invitation || !account) return
    let live = true
    void invitationStatus(account.id, invitation.uid).then((found) => live && setStatus(found))
    if (invitation.method === 'COUNTER')
      void counterStatus(account.id, account.email, invitation.ics).then((found) => live && setCounter(found))
    if (calendars.length === 0) void loadCalendars()
    return () => {
      live = false
    }
    // Asked again only when another invitation is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invitation?.uid, invitation?.sequence, account?.id])

  if (!invitation || !account) return null
  const method = invitation.method
  const targets = calendars.filter((c) => c.accountId === account.id && canImportInto(c))
  // Until the person picks ("No calendar" included), the calendar already
  // holding it, else the first that can take it.
  const chosen =
    calendarId ?? (status?.calendars.find((id) => targets.some((c) => c.id === id)) || targets[0]?.id || '')
  // An answered later version makes an invitation or cancellation old; a
  // proposal is old when the meeting has changed since it was made.
  const outdated =
    method === 'COUNTER' ? !!counter?.outdated : method !== 'DECLINECOUNTER' && isOutdated(invitation, status)
  const serverKeeps = accountSupportsCalendar(account)
  const proposer = method === 'COUNTER' ? invitation.attendees[0] : undefined
  const answered = status?.answer?.sequence === invitation.sequence ? status.answer.response : ''
  const Icon =
    method === 'CANCEL' || method === 'DECLINECOUNTER'
      ? CalendarX
      : method === 'REPLY'
        ? CalendarCheck
        : method === 'COUNTER'
          ? CalendarSearch
          : CalendarClock

  const answer = async (response: Reply) => {
    setBusy(true)
    const sent = await answerInvitation(account, message, invitation, response, chosen)
    setStatus(await invitationStatus(account.id, invitation.uid))
    setBusy(false)
    return sent
  }

  const decline = async () => {
    setBusy(true)
    const sent = await declineProposal(account, message, invitation, note)
    if (sent) setDeclined(true)
    setBusy(false)
  }

  const cancel = async () => {
    setBusy(true)
    await applyCancellation(account.id, invitation)
    setStatus(await invitationStatus(account.id, invitation.uid))
    setBusy(false)
  }

  const answeredLabel: Record<string, string> = {
    accept: t('invite.youAccepted', { defaultValue: 'You accepted' }),
    tentative: t('invite.youTentative', { defaultValue: 'You said maybe' }),
    decline: t('invite.youDeclined', { defaultValue: 'You declined' }),
    cancelled: t('invite.youRemoved', { defaultValue: 'Removed from your calendar' }),
  }

  return (
    <section
      aria-label={t('invite.label', { defaultValue: 'Meeting invitation' })}
      className="mb-3 rounded-panel border border-border bg-raised p-3 text-caption"
    >
      <div className="flex items-start gap-2.5">
        <Icon size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-ui font-semibold text-primary">
            {method === 'CANCEL'
              ? t('invite.cancelled', { summary: invitation.summary, defaultValue: 'Cancelled: {summary}' })
              : invitation.summary || t('invite.untitled', { defaultValue: 'Meeting' })}
          </p>
          {method === 'COUNTER' && (
            <p className="text-primary">
              {t('invite.proposes', {
                name: proposer?.name || proposer?.addr || t('invite.someone', { defaultValue: 'Someone' }),
                defaultValue: '{name} proposes a new time:',
              })}
            </p>
          )}
          {method === 'DECLINECOUNTER' && (
            <p className="text-primary">
              {t('invite.proposalDeclined', { defaultValue: 'The organizer declined your proposed time.' })}
            </p>
          )}
          {/* A refusal names no time: the meeting stays as it was. */}
          {(method !== 'DECLINECOUNTER' || invitation.start > 0) && (
            <p className="text-secondary">{when(invitation.start, invitation.end, invitation.all_day)}</p>
          )}
          {invitation.comment && (method === 'COUNTER' || method === 'DECLINECOUNTER') && (
            <p className="whitespace-pre-line text-primary">“{invitation.comment}”</p>
          )}
          {invitation.repeats && <p className="text-secondary">{t('invite.repeats', { defaultValue: 'Repeats' })}</p>}
          {invitation.location && <p className="text-secondary">{invitation.location}</p>}
          {invitation.organizer && method !== 'COUNTER' && method !== 'DECLINECOUNTER' && (
            <p className="text-secondary">
              {t('invite.organizer', {
                name: invitation.organizer.name || invitation.organizer.addr,
                defaultValue: 'Organized by {name}',
              })}
            </p>
          )}
          {method === 'REPLY' &&
            invitation.attendees.map((person) => (
              <p key={person.addr} className="text-primary">
                {person.name || person.addr}:{' '}
                {person.response === 'accept'
                  ? t('invite.accepted', { defaultValue: 'accepted' })
                  : person.response === 'decline'
                    ? t('invite.declined', { defaultValue: 'declined' })
                    : person.response === 'tentative'
                      ? t('invite.tentative', { defaultValue: 'maybe' })
                      : t('invite.noAnswer', { defaultValue: 'no answer' })}
              </p>
            ))}
        </div>
      </div>

      {method === 'DECLINECOUNTER' ? null : outdated ? (
        <p className="mt-2 text-secondary">
          {method === 'COUNTER'
            ? t('invite.proposalOutdated', {
                defaultValue: 'This time was proposed for an older version of the meeting.',
              })
            : t('invite.outdated', { defaultValue: 'A newer version of this invitation has already been answered.' })}
        </p>
      ) : serverKeeps && method !== 'REPLY' ? (
        <p className="mt-2 text-secondary">
          {t('invite.serverKeeps', {
            defaultValue: 'This account keeps invitations in its own calendar; answer it there.',
          })}
        </p>
      ) : method === 'COUNTER' ? (
        counter && (
          <div className="mt-2.5 flex flex-col gap-2">
            {!counter.organizer || !counter.event ? (
              <p className="text-secondary">
                {t('invite.proposalInfoOnly', {
                  defaultValue:
                    'You do not organize this meeting in a calendar kept here; this is for information only.',
                })}
              </p>
            ) : declined ? (
              <p className="font-semibold text-primary">
                {t('invite.youDeclinedProposal', { defaultValue: 'You declined this proposal' })}
              </p>
            ) : (
              <>
                <ConflictNote
                  start={invitation.start}
                  end={invitation.end}
                  allDay={invitation.all_day}
                  exclude={[invitation.uid]}
                />
                <label className="flex flex-col gap-1 text-secondary">
                  {t('invite.declineNote', { defaultValue: 'Note if you decline (optional)' })}
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => counter.event && editWithProposal(account.id, counter.event, invitation)}
                  >
                    {t('invite.openInEditor', { defaultValue: 'Open in editor' })}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void decline()}>
                    {t('invite.declineProposal', { defaultValue: 'Decline proposal' })}
                  </Button>
                </div>
                <p className="text-2xs text-secondary">
                  {t('invite.acceptNotice', {
                    defaultValue:
                      'The editor opens with the proposed time; saving changes your calendar only. The people invited are not sent the new time from here. Declining sends a message to the person who proposed it.',
                  })}
                </p>
              </>
            )}
          </div>
        )
      ) : method === 'REQUEST' ? (
        <div className="mt-2.5 flex flex-col gap-2">
          <ConflictNote
            start={invitation.start}
            end={invitation.end}
            allDay={invitation.all_day}
            exclude={[invitation.uid]}
          />
          {answered && <p className="font-semibold text-primary">{answeredLabel[answered]}</p>}
          <label className="flex flex-wrap items-center gap-2 text-secondary">
            {t('invite.keepIn', { defaultValue: 'Keep in' })}
            <select
              value={chosen}
              onChange={(e) => setCalendarId(e.target.value)}
              className="rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary"
            >
              <option value="">{t('invite.noCalendar', { defaultValue: 'No calendar' })}</option>
              {targets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void answer('accept')}>
              {t('invite.accept', { defaultValue: 'Accept' })}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void answer('tentative')}>
              {t('invite.maybe', { defaultValue: 'Maybe' })}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void answer('decline')}>
              {t('invite.decline', { defaultValue: 'Decline' })}
            </Button>
          </div>
          <p className="text-2xs text-secondary">
            {t('invite.sendsAnswer', { defaultValue: 'Answering sends a message to the organizer.' })}
          </p>
          {canPropose(invitation, account) && (
            <ProposeTime account={account} message={message} invitation={invitation} />
          )}
        </div>
      ) : method === 'CANCEL' ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {answered === 'cancelled' || (status && status.calendars.length === 0) ? (
            <p className="text-secondary">
              {answered === 'cancelled'
                ? answeredLabel.cancelled
                : t('invite.notInCalendar', { defaultValue: 'It was not in any of your calendars' })}
            </p>
          ) : (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void cancel()}>
              {t('invite.removeFromCalendar', { defaultValue: 'Remove from my calendar' })}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  )
}

/** A time can be proposed for one meeting (or one occurrence) someone else organizes. */
function canPropose(invitation: Invitation, account: Pick<Account, 'email'>): boolean {
  if (invitation.cancelled || (invitation.repeats && invitation.recurrence_id == null)) return false
  const organizer = invitation.organizer?.addr.toLowerCase()
  return !!organizer && organizer !== account.email.toLowerCase()
}

/**
 * Proposing another time (RFC 5546 COUNTER): a form behind a button, sent
 * only when "Send proposal" is pressed. The calendar does not change; the
 * organizer decides.
 */
function ProposeTime({ account, message, invitation }: { account: Account; message: Message; invitation: Invitation }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [start, setStart] = useState(invitation.start)
  const [end, setEnd] = useState(invitation.end)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const allDay = invitation.all_day
  const length = Math.max(invitation.end - invitation.start, allDay ? 86400 : 60)
  const invalid = !(end > start)

  if (!open)
    return (
      <div>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          {t('invite.proposeTime', { defaultValue: 'Propose a new time' })}
        </Button>
      </div>
    )

  const send = async () => {
    setBusy(true)
    const sent = await proposeTime(account, message, invitation, start, end, comment)
    setBusy(false)
    if (sent) setOpen(false)
  }

  return (
    <div
      role="group"
      aria-label={t('invite.proposeTime', { defaultValue: 'Propose a new time' })}
      className="flex flex-col gap-2 rounded-control border border-border bg-app p-2.5"
    >
      {allDay ? (
        // An all-day meeting stays all-day: a day, and as many days as it had.
        <label className="flex flex-col gap-1 text-secondary">
          {t('invite.newDay', { defaultValue: 'New day' })}
          <DateAndTime
            value={start}
            allDay
            onChange={(next) => {
              setStart(next)
              setEnd(next + length)
            }}
          />
        </label>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-secondary">
            {t('invite.newStart', { defaultValue: 'New start' })}
            <DateAndTime
              value={start}
              allDay={false}
              onChange={(next) => {
                // Moving the start keeps the length, as in the event editor.
                setEnd(next + (end - start))
                setStart(next)
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-secondary">
            {t('invite.newEnd', { defaultValue: 'New end' })}
            <DateAndTime value={end} allDay={false} onChange={setEnd} />
          </label>
        </>
      )}
      {invalid ? (
        <p className="text-danger">
          {t('invite.proposalEndsBeforeStart', { defaultValue: 'The proposed end must be after its start.' })}
        </p>
      ) : (
        <ConflictNote start={start} end={end} allDay={allDay} exclude={[invitation.uid]} />
      )}
      <label className="flex flex-col gap-1 text-secondary">
        {t('invite.proposalNote', { defaultValue: 'Note to the organizer (optional)' })}
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          className="resize-y rounded-control-sm border border-border bg-raised px-2 py-1 text-caption text-primary"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || invalid} onClick={() => void send()}>
          {t('invite.sendProposal', { defaultValue: 'Send proposal' })}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          {t('invite.cancelProposal', { defaultValue: 'Cancel' })}
        </Button>
      </div>
      <p className="text-2xs text-secondary">
        {t('invite.proposalNotice', {
          defaultValue:
            'This sends your proposal to the organizer. Your calendar does not change; the organizer decides.',
        })}
      </p>
    </div>
  )
}
