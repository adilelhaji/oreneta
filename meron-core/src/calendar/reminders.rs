//! When an event's reminder rings, wherever the reader is and however long
//! nobody looked (#209, ADR-0056).
//!
//! - A timed event is an instant, and so is its reminder: a change of time
//!   zone does not move it.
//! - An all-day event is a date (stored as that date's UTC midnight, the
//!   calendar's model): its reminder counts back from the midnight that
//!   starts the date in the zone the machine is in at each look, so it
//!   follows the reader.
//! - A floating time is read in this machine's zone when its calendar is read
//!   (`subscription`). After a change of zone the calendars that can hold one
//!   are read again (`pim::reminders`), and its reminder follows that read
//!   like a moved event's.
//!
//! A look gives each reminder not yet recorded whose time has come, once,
//! while it is still of use:
//!
//! - its event has not started (on time, or synced in after its time); or
//! - it was not yet due at the previous look and its event has not ended: it
//!   came due while nobody looked (the machine asleep, the app closed, the
//!   clock moved on), or a change of zone brought it forward.
//!
//! A reminder whose event ended before anyone looked is not given. One set
//! for the start is given by the first look from the start; an event with
//! no length counts as on for its first minute.

use anyhow::Result;
use chrono::{FixedOffset, Offset as _, TimeZone};
use rusqlite::{params, Connection, OptionalExtension as _};

use super::Event;

/// How far back a previous look is believed: the life of the record of
/// reminders given (`forget_old_reminders`), so nothing older can be given
/// twice.
pub const MAX_GAP: i64 = 14 * 86_400;

/// How far an all-day event's local midnight can be from its stored UTC one,
/// with room to spare: no zone is more than 14 hours from UTC.
const ZONE_SLACK: i64 = 2 * 86_400;

/// How long an event with no length counts as on: a look's tick.
pub const ZERO_LENGTH_ON: i64 = 60;

/// How long a re-read asked for after a change of zone is waited for before
/// it is asked for again.
pub const REREAD_RETRY: i64 = 15 * 60;

/// When a reminder rings, and when its event starts and ends, in one zone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    pub fire_at: i64,
    pub start: i64,
    pub end: i64,
}

/// An event's [`Timing`] in `zone`; `None` when it has no reminder.
pub fn timing<Tz: TimeZone>(event: &Event, zone: &Tz) -> Option<Timing> {
    let minutes = event.reminder_minutes?;
    let (start, end) = if event.all_day {
        let start = local_midnight(zone, event.start)?;
        // An all-day end is exclusive: the midnight after its last day.
        let end = local_midnight(zone, event.end).filter(|end| *end > start).unwrap_or(start + 86_400);
        (start, end)
    } else if event.end > event.start {
        (event.start, event.end)
    } else {
        // An event with no length is on for the minute it starts: long enough
        // for a look to give an "at the start" reminder that came due since
        // the one before.
        (event.start, event.start + ZERO_LENGTH_ON)
    };
    Some(Timing { fire_at: start - minutes * 60, start, end })
}

/// The instant the date stored as `utc_date` (its UTC midnight) starts in
/// `zone`. A day that starts in a clock change's gap starts when the clock
/// does.
fn local_midnight<Tz: TimeZone>(zone: &Tz, utc_date: i64) -> Option<i64> {
    let date = chrono::DateTime::from_timestamp(utc_date, 0)?.date_naive();
    super::recurrence::resolve(zone, date.and_hms_opt(0, 0, 0)?)
}

/// The offset from UTC `zone` has at `at`, in seconds.
pub fn offset_at<Tz: TimeZone>(zone: &Tz, at: i64) -> Option<i32> {
    let utc = chrono::DateTime::from_timestamp(at, 0)?.naive_utc();
    Some(zone.offset_from_utc_datetime(&utc).fix().local_minus_utc())
}

/// The previous look at an account's reminders: when it was, and the offset
/// from UTC the machine's zone had then.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Previous {
    pub at: i64,
    pub offset: i32,
}

impl Previous {
    /// The zone of that look, as far as it matters here: its offset then.
    pub fn zone(&self) -> FixedOffset {
        FixedOffset::east_opt(self.offset).unwrap_or_else(|| FixedOffset::east_opt(0).expect("UTC"))
    }

    /// Whether `zone` is another zone than the one of this look: it puts that
    /// moment at another offset. A daylight-saving change is not one, since
    /// the same zone gives the same moment the same offset.
    pub fn zone_changed<Tz: TimeZone>(&self, zone: &Tz) -> bool {
        offset_at(zone, self.at) != Some(self.offset)
    }
}

fn look_key(account: &str) -> String {
    format!("reminders.look:{account}")
}

/// The previous look at `account`'s reminders, if one was recorded.
pub fn previous_look(conn: &Connection, account: &str) -> Result<Option<Previous>> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", params![look_key(account)], |row| row.get(0))
        .optional()?;
    Ok(value.and_then(|value| {
        let (at, offset) = value.split_once(' ')?;
        Some(Previous { at: at.parse().ok()?, offset: offset.parse().ok()? })
    }))
}

/// Records a look at `account`'s reminders at `now` in `zone`. Written after
/// what it found is recorded as given: a crash in between costs a look at the
/// same gap again, which those records make harmless.
pub fn record_look<Tz: TimeZone>(conn: &Connection, account: &str, now: i64, zone: &Tz) -> Result<()> {
    let offset = offset_at(zone, now).unwrap_or(0);
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![look_key(account), format!("{now} {offset}")],
    )?;
    Ok(())
}

/// Forgets an account's looks, with the account (ADR-0011): the same address
/// added again starts with no gap to look into.
pub fn forget_looks(conn: &Connection, account: &str) -> Result<()> {
    conn.execute("DELETE FROM meta WHERE key IN (?1, ?2)", params![look_key(account), reread_key(account)])?;
    Ok(())
}

// ---- Reading floating times again after a change of zone ---------------------

fn reread_key(account: &str) -> String {
    format!("reminders.reread:{account}")
}

/// The enabled calendars of `account` whose times can be floating: CalDAV and
/// subscribed ones, read from iCalendar. Local, Exchange and Google events are
/// instants or dates. A hidden calendar is not read, so it is not waited for.
pub fn floating_calendars(conn: &Connection, account: &str) -> Result<Vec<super::Calendar>> {
    Ok(super::get_calendars(conn, account)?
        .into_iter()
        .filter(|c| c.enabled && matches!(c.kind, super::CalendarKind::CalDav | super::CalendarKind::Subscribed))
        .collect())
}

/// Notes that `account`'s floating calendars must be read again, since the
/// zone changed at `since`: kept until each has been read after it, so a
/// read that fails or is skipped is asked for again.
pub fn mark_reread(conn: &Connection, account: &str, since: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![reread_key(account), format!("{since} 0")],
    )?;
    Ok(())
}

/// The re-read `account` is waiting for, if it is time to ask for it at
/// `now`: `Some(since)`, the moment the zone changed, and the ask is noted.
/// It is asked for at once, then again every [`REREAD_RETRY`] until every
/// floating calendar was read after `since`, when it is forgotten.
pub fn reread_due(conn: &Connection, account: &str, now: i64) -> Result<Option<i64>> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", params![reread_key(account)], |row| row.get(0))
        .optional()?;
    let Some((since, asked)) = value.as_deref().and_then(|value| {
        let (since, asked) = value.split_once(' ')?;
        Some((since.parse::<i64>().ok()?, asked.parse::<i64>().ok()?))
    }) else {
        return Ok(None);
    };
    if floating_calendars(conn, account)?.iter().all(|c| c.synced_at >= since) {
        conn.execute("DELETE FROM meta WHERE key = ?1", params![reread_key(account)])?;
        return Ok(None);
    }
    if asked != 0 && asked <= now && now - asked < REREAD_RETRY {
        return Ok(None);
    }
    conn.execute(
        "UPDATE meta SET value = ?2 WHERE key = ?1",
        params![reread_key(account), format!("{since} {now}")],
    )?;
    Ok(Some(since))
}

/// A reminder a look gives, with when it rings in the zone of that look.
#[derive(Clone, Debug, PartialEq)]
pub struct Due {
    pub event: Event,
    pub timing: Timing,
}

/// The reminders of `account` to give at `now` in `zone`, not yet recorded
/// as given, in the order their events start. The caller records each
/// (`mark_reminder_fired`), then the look (`record_look`).
pub fn due<Tz: TimeZone>(
    conn: &Connection,
    account: &str,
    now: i64,
    zone: &Tz,
    previous: Option<Previous>,
) -> Result<Vec<Due>> {
    // Whether that look was in another zone, told before its moment is
    // clamped below: the same zone gives a moment it moved to another offset
    // when a daylight-saving change lies between.
    let moved = previous.is_some_and(|p| p.zone_changed(zone));
    // As far as the previous look is believed: a clock set back opens no gap,
    // and a gap is looked into no further than the record of what was given.
    let previous = previous.map(|p| Previous { at: p.at.min(now).max(now - MAX_GAP), ..p });
    let from = previous.map_or(now, |p| p.at);
    let mut due = Vec::new();
    for event in candidates(conn, account, from - ZONE_SLACK, now + ZONE_SLACK)? {
        let Some(now_timing) = timing(&event, zone) else { continue };
        if now_timing.fire_at > now {
            continue;
        }
        let ahead = now_timing.start > now;
        let came_due_since = previous.is_some_and(|previous| {
            // When it rang as the previous look saw it: in this zone, unless
            // the zone changed since; then in that look's offset, which is all
            // that is known of the zone it was in.
            let then = if moved { timing(&event, &previous.zone()) } else { Some(now_timing) };
            now_timing.end > now && then.is_some_and(|then| then.fire_at > previous.at)
        });
        if ahead || came_due_since {
            due.push(Due { event, timing: now_timing });
        }
    }
    due.sort_by(|a, b| a.timing.start.cmp(&b.timing.start).then_with(|| a.event.id.cmp(&b.event.id)));
    Ok(due)
}

/// Events of `account` with a reminder not yet recorded as given that might
/// ring in `[from, to]`: deliberately wider than due, since when an all-day
/// event's reminder rings depends on the zone, which [`due`] decides.
fn candidates(conn: &Connection, account: &str, from: i64, to: i64) -> Result<Vec<Event>> {
    let mut stmt = conn.prepare(
        "SELECT e.calendar_id, e.event_id, e.subject, e.start_utc, e.end_utc,
                e.all_day, e.location, e.reminder_minutes
         FROM calendar_events e
         JOIN calendars c
           ON c.account = e.account AND c.provider_id = e.calendar_id
         WHERE e.account = ?1 AND c.enabled = 1
           AND e.reminder_minutes IS NOT NULL
           AND e.is_cancelled = 0
           AND MAX(e.end_utc, e.start_utc) >= ?2
           AND e.start_utc - (e.reminder_minutes * 60) <= ?3
           AND NOT EXISTS (
                 SELECT 1 FROM calendar_reminders_fired f
                 WHERE f.account = e.account
                   AND f.event_id IN (e.event_id || '@' || e.start_utc, e.event_id))
         ORDER BY e.start_utc, e.event_id",
    )?;
    let events = stmt
        .query_map(params![account, from, to], |row| {
            Ok(Event {
                calendar_id: row.get(0)?,
                id: row.get(1)?,
                subject: row.get(2)?,
                start: row.get(3)?,
                end: row.get(4)?,
                all_day: row.get::<_, i64>(5)? != 0,
                location: row.get(6)?,
                reminder_minutes: row.get(7)?,
                ..Default::default()
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::{mark_reminder_fired, replace_window, upsert_calendars, Calendar};
    use chrono_tz::{America::Los_Angeles, America::Santiago, Asia::Tokyo, Europe::Madrid};

    fn at(text: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(text).unwrap().timestamp()
    }

    fn store() -> Connection {
        let conn = crate::store::open_in_memory_for_test().expect("open store");
        upsert_calendars(
            &conn,
            "acct",
            &[Calendar { id: "cal".into(), name: "Home".into(), enabled: true, ..Default::default() }],
        )
        .unwrap();
        conn
    }

    fn timed(id: &str, start: i64, minutes: i64) -> Event {
        Event {
            id: id.into(),
            calendar_id: "cal".into(),
            subject: id.into(),
            start,
            end: start + 3_600,
            reminder_minutes: Some(minutes),
            ..Default::default()
        }
    }

    /// An all-day event on `date` (YYYY-MM-DD), stored as the calendar
    /// stores one: from that date's UTC midnight to the next.
    fn all_day(id: &str, date: &str, minutes: i64) -> Event {
        let start = at(&format!("{date}T00:00:00Z"));
        Event { all_day: true, end: start + 86_400, ..timed(id, start, minutes) }
    }

    fn put(conn: &Connection, events: &[Event]) {
        replace_window(conn, "acct", "cal", (at("2026-01-01T00:00:00Z"), at("2027-01-01T00:00:00Z")), events).unwrap();
    }

    fn ids(due: &[Due]) -> Vec<&str> {
        due.iter().map(|d| d.event.id.as_str()).collect()
    }

    fn give(conn: &Connection, due: &[Due], now: i64) {
        for d in due {
            mark_reminder_fired(conn, "acct", &d.event.id, d.event.start, now).unwrap();
        }
    }

    #[test]
    fn an_all_day_reminder_counts_back_from_the_midnight_where_the_reader_is() {
        // The day before at 18:00: 6 hours before the day starts.
        let event = all_day("trip", "2026-10-20", 6 * 60);
        let start = |zone: &chrono_tz::Tz| timing(&event, zone).unwrap();
        assert_eq!(
            start(&Madrid),
            Timing {
                fire_at: at("2026-10-19T18:00:00+02:00"),
                start: at("2026-10-20T00:00:00+02:00"),
                end: at("2026-10-21T00:00:00+02:00"),
            }
        );
        assert_eq!(start(&Los_Angeles).fire_at, at("2026-10-19T18:00:00-07:00"));
        assert_eq!(start(&Tokyo).fire_at, at("2026-10-19T18:00:00+09:00"));
        // Read as an instant, as before, it rang at 20:00 the day before in
        // Madrid and at 11:00 in Los Angeles.
        assert_ne!(start(&Madrid).fire_at, event.start - 6 * 3_600);
    }

    #[test]
    fn an_all_day_event_on_a_day_without_a_midnight_starts_when_the_clock_does() {
        // Chile goes forward at midnight: 2026-09-06 begins at 01:00.
        let event = all_day("spring", "2026-09-06", 0);
        assert_eq!(timing(&event, &Santiago).unwrap().start, at("2026-09-06T01:00:00-03:00"));
        // And one with no end of its own lasts its day.
        let open = Event { end: event.start, ..event };
        let t = timing(&open, &Madrid).unwrap();
        assert_eq!(t.end - t.start, 86_400);
    }

    #[test]
    fn a_timed_reminder_is_the_same_instant_in_every_zone() {
        let event = timed("call", at("2026-10-20T09:00:00Z"), 15);
        let madrid = timing(&event, &Madrid).unwrap();
        assert_eq!(madrid.fire_at, at("2026-10-20T08:45:00Z"));
        assert_eq!(timing(&event, &Tokyo), Some(madrid));
        assert_eq!(timing(&event, &Los_Angeles), Some(madrid));
        assert_eq!(timing(&Event { reminder_minutes: None, ..event }, &Madrid), None, "no reminder, no timing");
    }

    #[test]
    fn a_zone_change_is_told_by_the_offset_of_the_previous_look_not_by_daylight_saving() {
        let summer = at("2026-07-01T12:00:00Z");
        let previous = Previous { at: summer, offset: offset_at(&Madrid, summer).unwrap() };
        assert_eq!(previous.offset, 2 * 3_600);
        assert!(!previous.zone_changed(&Madrid), "Madrid in winter is still Madrid");
        assert!(previous.zone_changed(&Los_Angeles));
        assert!(previous.zone_changed(&Tokyo));
        assert_eq!(previous.zone().local_minus_utc(), 2 * 3_600);
    }

    #[test]
    fn looks_are_recorded_per_account_and_forgotten_with_it() {
        let conn = store();
        assert_eq!(previous_look(&conn, "acct").unwrap(), None, "no look yet");
        let now = at("2026-10-20T08:00:00Z");
        record_look(&conn, "acct", now, &Tokyo).unwrap();
        assert_eq!(previous_look(&conn, "acct").unwrap(), Some(Previous { at: now, offset: 9 * 3_600 }));
        assert_eq!(previous_look(&conn, "other").unwrap(), None);
        record_look(&conn, "acct", now + 60, &Madrid).unwrap();
        assert_eq!(previous_look(&conn, "acct").unwrap(), Some(Previous { at: now + 60, offset: 2 * 3_600 }));
        forget_looks(&conn, "acct").unwrap();
        assert_eq!(previous_look(&conn, "acct").unwrap(), None);
    }

    #[test]
    fn a_previous_look_that_cannot_be_read_is_no_look() {
        let conn = store();
        for value in ["", "garbage", "1800000000", "1800000000 x", "x 7200"] {
            conn.execute(
                "INSERT INTO meta(key, value) VALUES('reminders.look:acct', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![value],
            )
            .unwrap();
            assert_eq!(previous_look(&conn, "acct").unwrap(), None, "{value:?}");
        }
    }

    #[test]
    fn an_event_with_no_length_is_on_for_the_minute_it_starts() {
        let start = at("2026-10-20T09:00:00Z");
        let event = Event { end: start, ..timed("deadline", start, 0) };
        assert_eq!(timing(&event, &Madrid), Some(Timing { fire_at: start, start, end: start + ZERO_LENGTH_ON }));
    }

    /// Madrid's clocks go back on 25 October. Looked at on the 24th at 23:30
    /// (+02:00), then not until the 26th: a reminder 25 hours before the
    /// 26th (whose midnight is +01:00) rang at 00:00 on the 25th, after that
    /// look. Read in the look's fixed +02:00 it would seem to have rung at
    /// 23:00 on the 24th, before the look, and been lost.
    #[test]
    fn a_daylight_saving_change_between_two_looks_does_not_lose_a_reminder() {
        let conn = store();
        put(&conn, &[all_day("holiday", "2026-10-26", 25 * 60)]);
        let before = at("2026-10-24T21:30:00Z");
        let previous = Previous { at: before, offset: offset_at(&Madrid, before).unwrap() };
        assert!(!previous.zone_changed(&Madrid));
        let due = due(&conn, "acct", at("2026-10-26T10:00:00Z"), &Madrid, Some(previous)).unwrap();
        assert_eq!(ids(&due), ["holiday"]);
        assert_eq!(due[0].timing.fire_at, at("2026-10-24T22:00:00Z"));
    }

    #[test]
    fn a_reread_is_noted_asked_for_again_and_forgotten_once_its_calendars_are_read() {
        let conn = store();
        upsert_calendars(
            &conn,
            "acct",
            &[Calendar {
                id: "dav".into(),
                name: "Work".into(),
                kind: crate::calendar::CalendarKind::CalDav,
                enabled: true,
                ..Default::default()
            }],
        )
        .unwrap();
        let since = at("2026-10-20T10:00:00Z");
        assert_eq!(reread_due(&conn, "acct", since).unwrap(), None, "nothing noted");
        mark_reread(&conn, "acct", since).unwrap();
        assert_eq!(reread_due(&conn, "acct", since).unwrap(), Some(since));
        assert_eq!(reread_due(&conn, "acct", since + REREAD_RETRY - 1).unwrap(), None);
        assert_eq!(reread_due(&conn, "acct", since + REREAD_RETRY).unwrap(), Some(since));
        // A clock set back does not hold it off.
        assert_eq!(reread_due(&conn, "acct", since).unwrap(), Some(since));
        crate::calendar::mark_calendar_synced(&conn, "acct", "dav", since + 1).unwrap();
        assert_eq!(reread_due(&conn, "acct", since + 9 * REREAD_RETRY).unwrap(), None, "read since");
        mark_reread(&conn, "acct", since + 60).unwrap();
        forget_looks(&conn, "acct").unwrap();
        assert_eq!(reread_due(&conn, "acct", since + 120).unwrap(), None, "forgotten with the account");
    }

    #[test]
    fn on_time_a_reminder_is_due_until_its_event_starts() {
        let conn = store();
        let now = at("2026-10-20T08:50:00Z");
        put(
            &conn,
            &[
                timed("soon", now + 600, 15),
                timed("later", now + 7_200, 15),
                // Started before anyone ever looked: its moment is gone.
                timed("started", now - 60, 15),
            ],
        );
        let due = due(&conn, "acct", now, &Madrid, None).unwrap();
        assert_eq!(ids(&due), ["soon"]);
        assert_eq!(due[0].timing.fire_at, now + 600 - 900);
        give(&conn, &due, now);
        assert!(super::due(&conn, "acct", now + 60, &Madrid, None).unwrap().is_empty(), "given once");
    }

    #[test]
    fn a_reminder_that_came_due_in_a_gap_is_given_while_its_event_is_still_on() {
        let conn = store();
        let before = at("2026-10-20T08:00:00Z");
        put(
            &conn,
            &[
                // Rang at 08:45 while nobody looked; on until 10:00.
                timed("standup", at("2026-10-20T09:00:00Z"), 15),
                // Rang at 06:45, before the previous look: not this gap's.
                timed("early", at("2026-10-20T07:00:00Z"), 15).with_end(at("2026-10-20T12:00:00Z")),
                // Rang and ended inside the gap: no use any more.
                timed("over", at("2026-10-20T08:20:00Z"), 15).with_end(at("2026-10-20T08:40:00Z")),
            ],
        );
        let previous = Some(Previous { at: before, offset: 2 * 3_600 });
        let after = at("2026-10-20T09:20:00Z");
        let due = due(&conn, "acct", after, &Madrid, previous).unwrap();
        assert_eq!(ids(&due), ["standup"]);
        give(&conn, &due, after);
        let previous = Some(Previous { at: after, offset: 2 * 3_600 });
        assert!(super::due(&conn, "acct", after + 60, &Madrid, previous).unwrap().is_empty(), "once");
    }

    #[test]
    fn the_end_of_an_event_is_the_last_moment_its_missed_reminder_is_given() {
        let conn = store();
        let event = timed("standup", at("2026-10-20T09:00:00Z"), 15);
        put(&conn, &[event.clone()]);
        let previous = Some(Previous { at: at("2026-10-20T08:00:00Z"), offset: 0 });
        assert_eq!(ids(&due(&conn, "acct", event.end - 1, &Madrid, previous).unwrap()), ["standup"]);
        assert!(due(&conn, "acct", event.end, &Madrid, previous).unwrap().is_empty(), "ended");
    }

    #[test]
    fn a_clock_set_back_opens_no_gap() {
        let conn = store();
        put(&conn, &[timed("standup", at("2026-10-20T09:00:00Z"), 15)]);
        // The previous look is in the future of `now`: the clock went back.
        let previous = Some(Previous { at: at("2026-10-20T12:00:00Z"), offset: 0 });
        assert!(due(&conn, "acct", at("2026-10-20T09:30:00Z"), &Madrid, previous).unwrap().is_empty());
    }

    #[test]
    fn a_gap_is_looked_into_no_further_than_the_record_of_what_was_given() {
        let conn = store();
        let now = at("2026-10-20T09:30:00Z");
        put(
            &conn,
            &[
                // A month-long event whose reminder rang three weeks ago.
                timed("course", now - 21 * 86_400, 15).with_end(now + 86_400),
                // One whose reminder rang a week ago.
                timed("week", now - 7 * 86_400, 15).with_end(now + 86_400),
            ],
        );
        let previous = Some(Previous { at: now - 30 * 86_400, offset: 0 });
        assert_eq!(ids(&due(&conn, "acct", now, &Madrid, previous).unwrap()), ["week"]);
    }

    #[test]
    fn a_zone_change_east_gives_an_all_day_reminder_it_brought_forward_once() {
        let conn = store();
        // The day before at 23:45 wherever the reader is.
        put(&conn, &[all_day("holiday", "2026-10-20", 15)]);
        // Looked at in Los Angeles at 20:00 on the 19th: due at 23:45 there.
        let la = at("2026-10-19T20:00:00-07:00");
        let previous = Previous { at: la, offset: offset_at(&Los_Angeles, la).unwrap() };
        assert!(due(&conn, "acct", la, &Los_Angeles, Some(previous)).unwrap().is_empty());
        // A minute later the machine is in Tokyo, where the 20th began hours
        // ago: the reminder is past, the day is on, and it is given now.
        let tokyo = la + 60;
        assert!(previous.zone_changed(&Tokyo));
        let due = due(&conn, "acct", tokyo, &Tokyo, Some(previous)).unwrap();
        assert_eq!(ids(&due), ["holiday"]);
        assert_eq!(due[0].timing.start, at("2026-10-20T00:00:00+09:00"));
        give(&conn, &due, tokyo);
        // Back to Los Angeles: the same day, so the same record; not again.
        let back = Previous { at: tokyo, offset: 9 * 3_600 };
        let later = at("2026-10-19T23:50:00-07:00");
        assert!(super::due(&conn, "acct", later, &Los_Angeles, Some(back)).unwrap().is_empty());
    }

    #[test]
    fn a_zone_change_west_puts_an_all_day_reminder_off_until_its_time_there() {
        let conn = store();
        put(&conn, &[all_day("holiday", "2026-10-20", 15)]);
        // In Madrid it rings at 23:45 on the 19th, 21:45Z. At 21:50Z the
        // machine is in Los Angeles, where that is 14:50.
        let now = at("2026-10-19T21:50:00Z");
        let previous = Some(Previous { at: now - 60, offset: 2 * 3_600 });
        assert!(due(&conn, "acct", now, &Los_Angeles, previous).unwrap().is_empty(), "not yet where the reader is");
        let there = at("2026-10-19T23:45:00-07:00");
        let previous = Some(Previous { at: there - 60, offset: -7 * 3_600 });
        assert_eq!(ids(&due(&conn, "acct", there, &Los_Angeles, previous).unwrap()), ["holiday"]);
    }

    #[test]
    fn hidden_calendars_cancelled_events_and_given_reminders_are_not_candidates() {
        let conn = store();
        let now = at("2026-10-20T08:50:00Z");
        put(
            &conn,
            &[
                timed("given", now + 600, 15),
                Event { is_cancelled: true, ..timed("cancelled", now + 600, 15) },
                Event { reminder_minutes: None, ..timed("silent", now + 600, 15) },
            ],
        );
        mark_reminder_fired(&conn, "acct", "given", now + 600, now - 60).unwrap();
        assert!(due(&conn, "acct", now, &Madrid, None).unwrap().is_empty());
        put(&conn, &[timed("soon", now + 600, 15)]);
        assert_eq!(ids(&due(&conn, "acct", now, &Madrid, None).unwrap()), ["soon"]);
        crate::calendar::set_calendar_enabled(&conn, "acct", "cal", false).unwrap();
        assert!(due(&conn, "acct", now, &Madrid, None).unwrap().is_empty(), "hidden");
    }

    trait WithEnd {
        fn with_end(self, end: i64) -> Self;
    }
    impl WithEnd for Event {
        fn with_end(self, end: i64) -> Self {
            Event { end, ..self }
        }
    }
}
