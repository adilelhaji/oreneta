import { useEffect, useState } from 'react'
import { CalendarCheck, CalendarX, CalendarClock } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import { accountSupportsCalendar, calendar$, loadCalendars } from '../../states/calendar'
import { canImportInto } from '../../states/calendarFiles'
import {
  answerInvitation,
  applyCancellation,
  invitationStatus,
  isOutdated,
  type InvitationStatus,
  type Reply,
} from '../../states/invitations'
import type { Message } from '../../types'
import { Button } from '../button/Button'

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
 * A meeting invitation, cancellation or answer carried by a message (#102).
 *
 * It describes; it does not act. Answering, adding to a calendar and
 * removing a cancelled meeting are each a button. Exchange and Google keep
 * invitations in the account's own calendar, which is where they are
 * answered, so for those accounts this only says so.
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

  useEffect(() => {
    if (!invitation || !account) return
    let live = true
    void invitationStatus(account.id, invitation.uid).then((found) => live && setStatus(found))
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
  const outdated = isOutdated(invitation, status)
  const serverKeeps = accountSupportsCalendar(account)
  const answered = status?.answer?.sequence === invitation.sequence ? status.answer.response : ''
  const Icon = method === 'CANCEL' ? CalendarX : method === 'REPLY' ? CalendarCheck : CalendarClock

  const answer = async (response: Reply) => {
    setBusy(true)
    const sent = await answerInvitation(account, message, invitation, response, chosen)
    setStatus(await invitationStatus(account.id, invitation.uid))
    setBusy(false)
    return sent
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
          <p className="text-secondary">{when(invitation.start, invitation.end, invitation.all_day)}</p>
          {invitation.repeats && <p className="text-secondary">{t('invite.repeats', { defaultValue: 'Repeats' })}</p>}
          {invitation.location && <p className="text-secondary">{invitation.location}</p>}
          {invitation.organizer && (
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

      {outdated ? (
        <p className="mt-2 text-secondary">
          {t('invite.outdated', { defaultValue: 'A newer version of this invitation has already been answered.' })}
        </p>
      ) : serverKeeps && method !== 'REPLY' ? (
        <p className="mt-2 text-secondary">
          {t('invite.serverKeeps', {
            defaultValue: 'This account keeps invitations in its own calendar; answer it there.',
          })}
        </p>
      ) : method === 'REQUEST' ? (
        <div className="mt-2.5 flex flex-col gap-2">
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
