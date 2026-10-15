use super::*;
use chrono_tz::{America::Los_Angeles, Asia::Tokyo, Europe::Madrid};

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

/// A store in a file, which outlives the engine: what a restart keeps.
struct FileHost(std::path::PathBuf);
impl crate::engine::EngineHost for FileHost {
    fn open_db(&self) -> anyhow::Result<rusqlite::Connection> {
        crate::store::open_at(&self.0)
    }
    fn apply_secret(&self, _: &rusqlite::Connection, _: &str, _: &mut crate::imap::Creds) {}
    fn store_secret(&self, _: &rusqlite::Connection, _: &str, _: &crate::secrets::Secrets) -> anyhow::Result<()> {
        Ok(())
    }
}

const NOW: i64 = 1_800_000_000;

fn at(text: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(text).unwrap().timestamp()
}

fn put_on(engine: &Arc<Engine>, account: &str, kind: calendar::CalendarKind, events: &[calendar::Event]) {
    let db = engine.db.lock().unwrap();
    calendar::upsert_calendars(
        &db,
        account,
        &[calendar::Calendar {
            id: "local:home".into(),
            name: "Home".into(),
            kind,
            enabled: true,
            ..Default::default()
        }],
    )
    .unwrap();
    let window = (at("2026-01-01T00:00:00Z"), at("2028-01-01T00:00:00Z"));
    calendar::replace_window(&db, account, "local:home", window, events).unwrap();
}

fn put(engine: &Arc<Engine>, events: &[calendar::Event]) {
    put_on(engine, "a", calendar::CalendarKind::Local, events);
}

fn engine_with(events: &[calendar::Event]) -> Arc<Engine> {
    let engine = Arc::new(Engine::new(Box::new(MemoryHost)).unwrap());
    put(&engine, events);
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

/// An all-day event on `date` (YYYY-MM-DD), stored as the calendar stores
/// one: from that date's UTC midnight to the next.
fn all_day(id: &str, date: &str, minutes: i64) -> calendar::Event {
    let start = at(&format!("{date}T00:00:00Z"));
    calendar::Event { all_day: true, end: start + 86_400, ..event(id, start, Some(minutes)) }
}

fn names(look: &Look) -> Vec<&str> {
    look.reminders.iter().map(|detail| detail["event"].as_str().unwrap()).collect()
}

fn a() -> Vec<String> {
    vec!["a".to_string()]
}

fn clock(instant: i64) -> String {
    chrono::Local.timestamp_opt(instant, 0).earliest().unwrap().format("%H:%M").to_string()
}

#[test]
fn a_reminder_is_given_once_when_its_time_comes() {
    let engine = engine_with(&[
        event("soon", NOW + 600, Some(15)),
        event("later", NOW + 7_200, Some(15)),
        event("silent", NOW + 300, None),
        event("started", NOW - 60, Some(15)),
    ]);
    let accounts = a();
    let due = take_due(&engine, &accounts, NOW);
    assert_eq!(
        due,
        vec![json!({
            "account": "a", "event": "soon", "subject": "Subject soon", "location": "Room 1",
            "start": NOW + 600, "all_day": false, "minutes": 15, "local_time": clock(NOW + 600),
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
    let accounts = a();
    assert_eq!(take_due(&engine, &accounts, NOW).len(), 1);
    put(&engine, &[event("meeting", NOW + 3_600, Some(15))]);
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
    assert!(take_due(&engine, &a(), NOW).is_empty(), "a hidden calendar is not reminded of");
    {
        let db = engine.db.lock().unwrap();
        calendar::set_calendar_enabled(&db, "a", "local:home", true).unwrap();
    }
    // Still due: nothing was recorded while it was hidden.
    assert_eq!(take_due(&engine, &a(), NOW).len(), 1);
}

#[test]
fn old_records_are_forgotten() {
    let engine = engine_with(&[event("soon", NOW + 600, Some(15))]);
    assert_eq!(take_due(&engine, &a(), NOW).len(), 1);
    forget_old(&engine, NOW + 15 * 86_400);
    let left: i64 = engine
        .db
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM calendar_reminders_fired", [], |row| row.get(0))
        .unwrap();
    assert_eq!(left, 0);
}

// ---- Suspend and resume (#209) ----------------------------------------------

/// The machine sleeps from 08:30 to 09:10 through a 09:00 meeting's 08:45
/// reminder. Nothing looked while it slept (the watch's ticks run on a clock
/// that stood still); the first look on waking reads the wall clock, and the
/// reminder is given then, once.
#[test]
fn a_reminder_due_during_a_suspend_fires_exactly_once_after_resume() {
    let engine = engine_with(&[
        event("standup", at("2026-10-20T09:00:00Z"), Some(15)),
        event("lunch", at("2026-10-20T12:00:00Z"), Some(15)),
    ]);
    let asleep = at("2026-10-20T08:30:00Z");
    assert!(look(&engine, &a(), asleep, &Madrid).reminders.is_empty(), "not yet");

    let woke = at("2026-10-20T09:10:00Z");
    let first = look(&engine, &a(), woke, &Madrid);
    assert_eq!(names(&first), ["standup"]);
    assert_eq!(first.reminders[0]["local_time"], "11:00", "its start on the reader's clock");
    // The resume and the next tick both look: still once.
    assert!(look(&engine, &a(), woke, &Madrid).reminders.is_empty());
    assert!(look(&engine, &a(), woke + 60, &Madrid).reminders.is_empty());
    // Later ones are untouched, and come at their time.
    assert!(look(&engine, &a(), at("2026-10-20T11:44:00Z"), &Madrid).reminders.is_empty());
    assert_eq!(names(&look(&engine, &a(), at("2026-10-20T11:45:00Z"), &Madrid)), ["lunch"]);
}

#[test]
fn a_suspend_that_ends_before_the_event_starts_gives_the_reminder_on_waking() {
    let engine = engine_with(&[event("standup", at("2026-10-20T09:00:00Z"), Some(15))]);
    assert!(look(&engine, &a(), at("2026-10-20T08:30:00Z"), &Madrid).reminders.is_empty());
    assert_eq!(names(&look(&engine, &a(), at("2026-10-20T08:50:00Z"), &Madrid)), ["standup"]);
}

#[test]
fn a_reminder_whose_event_ended_during_a_suspend_is_not_given() {
    let engine = engine_with(&[event("standup", at("2026-10-20T09:00:00Z"), Some(15))]);
    assert!(look(&engine, &a(), at("2026-10-20T08:30:00Z"), &Madrid).reminders.is_empty());
    // Woke at 10:00, the very moment it ended.
    assert!(look(&engine, &a(), at("2026-10-20T10:00:00Z"), &Madrid).reminders.is_empty());
}

#[test]
fn a_look_cut_off_before_it_was_recorded_gives_nothing_twice() {
    let engine = engine_with(&[event("standup", at("2026-10-20T09:00:00Z"), Some(15))]);
    let asleep = at("2026-10-20T08:30:00Z");
    assert!(look(&engine, &a(), asleep, &Madrid).reminders.is_empty());
    let woke = at("2026-10-20T09:10:00Z");
    assert_eq!(names(&look(&engine, &a(), woke, &Madrid)), ["standup"]);
    // As if it had crashed after recording the reminder and before recording
    // the look: the next look sees the same gap again.
    when::record_look(&engine.db.lock().unwrap(), "a", asleep, &Madrid).unwrap();
    assert!(look(&engine, &a(), woke + 60, &Madrid).reminders.is_empty());
}

#[test]
fn a_paused_accounts_missed_reminders_are_not_saved_up() {
    let engine = Arc::new(Engine::new(Box::new(MemoryHost)).unwrap());
    let account = crate::archive::ACCOUNT;
    crate::archive::ensure_account(&engine.db.lock().unwrap(), NOW).unwrap();
    let standup = event("standup", at("2026-10-20T09:00:00Z"), Some(15));
    put_on(&engine, account, calendar::CalendarKind::Local, &[standup]);
    let accounts = vec![account.to_string()];
    assert!(look(&engine, &accounts, at("2026-10-20T08:30:00Z"), &Madrid).reminders.is_empty());
    crate::store::set_account_pref(&engine.db.lock().unwrap(), account, "paused", true).unwrap();
    assert!(look(&engine, &accounts, at("2026-10-20T08:50:00Z"), &Madrid).reminders.is_empty(), "paused");
    crate::store::set_account_pref(&engine.db.lock().unwrap(), account, "paused", false).unwrap();
    assert!(
        look(&engine, &accounts, at("2026-10-20T09:10:00Z"), &Madrid).reminders.is_empty(),
        "it came due while the reader asked not to hear, and the meeting has started",
    );

    // Removing the account forgets its looks with it (ADR-0011).
    crate::store::delete_account(&engine.db.lock().unwrap(), account).unwrap();
    assert_eq!(when::previous_look(&engine.db.lock().unwrap(), account).unwrap(), None);
}

/// Given before the app closed, then a reminder that came due while it was
/// closed, then a sleep and a resume, then a resync: each once.
#[test]
fn no_reminder_fires_twice_across_a_restart_followed_by_a_resume() {
    let path = std::env::temp_dir().join(format!("oreneta-reminders-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let events = [
        event("standup", at("2026-10-20T09:00:00Z"), Some(15)),
        calendar::Event { end: at("2026-10-20T11:00:00Z"), ..event("review", at("2026-10-20T10:00:00Z"), Some(30)) },
    ];
    {
        let engine = Arc::new(Engine::new(Box::new(FileHost(path.clone()))).unwrap());
        put(&engine, &events);
        assert_eq!(names(&look(&engine, &a(), at("2026-10-20T08:45:00Z"), &Madrid)), ["standup"]);
    }
    // Closed at 08:46, opened again at 09:35: the review's reminder rang at
    // 09:30 while it was closed, and the review is on.
    let engine = Arc::new(Engine::new(Box::new(FileHost(path.clone()))).unwrap());
    assert_eq!(names(&look(&engine, &a(), at("2026-10-20T09:35:00Z"), &Madrid)), ["review"]);
    // Asleep from 09:36 to 09:50, then the resume's look and a resync.
    assert!(look(&engine, &a(), at("2026-10-20T09:36:00Z"), &Madrid).reminders.is_empty());
    assert!(look(&engine, &a(), at("2026-10-20T09:50:00Z"), &Madrid).reminders.is_empty());
    put(&engine, &events);
    assert!(look(&engine, &a(), at("2026-10-20T09:51:00Z"), &Madrid).reminders.is_empty());
    let given: i64 = engine
        .db
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM calendar_reminders_fired", [], |row| row.get(0))
        .unwrap();
    assert_eq!(given, 2);
    drop(engine);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

// ---- Time zones (#209) ------------------------------------------------------

/// From Madrid to Los Angeles with a meeting and an all-day event ahead: the
/// meeting's reminder is the same instant, shown on the new clock; the
/// all-day one counts back from midnight where the reader is now.
#[test]
fn after_a_time_zone_change_timed_reminders_keep_their_instant_and_all_day_ones_follow() {
    let engine = engine_with(&[
        event("call", at("2026-10-20T16:00:00Z"), Some(15)),
        // The day before at 23:45 wherever the reader is.
        all_day("holiday", "2026-10-21", 15),
    ]);
    assert!(look(&engine, &a(), at("2026-10-20T10:00:00Z"), &Madrid).reminders.is_empty());

    let call = look(&engine, &a(), at("2026-10-20T15:45:00Z"), &Los_Angeles);
    assert_eq!(names(&call), ["call"]);
    assert_eq!(call.reminders[0]["local_time"], "09:00", "18:00 in Madrid, 09:00 here");
    assert!(
        look(&engine, &a(), at("2026-10-20T21:45:00Z"), &Los_Angeles).reminders.is_empty(),
        "23:45 in Madrid is not 23:45 here",
    );
    let holiday = look(&engine, &a(), at("2026-10-20T23:45:00-07:00"), &Los_Angeles);
    assert_eq!(names(&holiday), ["holiday"]);
    assert_eq!(holiday.reminders[0]["local_time"], Value::Null);
    assert_eq!(holiday.reminders[0]["start"], at("2026-10-21T00:00:00Z"), "the date, as stored");
}

/// A floating time is read in the zone the machine is in when its calendar
/// is read: the accounts that can hold one are named for reading again,
/// once, when the zone changes. Daylight saving is not a change.
#[test]
fn a_time_zone_change_asks_once_to_reread_calendars_that_can_hold_floating_times() {
    let engine = engine_with(&[]);
    put_on(&engine, "c", calendar::CalendarKind::CalDav, &[]);
    put_on(&engine, "s", calendar::CalendarKind::Subscribed, &[]);
    let accounts = vec!["a".to_string(), "c".to_string(), "s".to_string()];
    let summer = at("2026-10-20T10:00:00Z");
    assert!(look(&engine, &accounts, summer, &Madrid).reread.is_empty(), "no previous look");
    let winter = at("2026-10-26T10:00:00Z");
    assert!(look(&engine, &accounts, winter, &Madrid).reread.is_empty(), "the clocks went back: same zone");
    assert_eq!(look(&engine, &accounts, winter + 60, &Tokyo).reread, ["c", "s"]);
    assert!(look(&engine, &accounts, winter + 120, &Tokyo).reread.is_empty(), "once");
}

/// A floating 09:00 read in Madrid (07:00Z); the reader is in Tokyo before it
/// rang. The calendar is read again there, and the reminder rings at 08:45
/// Tokyo, once; the instant it had in Madrid gives nothing.
#[test]
fn a_floating_event_read_again_in_the_new_zone_is_reminded_at_its_time_there() {
    let engine = engine_with(&[]);
    let floating = |start: i64| calendar::Event { id: format!("uid@{start}"), ..event("x", start, Some(15)) };
    let in_madrid = at("2026-10-20T09:00:00+02:00");
    put_on(&engine, "c", calendar::CalendarKind::CalDav, &[floating(in_madrid)]);
    let accounts = vec!["c".to_string()];
    assert!(look(&engine, &accounts, at("2026-10-19T22:00:00Z"), &Madrid).reminders.is_empty());

    let moved = look(&engine, &accounts, at("2026-10-19T23:00:00Z"), &Tokyo);
    assert_eq!(moved.reread, ["c"]);
    assert!(moved.reminders.is_empty());
    let in_tokyo = at("2026-10-20T09:00:00+09:00");
    put_on(&engine, "c", calendar::CalendarKind::CalDav, &[floating(in_tokyo)]);
    let due = look(&engine, &accounts, in_tokyo - 15 * 60, &Tokyo);
    assert_eq!(names(&due), [format!("uid@{in_tokyo}").as_str()]);
    assert_eq!(due.reminders[0]["local_time"], "09:00");
    assert!(look(&engine, &accounts, in_madrid - 15 * 60, &Tokyo).reminders.is_empty());
}

/// The other way round: reminded at 08:45 in Tokyo, then in Madrid and read
/// again there, the same floating 09:00 is a later instant, and is reminded
/// again before it, as a moved event is (ADR-0056).
#[test]
fn a_floating_event_reminded_before_a_move_west_is_reminded_again_at_its_new_time() {
    let engine = engine_with(&[]);
    let floating = |start: i64| calendar::Event { id: format!("uid@{start}"), ..event("x", start, Some(15)) };
    let in_tokyo = at("2026-10-20T09:00:00+09:00");
    put_on(&engine, "c", calendar::CalendarKind::CalDav, &[floating(in_tokyo)]);
    let accounts = vec!["c".to_string()];
    assert_eq!(look(&engine, &accounts, in_tokyo - 15 * 60, &Tokyo).reminders.len(), 1);
    let in_madrid = at("2026-10-20T09:00:00+02:00");
    put_on(&engine, "c", calendar::CalendarKind::CalDav, &[floating(in_madrid)]);
    assert!(look(&engine, &accounts, in_madrid - 16 * 60, &Madrid).reminders.is_empty());
    assert_eq!(look(&engine, &accounts, in_madrid - 15 * 60, &Madrid).reminders.len(), 1);
}

/// The hosts' zone is this machine's: run under several `TZ` (as CI does),
/// an all-day reminder rings counting back from midnight there.
#[test]
fn an_all_day_reminder_follows_this_machines_zone() {
    let engine = engine_with(&[all_day("holiday", "2026-10-21", 60)]);
    let day = chrono::NaiveDate::from_ymd_opt(2026, 10, 21).unwrap();
    let midnight = chrono::Local.from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap()).earliest().unwrap().timestamp();
    assert!(take_due(&engine, &a(), midnight - 3_600 - 60).is_empty());
    assert_eq!(take_due(&engine, &a(), midnight - 3_600).len(), 1);
}
