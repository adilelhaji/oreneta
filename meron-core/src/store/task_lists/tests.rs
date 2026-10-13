use super::*;

fn conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::store::db::run_migrations(&conn).unwrap();
    conn
}

fn fields(list: &str, title: &str) -> TaskFields {
    TaskFields { list_id: list.into(), title: title.into(), priority: 1, ..Default::default() }
}

#[test]
fn linked_tasks_start_in_the_mail_list_and_keep_one_open_per_conversation() {
    let conn = conn();
    let id = crate::store::save_task(&conn, "acct", "t-1", "INBOX", None, "note", 1).unwrap();
    let (task, _, linked) = get(&conn, id).unwrap().unwrap();
    assert_eq!((task.list_id.as_str(), linked), (MAIL_LIST, true));
    let again = crate::store::save_task(&conn, "acct", "t-1", "INBOX", None, "edited", 2).unwrap();
    assert_eq!(again, id, "still one open task on the conversation");
}

#[test]
fn standalone_tasks_are_not_held_to_the_one_per_conversation_rule() {
    let conn = conn();
    let a = create(&conn, &fields(MAIL_LIST, "Buy stamps"), 1).unwrap();
    let b = create(&conn, &fields(MAIL_LIST, "Call the bank"), 1).unwrap();
    assert_ne!(a, b);
    assert!(create(&conn, &fields(MAIL_LIST, "  "), 1).is_err(), "a title is required");
}

#[test]
fn lists_are_created_renamed_and_deleted_with_their_tasks_but_the_mail_list_stays() {
    let conn = conn();
    let home = create_list(&conn, "Home", 1).unwrap();
    create(&conn, &fields(&home, "Paint the door"), 1).unwrap();
    rename_list(&conn, &home, "House").unwrap();
    let all = lists(&conn).unwrap();
    assert_eq!(all.iter().map(|l| (l.name.as_str(), l.open)).collect::<Vec<_>>(), vec![("", 0), ("House", 1)]);
    delete_list(&conn, &home).unwrap();
    assert_eq!(lists(&conn).unwrap().len(), 1);
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0, "its tasks went with it");
    assert!(delete_list(&conn, MAIL_LIST).is_err());
    assert!(create(&conn, &fields(&home, "Orphan"), 1).is_err(), "a deleted list takes no tasks");
}

#[test]
fn an_edit_from_an_older_revision_writes_nothing() {
    let conn = conn();
    let id = create(&conn, &fields(MAIL_LIST, "Draft report"), 1).unwrap();
    assert_eq!(update(&conn, id, 1, &fields(MAIL_LIST, "Draft the report")).unwrap(), Edit::Saved { revision: 2 });
    match update(&conn, id, 1, &fields(MAIL_LIST, "Other window")).unwrap() {
        Edit::Conflict { current: Some(current), revision } => {
            assert_eq!((current.title.as_str(), revision), ("Draft the report", 2));
        }
        other => panic!("{other:?}"),
    }
    conn.execute("DELETE FROM tasks WHERE id = ?1", [id]).unwrap();
    assert!(matches!(update(&conn, id, 2, &fields(MAIL_LIST, "x")).unwrap(), Edit::Conflict { current: None, .. }));
}

#[test]
fn a_reminder_rings_once_and_again_only_when_moved() {
    let conn = conn();
    let mut task = fields(MAIL_LIST, "Renew passport");
    task.reminder_at = Some(100);
    let id = create(&conn, &task, 1).unwrap();
    assert!(due_reminders(&conn, 99).unwrap().is_empty());
    let due = due_reminders(&conn, 100).unwrap();
    assert_eq!(due, vec![(id, "Renew passport".to_string(), None)]);
    mark_reminded(&conn, id, 100).unwrap();
    assert!(due_reminders(&conn, 200).unwrap().is_empty(), "once");
    // Saving with the same reminder does not ring again; moving it does.
    update(&conn, id, 1, &task).unwrap();
    assert!(due_reminders(&conn, 200).unwrap().is_empty());
    task.reminder_at = Some(150);
    update(&conn, id, 2, &task).unwrap();
    assert_eq!(due_reminders(&conn, 200).unwrap().len(), 1);
    // A finished task does not ring.
    crate::store::set_task_completed(&conn, id, true, 160).unwrap();
    assert!(due_reminders(&conn, 200).unwrap().is_empty());
}

#[test]
fn upgrading_keeps_every_linked_task_and_its_fields() {
    let conn = Connection::open_in_memory().unwrap();
    crate::store::db::run_migrations(&conn).unwrap();
    crate::store::save_task(&conn, "acct", "t-1", "INBOX", Some(42), "keep me", 1).unwrap();
    // Run the migration again from before it, as an upgrade would.
    conn.execute_batch("PRAGMA user_version = 38;").unwrap();
    crate::store::db::run_migrations(&conn).unwrap();
    let tasks = crate::store::list_tasks(&conn, true).unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!((tasks[0].note.as_str(), tasks[0].due_at), ("keep me", Some(42)));
}

// ---- Repeating tasks (ADR-0053) ---------------------------------------------------

fn local(y: i32, m: u32, d: u32, h: u32) -> i64 {
    use chrono::TimeZone as _;
    chrono::Local
        .from_local_datetime(&chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, 0, 0).unwrap())
        .earliest()
        .unwrap()
        .timestamp()
}

fn repeating(rule: Recurrence, due: i64) -> TaskFields {
    TaskFields {
        list_id: MAIL_LIST.into(),
        title: "Water the plants".into(),
        priority: 2,
        note: "the ferns too".into(),
        due_at: Some(due),
        reminder_at: Some(due - 3600),
        recurrence: Some(rule),
    }
}

fn weekly() -> Recurrence {
    Recurrence { freq: crate::calendar::Frequency::Weekly, interval: 1, ..Default::default() }
}

#[test]
fn a_repeating_task_needs_a_due_date_and_no_conversation() {
    let conn = conn();
    let mut fields = repeating(weekly(), local(2026, 10, 13, 9));
    fields.due_at = None;
    assert!(create(&conn, &fields, 1).unwrap_err().to_string().contains("due date"));
    let linked = crate::store::save_task(&conn, "acct", "t-1", "INBOX", None, "note", 1).unwrap();
    let (mut current, revision, _) = get(&conn, linked).unwrap().unwrap();
    current.due_at = Some(local(2026, 10, 13, 9));
    current.recurrence = Some(weekly());
    assert!(update(&conn, linked, revision, &current).is_err());
}

#[test]
fn the_rule_is_stored_spelled_out_and_read_back() {
    let conn = conn();
    let id = create(&conn, &repeating(weekly(), local(2026, 10, 13, 9)), 1).unwrap();
    let rrule: String = conn.query_row("SELECT rrule FROM tasks WHERE id = ?1", [id], |r| r.get(0)).unwrap();
    assert_eq!(rrule, "FREQ=WEEKLY;BYDAY=TU");
    let (fields, ..) = get(&conn, id).unwrap().unwrap();
    assert_eq!(fields.recurrence.unwrap().weekdays, vec![1]);
}

#[test]
fn completing_an_occurrence_keeps_a_record_and_moves_the_task_and_its_reminder_on() {
    let conn = conn();
    let due = local(2026, 10, 13, 9);
    let id = create(&conn, &repeating(weekly(), due), 1).unwrap();
    mark_reminded(&conn, id, due - 3600).unwrap();

    let done = set_completed(&conn, id, true, false, due + 60).unwrap();
    let next = local(2026, 10, 20, 9);
    assert_eq!(done.next_due, Some(next), "same time, a week on");
    let record = done.record.unwrap();

    let all = crate::store::list_tasks(&conn, true).unwrap();
    let task = all.iter().find(|t| t.id == id).unwrap();
    assert_eq!((task.due_at, task.reminder_at, task.completed_at), (Some(next), Some(next - 3600), None));
    assert_eq!(task.rrule, "FREQ=WEEKLY;BYDAY=TU", "the series goes on");
    let copy = all.iter().find(|t| t.id == record).unwrap();
    assert_eq!((copy.title.as_str(), copy.note.as_str(), copy.priority), ("Water the plants", "the ferns too", 2));
    assert_eq!((copy.due_at, copy.completed_at, copy.rrule.as_str()), (Some(due), Some(due + 60), ""));

    // The moved reminder rings again when its time comes; the record's never does.
    assert!(due_reminders(&conn, next - 3600 + 1).unwrap().iter().map(|r| r.0).eq([id]));
    // Reopening the record is reopening a plain task: the series is untouched.
    set_completed(&conn, record, false, false, due + 120).unwrap();
    assert_eq!(get(&conn, id).unwrap().unwrap().0.due_at, Some(next));
}

#[test]
fn the_last_occurrence_completes_the_task_and_stop_repeating_ends_the_rule() {
    let conn = conn();
    let rule = Recurrence { count: Some(2), ..weekly() };
    let id = create(&conn, &repeating(rule, local(2026, 10, 13, 9)), 1).unwrap();
    assert!(set_completed(&conn, id, true, false, 10).unwrap().next_due.is_some());
    let rrule: String = conn.query_row("SELECT rrule FROM tasks WHERE id = ?1", [id], |r| r.get(0)).unwrap();
    assert_eq!(rrule, "FREQ=WEEKLY;BYDAY=TU;COUNT=1", "one left");
    assert_eq!(set_completed(&conn, id, true, false, 20).unwrap().next_due, None);
    assert!(crate::store::list_tasks(&conn, false).unwrap().is_empty(), "the series is done");

    let other = create(&conn, &repeating(weekly(), local(2026, 10, 13, 9)), 1).unwrap();
    set_completed(&conn, other, true, true, 30).unwrap();
    let (fields, ..) = get(&conn, other).unwrap().unwrap();
    assert_eq!(fields.recurrence, None);
    assert_eq!(crate::store::list_tasks(&conn, true).unwrap().len(), 3, "no record for stopping");
    set_completed(&conn, other, false, false, 40).unwrap();
    assert!(set_completed(&conn, other, true, false, 50).unwrap().record.is_none(), "reopened, it no longer repeats");
}

#[test]
fn a_task_on_the_31st_comes_back_on_the_31st_after_a_short_month() {
    let conn = conn();
    let monthly = Recurrence { freq: crate::calendar::Frequency::Monthly, interval: 1, ..Default::default() };
    let id = create(&conn, &repeating(monthly, local(2027, 1, 31, 0)), 1).unwrap();
    assert_eq!(set_completed(&conn, id, true, false, 1).unwrap().next_due, Some(local(2027, 2, 28, 0)));
    assert_eq!(set_completed(&conn, id, true, false, 2).unwrap().next_due, Some(local(2027, 3, 31, 0)));

    // A due date changed by hand is the new anchor.
    let (mut fields, revision, _) = get(&conn, id).unwrap().unwrap();
    fields.due_at = Some(local(2027, 4, 15, 0));
    update(&conn, id, revision, &fields).unwrap();
    assert_eq!(set_completed(&conn, id, true, false, 3).unwrap().next_due, Some(local(2027, 5, 15, 0)));
}
