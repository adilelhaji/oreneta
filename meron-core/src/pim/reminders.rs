//! Calendar reminders as they come due, for both hosts.
//!
//! What is due is a question the store answers (`calendar::reminders::due`),
//! so nothing has to be kept in sync with the events: an event created,
//! moved or deleted is accounted for at the next look. Each reminder is
//! recorded as raised before it is handed back, so it is given once however
//! often its window is resynced and whichever host asks — the desktop's
//! minute watch (`calendar.reminder` on stdout), or the phone's foreground
//! tick and background refresh (local notifications).
//!
//! Each look is recorded per account, with when it was and the zone's offset
//! then (ADR-0056). The next look sees the gap however it came about: the
//! machine asleep, the app closed, or a host whose timer stood still. What
//! came due in that gap is given once, while its event is still on; what a
//! change of zone moved is worked out in the zone the machine is in now.

use std::sync::Arc;
use std::time::Duration;

use chrono::TimeZone;
use serde_json::{json, Value};

use crate::calendar;
use crate::calendar::reminders::{self as when, Due};
use crate::engine::Engine;

/// How often reminders are looked for. A minute is finer than any reminder
/// is set to, and coarse enough to cost nothing.
pub const TICK: Duration = Duration::from_secs(60);

/// The `calendar.reminder` detail for one event, as the desktop has always
/// sent it and as the phone posts it, with `local_time`: a timed event's
/// start on the clock of `zone` (`null` for an all-day one). The core says
/// it because it follows a change of zone, which a host that read its zone
/// once at start would not.
pub fn reminder_detail<Tz: TimeZone>(account: &str, event: &calendar::Event, zone: &Tz) -> Value
where
    Tz::Offset: std::fmt::Display,
{
    let local_time = (!event.all_day)
        .then(|| zone.timestamp_opt(event.start, 0).earliest())
        .flatten()
        .map(|start| start.format("%H:%M").to_string());
    json!({
        "account": account,
        "event": event.id,
        "subject": event.subject,
        "location": event.location,
        "start": event.start,
        "all_day": event.all_day,
        "minutes": event.reminder_minutes,
        "local_time": local_time,
    })
}

/// What one look found.
#[derive(Debug, Default, PartialEq)]
pub struct Look {
    /// The `calendar.reminder` details to give, each already recorded.
    pub reminders: Vec<Value>,
    /// Accounts whose zone changed since their previous look and that have
    /// calendars a floating time can come from (CalDAV, subscribed): to be
    /// read again, since such a time is read in the zone of the read.
    pub reread: Vec<String>,
}

/// The reminders due at `now` on `accounts`, in `zone`, each already
/// recorded as raised, and each account's look recorded.
///
/// Paused and muted accounts are skipped, and their look moves on all the
/// same: what comes due while the reader asked not to hear is not saved up
/// for later. A paused account is one the reader asked to stop hearing from,
/// and a muted one is one whose notifications they silenced. Recorded before
/// it is returned: a reminder given twice is worse than one lost to a crash
/// in between.
pub fn look<Tz: TimeZone>(engine: &Arc<Engine>, accounts: &[String], now: i64, zone: &Tz) -> Look
where
    Tz::Offset: std::fmt::Display,
{
    let mut look = Look::default();
    for account in accounts {
        let quiet = engine.is_paused(account) || engine.is_muted(account);
        let db = engine.db.lock().unwrap();
        if quiet {
            let _ = when::record_look(&db, account, now, zone);
            continue;
        }
        let previous = when::previous_look(&db, account).unwrap_or_default();
        if previous.is_some_and(|previous| previous.zone_changed(zone)) && reads_floating_times(&db, account) {
            look.reread.push(account.clone());
        }
        for Due { event, .. } in when::due(&db, account, now, zone, previous).unwrap_or_default() {
            if calendar::mark_reminder_fired(&db, account, &event.id, event.start, now).is_err() {
                continue;
            }
            look.reminders.push(reminder_detail(account, &event, zone));
        }
        let _ = when::record_look(&db, account, now, zone);
    }
    look
}

/// Whether an account has calendars whose times can be floating: CalDAV and
/// subscribed ones, read from iCalendar. Local, Exchange and Google events
/// are instants or dates.
fn reads_floating_times(db: &rusqlite::Connection, account: &str) -> bool {
    calendar::get_calendars(db, account)
        .unwrap_or_default()
        .iter()
        .any(|c| matches!(c.kind, calendar::CalendarKind::CalDav | calendar::CalendarKind::Subscribed))
}

/// [`look`] in this machine's zone, as it is now: the reminders only.
pub fn take_due(engine: &Arc<Engine>, accounts: &[String], now: i64) -> Vec<Value> {
    look(engine, accounts, now, &chrono::Local).reminders
}

/// Drops records of reminders long past, so the table does not grow forever.
pub fn forget_old(engine: &Arc<Engine>, now: i64) {
    let db = engine.db.lock().unwrap();
    let _ = calendar::forget_old_reminders(&db, now);
}

#[cfg(test)]
mod tests;
