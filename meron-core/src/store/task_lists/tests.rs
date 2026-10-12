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
