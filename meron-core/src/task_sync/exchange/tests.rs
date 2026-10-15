//! Task lists in an Exchange account's Tasks folder (ADR-0058), on recorded
//! SOAP.

use super::*;
use crate::exchange::book::tests::{found, got};
use crate::exchange::tasks::tests::task_xml;
use crate::exchange::tests::scripted::{client, error_response, ok, serve, Step};
use crate::store::task_lists::{self, TaskFields};

const ACCOUNT: &str = "work@example.org";

fn db() -> (Mutex<Connection>, String) {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    let list = add_list(&conn, ACCOUNT, "Feina", 1).unwrap();
    (Mutex::new(conn), list)
}

/// A folder listing and the tasks in it, as one full read answers.
fn read(tasks: &[(&str, String)]) -> Vec<Step> {
    let ids: Vec<(&str, &str)> = tasks.iter().map(|(id, _)| ("Task", *id)).collect();
    let mut steps = vec![Step::Reply(found(&ids, true))];
    if !tasks.is_empty() {
        steps.push(Step::Reply(got(&tasks.iter().map(|(_, xml)| xml.clone()).collect::<Vec<_>>())));
    }
    steps
}

fn plain(id: &str, change_key: &str, subject: &str) -> String {
    task_xml(id, change_key, subject, "<t:Importance>Normal</t:Importance><t:ReminderIsSet>false</t:ReminderIsSet><t:Status>NotStarted</t:Status>")
}

fn updated(id: &str, change_key: &str) -> Step {
    Step::Reply(ok("UpdateItem", &format!(r#"<m:Items><t:Task><t:ItemId Id="{id}" ChangeKey="{change_key}"/></t:Task></m:Items>"#)))
}

/// `(title, remote id, change key, pending, conflict)` of every task.
fn rows(db: &Mutex<Connection>) -> Vec<(String, String, String, String, String)> {
    let conn = db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT title, remote_href, remote_etag, pending, conflict FROM tasks WHERE list_id <> 'mail' ORDER BY id")
        .unwrap();
    stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn first_id(db: &Mutex<Connection>) -> i64 {
    db.lock().unwrap().query_row("SELECT id FROM tasks WHERE list_id <> 'mail' ORDER BY id LIMIT 1", [], |row| row.get(0)).unwrap()
}

/// A list holding T1 ("Informe"), read from the server at `ck1`.
fn synced() -> (Mutex<Connection>, String) {
    let (db, list) = db();
    let (url, server) = serve(read(&[("T1", plain("T1", "ck1", "Informe"))]));
    sync(&db, &client(url), &list, 10).expect("first read");
    server.join().expect("server");
    (db, list)
}

fn edit_title(db: &Mutex<Connection>, title: &str) {
    let conn = db.lock().unwrap();
    let id: i64 = conn.query_row("SELECT id FROM tasks WHERE remote_href = 'T1'", [], |row| row.get(0)).unwrap();
    let (fields, revision, _) = task_lists::get(&conn, id).unwrap().unwrap();
    let edited = TaskFields { title: title.to_string(), ..fields };
    assert!(matches!(task_lists::update(&conn, id, revision, &edited).unwrap(), task_lists::Edit::Saved { .. }));
}

#[test]
fn ews_task_read_brings_the_folder_into_the_list() {
    let (db, list) = db();
    let repeating = task_xml(
        "T3",
        "ck3",
        "Setmanal",
        "<t:DueDate>2026-10-13T00:00:00Z</t:DueDate><t:Recurrence><t:WeeklyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Tuesday</t:DaysOfWeek></t:WeeklyRecurrence><t:NoEndRecurrence><t:StartDate>2026-10-13</t:StartDate></t:NoEndRecurrence></t:Recurrence>",
    );
    let regenerating = task_xml(
        "T4",
        "ck4",
        "Regar",
        "<t:DueDate>2026-10-13T00:00:00Z</t:DueDate><t:Recurrence><t:DailyRegeneration><t:Interval>3</t:Interval></t:DailyRegeneration><t:NoEndRecurrence><t:StartDate>2026-10-13</t:StartDate></t:NoEndRecurrence></t:Recurrence>",
    );
    let (url, server) = serve(read(&[
        ("T1", plain("T1", "ck1", "Informe")),
        ("T3", repeating),
        ("T4", regenerating),
    ]));
    let report = sync(&db, &client(url), &list, 10).expect("read");
    assert_eq!(report.pulled, 3);
    let requests = server.join().expect("server");
    assert!(requests[0].contains(r#"<t:DistinguishedFolderId Id="tasks"/>"#), "{}", requests[0]);
    assert!(requests[1].contains("PropertyName=\"OrenetaTaskUid\"") && requests[1].contains("<t:BodyType>Text</t:BodyType>"));
    let conn = db.lock().unwrap();
    let rules: Vec<(String, String, bool)> = conn
        .prepare("SELECT title, rrule, recurring FROM tasks WHERE list_id = ?1 ORDER BY id")
        .unwrap()
        .query_map(params![list], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        rules,
        [
            ("Informe".to_string(), String::new(), false),
            ("Setmanal".to_string(), "FREQ=WEEKLY;BYDAY=TU".to_string(), false),
            ("Regar".to_string(), String::new(), true),
        ]
    );
    let lists = task_lists::lists(&conn).unwrap();
    let bound = lists.iter().find(|l| l.id == list).unwrap();
    assert_eq!((bound.ews_account.as_str(), bound.synced_at, bound.last_error.as_str()), (ACCOUNT, Some(10), ""));
    // The regenerating one is read only here; the others can be edited.
    let regar: i64 = conn.query_row("SELECT id FROM tasks WHERE remote_href = 'T4'", [], |row| row.get(0)).unwrap();
    assert!(task_lists::check_editable(&conn, regar).is_err());
}

#[test]
fn ews_task_edit_success_sends_only_the_change_against_the_version_read() {
    let (db, list) = synced();
    edit_title(&db, "Informe final");
    let mut steps = vec![updated("T1", "ck2"), Step::Reply(got(&[plain("T1", "ck2", "Informe final")]))];
    steps.extend(read(&[("T1", plain("T1", "ck2", "Informe final"))]));
    let (url, server) = serve(steps);
    let report = sync(&db, &client(url), &list, 20).expect("sync");
    assert_eq!((report.pushed, report.pulled, report.conflicts), (1, 0, 0));
    let requests = server.join().expect("server");
    let update = &requests[0];
    assert!(update.contains(r#"<t:ItemId Id="T1" ChangeKey="ck1"/>"#) && update.contains("NeverOverwrite"), "{update}");
    assert_eq!(update.matches("<t:SetItemField>").count(), 1, "the title alone: {update}");
    assert_eq!(rows(&db), [("Informe final".into(), "T1".into(), "ck2".into(), String::new(), String::new())]);
}

#[test]
fn ews_task_stale_local_edit_never_overwrites_a_server_change() {
    let (db, list) = synced();
    edit_title(&db, "Meu");
    // Changed in Outlook since: the server refuses the write.
    let mut steps = vec![Step::Reply(error_response("UpdateItem", "ErrorIrresolvableConflict", "The change conflicts."))];
    steps.extend(read(&[("T1", plain("T1", "ck9", "D'Outlook"))]));
    let (url, server) = serve(steps);
    let report = sync(&db, &client(url), &list, 20).expect("sync");
    assert!(report.stopped && report.conflicts >= 1, "{report:?}");
    server.join().expect("server");
    assert_eq!(rows(&db), [("Meu".into(), "T1".into(), "ck1".into(), "put".into(), "changed".into())], "neither copy is lost");

    // Choosing the server's copy takes it.
    let id = first_id(&db);
    let (url, server) = serve(vec![Step::Reply(got(&[plain("T1", "ck9", "D'Outlook")]))]);
    resolve_conflict(&db, &client(url), id, Keep::Server, 30).unwrap();
    server.join().expect("server");
    assert_eq!(rows(&db), [("D'Outlook".into(), "T1".into(), "ck9".into(), String::new(), String::new())]);
}

#[test]
fn ews_task_keeping_mine_writes_it_over_the_version_there_now() {
    let (db, list) = synced();
    edit_title(&db, "Meu");
    let mut steps = vec![Step::Reply(error_response("UpdateItem", "ErrorIrresolvableConflict", "conflict"))];
    steps.extend(read(&[("T1", plain("T1", "ck9", "D'Outlook"))]));
    let (url, server) = serve(steps);
    sync(&db, &client(url), &list, 20).unwrap();
    server.join().unwrap();
    let id = first_id(&db);
    let mut steps = vec![Step::Reply(got(&[plain("T1", "ck9", "D'Outlook")]))];
    steps.extend([updated("T1", "ck10"), Step::Reply(got(&[plain("T1", "ck10", "Meu")]))]);
    steps.extend(read(&[("T1", plain("T1", "ck10", "Meu"))]));
    let (url, server) = serve(steps);
    let client = client(url);
    resolve_conflict(&db, &client, id, Keep::Mine, 30).unwrap();
    sync(&db, &client, &list, 40).unwrap();
    let requests = server.join().unwrap();
    assert!(requests[1].contains(r#"ChangeKey="ck9""#) && requests[1].contains("<t:Subject>Meu</t:Subject>"), "{}", requests[1]);
    assert_eq!(rows(&db), [("Meu".into(), "T1".into(), "ck10".into(), String::new(), String::new())]);
}

#[test]
fn ews_task_changed_on_both_sides_waits_for_the_person() {
    let (db, list) = synced();
    edit_title(&db, "Meu");
    // A conflict elsewhere in the list holds the queue, so the read sees
    // T1 changed on the server while it is pending here.
    db.lock().unwrap().execute(
        "INSERT INTO tasks(account, thread_key, folder, note, created_at, list_id, title, conflict)
         VALUES('', '', '', '', 1, ?1, 'Other', 'changed')",
        params![list],
    ).unwrap();
    let (url, server) = serve(read(&[("T1", plain("T1", "ck5", "D'Outlook"))]));
    let report = sync(&db, &client(url), &list, 20).unwrap();
    assert!(report.stopped);
    assert_eq!(server.join().unwrap().iter().filter(|r| r.contains("UpdateItem")).count(), 0, "nothing sent while a conflict waits");
    assert_eq!(rows(&db)[0], ("Meu".into(), "T1".into(), "ck1".into(), "put".into(), "changed".into()));
}

#[test]
fn ews_task_error_stops_the_sync_and_keeps_the_change() {
    let (db, list) = synced();
    edit_title(&db, "Meu");
    let (url, server) = serve(vec![Step::Reply(error_response("UpdateItem", "ErrorAccessDenied", "Access is denied."))]);
    let error = sync(&db, &client(url), &list, 20).expect_err("refused");
    assert!(format!("{error:#}").contains("ErrorAccessDenied"));
    server.join().unwrap();
    assert_eq!(rows(&db), [("Meu".into(), "T1".into(), "ck1".into(), "put".into(), String::new())]);
    let last = task_lists::lists(&db.lock().unwrap()).unwrap().into_iter().find(|l| l.id == list).unwrap().last_error;
    assert!(last.contains("ErrorAccessDenied"), "{last}");
}

#[test]
fn ews_task_creation_with_a_lost_answer_is_found_again_and_never_made_twice() {
    let (db, list) = db();
    task_lists::create(&db.lock().unwrap(), &TaskFields { list_id: list.clone(), title: "Nova".into(), priority: 1, ..Default::default() }, 5)
        .unwrap();
    let (url, server) = serve(vec![Step::Drop]);
    sync(&db, &client(url), &list, 10).expect_err("no answer");
    let create = server.join().unwrap().remove(0);
    let marker = rows(&db)[0].1.clone();
    let uid = marker.strip_prefix("new:").expect("our id is kept before sending");
    assert!(create.contains(&format!("<t:Value>{uid}</t:Value>")), "{create}");

    // The server made it all the same. The next attempt finds it by our id.
    let made = task_xml(
        "T7",
        "ck7",
        "Nova",
        &format!(
            r#"<t:ExtendedProperty><t:ExtendedFieldURI DistinguishedPropertySetId="PublicStrings" PropertyName="OrenetaTaskUid" PropertyType="String"/><t:Value>{uid}</t:Value></t:ExtendedProperty><t:Status>NotStarted</t:Status>"#
        ),
    );
    let mut steps = vec![
        Step::Reply(found(&[("Task", "T7")], true)),
        Step::Reply(got(&[made.clone()])),
        Step::Reply(got(&[made.clone()])),
    ];
    steps.extend(read(&[("T7", made)]));
    let (url, server) = serve(steps);
    sync(&db, &client(url), &list, 20).expect("second attempt");
    let requests = server.join().unwrap();
    assert!(requests[0].contains("<m:Restriction>") && requests[0].contains(uid), "{}", requests[0]);
    assert!(!requests.iter().any(|r| r.contains("<m:CreateItem")), "never made twice");
    assert_eq!(rows(&db), [("Nova".into(), "T7".into(), "ck7".into(), String::new(), String::new())]);
}

#[test]
fn ews_task_created_here_goes_with_its_fields() {
    let (db, list) = db();
    let due = crate::exchange::tasks::tests::local_day_midnight(2026, 10, 13);
    task_lists::create(
        &db.lock().unwrap(),
        &TaskFields {
            list_id: list.clone(),
            title: "Setmanal".into(),
            note: "Notes".into(),
            priority: 2,
            due_at: Some(due),
            recurrence: Some(crate::calendar::Recurrence { freq: crate::calendar::Frequency::Weekly, interval: 1, ..Default::default() }),
            ..Default::default()
        },
        5,
    )
    .unwrap();
    let made = plain("T8", "ck8", "Setmanal");
    let mut steps = vec![
        Step::Reply(ok("CreateItem", r#"<m:Items><t:Task><t:ItemId Id="T8" ChangeKey="ck8"/></t:Task></m:Items>"#)),
        Step::Reply(got(&[made.clone()])),
    ];
    steps.extend(read(&[("T8", made)]));
    let (url, server) = serve(steps);
    sync(&db, &client(url), &list, 10).expect("sync");
    let create = server.join().unwrap().remove(0);
    for part in [
        "<t:Subject>Setmanal</t:Subject>",
        r#"<t:Body BodyType="Text">Notes</t:Body>"#,
        "<t:Importance>High</t:Importance>",
        "<t:DueDate>2026-10-13T00:00:00Z</t:DueDate>",
        "<t:DaysOfWeek>Tuesday</t:DaysOfWeek>",
        "<t:Status>NotStarted</t:Status>",
    ] {
        assert!(create.contains(part), "{part}: {create}");
    }
}

#[test]
fn ews_task_completing_an_occurrence_moves_the_series_and_keeps_a_record() {
    let (db, list) = db();
    let repeating = task_xml(
        "T3",
        "ck3",
        "Setmanal",
        "<t:DueDate>2026-10-13T00:00:00Z</t:DueDate><t:Recurrence><t:WeeklyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Tuesday</t:DaysOfWeek></t:WeeklyRecurrence><t:NumberedRecurrence><t:StartDate>2026-10-13</t:StartDate><t:NumberOfOccurrences>3</t:NumberOfOccurrences></t:NumberedRecurrence></t:Recurrence><t:Status>NotStarted</t:Status>",
    );
    let (url, server) = serve(read(&[("T3", repeating)]));
    sync(&db, &client(url), &list, 10).unwrap();
    server.join().unwrap();
    let id = first_id(&db);
    let done = task_lists::set_completed(&db.lock().unwrap(), id, true, false, 1_790_000_000).unwrap();
    assert!(done.next_due.is_some() && done.record.is_some());

    let record = plain("T9", "ck9", "Setmanal");
    let mut steps = vec![
        updated("T3", "ck4"),
        Step::Reply(got(&[plain("T3", "ck4", "Setmanal")])),
        Step::Reply(ok("CreateItem", r#"<m:Items><t:Task><t:ItemId Id="T9" ChangeKey="ck9"/></t:Task></m:Items>"#)),
        Step::Reply(got(&[record.clone()])),
    ];
    steps.extend(read(&[("T3", plain("T3", "ck4", "Setmanal")), ("T9", record)]));
    let (url, server) = serve(steps);
    sync(&db, &client(url), &list, 20).unwrap();
    let requests = server.join().unwrap();
    let master = &requests[0];
    assert!(master.contains("<t:DueDate>2026-10-20T00:00:00Z</t:DueDate>"), "{master}");
    assert!(master.contains("<t:NumberOfOccurrences>2</t:NumberOfOccurrences>") && master.contains("<t:StartDate>2026-10-20</t:StartDate>"), "{master}");
    assert!(!master.contains("<t:Status>Completed"), "the series goes on: {master}");
    let copy = &requests[2];
    assert!(copy.contains("<t:Status>Completed</t:Status>") && copy.contains("<t:DueDate>2026-10-13T00:00:00Z</t:DueDate>"), "{copy}");
    assert!(!copy.contains("<t:Recurrence>"), "the record does not repeat: {copy}");
}

#[test]
fn ews_task_deleted_here_is_deleted_there_unless_it_changed() {
    let (db, list) = synced();
    let id = first_id(&db);
    crate::store::delete_task(&db.lock().unwrap(), id).unwrap();
    assert_eq!(rows(&db)[0].3, "delete", "kept until the server has it gone");
    // Changed in Outlook since: not deleted, a conflict instead.
    let mut steps = vec![Step::Reply(got(&[plain("T1", "ck5", "Informe")]))];
    steps.extend(read(&[("T1", plain("T1", "ck5", "Informe"))]));
    let (url, server) = serve(steps);
    sync(&db, &client(url), &list, 20).unwrap();
    assert!(!server.join().unwrap().iter().any(|r| r.contains("<m:DeleteItem")));
    assert_eq!(rows(&db)[0].4, "changed");
    // Settled for mine: deleted from the version there now.
    let (url, server) = serve(vec![
        Step::Reply(got(&[plain("T1", "ck5", "Informe")])),
        Step::Reply(got(&[plain("T1", "ck5", "Informe")])),
        Step::Reply(ok("DeleteItem", "")),
        Step::Reply(found(&[], true)),
    ]);
    let client = client(url);
    resolve_conflict(&db, &client, id, Keep::Mine, 30).unwrap();
    sync(&db, &client, &list, 40).unwrap();
    assert!(server.join().unwrap()[2].contains(r#"DeleteType="MoveToDeletedItems""#));
    assert!(rows(&db).is_empty());
}

#[test]
fn ews_task_lists_of_two_accounts_stay_apart() {
    let (db, list) = synced();
    let conn = db.lock().unwrap();
    assert!(add_list(&conn, ACCOUNT, "Again", 2).unwrap_err().to_string().contains("already a list"));
    let other = add_list(&conn, "other@example.org", "", 2).unwrap();
    assert_eq!(binding(&conn, &other).unwrap().as_deref(), Some("other@example.org"));
    assert_eq!(bindings(&conn).unwrap().len(), 2);
    // A CalDAV binding never names an Exchange list, and the reverse.
    assert!(crate::task_sync::binding(&conn, &list).unwrap().is_none());
    // Moving a task out of a list kept in Exchange is refused like CalDAV's.
    let id: i64 = conn.query_row("SELECT id FROM tasks WHERE list_id = ?1", params![list], |row| row.get(0)).unwrap();
    let (fields, revision, _) = task_lists::get(&conn, id).unwrap().unwrap();
    let moved = TaskFields { list_id: other.clone(), ..fields };
    assert!(task_lists::update(&conn, id, revision, &moved).is_err());
    // The account goes, and its lists with it; the other stays.
    forget_account(&conn, ACCOUNT).unwrap();
    assert_eq!(bindings(&conn).unwrap(), [(other, "other@example.org".to_string())]);
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM tasks WHERE list_id = ?1", params![list], |row| row.get(0)).unwrap();
    assert_eq!(left, 0);
}

#[test]
fn ews_task_paging_counts_every_item_and_keeps_each_task_once() {
    let (url, server) = serve(vec![
        Step::Reply(found(&[("Task", "T1"), ("Message", "M1")], false)),
        // The first task again: the pages shifted under the read.
        Step::Reply(found(&[("Task", "T1"), ("Task", "T2")], true)),
        Step::Reply(got(&[plain("T1", "ck1", "Un"), plain("T2", "ck2", "Dos")])),
    ]);
    let tasks = client(url).read_tasks().expect("read");
    assert_eq!(tasks.iter().map(|task| task.id.as_str()).collect::<Vec<_>>(), ["T1", "T2"]);
    let requests = server.join().unwrap();
    assert!(requests[0].contains(r#"FieldURI="item:DateTimeCreated""#), "a stable order: {}", requests[0]);
    assert!(requests[1].contains(r#"Offset="2""#), "the item that is no task counts: {}", requests[1]);
    assert_eq!(requests[2].matches(r#"<t:ItemId Id="T1"/>"#).count(), 1, "{}", requests[2]);
}

#[test]
fn ews_task_change_exchange_cannot_take_is_set_aside_and_the_rest_goes_on() {
    let (db, list) = synced();
    edit_title(&db, "Informe final");
    let yearly = |interval| crate::calendar::Recurrence { freq: crate::calendar::Frequency::Yearly, interval, ..Default::default() };
    let due = crate::exchange::tasks::tests::local_day_midnight(2026, 10, 13);
    let id = task_lists::create(
        &db.lock().unwrap(),
        &TaskFields { list_id: list.clone(), title: "Biennal".into(), priority: 1, due_at: Some(due), recurrence: Some(yearly(2)), ..Default::default() },
        5,
    )
    .unwrap();
    let mut steps = vec![updated("T1", "ck2"), Step::Reply(got(&[plain("T1", "ck2", "Informe final")]))];
    steps.extend(read(&[("T1", plain("T1", "ck2", "Informe final"))]));
    let (url, server) = serve(steps);
    let report = sync(&db, &client(url), &list, 20).expect("sync");
    assert_eq!((report.pushed, report.rejected, report.stopped), (1, 1, false), "{report:?}");
    assert!(!server.join().unwrap().iter().any(|r| r.contains("<m:CreateItem")), "nothing of it was sent");
    let row = rows(&db).into_iter().find(|row| row.0 == "Biennal").unwrap();
    assert_eq!((row.1.as_str(), row.3.as_str()), ("", "put"), "kept, with nothing to look for on the server");
    assert_eq!(row.4, "rejected: Exchange cannot repeat a task every 2 years");

    // Changed to a rule Exchange takes, it goes, and the mark with it.
    {
        let conn = db.lock().unwrap();
        let (fields, revision, _) = task_lists::get(&conn, id).unwrap().unwrap();
        task_lists::update(&conn, id, revision, &TaskFields { recurrence: Some(yearly(1)), ..fields }).unwrap();
    }
    let made = plain("T5", "ck5", "Biennal");
    let mut steps = vec![
        Step::Reply(ok("CreateItem", r#"<m:Items><t:Task><t:ItemId Id="T5" ChangeKey="ck5"/></t:Task></m:Items>"#)),
        Step::Reply(got(&[made.clone()])),
    ];
    steps.extend(read(&[("T1", plain("T1", "ck2", "Informe final")), ("T5", made)]));
    let (url, server) = serve(steps);
    let report = sync(&db, &client(url), &list, 30).expect("sync");
    assert_eq!((report.pushed, report.rejected), (1, 0));
    assert!(server.join().unwrap()[0].contains("<t:AbsoluteYearlyRecurrence>"));
    let row = rows(&db).into_iter().find(|row| row.0 == "Biennal").unwrap();
    assert_eq!((row.1.as_str(), row.4.as_str()), ("T5", ""));
}

#[test]
fn ews_task_is_never_written_without_the_version_it_was_read_at() {
    // No server: nothing may reach it.
    let nowhere = client("http://127.0.0.1:1".into());
    let fields = Fields { title: "x".into(), ..Default::default() };
    assert_eq!(nowhere.update_task("T1", "", &Fields::default(), &fields, 0).unwrap(), ListWrite::Conflict);
    assert_eq!(nowhere.delete_task("T1", "").unwrap(), ListWrite::Conflict);
}
