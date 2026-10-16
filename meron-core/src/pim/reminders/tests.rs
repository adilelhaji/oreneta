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

fn rereads(look: &Look) -> Vec<&str> {
    look.reread.iter().map(|reread| reread.account.as_str()).collect()
}

fn clock(instant: i64) -> String {
    chrono::Local.timestamp_opt(instant, 0).earliest().unwrap().format("%H:%M").to_string()
}

/// `local_date` as this machine's clock gives it for an event at `start`
/// seen at `now`.
fn other_day(start: i64, now: i64) -> Value {
    let date = |instant: i64| chrono::Local.timestamp_opt(instant, 0).earliest().unwrap().date_naive();
    if date(start) == date(now) {
        Value::Null
    } else {
        json!(date(start).format("%Y-%m-%d").to_string())
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
    let accounts = a();
    let due = take_due(&engine, &accounts, NOW);
    assert_eq!(
        due,
        vec![json!({
            "account": "a", "event": "soon", "subject": "Subject soon", "location": "Room 1",
            "start": NOW + 600, "all_day": false, "minutes": 15, "local_time": clock(NOW + 600),
            "started": false, "local_date": other_day(NOW + 600, NOW),
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

// ---- Missed while asleep (#225) ---------------------------------------------

fn missed(look: &Look) -> Vec<&str> {
    look.missed
        .as_ref()
        .map(|notice| notice["reminders"].as_array().unwrap().iter().map(|d| d["event"].as_str().unwrap()).collect())
        .unwrap_or_default()
}

/// Asleep from 08:30 to 10:00 through the whole of a 09:00 meeting: on
/// waking its reminder is in the one missed-reminders notice, saying it
/// started, and nothing is given again afterwards.
#[test]
fn a_reminder_whose_event_ended_during_a_suspend_is_given_once_in_the_missed_notice() {
    let engine = engine_with(&[event("standup", at("2026-10-20T09:00:00Z"), Some(15))]);
    assert!(look(&engine, &a(), at("2026-10-20T08:30:00Z"), &Madrid).missed.is_none());
    // Woke at 10:00, the very moment it ended.
    let woke = at("2026-10-20T10:00:00Z");
    let first = look(&engine, &a(), woke, &Madrid);
    assert!(first.reminders.is_empty(), "not a reminder of its own");
    let notice = first.missed.clone().expect("one notice");
    assert_eq!(notice["count"], 1);
    assert_eq!(notice["day"], "2026-10-20", "the day to open the calendar on");
    assert_eq!(
        notice["reminders"][0],
        reminder_detail("a", &event("standup", at("2026-10-20T09:00:00Z"), Some(15)), &Madrid, woke),
        "each as a calendar.reminder says it",
    );
    assert_eq!(notice["reminders"][0]["started"], true);
    assert_eq!(notice["reminders"][0]["local_time"], "11:00");
    // The resume and the next tick both look: once.
    assert_eq!(look(&engine, &a(), woke, &Madrid), Look::default());
    assert_eq!(look(&engine, &a(), woke + 60, &Madrid), Look::default());
}

/// A night asleep over several meetings, on two accounts and two days:
/// exactly one notice, with all of them, newest first, and the days they
/// span.
#[test]
fn several_missed_reminders_make_exactly_one_notice_with_all_of_them() {
    let engine = engine_with(&[
        event("late", at("2026-10-19T21:00:00Z"), Some(15)),
        event("early", at("2026-10-20T06:00:00Z"), Some(15)),
        all_day("holiday", "2026-10-20", 0),
    ]);
    put_on(&engine, "b", calendar::CalendarKind::Local, &[event("other", at("2026-10-20T05:00:00Z"), Some(30))]);
    let accounts = vec!["a".to_string(), "b".to_string()];
    assert!(look(&engine, &accounts, at("2026-10-19T20:00:00Z"), &Madrid).missed.is_none());

    let woke = at("2026-10-21T07:00:00Z");
    let first = look(&engine, &accounts, woke, &Madrid);
    assert!(first.reminders.is_empty());
    assert_eq!(missed(&first), ["early", "other", "holiday", "late"], "newest first");
    let notice = first.missed.unwrap();
    assert_eq!(notice["count"], 4);
    assert_eq!(notice["day"], "2026-10-20", "the most recent missed day, on the reader's clock");
    assert_eq!(notice["first_day"], "2026-10-19", "and the first");
    assert_eq!(notice["reminders"][1]["account"], "b");
    assert_eq!(notice["reminders"][2]["local_date"], "2026-10-20");
    assert_eq!(look(&engine, &accounts, woke + 60, &Madrid), Look::default(), "once");
}

/// A long absence: the notice says how many in all, details only the most
/// recent few, and every one of them is recorded as given.
#[test]
fn a_notice_details_the_most_recent_missed_reminders_and_counts_them_all() {
    let first = at("2026-10-20T06:00:00Z");
    let events: Vec<_> = (0..25).map(|i| event(&format!("m{i:02}"), first + i * 3_600, Some(15))).collect();
    let engine = engine_with(&events);
    assert!(look(&engine, &a(), first - 7_200, &Madrid).missed.is_none());
    let woke = look(&engine, &a(), first + 30 * 3_600, &Madrid);
    let notice = woke.missed.clone().unwrap();
    assert_eq!(notice["count"], 25);
    assert_eq!(notice["reminders"].as_array().unwrap().len(), MISSED_DETAILED);
    assert_eq!(missed(&woke)[0], "m24", "the most recent first");
    assert_eq!(missed(&woke)[MISSED_DETAILED - 1], "m05");
    assert_eq!(recorded(&engine), 25);
    assert_eq!(look(&engine, &a(), first + 30 * 3_600 + 60, &Madrid), Look::default());
}

/// The look on waking runs before the calendars are read again, so a
/// meeting that a sync during the gap brought in (or a calendar shown again)
/// whose reminder rang and whose end passed in the gap is reported as missed
/// too: what was in the store at the look is what it reports.
#[test]
fn an_event_synced_in_or_shown_again_during_the_gap_is_reported_as_missed() {
    let engine = engine_with(&[]);
    put_on(&engine, "b", calendar::CalendarKind::Local, &[event("shown", at("2026-10-20T09:30:00Z"), Some(15))]);
    let hidden = |on: bool| {
        let db = engine.db.lock().unwrap();
        calendar::set_calendar_enabled(&db, "b", "local:home", !on).unwrap();
    };
    hidden(true);
    let accounts = vec!["a".to_string(), "b".to_string()];
    assert!(look(&engine, &accounts, at("2026-10-20T08:00:00Z"), &Madrid).missed.is_none());
    // Asleep from 08:00 to 11:00. Meanwhile (before the look on waking) a
    // sync brings in a 09:00 meeting, and the hidden calendar is shown again.
    put(&engine, &[event("synced", at("2026-10-20T09:00:00Z"), Some(15))]);
    hidden(false);
    assert_eq!(missed(&look(&engine, &accounts, at("2026-10-20T11:00:00Z"), &Madrid)), ["shown", "synced"]);
}

fn recorded(engine: &Arc<Engine>) -> i64 {
    engine
        .db
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM calendar_reminders_fired", [], |row| row.get(0))
        .unwrap()
}

/// One look on waking: the meeting still on is given on its own, as since
/// #209 ("Started at …"); the one already over goes in the notice.
#[test]
fn a_reminder_still_on_is_given_on_its_own_beside_the_missed_notice() {
    let engine = engine_with(&[
        event("over", at("2026-10-20T08:45:00Z"), Some(15)).with_end(at("2026-10-20T09:00:00Z")),
        event("review", at("2026-10-20T09:00:00Z"), Some(15)),
    ]);
    assert!(look(&engine, &a(), at("2026-10-20T08:00:00Z"), &Madrid).reminders.is_empty());
    let woke = look(&engine, &a(), at("2026-10-20T09:10:00Z"), &Madrid);
    assert_eq!(names(&woke), ["review"]);
    assert_eq!(woke.reminders[0]["started"], true);
    assert_eq!(missed(&woke), ["over"]);
}

/// Paused or muted, nothing is shown: neither the notice nor anything later.
#[test]
fn a_paused_or_muted_account_shows_no_missed_reminders() {
    let engine = Arc::new(Engine::new(Box::new(MemoryHost)).unwrap());
    let account = crate::archive::ACCOUNT;
    crate::archive::ensure_account(&engine.db.lock().unwrap(), NOW).unwrap();
    put_on(
        &engine,
        account,
        calendar::CalendarKind::Local,
        &[event("standup", at("2026-10-20T09:00:00Z"), Some(15)), event("lunch", at("2026-10-20T12:00:00Z"), Some(15))],
    );
    let accounts = vec![account.to_string()];
    let set = |pref: &str, on: bool| {
        crate::store::set_account_pref(&engine.db.lock().unwrap(), account, pref, on).unwrap();
    };
    assert!(look(&engine, &accounts, at("2026-10-20T08:30:00Z"), &Madrid).missed.is_none());
    for pref in ["paused", "muted"] {
        set(pref, true);
        let (asleep, woke) = if pref == "paused" { ("08:30", "10:30") } else { ("10:30", "13:30") };
        let woke = look(&engine, &accounts, at(&format!("2026-10-20T{woke}:00Z")), &Madrid);
        assert_eq!(woke, Look::default(), "{pref}: nothing since {asleep}");
        set(pref, false);
    }
    assert_eq!(look(&engine, &accounts, at("2026-10-20T13:31:00Z"), &Madrid), Look::default(), "nor later");
}

/// Missed while the app was closed, then a sleep and a resume: the notice
/// comes once, and neither a restart nor a resume brings it back.
#[test]
fn a_missed_reminder_is_not_given_twice_across_a_restart_followed_by_a_resume() {
    let file = TempDb::new("missed");
    let path = file.0.clone();
    let events = [event("standup", at("2026-10-20T09:00:00Z"), Some(15))];
    {
        let engine = Arc::new(Engine::new(Box::new(FileHost(path.clone()))).unwrap());
        put(&engine, &events);
        assert_eq!(look(&engine, &a(), at("2026-10-20T08:30:00Z"), &Madrid), Look::default());
    }
    // Closed at 08:31, opened again at 10:30: the standup came and went.
    {
        let engine = Arc::new(Engine::new(Box::new(FileHost(path.clone()))).unwrap());
        assert_eq!(missed(&look(&engine, &a(), at("2026-10-20T10:30:00Z"), &Madrid)), ["standup"]);
    }
    // Opened again, asleep, woke, and a resync: nothing more.
    let engine = Arc::new(Engine::new(Box::new(FileHost(path.clone()))).unwrap());
    assert_eq!(look(&engine, &a(), at("2026-10-20T10:31:00Z"), &Madrid), Look::default());
    assert_eq!(look(&engine, &a(), at("2026-10-20T12:00:00Z"), &Madrid), Look::default());
    put(&engine, &events);
    assert_eq!(look(&engine, &a(), at("2026-10-20T12:01:00Z"), &Madrid), Look::default());
}

/// A store file for a restart test, removed with its WAL files when the test
/// ends, passed or failed. Made before the engines, so dropped after them.
struct TempDb(std::path::PathBuf);

impl TempDb {
    fn new(name: &str) -> TempDb {
        let file = TempDb(std::env::temp_dir().join(format!("oreneta-{name}-{}.db", std::process::id())));
        file.remove();
        file
    }

    fn remove(&self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        self.remove();
    }
}

/// A missed reminder that could not be recorded is not shown (it could be
/// shown twice) and the look is not recorded: the next look's notice has it.
#[test]
fn a_missed_reminder_that_could_not_be_recorded_is_in_the_next_notice() {
    let engine = engine_with(&[
        event("standup", at("2026-10-20T09:00:00Z"), Some(15)),
        event("call", at("2026-10-20T09:00:00Z"), Some(20)),
    ]);
    assert!(look(&engine, &a(), at("2026-10-20T08:30:00Z"), &Madrid).missed.is_none());
    engine
        .db
        .lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER refuse_standup BEFORE INSERT ON calendar_reminders_fired
             WHEN NEW.event_id LIKE 'standup@%' BEGIN SELECT RAISE(FAIL, 'disk full'); END;",
        )
        .unwrap();
    let woke = at("2026-10-20T10:30:00Z");
    assert_eq!(missed(&look(&engine, &a(), woke, &Madrid)), ["call"]);
    engine.db.lock().unwrap().execute_batch("DROP TRIGGER refuse_standup").unwrap();
    assert_eq!(missed(&look(&engine, &a(), woke + 60, &Madrid)), ["standup"]);
    assert_eq!(look(&engine, &a(), woke + 120, &Madrid), Look::default(), "each once");
}

/// The phone shows no notice of missed reminders yet: its look leaves them
/// unrecorded, as before #225, and gives what is still on as always.
#[test]
fn the_phones_look_leaves_missed_reminders_as_before() {
    let engine = engine_with(&[
        event("over", at("2026-10-20T08:45:00Z"), Some(15)).with_end(at("2026-10-20T09:00:00Z")),
        event("review", at("2026-10-20T09:00:00Z"), Some(15)),
    ]);
    assert!(take_due(&engine, &a(), at("2026-10-20T08:00:00Z")).is_empty());
    let due = take_due(&engine, &a(), at("2026-10-20T09:10:00Z"));
    assert_eq!(due.iter().map(|d| d["event"].as_str().unwrap()).collect::<Vec<_>>(), ["review"]);
    let recorded: i64 = engine
        .db
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM calendar_reminders_fired WHERE event_id LIKE 'over@%'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(recorded, 0, "not recorded as given");
}

trait WithEnd {
    fn with_end(self, end: i64) -> Self;
}
impl WithEnd for calendar::Event {
    fn with_end(self, end: i64) -> Self {
        calendar::Event { end, ..self }
    }
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
    // Rings at 08:45 too, but starts at 09:30.
    let review = event("review", at("2026-10-20T09:30:00Z"), Some(45));
    put_on(&engine, account, calendar::CalendarKind::Local, &[standup, review]);
    let accounts = vec![account.to_string()];
    assert!(look(&engine, &accounts, at("2026-10-20T08:30:00Z"), &Madrid).reminders.is_empty());
    crate::store::set_account_pref(&engine.db.lock().unwrap(), account, "paused", true).unwrap();
    assert!(look(&engine, &accounts, at("2026-10-20T08:50:00Z"), &Madrid).reminders.is_empty(), "paused");
    crate::store::set_account_pref(&engine.db.lock().unwrap(), account, "paused", false).unwrap();
    assert_eq!(
        names(&look(&engine, &accounts, at("2026-10-20T09:10:00Z"), &Madrid)),
        ["review"],
        "the standup came due while the reader asked not to hear and has started; the review has not",
    );

    // Removing the account forgets its looks with it (ADR-0011).
    crate::store::delete_account(&engine.db.lock().unwrap(), account).unwrap();
    assert_eq!(when::previous_look(&engine.db.lock().unwrap(), account).unwrap(), None);
}

/// Given before the app closed, then a reminder that came due while it was
/// closed, then a sleep and a resume, then a resync: each once.
#[test]
fn no_reminder_fires_twice_across_a_restart_followed_by_a_resume() {
    let file = TempDb::new("reminders");
    let path = file.0.clone();
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
/// is read: the accounts that can hold one are named for reading again when
/// the zone changes, and again every quarter of an hour until each of their
/// calendars was read after the change. Daylight saving is not a change.
#[test]
fn a_time_zone_change_asks_to_reread_floating_calendars_until_they_are_read() {
    let engine = engine_with(&[]);
    put_on(&engine, "c", calendar::CalendarKind::CalDav, &[]);
    put_on(&engine, "s", calendar::CalendarKind::Subscribed, &[]);
    let accounts = vec!["a".to_string(), "c".to_string(), "s".to_string()];
    let summer = at("2026-10-20T10:00:00Z");
    assert!(look(&engine, &accounts, summer, &Madrid).reread.is_empty(), "no previous look");
    let winter = at("2026-10-26T10:00:00Z");
    assert!(look(&engine, &accounts, winter, &Madrid).reread.is_empty(), "the clocks went back: same zone");

    let changed = winter + 60;
    let first = look(&engine, &accounts, changed, &Tokyo);
    assert_eq!(rereads(&first), ["c", "s"]);
    assert_eq!((first.reread[0].from, first.reread[0].to), (changed - 86_400 * 31, changed + 86_400 * 366));
    assert!(look(&engine, &accounts, changed + 60, &Tokyo).reread.is_empty(), "not again while it may still run");
    // Fifteen minutes on, neither was read: both are asked for again, the
    // same window, so a read still running is not started twice.
    let retry = changed + when::REREAD_RETRY;
    let again = look(&engine, &accounts, retry, &Tokyo);
    assert_eq!(rereads(&again), ["c", "s"]);
    assert_eq!(again.reread, first.reread);
    // "c" was read after the change; "s" only before it.
    {
        let db = engine.db.lock().unwrap();
        calendar::mark_calendar_synced(&db, "c", "local:home", changed + 30).unwrap();
        calendar::mark_calendar_synced(&db, "s", "local:home", changed - 30).unwrap();
    }
    assert_eq!(rereads(&look(&engine, &accounts, retry + when::REREAD_RETRY, &Tokyo)), ["s"]);
    calendar::mark_calendar_synced(&engine.db.lock().unwrap(), "s", "local:home", retry).unwrap();
    assert!(look(&engine, &accounts, retry + 2 * when::REREAD_RETRY, &Tokyo).reread.is_empty(), "done");
    assert!(look(&engine, &accounts, retry + 9 * when::REREAD_RETRY, &Tokyo).reread.is_empty(), "and forgotten");
}

#[test]
fn a_muted_account_reads_again_and_a_paused_one_keeps_its_zone_change_until_resumed() {
    let engine = Arc::new(Engine::new(Box::new(MemoryHost)).unwrap());
    let account = crate::archive::ACCOUNT;
    crate::archive::ensure_account(&engine.db.lock().unwrap(), NOW).unwrap();
    put_on(&engine, account, calendar::CalendarKind::Subscribed, &[]);
    let accounts = vec![account.to_string()];
    let set = |pref: &str, on: bool| {
        crate::store::set_account_pref(&engine.db.lock().unwrap(), account, pref, on).unwrap();
    };
    let start = at("2026-10-20T10:00:00Z");
    assert!(look(&engine, &accounts, start, &Madrid).reread.is_empty());

    set("muted", true);
    assert_eq!(rereads(&look(&engine, &accounts, start + 60, &Tokyo)), [account], "muted: still read again");
    set("muted", false);

    let back = start + 120;
    assert_eq!(rereads(&look(&engine, &accounts, back, &Madrid)), [account], "back home: another change");
    set("paused", true);
    // Paused: nothing is read, but the change is kept.
    assert!(look(&engine, &accounts, back + 3_600, &Los_Angeles).reread.is_empty());
    assert!(look(&engine, &accounts, back + 7_200, &Los_Angeles).reread.is_empty());
    set("paused", false);
    assert_eq!(rereads(&look(&engine, &accounts, back + 7_260, &Los_Angeles)), [account], "on resuming");
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
    assert_eq!(rereads(&moved), ["c"]);
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

// ---- When the store fails (#209 review) -----------------------------------------

/// The store cannot answer what is due: the look is not recorded, so the
/// gap is not used up and the next look gives what came due in it.
#[test]
fn a_look_the_store_could_not_answer_is_not_recorded() {
    let engine = engine_with(&[event("standup", at("2026-10-20T09:00:00Z"), Some(15))]);
    let asleep = at("2026-10-20T08:30:00Z");
    assert!(look(&engine, &a(), asleep, &Madrid).reminders.is_empty());
    let rename = |from: &str, to: &str| {
        engine.db.lock().unwrap().execute_batch(&format!("ALTER TABLE {from} RENAME TO {to}")).unwrap();
    };
    rename("calendar_reminders_fired", "fired_aside");
    let woke = at("2026-10-20T09:10:00Z");
    assert!(look(&engine, &a(), woke, &Madrid).reminders.is_empty(), "the store failed");
    assert_eq!(when::previous_look(&engine.db.lock().unwrap(), "a").unwrap().map(|p| p.at), Some(asleep));
    rename("fired_aside", "calendar_reminders_fired");
    assert_eq!(names(&look(&engine, &a(), woke + 60, &Madrid)), ["standup"], "given at the next look");
}

/// A reminder that could not be recorded as given is not given (it could be
/// given twice), and the look is not recorded, so the next one gives it.
#[test]
fn a_reminder_that_could_not_be_recorded_is_given_at_the_next_look() {
    let engine = engine_with(&[
        event("standup", at("2026-10-20T09:00:00Z"), Some(15)),
        event("call", at("2026-10-20T09:00:00Z"), Some(20)),
    ]);
    let asleep = at("2026-10-20T08:30:00Z");
    assert!(look(&engine, &a(), asleep, &Madrid).reminders.is_empty());
    engine
        .db
        .lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER refuse_standup BEFORE INSERT ON calendar_reminders_fired
             WHEN NEW.event_id LIKE 'standup@%' BEGIN SELECT RAISE(FAIL, 'disk full'); END;",
        )
        .unwrap();
    let woke = at("2026-10-20T09:10:00Z");
    assert_eq!(names(&look(&engine, &a(), woke, &Madrid)), ["call"], "the one recorded is given");
    engine.db.lock().unwrap().execute_batch("DROP TRIGGER refuse_standup").unwrap();
    assert_eq!(names(&look(&engine, &a(), woke + 60, &Madrid)), ["standup"], "and the other at the next look");
    assert!(look(&engine, &a(), woke + 120, &Madrid).reminders.is_empty(), "each once");
}

// ---- "At the start" reminders (#209 review) -------------------------------------

/// A reminder set for the start used to be never given: the event had to be
/// still ahead when its time came, and its time is the start. It is given at
/// the first look from its start, while the event is on.
#[test]
fn an_at_the_start_reminder_is_given_when_its_event_starts() {
    let start = at("2026-10-20T09:00:00Z");
    let engine = engine_with(&[event("standup", start, Some(0))]);
    assert!(look(&engine, &a(), start - 30, &Madrid).reminders.is_empty());
    let given = look(&engine, &a(), start + 30, &Madrid);
    assert_eq!(names(&given), ["standup"]);
    assert_eq!(given.reminders[0]["started"], true);
    assert!(look(&engine, &a(), start + 90, &Madrid).reminders.is_empty(), "once");
}

#[test]
fn an_all_day_at_the_start_reminder_rings_at_the_local_midnight() {
    let engine = engine_with(&[all_day("holiday", "2026-10-21", 0)]);
    let midnight = at("2026-10-21T00:00:00+02:00");
    assert!(look(&engine, &a(), midnight - 60, &Madrid).reminders.is_empty());
    assert_eq!(names(&look(&engine, &a(), midnight + 20, &Madrid)), ["holiday"]);
}

/// An event with no length counts as on for the minute it starts, so its
/// "at the start" reminder is given by the look in that minute; one that
/// comes later has missed it, and says so in the missed notice (#225).
#[test]
fn a_zero_length_events_at_the_start_reminder_is_given_in_its_first_minute() {
    let start = at("2026-10-20T09:00:00Z");
    let deadline = calendar::Event { end: start, ..event("deadline", start, Some(0)) };
    let engine = engine_with(&[deadline.clone()]);
    assert!(look(&engine, &a(), start - 30, &Madrid).reminders.is_empty());
    assert_eq!(names(&look(&engine, &a(), start + 59, &Madrid)), ["deadline"]);

    let late = engine_with(&[deadline]);
    assert!(look(&late, &a(), start - 30, &Madrid).reminders.is_empty());
    let after = look(&late, &a(), start + 60, &Madrid);
    assert!(after.reminders.is_empty(), "its minute is over");
    assert_eq!(missed(&after), ["deadline"]);
}

// ---- What a reminder says (#209 review) -----------------------------------------

#[test]
fn a_reminder_detail_says_when_on_the_readers_clock() {
    let now = at("2026-10-20T08:45:00+02:00");
    let meeting = event("meeting", at("2026-10-20T09:00:00+02:00"), Some(15));
    let detail = reminder_detail("a", &meeting, &Madrid, now);
    assert_eq!(detail["local_time"], "09:00");
    assert_eq!(detail["started"], false);
    assert_eq!(detail["local_date"], Value::Null, "today");

    // Given late, after a sleep: it started.
    let late = reminder_detail("a", &meeting, &Madrid, now + 30 * 60);
    assert_eq!(late["started"], true);
    // In Tokyo the same instant is 16:00, still that day; in Los Angeles it is
    // 00:00 on the 20th while the reader's clock says the 19th.
    assert_eq!(reminder_detail("a", &meeting, &Tokyo, now)["local_time"], "16:00");
    let la = reminder_detail("a", &meeting, &Los_Angeles, at("2026-10-19T23:45:00-07:00"));
    assert_eq!((la["local_time"].clone(), la["local_date"].clone()), (json!("00:00"), json!("2026-10-20")));

    // An all-day event has no time; its date is the stored one.
    let holiday = all_day("holiday", "2026-10-21", 15);
    let detail = reminder_detail("a", &holiday, &Madrid, at("2026-10-20T23:45:00+02:00"));
    assert_eq!(detail["local_time"], Value::Null);
    assert_eq!(detail["local_date"], "2026-10-21");
    assert_eq!(detail["started"], false);
    let on_the_day = reminder_detail("a", &holiday, &Madrid, at("2026-10-21T00:10:00+02:00"));
    assert_eq!((on_the_day["started"].clone(), on_the_day["local_date"].clone()), (json!(true), Value::Null));
}
