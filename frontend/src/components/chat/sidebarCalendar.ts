import { useEffect, useRef, useState } from 'react'
import { invoke } from '../../lib/bridge'
import { accounts$ } from '../../states/accounts'
import { allDayLocalDays, isFeedAccount, openCalendarOn, openEvent, type CalendarEvent } from '../../states/calendar'
import { closeSidebarOverlay } from '../../states/sidebar'

// How the panels of the app's sidebar read the calendars: the agenda (#212,
// ADR-0059) and the day (ADR-0069 §3) read them the same way, and open an
// event the same way.

/**
 * Every account's enabled calendars over [from, to), epoch seconds (the core
 * leaves out disabled ones; a feed keeps none). A calendar that cannot be
 * read makes the answer incomplete, never a shorter one shown as whole.
 */
export async function readCalendarEvents(
  from: number,
  to: number,
  refresh: boolean,
): Promise<{ events: CalendarEvent[]; incomplete: boolean }> {
  let incomplete = false
  const accounts = accounts$.peek().filter((account) => !isFeedAccount(account.id))
  const perAccount = await Promise.all(
    accounts.map(async (account) => {
      try {
        const res = await invoke<{ events?: CalendarEvent[] }>('calendar.events', {
          account_id: account.id,
          from,
          to,
          refresh,
        })
        return (res?.events ?? []).map((event) => ({ ...event, accountId: account.id }))
      } catch {
        incomplete = true
        return [] as CalendarEvent[]
      }
    }),
  )
  return { events: perAccount.flat(), incomplete }
}

/** Milliseconds from `now` to just after the next local midnight. */
export function untilNextDay(now: number): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() - now + 50
}

/**
 * Opens an event where it lives: its day in the calendar, with the event
 * open. An all-day event's day is its date, not the instant it is stored at;
 * `day` (a local midnight) is the day it was chosen on, when that is the one
 * to open. The calendar is what is wanted then: an overlay of the app's
 * sidebar goes, also when the calendar was already on screen under it
 * (ADR-0069).
 */
export function openSidebarEvent(event: CalendarEvent, day?: number) {
  closeSidebarOverlay()
  openCalendarOn(new Date(day ?? (event.all_day ? allDayLocalDays(event)[0] : event.start * 1000)))
  openEvent(event)
}

type SyncDetail = { account?: string; from?: number; to?: number }

export type SidebarReading<T> = {
  /** The newest answer, or null before the first one. */
  answer: T | null
  /** The newest read failed. */
  failed: boolean
  /**
   * Accounts whose refresh from the server failed: what the cache holds for
   * them may be out of date, and is said to be until a later sync lands.
   */
  stale: ReadonlySet<string>
}

/**
 * Keeps a sidebar panel's reading of the calendars current:
 *
 * - `read(true)` at once, and again whenever `key` changes: the cache answers
 *   and the server is asked behind it;
 * - `read(false)`, the cache again, when a calendar refresh lands
 *   (`calendar.synced`), just after local midnight, and whenever `subscribe`
 *   calls back;
 * - only the newest read lands: an older, slower answer never replaces it;
 * - an account whose refresh failed (`calendar.syncError`) is stale until a
 *   `calendar.synced` of that account covers `covering()`, the window read; a
 *   sync that says neither window nor account counts as covering, and one
 *   that names no account clears them all.
 */
export function useSidebarCalendarReading<T>(
  read: (refresh: boolean) => Promise<T>,
  options: {
    now: () => number
    covering: () => { from: number; to: number }
    key?: unknown
    subscribe?: (reread: () => void) => () => void
  },
): SidebarReading<T> {
  const [answer, setAnswer] = useState<T | null>(null)
  const [failed, setFailed] = useState(false)
  const [stale, setStale] = useState<ReadonlySet<string>>(new Set())
  // The listeners are set up once per key; they call what this render passed.
  const latest = useRef({ read, ...options })
  latest.current = { read, ...options }

  useEffect(() => {
    let current = true
    let ticket = 0
    // A read that failed for the key before says nothing about this one.
    setFailed(false)
    const reread = (refresh: boolean) => {
      // Only the newest read lands: an older, slower answer never replaces it.
      const mine = ++ticket
      return latest.current.read(refresh).then(
        (value) => {
          if (!current || mine !== ticket) return
          setFailed(false)
          setAnswer(value)
        },
        () => current && mine === ticket && setFailed(true),
      )
    }
    void reread(true)
    // A calendar refresh behind the first read lands later; read the cache
    // again then, as the calendar view does.
    const eventsOn = (window as any).runtime?.EventsOn
    const off = eventsOn?.('calendar.synced', (detail?: SyncDetail) => {
      // Only a sync that covers what was read makes it current again.
      const { from, to } = latest.current.covering()
      const covers = detail?.from === undefined || detail?.to === undefined || (detail.from <= from && detail.to >= to)
      if (covers) {
        setStale((accounts) => {
          if (!detail?.account) return new Set()
          if (!accounts.has(detail.account)) return accounts
          const next = new Set(accounts)
          next.delete(detail.account)
          return next
        })
      }
      void reread(false)
    })
    // The cache answers at once and the server behind it; when the server
    // refuses or cannot be reached, only this event says so.
    const offError = eventsOn?.('calendar.syncError', (detail?: { account?: string }) => {
      setStale((accounts) => new Set(accounts).add(detail?.account ?? ''))
    })
    const offMore = latest.current.subscribe?.(() => void reread(false))
    // What today is moves at midnight.
    let timer: ReturnType<typeof setTimeout>
    const atMidnight = () => {
      timer = setTimeout(() => {
        void reread(false)
        atMidnight()
      }, untilNextDay(latest.current.now()))
    }
    atMidnight()
    return () => {
      current = false
      if (typeof off === 'function') off()
      if (typeof offError === 'function') offError()
      offMore?.()
      clearTimeout(timer)
    }
    // Only the key: `now` is a clock and `read` a reading of it, not inputs;
    // reading again on every render would loop.
  }, [options.key])

  return { answer, failed, stale }
}
