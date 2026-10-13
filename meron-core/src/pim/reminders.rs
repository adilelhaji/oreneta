//! Calendar reminders as they come due, for both hosts.
//!
//! What is due is a question the store answers (`calendar::reminder_candidates`
//! and the record of what was given), so nothing has to be kept in sync with
//! the events: an event created, moved or deleted is accounted for at the next
//! look. Each reminder is recorded as raised before it is handed back, so it
//! is given once however often its window is resynced and whichever host asks
//! — the desktop's minute watch (`calendar.reminder` on stdout), or the
//! phone's foreground tick and background refresh (local notifications).
//!
//! Across a suspend, a restart and a change of time zone (ADR-0057):
//!
//! - Time is the wall clock (`SystemTime`), never the watch's own ticks: a
//!   tokio interval runs on the monotonic clock, which stands still while the
//!   machine sleeps on some systems. Each look also records *when* it looked,
//!   per account, in the store; the next look sees the gap however long it
//!   was, whether the machine slept or the app was closed.
//! - What came due in the gap is given once, as "missed": one by itself, or
//!   all together in one notice when there are several. Those for events that
//!   ended long ago ([`STALE_AFTER`]) are only counted in that notice.
//! - A timed event is an instant, and so is its reminder, wherever the reader
//!   is. An all-day event is a date and a floating one a wall clock: theirs
//!   are worked out in the zone the machine is in at each look, so they
//!   follow the reader. The record of a given reminder names the event by its
//!   date or wall clock, never by an instant a zone produced, so a change of
//!   zone cannot give one twice.

use std::sync::Arc;
use std::time::Duration;

use chrono::{NaiveDateTime, Offset as _, TimeZone as _};
use rusqlite::{params, Connection, OptionalExtension as _};
use serde_json::{json, Value};

use crate::calendar;
use crate::engine::Engine;

/// How often reminders are looked for. A minute is finer than any reminder
/// is set to, and coarse enough to cost nothing.
pub const TICK: Duration = Duration::from_secs(60);

/// How late a reminder may be given and still count as on time: a tick, and
/// a machine slow to come back from sleep.
pub const LATE_GRACE: i64 = 5 * 60;

/// An event that ended longer ago than this is past being useful to pop up:
/// a reminder for it that came due while nobody was looking is only counted.
pub const STALE_AFTER: i64 = 6 * 3600;

/// How far back a gap is looked into: the life of the record of what was
/// given (`calendar::forget_old_reminders`), so nothing older can be given
/// twice.
pub const MAX_LOOKBACK: i64 = 14 * 86_400;

/// From how many missed reminders on they are given together, in one notice.
pub const GROUP_FROM: usize = 2;

// ---- Zones -----------------------------------------------------------------

/// The time zone reminders of all-day and floating events are worked out in.
///
/// The hosts pass [`Zone::system`], read afresh at every look so a change of
/// zone is noticed within a tick; tests pass a named zone, so they say the
/// same under any `TZ`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Zone {
    /// The machine's clock, when its zone has no IANA name to go by.
    Local,
    Named(chrono_tz::Tz),
}

impl Zone {
    /// The machine's zone as it is now.
    pub fn system() -> Zone {
        iana_time_zone::get_timezone()
            .ok()
            .and_then(|name| name.parse::<chrono_tz::Tz>().ok())
            .map(Zone::Named)
            .unwrap_or(Zone::Local)
    }

    /// The zone a stored name stands for, if it still stands for one.
    pub fn from_name(name: &str) -> Option<Zone> {
        name.parse::<chrono_tz::Tz>().ok().map(Zone::Named)
    }

    /// What a change of zone is noticed by. An unnamed zone goes by its
    /// offset, so a daylight-saving change there looks like a move: harmless,
    /// since a move never gives a reminder twice.
    pub fn name(&self) -> String {
        match self {
            Zone::Named(tz) => tz.name().to_string(),
            Zone::Local => format!("local{}", chrono::Local::now().offset()),
        }
    }

    /// The instant a wall-clock time names in this zone.
    ///
    /// The hour skipped when clocks go forward is read with the offset in
    /// force before it, as RFC 5545 §3.3.5 says (02:30 on that night is 03:30
    /// of the new time); the hour that happens twice when they go back is its
    /// first time round, as everywhere else in the calendar.
    pub fn instant(&self, wall: NaiveDateTime) -> Option<i64> {
        fn resolve<Tz: chrono::TimeZone>(zone: &Tz, wall: NaiveDateTime) -> Option<i64> {
            if let Some(at) = zone.from_local_datetime(&wall).earliest() {
                return Some(at.timestamp());
            }
            let before = zone.from_local_datetime(&(wall - chrono::Duration::hours(3))).earliest()?;
            let offset = before.offset().fix().local_minus_utc() as i64;
            Some(wall.and_utc().timestamp() - offset)
        }
        match self {
            Zone::Named(tz) => resolve(tz, wall),
            Zone::Local => resolve(&chrono::Local, wall),
        }
    }

    /// The wall clock at an instant, as "HH:MM": what a notification shows,
    /// in the zone the reader is in now rather than the one the app started in.
    pub fn clock(&self, instant: i64) -> String {
        match self {
            Zone::Named(tz) => tz.timestamp_opt(instant, 0).single().map(|at| at.format("%H:%M").to_string()),
            Zone::Local => chrono::Local.timestamp_opt(instant, 0).earliest().map(|at| at.format("%H:%M").to_string()),
        }
        .unwrap_or_default()
    }
}

/// A wall clock stored as seconds (an all-day date at 00:00, or a floating
/// time) as the date-time it names.
fn wall(seconds: i64) -> Option<NaiveDateTime> {
    chrono::DateTime::from_timestamp(seconds, 0).map(|at| at.naive_utc())
}

/// When an event's reminder rings, and when the event starts and ends, in
/// `zone`. A timed event is its instants; an all-day event its dates' local
/// midnights; a floating one its wall clock read here.
pub fn timing(event: &calendar::Event, zone: &Zone) -> Option<(i64, i64, i64)> {
    let minutes = event.reminder_minutes?;
    let (start, end) = if event.all_day {
        let start = zone.instant(wall(event.start)?)?;
        let end = if event.end > event.start { zone.instant(wall(event.end)?)? } else { start + 86_400 };
        (start, end)
    } else if let Some(floating) = event.floating {
        let start = zone.instant(wall(floating)?)?;
        (start, start + (event.end - event.start).max(0))
    } else {
        (event.start, event.end)
    };
    Some((start - minutes * 60, start, end.max(start)))
}

/// The records that say an event's reminder was given: the one written now
/// first, then the older forms that still count.
///
/// An instant names a timed event at that start, so a moved meeting is
/// reminded again. An all-day event's stored start is its date, the same in
/// every zone. A floating event's stored start is where its wall clock fell
/// in the zone it was last read in, which changes when the reader travels,
/// and so does its id (`uid@start`): its record names the series and the
/// wall clock instead.
pub fn keys(event: &calendar::Event) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(floating) = event.floating {
        let series = event.id.rsplit_once('@').map(|(uid, _)| uid).unwrap_or(&event.id);
        keys.push(format!("{series}@floating:{floating}"));
    }
    keys.push(format!("{}@{}", event.id, event.start));
    keys.push(event.id.clone());
    keys
}

// ---- When the last look was -------------------------------------------------

fn meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |row| row.get(0))
        .optional()
        .ok()
        .flatten()
}

fn set_meta(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    );
}

fn checked_key(scope: &str) -> String {
    format!("reminders.checked:{scope}")
}

/// When reminders were last looked for on `scope` (an account, or `tasks`).
pub fn last_checked(conn: &Connection, scope: &str) -> Option<i64> {
    meta(conn, &checked_key(scope))?.parse().ok()
}

/// Records that reminders were looked for on `scope` at `now`. Written after
/// what was found is recorded as given: a crash in between costs a look at
/// the same gap again, which the records make harmless.
pub fn set_checked(conn: &Connection, scope: &str, now: i64) {
    set_meta(conn, &checked_key(scope), &now.to_string());
}

/// The last look, made sense of at `now`: a clock set back is no gap, and a
/// gap is looked into no further than [`MAX_LOOKBACK`].
fn floor(last: Option<i64>, now: i64) -> Option<i64> {
    last.map(|at| at.min(now).max(now - MAX_LOOKBACK))
}

/// What kind of lateness a reminder that came due at `fire_at` has.
fn lateness(fire_at: i64, end: i64, last: Option<i64>, now: i64) -> Kind {
    if end <= now - STALE_AFTER {
        Kind::Stale
    } else if last.is_some_and(|last| fire_at > last - LATE_GRACE) && fire_at < now - LATE_GRACE {
        Kind::Missed
    } else {
        Kind::Due
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// On time, or late for a reason other than nobody looking (an event
    /// synced in after its reminder time).
    Due,
    /// Came due while nobody was looking: asleep, or the app closed.
    Missed,
    /// Came due while nobody was looking, for an event long over.
    Stale,
}

// ---- What a look finds -------------------------------------------------------

/// The reminders one look found, each already recorded as given.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Taken {
    /// Calendar reminders to give one by one (`calendar.reminder`).
    pub due: Vec<Value>,
    /// Task reminders to give one by one (`tasks.reminder`).
    pub tasks: Vec<Value>,
    /// Calendar and task reminders that came due while nobody was looking.
    pub missed: Vec<Value>,
    /// Those for events long over: counted, not shown one by one.
    pub stale: Vec<Value>,
    /// The machine's zone changed since the last look: `(from, to)`.
    pub zone_changed: Option<(String, String)>,
}

impl Taken {
    pub fn is_empty(&self) -> bool {
        self.due.is_empty() && self.tasks.is_empty() && self.missed.is_empty() && self.stale.is_empty()
    }

    pub fn extend(&mut self, other: Taken) {
        self.due.extend(other.due);
        self.tasks.extend(other.tasks);
        self.missed.extend(other.missed);
        self.stale.extend(other.stale);
        self.zone_changed = self.zone_changed.take().or(other.zone_changed);
    }

    /// Whether what was missed is given in one notice rather than one by one.
    pub fn grouped(&self) -> bool {
        !self.stale.is_empty() || self.missed.len() >= GROUP_FROM
    }

    /// The one notice for what was missed, when it is given together:
    /// `calendar.remindersAway`.
    pub fn away(&self) -> Option<Value> {
        self.grouped().then(|| {
            json!({
                "count": self.missed.len() + self.stale.len(),
                "missed": self.missed,
                "stale": self.stale,
            })
        })
    }

    /// What the desktop emits, in order: the zone change, those due, those
    /// missed one by one or together.
    pub fn notices(&self) -> Vec<(&'static str, Value)> {
        let mut out = Vec::new();
        if let Some((from, to)) = &self.zone_changed {
            out.push(("calendar.zoneChanged", json!({ "from": from, "to": to })));
        }
        out.extend(self.due.iter().map(|detail| ("calendar.reminder", detail.clone())));
        out.extend(self.tasks.iter().map(|detail| ("tasks.reminder", detail.clone())));
        match self.away() {
            Some(away) => out.push(("calendar.remindersAway", away)),
            None => out.extend(self.missed.iter().map(|detail| {
                let name = if detail["kind"] == "task" { "tasks.reminder" } else { "calendar.reminder" };
                (name, detail.clone())
            })),
        }
        out
    }

    /// The calendar reminders a phone posts one by one (`pim.refresh`'s
    /// `reminders`): those due, and those missed, each marked `missed`, and
    /// `grouped` when [`Taken::away`] also gives them together — a client that
    /// shows `away` leaves those out; one that does not still gives each once.
    pub fn individual(&self) -> Vec<Value> {
        let grouped = self.grouped();
        let mut out = self.due.clone();
        out.extend(self.missed.iter().filter(|detail| detail["kind"] != "task").map(|detail| {
            let mut detail = detail.clone();
            detail["grouped"] = json!(grouped);
            detail
        }));
        out
    }
}

/// The `calendar.reminder` detail for one event, as the desktop has always
/// sent it and as the phone posts it.
pub fn reminder_detail(account: &str, event: &calendar::Event) -> Value {
    json!({
        "account": account,
        "event": event.id,
        "subject": event.subject,
        "location": event.location,
        "start": event.start,
        "all_day": event.all_day,
        "minutes": event.reminder_minutes,
    })
}

/// [`reminder_detail`] with when it starts where the reader is now: `at`, the
/// instant (an all-day or floating event's in this zone), and `local_time`,
/// its clock here for a notification to show.
fn detail_in(account: &str, event: &calendar::Event, start: i64, zone: &Zone, kind: Kind) -> Value {
    let mut detail = reminder_detail(account, event);
    detail["at"] = json!(start);
    detail["local_time"] = json!(zone.clock(start));
    if kind != Kind::Due {
        detail["kind"] = json!("event");
        detail["missed"] = json!(true);
    }
    detail
}

/// The reminders due at `now` on `accounts`, in `zone`, each already recorded
/// as given, and the last look moved to `now`.
///
/// Paused and muted accounts are skipped (and their last look moved on: what
/// came due while the reader asked not to hear is not saved up for later). A
/// paused account is one the reader asked to stop hearing from, and a muted
/// one is one whose notifications they silenced. Recorded before it is
/// returned: a reminder given twice is worse than one lost to a crash in
/// between.
pub fn take(engine: &Arc<Engine>, accounts: &[String], now: i64, zone: &Zone) -> Taken {
    let mut taken = Taken { zone_changed: notice_zone(engine, zone), ..Taken::default() };
    let moved_from = taken.zone_changed.as_ref().and_then(|(from, _)| Zone::from_name(from));
    for account in accounts {
        if engine.is_paused(account) || engine.is_muted(account) {
            set_checked(&engine.db.lock().unwrap(), account, now);
            continue;
        }
        let db = engine.db.lock().unwrap();
        let last = floor(last_checked(&db, account), now);
        let from = last.unwrap_or(now).min(now - LATE_GRACE);
        for event in calendar::reminder_candidates(&db, account, from, now).unwrap_or_default() {
            let Some((fire_at, start, end)) = timing(&event, zone) else { continue };
            if fire_at > now {
                continue;
            }
            let came_due_unseen = last.is_some_and(|last| fire_at > last - LATE_GRACE);
            // A zone change can put an all-day or floating reminder that had
            // not come due where the reader was into the past where they are:
            // it is given now, once, if its event is still on.
            let moved_into_past = (event.all_day || event.floating.is_some())
                && end > now
                && moved_from
                    .and_then(|old| timing(&event, &old))
                    .is_some_and(|(old_fire, _, _)| old_fire > last.unwrap_or(now) - LATE_GRACE);
            let eligible = start > now || came_due_unseen || fire_at >= now - LATE_GRACE || moved_into_past;
            if !eligible {
                continue;
            }
            let keys = keys(&event);
            if calendar::reminder_given(&db, account, &keys).unwrap_or(true) {
                continue;
            }
            if calendar::mark_reminder_given(&db, account, &keys[0], now).is_err() {
                continue;
            }
            let kind = if moved_into_past { Kind::Due } else { lateness(fire_at, end, last, now) };
            let detail = detail_in(account, &event, start, zone, kind);
            match kind {
                Kind::Due => taken.due.push(detail),
                Kind::Missed => taken.missed.push(detail),
                Kind::Stale => taken.stale.push(detail),
            }
        }
        set_checked(&db, account, now);
    }
    taken
}

/// [`take`] in the machine's zone, flattened to the reminders a phone posts:
/// kept for callers that only want the details.
pub fn take_due(engine: &Arc<Engine>, accounts: &[String], now: i64) -> Vec<Value> {
    take(engine, accounts, now, &Zone::system()).individual()
}

/// Task reminders due at `now` (ADR-0013), each recorded as given, added to
/// `taken`: those that came due while nobody was looking count as missed.
/// A task's reminder is an instant the reader chose, so it does not move with
/// the zone.
pub fn take_tasks(engine: &Arc<Engine>, now: i64, taken: &mut Taken) {
    let db = engine.db.lock().unwrap();
    let last = floor(last_checked(&db, "tasks"), now);
    let due = crate::store::task_lists::due_reminders(&db, now).unwrap_or_default();
    for (id, title, due_at) in due {
        let fire_at: Option<i64> = db
            .query_row("SELECT reminder_at FROM tasks WHERE id = ?1", params![id], |row| row.get(0))
            .ok()
            .flatten();
        if crate::store::task_lists::mark_reminded(&db, id, now).is_err() {
            continue;
        }
        let detail = json!({ "id": id, "title": title, "due_at": due_at });
        match fire_at.map(|at| lateness(at, i64::MAX, last, now)) {
            Some(Kind::Missed) => {
                let mut detail = detail;
                detail["kind"] = json!("task");
                detail["missed"] = json!(true);
                taken.missed.push(detail);
            }
            _ => taken.tasks.push(detail),
        }
    }
    set_checked(&db, "tasks", now);
}

/// Compares the machine's zone with the one the last look saw and records
/// it: `(from, to)` when it changed. Nothing has to be recomputed — when an
/// all-day or floating reminder rings is worked out at every look — but the
/// change is said, for the log and for views that show times.
fn notice_zone(engine: &Arc<Engine>, zone: &Zone) -> Option<(String, String)> {
    let db = engine.db.lock().unwrap();
    let now = zone.name();
    let before = meta(&db, "reminders.zone");
    if before.as_deref() != Some(now.as_str()) {
        set_meta(&db, "reminders.zone", &now);
    }
    before.filter(|before| *before != now).map(|before| (before, now))
}

/// Drops records of reminders long past, so the table does not grow forever.
pub fn forget_old(engine: &Arc<Engine>, now: i64) {
    let db = engine.db.lock().unwrap();
    let _ = calendar::forget_old_reminders(&db, now);
}

// ---- Looking now --------------------------------------------------------------

fn wake() -> &'static tokio::sync::Notify {
    static WAKE: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();
    WAKE.get_or_init(tokio::sync::Notify::new)
}

/// Asks the desktop's watch to look now rather than at its next tick: the
/// machine woke from sleep (`system.resumed`). Kept if the watch is busy, so
/// it is never lost.
pub fn check_now() {
    wake().notify_one();
}

/// Resolves when [`check_now`] is called.
pub async fn woken() {
    wake().notified().await
}

/// The wall clock, in epoch seconds: what every comparison is made against,
/// since a sleep stops the monotonic clock tokio's timers run on.
pub fn wall_clock() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|epoch| epoch.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
