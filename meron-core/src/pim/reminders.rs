//! Calendar reminders as they come due, for both hosts.
//!
//! What is due is a question the store answers (`calendar::due_reminders`),
//! so nothing has to be kept in sync with the events: an event created,
//! moved or deleted is accounted for at the next look. Each reminder is
//! recorded as raised before it is handed back, so it is given once however
//! often its window is resynced and whichever host asks — the desktop's
//! minute watch (`calendar.reminder` on stdout), or the phone's foreground
//! tick and background refresh (local notifications).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::calendar;
use crate::engine::Engine;

/// How often reminders are looked for. A minute is finer than any reminder
/// is set to, and coarse enough to cost nothing.
pub const TICK: Duration = Duration::from_secs(60);

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

/// The reminders due at `now` on `accounts`, each already recorded as raised.
///
/// Paused and muted accounts are skipped: a paused account is one the reader
/// asked to stop hearing from, and a muted one is one whose notifications they
/// silenced. Recorded before it is returned: a reminder given twice is worse
/// than one lost to a crash in between.
pub fn take_due(engine: &Arc<Engine>, accounts: &[String], now: i64) -> Vec<Value> {
    let mut raised = Vec::new();
    for account in accounts {
        if engine.is_paused(account) || engine.is_muted(account) {
            continue;
        }
        let due = {
            let db = engine.db.lock().unwrap();
            calendar::due_reminders(&db, account, now).unwrap_or_default()
        };
        for event in due {
            {
                let db = engine.db.lock().unwrap();
                if calendar::mark_reminder_fired(&db, account, &event.id, event.start, now).is_err() {
                    continue;
                }
            }
            raised.push(reminder_detail(account, &event));
        }
    }
    raised
}

/// Drops records of reminders long past, so the table does not grow forever.
pub fn forget_old(engine: &Arc<Engine>, now: i64) {
    let db = engine.db.lock().unwrap();
    let _ = calendar::forget_old_reminders(&db, now);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MemoryHost;
    impl crate::engine::EngineHost for MemoryHost {
        fn open_db(&self) -> anyhow::Result<rusqlite::Connection> {
            crate::store::open_at(":memory:")
        }
        fn apply_secret(&self, _: &rusqlite::Connection, _: &str, _: &mut crate::imap::Creds) {}
        fn store_secret(&self, _: &rusqlite::Connection, _: &str, _: &crate::secrets::Secrets) -> anyhow::Result<()> {
            Ok(())
        }
    }

    const NOW: i64 = 1_800_000_000;

    fn engine_with(events: &[calendar::Event]) -> Arc<Engine> {
        let engine = Arc::new(Engine::new(Box::new(MemoryHost)).unwrap());
        {
            let db = engine.db.lock().unwrap();
            calendar::upsert_calendars(
                &db,
                "a",
                &[calendar::Calendar {
                    id: "local:home".into(),
                    name: "Home".into(),
                    kind: calendar::CalendarKind::Local,
                    enabled: true,
                    ..Default::default()
                }],
            )
            .unwrap();
            calendar::replace_window(&db, "a", "local:home", (NOW - 86_400, NOW + 86_400 * 30), events).unwrap();
        }
        engine
    }

    fn event(id: &str, start: i64, minutes: Option<i64>) -> calendar::Event {
        calendar::Event {
            id: id.into(),
            calendar_id: "local:home".into(),
            subject: format!("Subject {id}"),
            start,
            end: start + 3_600,
            location: Some("Room 1".into()),
            reminder_minutes: minutes,
            ..Default::default()
        }
    }

    #[test]
    fn a_reminder_is_given_once_when_its_time_comes() {
        let engine = engine_with(&[
            event("soon", NOW + 600, Some(15)),
            event("later", NOW + 7_200, Some(15)),
            event("silent", NOW + 300, None),
            event("started", NOW - 60, Some(15)),
        ]);
        let accounts = vec!["a".to_string()];
        let due = take_due(&engine, &accounts, NOW);
        assert_eq!(
            due,
            vec![json!({
                "account": "a", "event": "soon", "subject": "Subject soon", "location": "Room 1",
                "start": NOW + 600, "all_day": false, "minutes": 15,
            })],
            "only the one whose reminder time has come and that has not started",
        );
        assert!(take_due(&engine, &accounts, NOW + 60).is_empty(), "given once");
        let later = take_due(&engine, &accounts, NOW + 7_200 - 900);
        assert_eq!(later.len(), 1);
        assert_eq!(later[0]["event"], "later");
    }

    #[test]
    fn a_moved_event_is_reminded_again_at_its_new_time() {
        let engine = engine_with(&[event("meeting", NOW + 600, Some(15))]);
        let accounts = vec!["a".to_string()];
        assert_eq!(take_due(&engine, &accounts, NOW).len(), 1);
        {
            let db = engine.db.lock().unwrap();
            calendar::replace_window(
                &db,
                "a",
                "local:home",
                (NOW - 86_400, NOW + 86_400 * 30),
                &[event("meeting", NOW + 3_600, Some(15))],
            )
            .unwrap();
        }
        assert!(take_due(&engine, &accounts, NOW + 60).is_empty());
        assert_eq!(take_due(&engine, &accounts, NOW + 3_600 - 600).len(), 1, "the new start is a new moment");
    }

    #[test]
    fn hidden_calendars_and_unlisted_accounts_raise_nothing() {
        let engine = engine_with(&[event("soon", NOW + 600, Some(15))]);
        assert!(take_due(&engine, &[], NOW).is_empty(), "only the accounts asked about");
        assert!(take_due(&engine, &["b".to_string()], NOW).is_empty());
        {
            let db = engine.db.lock().unwrap();
            calendar::set_calendar_enabled(&db, "a", "local:home", false).unwrap();
        }
        assert!(take_due(&engine, &["a".to_string()], NOW).is_empty(), "a hidden calendar is not reminded of");
        {
            let db = engine.db.lock().unwrap();
            calendar::set_calendar_enabled(&db, "a", "local:home", true).unwrap();
        }
        // Still due: nothing was recorded while it was hidden.
        assert_eq!(take_due(&engine, &["a".to_string()], NOW).len(), 1);
    }

    #[test]
    fn old_records_are_forgotten() {
        let engine = engine_with(&[event("soon", NOW + 600, Some(15))]);
        assert_eq!(take_due(&engine, &["a".to_string()], NOW).len(), 1);
        forget_old(&engine, NOW + 15 * 86_400);
        let left: i64 = engine
            .db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM calendar_reminders_fired", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }
}
