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
//! came due in that gap is given once: on its own while its event is still
//! on, and in one grouped notice with the others when its event is over
//! (#225); what a change of zone moved is worked out in the zone the machine
//! is in now.

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

/// The `calendar.reminder` detail for one event at `now`, as the desktop has
/// always sent it and as the phone posts it, with what the core knows better
/// than a host that read its zone once at start (ADR-0056):
///
/// - `local_time`: a timed event's start on the clock of `zone` (`null` for
///   an all-day one);
/// - `started`: whether the event had already started, as a reminder given
///   late (after a sleep) can be;
/// - `local_date`: the event's date in `zone` ("YYYY-MM-DD") when it is not
///   today's, `null` when it is.
pub fn reminder_detail<Tz: TimeZone>(account: &str, event: &calendar::Event, zone: &Tz, now: i64) -> Value
where
    Tz::Offset: std::fmt::Display,
{
    let in_zone = |instant: i64| zone.timestamp_opt(instant, 0).earliest();
    let local_time = (!event.all_day).then(|| in_zone(event.start)).flatten().map(|start| start.format("%H:%M").to_string());
    let date = event_date(event, zone);
    let today = in_zone(now).map(|now| now.date_naive());
    let local_date = date.filter(|date| Some(*date) != today).map(|date| date.format("%Y-%m-%d").to_string());
    let start = when::timing(event, zone).map_or(event.start, |timing| timing.start);
    json!({
        "account": account,
        "event": event.id,
        "subject": event.subject,
        "location": event.location,
        "start": event.start,
        "all_day": event.all_day,
        "minutes": event.reminder_minutes,
        "local_time": local_time,
        "started": start < now,
        "local_date": local_date,
    })
}

/// The date an event is on in `zone`: an all-day event's is the stored one.
fn event_date<Tz: TimeZone>(event: &calendar::Event, zone: &Tz) -> Option<chrono::NaiveDate> {
    if event.all_day {
        chrono::DateTime::from_timestamp(event.start, 0).map(|day| day.date_naive())
    } else {
        zone.timestamp_opt(event.start, 0).earliest().map(|start| start.date_naive())
    }
}

/// How many missed reminders a notice details; `count` says how many in all.
/// A host shows a few lines, so more is only weight on the wire.
pub const MISSED_DETAILED: usize = 20;

/// The `calendar.missedReminders` detail (#225): how many reminders a look
/// found missed (`count`), the most recent [`MISSED_DETAILED`] of them as
/// `calendar.reminder` details, newest first, since the latest missed meeting
/// is the likeliest still to need something, and the days they span on the
/// clock of `zone` ("YYYY-MM-DD"): `day`, the most recent, and `first_day`.
/// `None` when nothing was missed.
fn missed_notice<Tz: TimeZone>(mut missed: Vec<(i64, String, calendar::Event)>, zone: &Tz, now: i64) -> Option<Value>
where
    Tz::Offset: std::fmt::Display,
{
    missed.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)).then_with(|| a.2.id.cmp(&b.2.id)));
    let date = |event: &calendar::Event| event_date(event, zone).map(|day| day.format("%Y-%m-%d").to_string());
    let day = date(&missed.first()?.2);
    let first_day = date(&missed.last()?.2);
    let reminders: Vec<Value> = missed
        .iter()
        .take(MISSED_DETAILED)
        .map(|(_, account, event)| reminder_detail(account, event, zone, now))
        .collect();
    Some(json!({ "count": missed.len(), "day": day, "first_day": first_day, "reminders": reminders }))
}

/// An account whose floating calendars are to be read again after a change
/// of zone, and the window to read: around the change, so asking again
/// while a read runs is the same window, which `pim::calendar` runs once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reread {
    pub account: String,
    pub from: i64,
    pub to: i64,
}

impl Reread {
    fn since(account: &str, since: i64) -> Reread {
        Reread { account: account.to_string(), from: since - 86_400 * 31, to: since + 86_400 * 366 }
    }
}

/// What one look found.
#[derive(Debug, Default, PartialEq)]
pub struct Look {
    /// The `calendar.reminder` details to give, each already recorded.
    pub reminders: Vec<Value>,
    /// The reminders that came due while nobody looked and whose events
    /// ended before this look, each already recorded: one
    /// `calendar.missedReminders` notice for them all (#225).
    pub missed: Option<Value>,
    /// Accounts whose zone changed and that have calendars a floating time
    /// can come from (CalDAV, subscribed): to be read again, since such a
    /// time is read in the zone of the read. Asked again until done.
    pub reread: Vec<Reread>,
}

/// The reminders due at `now` on `accounts`, in `zone`, each already
/// recorded as raised, and each account's look recorded.
///
/// What came due while nobody looked and whose event is over by now is
/// missed: gathered across accounts into one notice (`Look::missed`), so a
/// night asleep ends in one notification, not a burst (#225).
///
/// A paused account is one the reader asked to stop hearing from, and a
/// muted one is one whose notifications they silenced: neither is reminded,
/// and its look moves on all the same, so a reminder that came due meanwhile
/// is not given later as missed (one whose event has not started still is,
/// on time). A change of zone is noted first all the same: a muted account's
/// calendars are read again, a paused one's once it is resumed.
///
/// Recorded before it is returned: a reminder given twice is worse than one
/// lost to a crash in between. A look that could not finish (the store
/// failed) is not recorded, so the next one looks at the same gap again.
pub fn look<Tz: TimeZone>(engine: &Arc<Engine>, accounts: &[String], now: i64, zone: &Tz) -> Look
where
    Tz::Offset: std::fmt::Display,
{
    look_for(engine, accounts, now, zone, Missed::Gather)
}

/// What a look does with missed reminders: the desktop gathers them into its
/// notice; the phone has no such notice yet, so it leaves them unrecorded and
/// its look moves past them, as before #225 (ADR-0056).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Missed {
    Gather,
    Leave,
}

fn look_for<Tz: TimeZone>(engine: &Arc<Engine>, accounts: &[String], now: i64, zone: &Tz, missed: Missed) -> Look
where
    Tz::Offset: std::fmt::Display,
{
    let mut look = Look::default();
    let mut gathered = Vec::new();
    for account in accounts {
        let paused = engine.is_paused(account);
        let quiet = paused || engine.is_muted(account);
        let db = engine.db.lock().unwrap();
        let Ok(previous) = when::previous_look(&db, account) else { continue };
        let mut complete = true;
        if previous.is_some_and(|previous| previous.zone_changed(zone)) {
            match when::floating_calendars(&db, account) {
                Ok(calendars) if calendars.is_empty() => {}
                Ok(_) => complete &= when::mark_reread(&db, account, now).is_ok(),
                Err(_) => complete = false,
            }
        }
        if !paused {
            if let Ok(Some(since)) = when::reread_due(&db, account, now) {
                look.reread.push(Reread::since(account, since));
            }
        }
        if !quiet {
            match when::due(&db, account, now, zone, previous) {
                Ok(due) => {
                    for Due { event, timing, missed: was_missed } in due {
                        if was_missed && missed == Missed::Leave {
                            continue;
                        }
                        if calendar::mark_reminder_fired(&db, account, &event.id, event.start, now).is_err() {
                            complete = false;
                            continue;
                        }
                        if was_missed {
                            gathered.push((timing.start, account.clone(), event));
                        } else {
                            look.reminders.push(reminder_detail(account, &event, zone, now));
                        }
                    }
                }
                Err(_) => complete = false,
            }
        }
        if complete {
            let _ = when::record_look(&db, account, now, zone);
        }
    }
    look.missed = missed_notice(gathered, zone, now);
    look
}

/// A look in this machine's zone, as it is now, for the phone: the
/// reminders only. The phone reads its calendars again on its own
/// quarter-hour refresh, and has no notice of missed reminders yet.
pub fn take_due(engine: &Arc<Engine>, accounts: &[String], now: i64) -> Vec<Value> {
    look_for(engine, accounts, now, &chrono::Local, Missed::Leave).reminders
}

/// Drops records of reminders long past, so the table does not grow forever.
pub fn forget_old(engine: &Arc<Engine>, now: i64) {
    let db = engine.db.lock().unwrap();
    let _ = calendar::forget_old_reminders(&db, now);
}

#[cfg(test)]
mod tests;
