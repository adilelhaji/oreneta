import { useEffect, useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { Trash2, X } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import {
  calendar$,
  canAddMeet,
  closeEditor,
  meetingName,
  deleteEvent,
  loadSeriesRule,
  resolveNames,
  saveEvent,
  writableCalendars,
  type EditScope,
  type EventDraft,
  type Participant,
} from '../../states/calendar'
import { accounts$ } from '../../states/accounts'
import { mailsNotices, noticeRecipients, noticeSender, organizerFor } from '../../states/organizerNotices'
import { ScopeAsk } from './ScopeAsk'
import { NotifyAsk } from './NotifyAsk'
import { ConflictNote } from './ConflictNote'
import { RepeatFields } from './RepeatFields'

/// Creates or edits one event.
///
/// Saving tells nobody on its own. When the event has people on it, saving or
/// deleting asks whether to tell them, naming who, and only what the person
/// chooses is sent: by the account's server for Google and Exchange, by mail
/// from here for local and CalDAV calendars (2026-10-12). Where nothing could
/// be sent — someone else organizes it, or no account here sends mail — the
/// question is not asked and a note says so.
export function EventEditor() {
  const { t } = useTranslation()
  const draft = useValue(calendar$.editing)
  const saving = useValue(calendar$.saving)
  const error = useValue(calendar$.error)
  const calendars = useValue(calendar$.calendars)
  const accounts = useValue(accounts$)
  const [local, setLocal] = useState<EventDraft | null>(null)
  const [pendingScope, setPendingScope] = useState<'save' | 'delete' | null>(null)
  // An action waiting on "should the people on it be told?", with the scope
  // already decided.
  const [pendingNotify, setPendingNotify] = useState<{
    action: 'save' | 'delete'
    scope: EditScope
  } | null>(null)
  // The rule is not carried with an occurrence, so it is fetched once when a
  // repeating event is opened.
  const [ruleLoaded, setRuleLoaded] = useState('')

  // The rule behind a series, fetched once per opening. Runs before the early
  // return, since a hook behind a condition changes the count between renders.
  useEffect(() => {
    if (!draft?.id || !draft.is_recurring || !draft.series_id) return
    if (ruleLoaded === draft.id) return
    setRuleLoaded(draft.id)
    let live = true
    void loadSeriesRule(draft).then((recurrence) => {
      // Merged into whatever is on screen rather than replacing it: the reader
      // may have typed while the answer was in flight.
      if (live && recurrence) {
        setLocal((current) => ({ ...(current ?? draft), recurrence }))
      }
    })
    return () => {
      live = false
    }
  }, [draft?.id, draft?.is_recurring, draft?.series_id, ruleLoaded])

  // Adopt the draft once per opening, so typing is not overwritten by the
  // observable it came from.
  const event = local && draft && local.id === draft.id ? local : draft
  if (!draft || !event) return null

  const set = (patch: Partial<EventDraft>) => setLocal({ ...event, ...patch })
  // Which action is waiting on "this one or all of them?", if any.
  const asking = pendingScope
  const isNew = !event.id
  const invalid = !event.subject.trim() || event.end < event.start
  // Only an occurrence of a real series raises the question; a one-off, or an
  // event being created, has only one answer.
  const repeats = !isNew && event.is_recurring && Boolean(event.series_id)
  // People who could be told. Only those with an address: an attendee the
  // server named without one cannot be written to. An account's own calendar
  // (Exchange, Google) tells them itself; a local or CalDAV one is told by
  // mail from here, which needs an account that sends as the organizer.
  // Without one the question is not asked, since nothing could follow it.
  const kind = calendars.find((c) => c.id === event.calendar_id && c.accountId === event.accountId)?.kind
  const byMail = mailsNotices(kind)
  const sender = byMail ? noticeSender(event, accounts) : null
  const canNotify = !byMail || sender !== null
  const invitees = !canNotify
    ? []
    : byMail
      ? noticeRecipients(event, sender)
      : event.attendees.map((person) => person.addr.trim()).filter(Boolean)
  // A meeting with guests is saved naming its organizer: the identity the
  // notice goes out from, when it names none yet.
  const toSave: EventDraft =
    byMail && sender && event.attendees.length > 0 ? { ...event, organizer: organizerFor(event, sender) } : event

  /// Runs an action through the questions it raises, in order: which
  /// occurrences, then whether to tell anyone. Neither is asked when it has
  /// only one answer.
  const begin = (action: 'save' | 'delete') => {
    if (repeats) return setPendingScope(action)
    if (invitees.length > 0) return setPendingNotify({ action, scope: 'occurrence' })
    if (action === 'save') void saveEvent(toSave)
    else void deleteEvent(event)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeEditor}>
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col rounded-panel border border-border bg-app shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between px-5 pb-3 pt-5">
          <h2 className="text-sm font-semibold text-primary">
            {isNew
              ? t('calendar.newEvent', { defaultValue: 'New event' })
              : t('calendar.editEvent', { defaultValue: 'Edit event' })}
          </h2>
          <button
            type="button"
            onClick={closeEditor}
            className="flex h-7 w-7 items-center justify-center rounded-control-sm text-secondary hover:bg-hover hover:text-primary cursor-pointer"
            aria-label={t('calendar.close', { defaultValue: 'Close' })}
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-1">
          <Labelled label={t('calendar.subject', { defaultValue: 'Title' })}>
            <input
              value={event.subject}
              onChange={(e) => set({ subject: e.target.value })}
              autoFocus
              className={inputClass}
            />
          </Labelled>

          <Labelled label={t('calendar.location', { defaultValue: 'Location' })}>
            <input
              value={event.location ?? ''}
              onChange={(e) => set({ location: e.target.value })}
              className={inputClass}
            />
          </Labelled>

          <Labelled label={t('calendar.attendees', { defaultValue: 'Invite' })}>
            <Attendees
              accountId={event.accountId}
              people={event.attendees}
              onChange={(attendees) => set({ attendees })}
              placeholder={t('calendar.attendeesHint', {
                defaultValue: 'Name or email address',
              })}
            />
          </Labelled>

          <Labelled label={t('calendar.reminder', { defaultValue: 'Reminder' })}>
            <select
              value={event.reminder_minutes ?? ''}
              onChange={(e) => set({ reminder_minutes: e.target.value === '' ? null : Number(e.target.value) })}
              className={inputClass}
            >
              <option value="">{t('calendar.reminderNone', { defaultValue: 'None' })}</option>
              {REMINDER_CHOICES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {reminderLabel(minutes, t)}
                </option>
              ))}
            </select>
          </Labelled>

          {/* An online meeting is made only by this choice, on this save (#109). */}
          {/* A group, not a label: it holds a button and its own labelled
              checkbox, which a <label> around them would misname. */}
          <div
            role="group"
            aria-label={t('calendar.meeting', { defaultValue: 'Online meeting' })}
            className="flex w-full flex-col gap-1.5"
          >
            <span className="ps-0.5 text-caption font-semibold text-secondary">
              {t('calendar.meeting', { defaultValue: 'Online meeting' })}
            </span>
            {event.meeting && event.add_meeting !== 'none' ? (
              <div className="flex flex-wrap items-center gap-2 text-caption">
                <span className="text-primary">{meetingName(event.meeting.provider)}</span>
                <span className="truncate text-secondary">{event.meeting.url}</span>
                {event.meeting.provider === 'meet' && canAddMeet(event) && (
                  <button
                    type="button"
                    onClick={() => set({ add_meeting: 'none' })}
                    className="text-accent underline cursor-pointer"
                  >
                    {t('calendar.meetingRemove', { defaultValue: 'Remove it' })}
                  </button>
                )}
              </div>
            ) : canAddMeet(event) ? (
              <label className="flex items-center gap-2 text-caption text-secondary">
                <input
                  type="checkbox"
                  checked={event.add_meeting === 'meet'}
                  onChange={(e) => set({ add_meeting: e.target.checked ? 'meet' : undefined })}
                  className="accent-accent"
                />
                {t('calendar.addMeet', { defaultValue: 'Add a Google Meet when saving' })}
              </label>
            ) : (
              <p className="text-caption text-secondary">
                {t('calendar.meetingHint', {
                  defaultValue:
                    'Here a meeting can be created only on Google calendars. A Zoom, Teams or other link pasted into the location or notes is recognised.',
                })}
              </p>
            )}
          </div>

          <Labelled label={t('calendar.description', { defaultValue: 'Notes' })}>
            <textarea
              value={event.description ?? ''}
              onChange={(e) => set({ description: e.target.value })}
              rows={4}
              className={`${inputClass} resize-y`}
            />
          </Labelled>

          <div className="flex flex-col gap-3">
            <Labelled label={t('calendar.starts', { defaultValue: 'Starts' })}>
              <DateAndTime
                value={event.start}
                allDay={event.all_day}
                onChange={(start) =>
                  // Keep the duration when the start moves, which is what
                  // moving a meeting to another time means.
                  set({ start, end: start + (event.end - event.start) })
                }
              />
            </Labelled>
            <Labelled label={t('calendar.ends', { defaultValue: 'Ends' })}>
              <DateAndTime value={event.end} allDay={event.all_day} onChange={(end) => set({ end })} />
            </Labelled>
          </div>

          <label className="flex items-center gap-2 text-xs text-primary">
            <input type="checkbox" checked={event.all_day} onChange={(e) => set(asAllDay(event, e.target.checked))} />
            {t('calendar.allDay', { defaultValue: 'All day' })}
          </label>

          {/* The person's own events at that time, from the calendars kept
              here; the event itself does not count. */}
          <ConflictNote
            start={event.start}
            end={event.end}
            allDay={event.all_day}
            exclude={[event.id, event.series_id ?? '']}
          />

          {/* The rule shows for a new event and for one whose series can be
              reached; a change to it takes effect when the save applies to the
              whole series, which is what the question on saving decides. */}
          {isNew || repeats ? (
            <RepeatFields
              rule={event.recurrence ?? null}
              start={event.start}
              onChange={(recurrence) => set({ recurrence })}
            />
          ) : (
            // Said only when the series genuinely cannot be reached: without an
            // identifier from the server there is no way to address it, and
            // offering the choice would be offering something that cannot be
            // carried out.
            event.is_recurring && (
              <p className="rounded-control bg-raised px-3 py-2 text-caption text-secondary">
                {t('calendar.seriesNotReachable', {
                  defaultValue:
                    'This event repeats, but its series has not been identified yet. Changes here apply to this day only; a refresh usually resolves it.',
                })}
              </p>
            )
          )}

          {isNew && writableCalendars(calendars).length > 1 && (
            <Labelled label={t('calendar.calendar', { defaultValue: 'Calendar' })}>
              <select
                value={`${event.accountId} ${event.calendar_id}`}
                onChange={(e) => {
                  const [accountId, calendar_id] = e.target.value.split(' ')
                  set({ accountId, calendar_id })
                }}
                className={inputClass}
              >
                {writableCalendars(calendars).map((calendar) => (
                  <option key={`${calendar.accountId}:${calendar.id}`} value={`${calendar.accountId} ${calendar.id}`}>
                    {calendar.name}
                  </option>
                ))}
              </select>
            </Labelled>
          )}

          {event.attendees.length > 0 && !canNotify && (
            <p className="text-caption text-secondary">
              {t('calendar.attendeesNote', {
                defaultValue: 'This event has {count} guests. Editing it here does not notify them.',
                count: event.attendees.length,
              })}
            </p>
          )}

          {event.end < event.start && (
            <p className="text-caption text-danger">
              {t('calendar.endsBeforeStart', { defaultValue: 'It ends before it starts.' })}
            </p>
          )}
        </div>

        {error && <p className="shrink-0 px-5 pt-2 text-caption text-danger">{error}</p>}

        {asking && (
          <ScopeAsk
            action={asking}
            onCancel={() => setPendingScope(null)}
            onChoose={(scope: EditScope) => {
              setPendingScope(null)
              if (invitees.length > 0) return setPendingNotify({ action: asking, scope })
              if (asking === 'save') void saveEvent(toSave, scope)
              else void deleteEvent(event, scope)
            }}
          />
        )}

        {pendingNotify && (
          <NotifyAsk
            action={pendingNotify.action}
            people={invitees}
            from={sender?.identity.email}
            onCancel={() => setPendingNotify(null)}
            onChoose={(notify) => {
              const { action, scope } = pendingNotify
              setPendingNotify(null)
              if (action === 'save') void saveEvent(toSave, scope, notify)
              else void deleteEvent(event, scope, notify)
            }}
          />
        )}

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-5 py-4">
          {!isNew ? (
            <button
              type="button"
              onClick={() => begin('delete')}
              className="inline-flex items-center gap-1.5 rounded-control px-3 py-2 text-xs font-medium text-danger transition-colors hover:bg-danger-soft cursor-pointer"
            >
              <Trash2 size={14} strokeWidth={1.75} />
              {t('calendar.delete', { defaultValue: 'Delete' })}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={closeEditor}
              className="rounded-control px-3 py-2 text-xs font-medium text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
            >
              {t('calendar.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="button"
              disabled={invalid || saving}
              onClick={() => begin('save')}
              className="rounded-control bg-accent px-4 py-2 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              {t('calendar.save', { defaultValue: 'Save' })}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const inputClass =
  'w-full rounded-control border border-border bg-raised px-3 py-2 text-xs text-primary outline-none transition-all focus:border-transparent focus:bg-chats focus:ring-1 focus:ring-accent'

/// The usual ladder of reminder times, in minutes before the start.
const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 24 * 60, 2 * 24 * 60, 7 * 24 * 60]

export function reminderLabel(minutes: number, t: ReturnType<typeof useTranslation>['t']): string {
  if (minutes === 0) return t('calendar.reminderAtStart', { defaultValue: 'At the start' })
  if (minutes % (7 * 24 * 60) === 0)
    return t('calendar.reminderWeeks', {
      defaultValue: '{count} weeks before',
      count: minutes / (7 * 24 * 60),
    })
  if (minutes % (24 * 60) === 0)
    return t('calendar.reminderDays', {
      defaultValue: '{count} days before',
      count: minutes / (24 * 60),
    })
  if (minutes % 60 === 0) return t('calendar.reminderHours', { defaultValue: '{count} h before', count: minutes / 60 })
  return t('calendar.reminderMinutes', { defaultValue: '{count} min before', count: minutes })
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex w-full flex-col gap-1.5">
      <span className="ps-0.5 text-caption font-semibold text-secondary">{label}</span>
      {children}
    </label>
  )
}

/// Epoch seconds to what a datetime-local input expects, in local time — the
/// timezone the person editing is in, which is the only one they can reason
/// about.
/// A date, an hour and a minute, as three controls rather than one
/// `datetime-local`.
///
/// The engine this app runs on renders `datetime-local` with a date picker and
/// no way to reach the time, which left every event stuck at whatever hour it
/// already had. Plain controls work the same everywhere; hour and minute are
/// separate so any time is reachable exactly, without hunting through a list
/// of every minute in the day.
export function DateAndTime({
  value,
  allDay,
  onChange,
}: {
  value: number
  allDay: boolean
  onChange: (epochSeconds: number) => void
}) {
  const date = new Date(value * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  // An all-day event is a date, stored at midnight UTC because a date has no
  // hour of its own; reading it in the reader's zone would name the day before
  // west of Greenwich. Anything with an hour is read where the reader is.
  const dateValue = allDay
    ? `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

  const setDate = (text: string) => {
    const [year, month, day] = text.split('-').map(Number)
    if (!year || !month || !day) return
    if (allDay) {
      onChange(Math.floor(Date.UTC(year, month - 1, day) / 1000))
      return
    }
    const next = new Date(value * 1000)
    next.setFullYear(year, month - 1, day)
    onChange(Math.floor(next.getTime() / 1000))
  }

  const setClock = (hours: number, minutes: number) => {
    const next = new Date(value * 1000)
    next.setHours(hours, minutes, 0, 0)
    onChange(Math.floor(next.getTime() / 1000))
  }

  return (
    <div className="flex items-stretch gap-2">
      <input
        type="date"
        value={dateValue}
        onChange={(e) => setDate(e.target.value)}
        className={`${inputClass} min-w-0 flex-1 max-w-[11.5rem]`}
      />
      {/* An all-day event has no hour to set, so none is offered. Hours and
          minutes share one frame: they are two controls but a single reading,
          and framing them apart made the time look wider than the date it
          belongs to. */}
      {!allDay && (
        <div className="flex shrink-0 items-center rounded-control border border-border bg-raised px-2 focus-within:border-transparent focus-within:bg-chats focus-within:ring-1 focus-within:ring-accent">
          <select
            value={date.getHours()}
            onChange={(e) => setClock(Number(e.target.value), date.getMinutes())}
            className={clockClass}
            aria-label="hh"
          >
            {HOURS.map((hour) => (
              <option key={hour} value={hour}>
                {pad(hour)}
              </option>
            ))}
          </select>
          <span className="text-xs font-medium text-secondary">:</span>
          <select
            value={date.getMinutes()}
            onChange={(e) => setClock(date.getHours(), Number(e.target.value))}
            className={clockClass}
            aria-label="mm"
          >
            {minuteChoices(date.getMinutes()).map((minute) => (
              <option key={minute} value={minute}>
                {pad(minute)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

/// The hour and minute selects, bare: the frame around them is the control.
const clockClass =
  'appearance-none bg-transparent px-2 py-2 text-sm font-medium tabular-nums text-primary outline-none cursor-pointer'

/// The people invited to an event, added one address at a time.
///
/// Addresses are typed rather than picked from a directory: translating an
/// Exchange directory name into an address needs a lookup this client does not
/// implement, and a picker that could not find half the organisation would be
/// worse than a plain field.
function Attendees({
  accountId,
  people,
  onChange,
  placeholder,
}: {
  accountId: string
  people: Participant[]
  onChange: (people: Participant[]) => void
  placeholder: string
}) {
  const [typed, setTyped] = useState('')
  const [matches, setMatches] = useState<Participant[]>([])

  // Asked after a pause, not on every keystroke: each answer is a round trip
  // to a directory, and nobody types a colleague's name one letter at a time.
  useEffect(() => {
    const query = typed.trim()
    if (query.length < 2) {
      setMatches([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void resolveNames(accountId, query).then((found) => {
        if (live) setMatches(found.filter((one) => !people.some((p) => p.addr === one.addr)))
      })
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [accountId, typed, people])

  const addPerson = (person: Participant) => {
    if (!person.addr || people.some((other) => other.addr === person.addr)) return
    onChange([...people, person])
    setTyped('')
    setMatches([])
  }

  const add = () => {
    // What was typed, when it is already an address. A name with no match is
    // not added: an attendee without an address cannot be invited.
    const addr = typed.trim()
    if (!addr.includes('@') || people.some((person) => person.addr === addr)) return
    addPerson({ name: '', addr, response: '' })
  }

  return (
    <div className="flex flex-col gap-1.5">
      {people.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {people.map((person) => (
            <li
              key={person.addr}
              className="flex items-center gap-1 rounded-control-sm bg-raised px-2 py-1 text-caption text-primary"
            >
              <span className="max-w-[12rem] truncate">{person.addr}</span>
              <button
                type="button"
                onClick={() => onChange(people.filter((other) => other.addr !== person.addr))}
                aria-label={person.addr}
                className="text-secondary hover:text-danger cursor-pointer"
              >
                <X size={14} strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault()
            // The first match when the directory found one, since that is what
            // the reader was looking at; otherwise what they typed.
            if (matches.length > 0) addPerson(matches[0])
            else add()
          }
        }}
        placeholder={placeholder}
        className={inputClass}
      />
      {matches.length > 0 && (
        <ul className="max-h-32 overflow-y-auto rounded-control border border-border bg-raised">
          {matches.slice(0, 8).map((person) => (
            <li key={person.addr}>
              <button
                type="button"
                onClick={() => addPerson(person)}
                className="flex w-full flex-col items-start px-3 py-1.5 text-start transition-colors hover:bg-hover cursor-pointer"
              >
                <span className="text-caption font-medium text-primary">{person.name || person.addr}</span>
                {person.name && <span className="text-2xs text-secondary">{person.addr}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/// Turning "all day" on or off rewrites the instants into what the other kind
/// of time means.
///
/// An all-day event covers whole dates, stored as midnight UTC with an
/// exclusive end — without this, ticking the box left a 15:32 start and an end
/// on the same date, which a server reads as an event that ends before it
/// begins.
function asAllDay(event: EventDraft, allDay: boolean): Partial<EventDraft> {
  if (allDay) {
    const start = new Date(event.start * 1000)
    const first = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()) / 1000
    return { all_day: true, start: first, end: first + 86400 }
  }
  // Back to a timed event: the date it covered, at a working hour.
  const date = new Date(event.start * 1000)
  const start = new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 9, 0, 0, 0)
  const seconds = Math.floor(start.getTime() / 1000)
  return { all_day: false, start: seconds, end: seconds + 3600 }
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)
/// Five-minute steps, which is short enough for anything anyone schedules and
/// keeps the list to a dozen entries rather than sixty.
const MINUTE_STEPS = Array.from({ length: 12 }, (_, index) => index * 5)

/// The steps, plus the event's own minute when it falls between them — an
/// invitation at 14:37 must survive being looked at.
function minuteChoices(current: number): number[] {
  return MINUTE_STEPS.includes(current) ? MINUTE_STEPS : [...MINUTE_STEPS, current].sort((a, b) => a - b)
}
