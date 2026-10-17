// Moving and resizing an event on the day and week grid, by pointer or by
// keyboard, and dropping it on the mini calendar (#266).
//
// One move at a time: it starts, is previewed where it would land while it is
// adjusted, and is then settled — asked about when it repeats or has people
// on it, exactly as the editor asks — and written with the version it was
// read at, or given up. Nothing reaches the server before it is settled, and
// a move on a calendar that cannot be changed is refused before it starts.
import { observable } from '@legendapp/state'
import { t } from '../lib/i18n'
import type { DragEdge } from '../lib/calendarDrag'
import { accounts$ } from './accounts'
import {
  calendar$,
  changeRefusal,
  changeRefusalText,
  completeForWrite,
  rescheduleEvent,
  type CalendarEvent,
  type EditScope,
  type EventDraft,
} from './calendar'
import { noticePlan } from './organizerNotices'
import { showToast } from './ui'

/// A move in hand: the event as it was read, and where it would land.
export type EventMove = {
  event: CalendarEvent
  start: number
  end: number
  /// How it is being adjusted. A keyboard move is saved with Enter; a
  /// pointer move when it is dropped.
  via: 'pointer' | 'keyboard'
  /// Dropped or confirmed: no longer adjusted, waiting on its questions or
  /// its write.
  settled: boolean
}

/// What a pointer drag holds: an event, which part of it, and the local day
/// (local-midnight epoch ms) of the column or all-day cell it was picked up in.
export type CalendarDrag = { edge: DragEdge; event: CalendarEvent; day: number; origin: 'grid' | 'allDay' }

/// What a drag can be dropped on: a column of the hour grid, a cell of the
/// all-day strip, or a day of the mini calendar, and the local day it stands
/// for (local-midnight epoch ms).
export type CalendarDrop = { area: 'grid' | 'allDay' | 'mini'; day: number }

/// A question a settled move waits on: which occurrences, then whether to
/// tell the people on it.
export type MoveQuestion = { kind: 'scope' } | { kind: 'notify'; people: string[]; from?: string }

export const move$ = observable({
  moving: null as EventMove | null,
  question: null as MoveQuestion | null,
})

/// What a settled move writes, once its questions are answered.
let pending: { draft: EventDraft; invitees: string[]; from?: string; scope: EditScope } | null = null

/// Counts moves, so an answer that arrives after its move was given up (the
/// event's details read while Escape was pressed) does nothing.
let generation = 0

/// When the last pointer move ended, so the click a drop leaves behind on the
/// event does not also open it.
let lastDropAt = 0

/// The key an event is known by on the grid.
export function eventKey(event: Pick<CalendarEvent, 'accountId' | 'id'>): string {
  return `${event.accountId}:${event.id}`
}

/// Begins moving an event. Refused, and said why, on a calendar that cannot be
/// changed here; ignored while another move is still being settled.
export function startMove(event: CalendarEvent, via: EventMove['via']): boolean {
  const current = move$.moving.peek()
  if (current?.settled) return false
  const refusal = changeRefusal(event, calendar$.calendars.peek())
  if (refusal) {
    showToast(changeRefusalText(refusal), 'error')
    return false
  }
  generation++
  move$.moving.set({ event, start: event.start, end: event.end, via, settled: false })
  return true
}

/// Where the move in hand would land now.
export function previewMove(times: { start: number; end: number }) {
  const current = move$.moving.peek()
  if (!current || current.settled) return
  if (current.start === times.start && current.end === times.end) return
  move$.moving.set({ ...current, start: times.start, end: times.end })
}

/// Gives the move up: nothing is written.
export function cancelMove() {
  if (move$.moving.peek()?.via === 'pointer') lastDropAt = Date.now()
  generation++
  pending = null
  move$.question.set(null)
  move$.moving.set(null)
}

/// A pointer drag ended, written or not: the click it leaves behind on the
/// event is not a click to open it.
export function markDrop() {
  lastDropAt = Date.now()
}

/// Whether a click on an event is the one a drop just left behind.
export function clickFollowsDrop(): boolean {
  return Date.now() - lastDropAt < 400
}

/// Settles the move in hand: refused again if its calendar became read-only
/// meanwhile; completed with what the window does not carry; then asked about
/// and written. A move that lands where it started writes nothing.
export async function settleMove() {
  const current = move$.moving.peek()
  if (!current || current.settled) return
  if (current.via === 'pointer') lastDropAt = Date.now()
  if (current.start === current.event.start && current.end === current.event.end) return cancelMove()
  const refusal = changeRefusal(current.event, calendar$.calendars.peek())
  if (refusal) {
    showToast(changeRefusalText(refusal), 'error')
    return cancelMove()
  }
  const mine = generation
  move$.moving.set({ ...current, settled: true })
  try {
    await askAbout(current, mine)
  } catch (err) {
    // A fault while preparing the questions: said, and the move given up,
    // rather than left settled with nothing able to move again.
    if (mine !== generation) return
    showToast(t('calendar.moveFailed', { reason: errorText(err), defaultValue: 'The event was not moved: {reason}' }), 'error')
    cancelMove()
  }
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err)
}

/// Completes a settled move and asks what it raises, or writes it.
async function askAbout(current: EventMove, mine: number) {
  const complete = await completeForWrite(current.event)
  if (mine !== generation) return
  if (!complete) {
    showToast(
      t('calendar.moveDetailsUnreadable', {
        defaultValue:
          'The event was not moved: its guests and notes could not be read, and saving it without them would remove them.',
      }),
      'error',
    )
    return cancelMove()
  }
  const kind = calendar$.calendars
    .peek()
    .find((c) => c.id === complete.calendar_id && c.accountId === complete.accountId)?.kind
  const plan = noticePlan({ ...complete, start: current.start, end: current.end }, kind, accounts$.peek())
  pending = { draft: plan.toSave, invitees: plan.invitees, from: plan.sender?.identity.email, scope: 'occurrence' }
  // Only an occurrence of a real series has two answers; the editor asks the
  // same question of the same events.
  if (complete.is_recurring && complete.series_id) return move$.question.set({ kind: 'scope' })
  askToNotify()
}

function askToNotify() {
  if (!pending) return
  if (pending.invitees.length > 0) {
    move$.question.set({ kind: 'notify', people: pending.invitees, from: pending.from })
    return
  }
  void write(false)
}

/// Which occurrences the move reaches.
export function answerScope(scope: EditScope) {
  if (!pending || move$.question.peek()?.kind !== 'scope') return
  pending.scope = scope
  move$.question.set(null)
  askToNotify()
}

/// Whether the people on it are told.
export function answerNotify(notify: boolean) {
  if (!pending || move$.question.peek()?.kind !== 'notify') return
  move$.question.set(null)
  void write(notify)
}

async function write(notify: boolean) {
  const job = pending
  if (!job) return
  pending = null
  const mine = generation
  try {
    await rescheduleEvent(job.draft, job.scope, notify)
  } finally {
    // Done either way: rescheduleEvent says a refusal itself.
    if (mine === generation) move$.moving.set(null)
  }
}
