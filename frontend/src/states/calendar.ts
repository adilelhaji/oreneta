import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { accounts$ } from './accounts'
import type { Account } from '../types'
import { showToast, ui$ } from './ui'
import { t } from '../lib/i18n'
import { settings$ } from './settings'
import {
  effectiveWorkDays,
  localeWeekInfo,
  resolveFirstDay,
  systemLocale,
  weekStartOf,
  type LocaleWeekInfo,
  type Weekday,
} from '../lib/calendarWeek'
import {
  buildNotice,
  cancellationNotSent,
  cancellationSent,
  mailsNotices,
  noticeRecipients,
  noticeSender,
  notifyAfterSave,
  sendNotice,
  type Notice,
} from './organizerNotices'

/// Whether an account keeps calendars on its server. Exchange does, and so
/// does a Google account signed in with Google. Plain IMAP has no calendar
/// concept at all — including a Google account added with an app password,
/// which authenticates mail only and grants no API access.
export function accountSupportsCalendar(account: Account): boolean {
  return (
    account.provider === 'exchange' || !!account.ews_url || account.auth_type === 'gmail_oauth'
  )
}

/// One person on an event. `addr` is empty when the server identified them
/// only by an internal directory name, which is why `name` is what gets shown.
export type Participant = {
  name: string
  addr: string
  response: string
}

/// One occurrence, never a series: the server expands recurrences over the
/// window we ask for, so every event here is a concrete instance with real
/// start and end instants.
export type CalendarEvent = {
  id: string
  calendar_id: string
  change_key?: string | null
  subject: string
  location?: string | null
  /// Epoch seconds.
  start: number
  end: number
  all_day: boolean
  is_recurring: boolean
  /// The series this occurrence came from, when the server names one. Every
  /// occurrence of one series shares it.
  series_id?: string | null
  /// The event's own notes, as plain text.
  description?: string
  /// How it repeats, when it is being created as a series. Write-only: what
  /// comes back from a server are the occurrences, never the rule.
  recurrence?: Recurrence | null
  /// Minutes before the start a reminder is due; null or absent means none.
  reminder_minutes?: number | null
  is_cancelled: boolean
  free_busy: string
  my_response: string
  organizer?: Participant | null
  attendees: Participant[]
  /// The online meeting bound to it (#109): from the server, or found in its
  /// location or notes.
  meeting?: OnlineMeeting | null
  /// Write-only: create a Google Meet with this save, or remove the one there.
  add_meeting?: 'meet' | 'none'
  /// Answer to a meeting asked for: ready, still being set up, or not made.
  meeting_status?: 'ready' | 'pending' | 'failed'
  /// Which account it came from. The core answers per account, so this is
  /// stamped on merge rather than sent.
  accountId: string
}

export type OnlineMeeting = { provider: string; url: string }

/// What a meeting service is called.
export function meetingName(provider: string): string {
  return (
    {
      meet: 'Google Meet',
      zoom: 'Zoom',
      teams: 'Microsoft Teams',
      webex: 'Webex',
      jitsi: 'Jitsi Meet',
      gotomeeting: 'GoTo Meeting',
      whereby: 'Whereby',
    } as Record<string, string>
  )[provider] ?? provider
}

/// Whether this build can make a meeting on the event's calendar: Google Meet,
/// on a calendar of a Google account signed in with OAuth (#109).
export function canAddMeet(event: { calendar_id: string; accountId: string }): boolean {
  const calendar = calendar$.calendars.peek().find((c) => c.id === event.calendar_id && c.accountId === event.accountId)
  const account = accounts$.peek().find((a) => a.id === event.accountId)
  return calendar?.kind === 'account' && account?.auth_type === 'gmail_oauth'
}

/// Where a calendar comes from, which decides how it syncs and whether its
/// events can be changed.
export type CalendarKind = 'account' | 'local' | 'subscribed' | 'caldav'

export type Calendar = {
  id: string
  name: string
  is_default: boolean
  enabled: boolean
  color?: string | null
  kind: CalendarKind
  url?: string | null
  read_only: boolean
  synced_at: number
  accountId: string
}

/// How often an event repeats.
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly'

export type Recurrence = {
  freq: Frequency
  /// Every N days/weeks/months/years.
  interval: number
  /// Which days a weekly rule falls on, 0 = Monday … 6 = Sunday. Empty means
  /// the day the event itself starts on.
  weekdays: number[]
  /// The last day the series may fall on, as epoch seconds.
  until?: number | null
  /// Or a fixed number of occurrences.
  count?: number | null
  /// A monthly or yearly rule on the nth weekday (1–4, or -1 for the last)
  /// instead of a day of the month; the weekday is the first of `weekdays`
  /// (ADR-0053). Tasks only, for now.
  month_week?: number | null
  /// A monthly or yearly rule's day of the month, when it is not the start's
  /// own (a task moved from the 31st to a shorter month's last day).
  month_day?: number | null
}

/// The event being edited, or null when the editor is closed. A new event has
/// an empty id: the server assigns one on create.
export type EventDraft = Omit<CalendarEvent, 'id'> & { id: string }

/// How the calendar is drawn. The agenda answers "what is next"; the grids
/// answer "what does my day / week / month look like".
export type CalendarViewMode = 'agenda' | 'day' | 'week' | 'month'

export const calendar$ = observable({
  /// Open editor, if any.
  editing: null as EventDraft | null,
  saving: false,
  /// The window currently shown, as epoch seconds.
  from: 0,
  to: 0,
  events: [] as CalendarEvent[],
  calendars: [] as Calendar[],
  loading: false,
  error: '',
  /// The event being read, or null. Separate from `editing`: opening an event
  /// asks "what is this", and only then "change this".
  viewing: null as CalendarEvent | null,
  /// Why the last refresh from a server failed, if it did. Separate from
  /// `error`, which belongs to something the reader just did: this one is
  /// about the agenda on screen being older than it looks.
  syncError: '',
  view: 'agenda' as CalendarViewMode,
  /// The day the current view is anchored on, as local-midnight epoch ms.
  anchor: startOfDay(new Date()).getTime(),
})

/// How far ahead the agenda reaches. Wide enough that scrolling rarely runs
/// out, narrow enough that the first sync of a busy calendar stays quick.
export const AGENDA_DAYS = 90

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

let cachedWeek: { locale: string; info: LocaleWeekInfo } | null = null

/// The system locale's week (ADR-0051): its first day, weekend and the minimum
/// days of week 1. The system's, not the interface language's, because only it
/// carries a region — an English interface in Madrid still has Monday weeks.
export function localeWeek(): LocaleWeekInfo {
  const locale = systemLocale()
  if (cachedWeek?.locale !== locale) cachedWeek = { locale, info: localeWeekInfo(locale) }
  return cachedWeek.info
}

/// The day the week opens on: the person's choice, else the locale's.
export function firstDayOfWeek(choice = settings$.calendarWeekStart.peek()): Weekday {
  return resolveFirstDay(choice, localeWeek())
}

/// The working days, ISO-numbered: the chosen ones, else all but the weekend.
export function workDays(prefs = settings$.calendar.peek()): Weekday[] {
  return effectiveWorkDays(prefs, localeWeek())
}

/// Local midnight of the first day of the week, on the configured first day.
export function startOfWeek(date: Date, firstDay: Weekday = firstDayOfWeek()): Date {
  return weekStartOf(startOfDay(date), firstDay)
}

/// The [from, to) window a view needs, in epoch seconds. Boundaries are
/// computed with calendar arithmetic, not by adding day-lengths: a window
/// crossing a daylight-saving change still starts and ends at midnight.
export function viewRange(view: CalendarViewMode, anchorMs: number): [number, number] {
  const anchor = new Date(anchorMs)
  const day = startOfDay(anchor)
  const seconds = (date: Date) => Math.floor(date.getTime() / 1000)
  if (view === 'day') {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
    return [seconds(day), seconds(next)]
  }
  if (view === 'week') {
    const monday = startOfWeek(day)
    const next = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7)
    return [seconds(monday), seconds(next)]
  }
  if (view === 'month') {
    // The six full weeks the month grid draws, padding days included: the
    // grid shows them, so it loads them.
    const gridStart = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
    const end = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 42)
    return [seconds(gridStart), seconds(end)]
  }
  const now = Math.floor(Date.now() / 1000)
  return [now, now + AGENDA_DAYS * 24 * 3600]
}

/// Loads whatever window the current view and anchor call for.
export async function loadCurrentView(refresh = true) {
  const [from, to] = viewRange(calendar$.view.peek(), calendar$.anchor.peek())
  await loadWindow(from, to, refresh)
}

export function setCalendarView(view: CalendarViewMode) {
  calendar$.view.set(view)
  void loadCurrentView()
}

/// Moves the anchor one period back or forward, or to today with 0.
export function navigateCalendar(step: -1 | 0 | 1) {
  if (step === 0) {
    calendar$.anchor.set(startOfDay(new Date()).getTime())
  } else {
    const view = calendar$.view.peek()
    const anchor = new Date(calendar$.anchor.peek())
    const moved =
      view === 'month'
        ? new Date(anchor.getFullYear(), anchor.getMonth() + step, 1)
        : new Date(
            anchor.getFullYear(),
            anchor.getMonth(),
            anchor.getDate() + step * (view === 'week' ? 7 : 1),
          )
    calendar$.anchor.set(moved.getTime())
  }
  void loadCurrentView()
}

/// Colours calendars by account so a merged agenda stays readable. Indexed by
/// the account's position, which is stable for a given set of accounts.
const ACCOUNT_COLORS = ['#2056DD', '#E8830C', '#2E9E5B', '#8B5CF6', '#E24C3B', '#0891B2']

export function accountColor(accountId: string): string {
  const index = accounts$.peek().findIndex((account) => account.id === accountId)
  return ACCOUNT_COLORS[(index < 0 ? 0 : index) % ACCOUNT_COLORS.length]
}

/// What else is known about the series an occurrence belongs to, from the
/// occurrences already loaded.
///
/// Deliberately says "in the window loaded", not "in total": servers expand
/// series into occurrences over the range asked for, and this client never
/// interprets recurrence rules, so how many the series has altogether is not
/// something it can honestly claim to know.
export function seriesInWindow(
  event: CalendarEvent,
  events: CalendarEvent[],
): { next: CalendarEvent | null; upcoming: number } | null {
  if (!event.series_id) return null
  const now = Date.now() / 1000
  const siblings = events
    .filter(
      (candidate) =>
        candidate.accountId === event.accountId &&
        candidate.series_id === event.series_id &&
        candidate.id !== event.id &&
        !candidate.is_cancelled,
    )
    .sort((a, b) => a.start - b.start)
  const later = siblings.filter((candidate) => candidate.start > Math.max(now, event.start))
  return { next: later[0] ?? null, upcoming: later.length }
}

/// The colour an event is drawn in: its calendar's, falling back to its
/// account's while the calendar list is still loading or when the calendar has
/// no colour of its own. One place, so every view agrees.
export function eventColor(event: CalendarEvent, calendars: Calendar[]): string {
  const calendar = calendars.find(
    (candidate) => candidate.accountId === event.accountId && candidate.id === event.calendar_id,
  )
  return calendar?.color || accountColor(event.accountId)
}

/// Loads a window across every account, merged and sorted by start.
///
/// Each account answers from its own cache and refreshes behind the request,
/// so this returns quickly and the view settles when `calendar.synced` lands.
export async function loadWindow(from: number, to: number, refresh = true) {
  calendar$.from.set(from)
  calendar$.to.set(to)
  calendar$.loading.set(true)
  calendar$.error.set('')
  try {
    const accounts = accounts$.peek().filter((account) => !isFeedAccount(account.id))
    const perAccount = await Promise.all(
      accounts.map(async (account) => {
        try {
          const res = await invoke<{ events: CalendarEvent[] }>('calendar.events', {
            account_id: account.id,
            from,
            to,
            refresh,
          })
          return (res.events ?? []).map((event) => ({ ...event, accountId: account.id }))
        } catch {
          // One account failing must not blank the whole agenda; the others
          // still have events worth showing.
          return [] as CalendarEvent[]
        }
      }),
    )
    const merged = perAccount.flat().sort((a, b) => a.start - b.start || a.subject.localeCompare(b.subject))
    calendar$.events.set(merged)
  } catch (err) {
    calendar$.error.set(String(err))
  } finally {
    calendar$.loading.set(false)
  }
}

export async function loadCalendars() {
  const accounts = accounts$.peek().filter((account) => !isFeedAccount(account.id))
  const perAccount = await Promise.all(
    accounts.map(async (account) => {
      try {
        const res = await invoke<{ calendars: Calendar[] }>('calendar.list', {
          account_id: account.id,
        })
        return (res.calendars ?? []).map((calendar) => ({ ...calendar, accountId: account.id }))
      } catch {
        return [] as Calendar[]
      }
    }),
  )
  calendar$.calendars.set(perAccount.flat())
}

/// Whether an account is a Google one — by auth type, provider, or its
/// servers, so an app-password IMAP setup is recognised too. Google calendars
/// need their own backend, which is not wired up yet; the settings page uses
/// this to say so instead of staying silent.
export function isGoogleAccount(account: Account): boolean {
  return (
    account.auth_type === 'gmail_oauth' ||
    account.provider === 'gmail' ||
    /gmail|googlemail/i.test(account.imap_host ?? '') ||
    /@(gmail|googlemail)\./i.test(account.email)
  )
}

/// Re-runs calendar discovery for one account, on demand. The events call
/// refreshes behind the request: it lists the account's calendars again and
/// re-syncs the window, and the calendar.synced event reloads state here.
export async function importAccountCalendars(accountId: string) {
  const now = Math.floor(Date.now() / 1000)
  const { from, to } = calendar$.peek()
  const [windowFrom, windowTo] =
    to > from ? [from, to] : [now - 7 * 24 * 3600, now + 90 * 24 * 3600]
  await invoke('calendar.events', {
    account_id: accountId,
    from: windowFrom,
    to: windowTo,
    refresh: true,
  })
  await loadCalendars()
  // How many the server offers, so the caller can tell the user something
  // happened even when nothing new turned up.
  return calendar$.calendars
    .peek()
    .filter((calendar) => calendar.accountId === accountId && calendar.kind === 'account').length
}

export async function setCalendarEnabled(accountId: string, calendarId: string, enabled: boolean) {
  await invoke('calendar.setEnabled', {
    account_id: accountId,
    calendar_id: calendarId,
    enabled,
  })
  calendar$.calendars.set(
    calendar$.calendars
      .peek()
      .map((calendar) =>
        calendar.accountId === accountId && calendar.id === calendarId ? { ...calendar, enabled } : calendar,
      ),
  )
  // The window's contents depend on which calendars are shown, so re-read it.
  const { from, to } = calendar$.peek()
  if (to > from) await loadWindow(from, to, false)
}

/// Feed accounts and the unified view keep no calendar.
export function isFeedAccount(id: string): boolean {
  return id.startsWith('rss:') || id === 'unified'
}

/// Groups a window's events by local day, for an agenda that reads as a diary.
/// The days an all-day event covers, as the local midnights the views key on.
///
/// An all-day event is a run of calendar dates, not a span of instants: it is
/// stored at midnight UTC because a date has no hour of its own. Reading those
/// instants in the reader's timezone would smear each date onto the next — a
/// holiday on the 27th showing on the 27th and the 28th east of Greenwich — so
/// the dates are read back as dates, in the zone they were written in.
export function allDayLocalDays(event: CalendarEvent): number[] {
  const first = new Date(event.start * 1000)
  // The end is exclusive: a one-day event ends at midnight of the next.
  const days = Math.max(1, Math.round((event.end - event.start) / 86400))
  return Array.from({ length: days }, (_, offset) => {
    const date = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate() + offset),
    )
    return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()).getTime()
  })
}

/// One day's entry in the agenda: the event, and whether this is a later day
/// of one that started earlier.
export type DayEntry = { event: CalendarEvent; continues: boolean }

/// Groups events by the days they occupy, in the reader's own timezone.
///
/// An event spanning several days appears on each of them, which is what every
/// calendar does and what the question an agenda answers demands: a holiday
/// that began on Monday still occupies Wednesday, even though it does not
/// start that day. The later days are marked as continuing, so a reader can
/// tell "this starts now" from "this is still going".
export function groupByDay(events: CalendarEvent[]): { day: number; events: DayEntry[] }[] {
  const days = new Map<number, DayEntry[]>()
  const midnightOf = (instant: number) => {
    const date = new Date(instant * 1000)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  const add = (day: number, entry: DayEntry) => {
    const bucket = days.get(day)
    if (bucket) bucket.push(entry)
    else days.set(day, [entry])
  }

  for (const event of events) {
    if (event.all_day) {
      // Dates, not instants: see allDayLocalDays.
      allDayLocalDays(event).forEach((day, index) => add(day, { event, continues: index > 0 }))
      continue
    }

    const firstDay = midnightOf(event.start)
    add(firstDay, { event, continues: false })

    // Days after the first, up to but not including the one the event ends on
    // when it ends exactly at midnight: an all-day event's end is exclusive,
    // and a meeting finishing at midnight does not occupy the next morning.
    let day = new Date(firstDay)
    for (;;) {
      day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
      const dayStart = day.getTime() / 1000
      if (event.end <= dayStart) break
      add(day.getTime(), { event, continues: true })
    }
  }

  return [...days.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, entries]) => ({
      day,
      // Within a day, what is already under way comes before what starts.
      events: entries.sort(
        (a, b) => Number(b.continues) - Number(a.continues) || a.event.start - b.event.start,
      ),
    }))
}


/// The calendars a new event can be saved to: shown, and neither read-only
/// nor a subscription, which belong to whoever publishes them.
export function writableCalendars(calendars: Calendar[]): Calendar[] {
  return calendars.filter((calendar) => calendar.enabled && !calendar.read_only && calendar.kind !== 'subscribed')
}

/// Opens the editor on a new event, defaulting to the next round hour.
export function newEvent(startAt?: number): EventDraft | null {
  const calendars = writableCalendars(calendar$.calendars.peek())
  const target = calendars.find((calendar) => calendar.is_default) ?? calendars[0]
  // With no calendar there is nowhere to put it, and inventing one would fail
  // at save time with a worse message.
  if (!target) return null
  const start = startAt ?? Math.ceil(Date.now() / 1000 / 3600) * 3600
  // Calendar → General: how long a new event lasts and whether it reminds.
  const { defaultDuration, defaultReminder } = settings$.calendar.peek()
  const draft: EventDraft = {
    id: '',
    calendar_id: target.id,
    accountId: target.accountId,
    subject: '',
    location: '',
    start,
    end: start + defaultDuration * 60,
    ...(defaultReminder === null ? {} : { reminder_minutes: defaultReminder }),
    all_day: false,
    is_recurring: false,
    is_cancelled: false,
    free_busy: '',
    my_response: '',
    organizer: null,
    attendees: [],
  }
  calendar$.editing.set(draft)
  return draft
}

/// Shows the calendar's day view on the local day of `date`, in place of the
/// other views that take the same pane.
export function openCalendarOn(date: Date) {
  calendar$.anchor.set(startOfDay(date).getTime())
  calendar$.view.set('day')
  ui$.peopleOpen.set(false)
  ui$.tasksOpen.set(false)
  ui$.notesOpen.set(false)
  ui$.attachmentsOpen.set(false)
  ui$.messagingOpen.set(false)
  ui$.calendarOpen.set(true)
}

/// A notice of missed reminders was clicked (#225): the calendar on the day
/// it names ("YYYY-MM-DD", the reader's local day), in the week view when it
/// says so ("week:YYYY-MM-DD", misses on several days), or on today when it
/// names none it can read.
export function openCalendarFromNotification(target: string) {
  const week = target.startsWith('week:')
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(week ? target.slice('week:'.length) : target)
  const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date()
  const real = match && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3])
  openCalendarOn(real ? date : new Date())
  if (week) calendar$.view.set('week')
}

export function openEvent(event: CalendarEvent) {
  calendar$.viewing.set({ ...event })
}

export function closeDetails() {
  calendar$.viewing.set(null)
}

/// An answer to a meeting invitation.
export type MeetingResponse = 'accept' | 'tentative' | 'decline'

/// Answers a meeting invitation, telling the organiser.
///
/// The one calendar action that deliberately reaches another person, so it is
/// never taken on the reader's behalf — only when they press one of the three.
export async function respondToInvitation(event: CalendarEvent, response: MeetingResponse) {
  calendar$.error.set('')
  try {
    await invoke('calendar.respond', {
      account_id: event.accountId,
      calendar_id: event.calendar_id,
      event_id: event.id,
      change_key: event.change_key ?? '',
      response,
      start: event.start,
      end: event.end,
    })
    // Shown at once rather than waiting for the sync behind it: the answer is
    // already on its way, and a button that seems not to have worked invites
    // pressing it again.
    calendar$.events.set(
      calendar$.events
        .peek()
        .map((candidate) =>
          candidate.id === event.id ? { ...candidate, my_response: response } : candidate,
        ),
    )
    const viewing = calendar$.viewing.peek()
    if (viewing && viewing.id === event.id) {
      calendar$.viewing.set({ ...viewing, my_response: response })
    }
  } catch (err) {
    calendar$.error.set(String(err))
    throw err
  }
}

/// Refreshes the window on screen from every account's server.
///
/// The one the retry button calls: a failed sync leaves the agenda showing
/// what it last knew, and this is how a reader asks for another attempt
/// without hunting through settings.
export async function retrySync() {
  calendar$.syncError.set('')
  const { from, to } = calendar$.peek()
  if (to > from) await loadWindow(from, to, true)
}

/// People matching what has been typed, for choosing who to invite.
///
/// Exchange answers from its directory; elsewhere an address typed in full is
/// its own match, so a field that finds nothing does not look like "no such
/// person" for an address that is perfectly valid.
export async function resolveNames(accountId: string, query: string): Promise<Participant[]> {
  if (query.trim().length < 2) return []
  try {
    const res = await invoke<{ people: Participant[] }>('calendar.resolveNames', {
      account_id: accountId,
      query,
    })
    return res.people ?? []
  } catch {
    // A directory that cannot be reached must not stop someone typing an
    // address they already know.
    return []
  }
}

/// Reads what a cached occurrence cannot carry: who is on the event and its
/// notes.
///
/// Exchange's window query returns neither — its FindItem never returns
/// collections or bodies, however they are asked for — so an event's people
/// and notes are fetched when it is opened rather than shown as absent.
export async function loadEventDetails(
  event: CalendarEvent,
): Promise<{ attendees: Participant[]; description: string } | null> {
  try {
    return await invoke<{ attendees: Participant[]; description: string }>(
      'calendar.eventDetails',
      {
        account_id: event.accountId,
        calendar_id: event.calendar_id,
        event_id: event.id,
        change_key: event.change_key ?? '',
      },
    )
  } catch {
    // Not reaching them is survivable: the event still shows what the window
    // knew, which is everything except these two.
    return null
  }
}

/// Reads the rule behind an event's series, for the editor to show.
///
/// Asked for on opening rather than carried with the event: the core keeps
/// occurrences, never rules, so this is one request instead of a stored second
/// copy that could go stale.
export async function loadSeriesRule(event: CalendarEvent): Promise<Recurrence | null> {
  if (!event.is_recurring) return null
  try {
    const res = await invoke<{ recurrence: Recurrence | null }>('calendar.seriesRule', {
      account_id: event.accountId,
      calendar_id: event.calendar_id,
      event_id: event.id,
      change_key: event.change_key ?? '',
      series_id: event.series_id ?? '',
    })
    return res.recurrence ?? null
  } catch {
    // Not knowing the rule is survivable: the editor shows no repetition
    // rather than a wrong one, and everything else still saves.
    return null
  }
}

export function editEvent(event: CalendarEvent) {
  // Editing supersedes reading: the details close behind the editor rather
  // than stacking two dialogs on top of each other.
  calendar$.viewing.set(null)
  calendar$.editing.set({ ...event })
}

export function closeEditor() {
  calendar$.editing.set(null)
  calendar$.saving.set(false)
}

/// Saves the open draft, creating it or updating it as appropriate.
/// Which occurrences a change reaches: the one in hand, or every one of its
/// series.
export type EditScope = 'occurrence' | 'series'

/// The kind of calendar an event is in.
function kindOf(event: Pick<CalendarEvent, 'calendar_id' | 'accountId'>): CalendarKind | undefined {
  return calendar$.calendars.peek().find((c) => c.id === event.calendar_id && c.accountId === event.accountId)?.kind
}

/// Telling the people on an event: Google and Exchange do it themselves when
/// asked (`notify` reaches them); for a local or CalDAV calendar nothing on a
/// server mails anyone, so the notice is built and sent from here once the
/// event is saved (2026-10-12).
export async function saveEvent(
  draft: EventDraft,
  scope: EditScope = 'occurrence',
  notify = false,
) {
  calendar$.saving.set(true)
  calendar$.error.set('')
  const byMail = notify && mailsNotices(kindOf(draft))
  const sender = byMail ? noticeSender(draft, accounts$.peek()) : null
  // The people the person was shown, and only them.
  const people = byMail ? noticeRecipients(draft, sender) : []
  // The guests taken out in the editor, so a CalDAV copy drops them and
  // nobody it names that the editor never showed.
  const opened = calendar$.editing.peek()
  const removed =
    draft.id && opened?.id === draft.id
      ? opened.attendees
          .filter((person) => person.addr && !draft.attendees.some((kept) => sameAddr(kept.addr, person.addr)))
          .map((person) => person.addr)
      : []
  try {
    let savedId = draft.id
    if (draft.id) {
      await invoke('calendar.update', {
        account_id: draft.accountId,
        event: draft,
        scope,
        notify: byMail ? false : notify,
        removed_attendees: removed,
      })
    } else {
      const created = await invoke<{ event?: { id?: string; meeting_status?: string } }>('calendar.create', {
        account_id: draft.accountId,
        event: draft,
        notify: byMail ? false : notify,
      })
      savedId = created?.event?.id ?? ''
      // Said, not assumed: an account without Meet saves the event alone.
      const status = created?.event?.meeting_status
      if (status === 'failed')
        showToast(
          t('calendar.meetFailed', {
            defaultValue: 'The event was saved, but Google did not create a Meet for it. This account may not allow it.',
          }),
          'error',
        )
      if (status === 'pending')
        showToast(t('calendar.meetPending', { defaultValue: 'Google is still setting up the Meet; it appears shortly.' }))
    }
    closeEditor()
    if (byMail) {
      if (sender && savedId) await notifyAfterSave({ ...draft, id: savedId }, scope, sender, people)
      else
        showToast(
          t('calendar.noticeNoSender', {
            defaultValue: 'The event was saved, but no mail account here can tell the people on it.',
          }),
          'error',
        )
    }
    const { from, to } = calendar$.peek()
    if (to > from) await loadWindow(from, to, false)
  } catch (err) {
    // Left open with the message: closing would lose what was typed, and the
    // server rejecting a save is exactly when that matters most.
    calendar$.error.set(String(err))
    calendar$.saving.set(false)
  }
}

export async function deleteEvent(
  event: CalendarEvent,
  scope: EditScope = 'occurrence',
  notify = false,
) {
  calendar$.error.set('')
  // A cancellation from here is built, then the event deleted, then the
  // cancellation sent. Built first because it is made from the stored event,
  // which the delete removes; sent last so that a delete the server refuses
  // (a conflict, a lost connection) tells nobody a meeting is off that is
  // still on. A failed build deletes nothing; a failed send is said.
  const byMail = notify && mailsNotices(kindOf(event))
  let notice: Notice | null = null
  const sender = byMail ? noticeSender(event, accounts$.peek()) : null
  if (byMail) {
    try {
      if (!sender) throw new Error(t('calendar.noSender', { defaultValue: 'no mail account here can send it' }))
      notice = await buildNotice(event, scope, 'cancel', sender, noticeRecipients(event, sender))
    } catch (err) {
      calendar$.error.set(
        t('calendar.cancelNotBuilt', {
          reason: err instanceof Error ? err.message : String(err),
          defaultValue: 'Nothing was deleted: the cancellation could not be prepared: {reason}',
        }),
      )
      return
    }
  }
  try {
    await invoke('calendar.delete', {
      account_id: event.accountId,
      event_id: event.id,
      // Exchange finds an event by its own id; Google needs the calendar
      // holding it, and the series when a whole one is going.
      calendar_id: event.calendar_id,
      change_key: event.change_key ?? '',
      series_id: event.series_id ?? '',
      scope,
      notify: byMail ? false : notify,
    })
    closeEditor()
    calendar$.viewing.set(null)
    calendar$.events.set(
      calendar$.events
        .peek()
        .filter((candidate) =>
          scope === 'series' && event.series_id
            ? candidate.series_id !== event.series_id
            : candidate.id !== event.id,
        ),
    )
  } catch (err) {
    calendar$.error.set(String(err))
    return
  }
  if (notice && sender) {
    try {
      await sendNotice(sender, notice)
      cancellationSent()
    } catch (err) {
      cancellationNotSent(err)
    }
  }
}

function sameAddr(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}


export async function createCalendar(accountId: string, name: string): Promise<string> {
  const res = await invoke<{ id: string }>('calendar.createCalendar', {
    account_id: accountId,
    name,
  })
  await loadCalendars()
  return res.id
}

export async function renameCalendar(accountId: string, calendarId: string, name: string) {
  await invoke('calendar.renameCalendar', {
    account_id: accountId,
    calendar_id: calendarId,
    name,
  })
  calendar$.calendars.set(
    calendar$.calendars
      .peek()
      .map((calendar) =>
        calendar.accountId === accountId && calendar.id === calendarId ? { ...calendar, name } : calendar,
      ),
  )
}

/// Deletes a calendar and, with it, every event on it. The confirmation is the
/// caller's: by the time this runs the choice is made.
export async function deleteCalendar(accountId: string, calendarId: string) {
  await invoke('calendar.deleteCalendar', { account_id: accountId, calendar_id: calendarId })
  calendar$.calendars.set(
    calendar$.calendars
      .peek()
      .filter((calendar) => !(calendar.accountId === accountId && calendar.id === calendarId)),
  )
  calendar$.events.set(calendar$.events.peek().filter((event) => event.calendar_id !== calendarId))
}

export async function setCalendarColor(accountId: string, calendarId: string, color: string) {
  await invoke('calendar.setColor', {
    account_id: accountId,
    calendar_id: calendarId,
    color,
  })
  calendar$.calendars.set(
    calendar$.calendars
      .peek()
      .map((calendar) =>
        calendar.accountId === accountId && calendar.id === calendarId ? { ...calendar, color } : calendar,
      ),
  )
}

/// The palette offered for a calendar. Colours are a local choice: Exchange
/// has none other clients agree on, so syncing one would write a property
/// nothing else reads.
export const CALENDAR_COLORS = ACCOUNT_COLORS


export async function createLocalCalendar(accountId: string, name: string): Promise<string> {
  const res = await invoke<{ id: string }>('calendar.createLocal', {
    account_id: accountId,
    name,
  })
  await loadCalendars()
  return res.id
}

/// A calendar collection found on a CalDAV server (#101, ADR-0018).
export type RemoteCalendar = { url: string; name: string; color: string | null; writable: boolean | null }

/// Asks a CalDAV server which calendars it holds for this sign-in. The account
/// it will be kept under decides the route the request takes (its own proxy,
/// direct, or the app-wide one).
export async function discoverCalDav(
  accountId: string,
  server: string,
  username: string,
  password: string,
): Promise<RemoteCalendar[]> {
  const res = await invoke<{ calendars: RemoteCalendar[] }>('caldav.discover', {
    account: accountId,
    server,
    username,
    password,
  })
  return res?.calendars ?? []
}

/// Keeps the chosen CalDAV calendars, listed under an account. The password
/// goes to the system keychain, one entry per calendar.
export async function addCalDav(
  accountId: string,
  username: string,
  password: string,
  calendars: RemoteCalendar[],
): Promise<string[]> {
  const res = await invoke<{ ids: string[] }>('caldav.add', { account: accountId, username, password, calendars })
  await loadCalendars()
  return res?.ids ?? []
}

/// Follows a published calendar file. The core fetches it once before storing,
/// so a URL that is not a calendar fails here rather than becoming a
/// subscription that never fills.
export async function subscribeCalendar(
  accountId: string,
  name: string,
  url: string,
): Promise<string> {
  const res = await invoke<{ id: string }>('calendar.subscribe', {
    account_id: accountId,
    name,
    url,
  })
  await loadCalendars()
  return res.id
}
