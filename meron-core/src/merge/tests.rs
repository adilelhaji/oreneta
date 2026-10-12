use super::*;

const NOW: i64 = 1_800_000_000;

fn me() -> Sender {
    Sender { name: "Sam Example".into(), email: "sam@example.com".into() }
}

fn conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::store::run_migrations(&conn).unwrap();
    conn
}

#[test]
fn reads_a_list_or_a_table_with_its_columns() {
    let list = parse_recipients("\"Rivera, Morgan\" <morgan@example.com>\n\n  ann@example.com  \n");
    assert_eq!(list.len(), 2);
    assert_eq!((list[0].name.as_str(), list[0].email.as_str(), list[0].line), ("Rivera, Morgan", "morgan@example.com", 1));
    assert_eq!((list[1].email.as_str(), list[1].line), ("ann@example.com", 3));

    let table = parse_recipients("Email;Name;Company\nann@example.com;Ann;\"Acme; Inc\"\nbob@example.com;Bob");
    assert_eq!(table.len(), 2);
    assert_eq!(table[0].columns.get("company").map(String::as_str), Some("Acme; Inc"));
    assert_eq!(table[1].columns.get("company").map(String::as_str), Some(""));
}

#[test]
fn each_message_is_for_its_recipient_alone() {
    let preview = preview(
        "email,name,company\nann@example.com,Ann Lee,Acme\nbob@example.com,Bob Ray,Beta",
        "For {{company}}",
        "Dear {{to.firstName}},\n— {{me.firstName}}",
        &me(),
    );
    assert!(preview.ready, "{preview:?}");
    assert_eq!(preview.messages[0].to, "ann@example.com");
    assert_eq!(preview.messages[0].subject, "For Acme");
    assert_eq!(preview.messages[0].body, "Dear Ann,\n— Sam");
    // Nobody else's data in anybody's message.
    for message in &preview.messages {
        let other = if message.to.starts_with("ann") { ["bob", "Beta"] } else { ["ann", "Acme"] };
        for word in other {
            assert!(!message.body.contains(word) && !message.subject.contains(word), "{message:?}");
        }
    }
}

#[test]
fn problems_are_named_per_recipient_and_block_sending() {
    let preview = preview(
        "email,name\nann@example.com,Ann\nANN@example.com,Ann again\nnot-an-address,X\nbob@example.com,",
        "Hi {{to.firstName}}",
        "{{nickname}}",
        &me(),
    );
    assert!(!preview.ready);
    assert_eq!(preview.problems, vec!["unknown:nickname"]);
    let problems: Vec<Vec<String>> = preview.messages.iter().map(|m| m.problems.clone()).collect();
    assert_eq!(problems[0], Vec::<String>::new());
    assert_eq!(problems[1], vec!["duplicate"]);
    assert_eq!(problems[2], vec!["invalidAddress"]);
    assert_eq!(problems[3], vec!["missing:to.firstName"]);
    // What cannot be filled stays as written, for the preview to show.
    assert_eq!(preview.messages[3].subject, "Hi {{to.firstName}}");

    let empty = super::preview("", " ", "x", &me());
    assert_eq!(empty.problems, vec!["noRecipients", "noSubject"]);
    let many = (0..=MAX_RECIPIENTS).map(|i| format!("p{i}@example.com")).collect::<Vec<_>>().join("\n");
    assert!(super::preview(&many, "s", "b", &me()).problems.contains(&"tooMany".to_string()));
}

fn ready() -> Preview {
    preview("ann@example.com\nbob@example.com\ncarol@example.com", "Hello", "Body", &me())
}

#[test]
fn a_batch_is_what_was_reviewed_or_nothing() {
    let conn = conn();
    assert!(create(&conn, "b0", "acct", "sam@example.com", "Hello", &ready(), 2, 0, NOW).is_err(), "list changed");
    let broken = preview("nope", "Hello", "Body", &me());
    assert!(create(&conn, "b0", "acct", "sam@example.com", "Hello", &broken, 1, 0, NOW).is_err(), "problems");
    create(&conn, "b1", "acct", "sam@example.com", "Hello", &ready(), 3, 0, NOW).unwrap();
    let stored = batch(&conn, "b1").unwrap().unwrap();
    assert_eq!(stored.state, "sending");
    let ids: HashSet<&str> = stored.items.iter().map(|i| i.message_id.as_str()).collect();
    assert_eq!(ids.len(), 3, "one identity per message");
    assert!(stored.items[0].message_id.ends_with("@example.com>"));
}

#[test]
fn each_message_settles_on_its_own_and_a_refusal_to_wait_pauses() {
    let conn = conn();
    create(&conn, "b1", "acct", "sam@example.com", "Hello", &ready(), 3, 0, NOW).unwrap();
    let first = claim_next(&conn, "b1", NOW).unwrap().unwrap();
    assert_eq!(first.index, 0);
    settle(&conn, "b1", 0, Outcome::Accepted, NOW).unwrap();
    let second = claim_next(&conn, "b1", NOW).unwrap().unwrap();
    settle(&conn, "b1", second.index, Outcome::Deferred("451 4.7.1 slow down".into()), NOW).unwrap();
    let paused = batch(&conn, "b1").unwrap().unwrap();
    assert_eq!(paused.state, "paused");
    assert!(paused.reason.contains("451"));
    assert_eq!(paused.items[1].state, "pending", "still to send");
    assert!(claim_next(&conn, "b1", NOW).unwrap().is_none(), "nothing goes while paused");

    resume(&conn, "b1", false).unwrap();
    let again = claim_next(&conn, "b1", NOW).unwrap().unwrap();
    assert_eq!(again.index, 1);
    settle(&conn, "b1", 1, Outcome::Uncertain("connection reset".into()), NOW).unwrap();
    let third = claim_next(&conn, "b1", NOW).unwrap().unwrap();
    settle(&conn, "b1", third.index, Outcome::Rejected("550 no such user".into()), NOW).unwrap();
    assert!(claim_next(&conn, "b1", NOW).unwrap().is_none());
    let done = batch(&conn, "b1").unwrap().unwrap();
    assert_eq!(done.state, "done");
    let states: Vec<&str> = done.items.iter().map(|i| i.state.as_str()).collect();
    assert_eq!(states, vec!["accepted", "uncertain", "rejected"]);

    // Carrying on with refusals put back: the uncertain one is never.
    resume(&conn, "b1", true).unwrap();
    let retried = claim_next(&conn, "b1", NOW).unwrap().unwrap();
    assert_eq!(retried.index, 2);
    settle(&conn, "b1", 2, Outcome::Accepted, NOW).unwrap();
    assert!(claim_next(&conn, "b1", NOW).unwrap().is_none());
    assert_eq!(batch(&conn, "b1").unwrap().unwrap().items[1].state, "uncertain");
}

#[test]
fn cancelling_keeps_what_went_and_marks_the_rest() {
    let conn = conn();
    create(&conn, "b1", "acct", "sam@example.com", "Hello", &ready(), 3, 0, NOW).unwrap();
    let first = claim_next(&conn, "b1", NOW).unwrap().unwrap();
    cancel(&conn, "b1", NOW).unwrap();
    // The one on its way settles as it settles.
    settle(&conn, "b1", first.index, Outcome::Accepted, NOW).unwrap();
    assert!(claim_next(&conn, "b1", NOW).unwrap().is_none());
    let states: Vec<String> = batch(&conn, "b1").unwrap().unwrap().items.into_iter().map(|i| i.state).collect();
    assert_eq!(states, vec!["accepted", "cancelled", "cancelled"]);
    assert!(resume(&conn, "b1", false).is_err(), "a cancelled mailing does not carry on");
}

#[test]
fn a_restart_pauses_and_settles_the_message_on_its_way_from_its_attempt() {
    let conn = conn();
    create(&conn, "b1", "acct", "sam@example.com", "Hello", &ready(), 3, 0, NOW).unwrap();
    let a = claim_next(&conn, "b1", NOW).unwrap().unwrap();
    // Accepted by the server before the crash.
    crate::store::outgoing::begin_attempt(
        &conn,
        &a.message_id,
        "acct",
        crate::store::outgoing::AttemptKind::Now,
        &a.message_id,
        &serde_json::json!({ "to": a.to, "subject": a.subject }),
        NOW,
    )
    .unwrap();
    crate::store::outgoing::mark_accepted(&conn, &a.message_id, NOW).unwrap();
    assert_eq!(recover(&conn, NOW).unwrap(), vec!["b1".to_string()]);
    let after = batch(&conn, "b1").unwrap().unwrap();
    assert_eq!(after.state, "paused");
    assert_eq!(after.items[0].state, "accepted");

    // One begun and never answered is uncertain; one never begun waits again.
    resume(&conn, "b1", false).unwrap();
    let b = claim_next(&conn, "b1", NOW).unwrap().unwrap();
    crate::store::outgoing::begin_attempt(
        &conn,
        &b.message_id,
        "acct",
        crate::store::outgoing::AttemptKind::Now,
        &b.message_id,
        &serde_json::json!({ "to": b.to }),
        NOW,
    )
    .unwrap();
    crate::store::outgoing::mark_interrupted_uncertain(&conn, NOW).unwrap();
    recover(&conn, NOW).unwrap();
    resume(&conn, "b1", false).unwrap();
    let c = claim_next(&conn, "b1", NOW).unwrap().unwrap();
    recover(&conn, NOW).unwrap();
    let states: Vec<String> = batch(&conn, "b1").unwrap().unwrap().items.into_iter().map(|i| i.state).collect();
    assert_eq!(states, vec!["accepted", "uncertain", "pending"]);
    assert_eq!(c.index, 2);
}

#[test]
fn deferrals_are_told_from_refusals() {
    assert!(is_deferral("451 4.7.1 Please try again later"));
    assert!(is_deferral("421 Too many connections"));
    assert!(is_deferral("Rate limit exceeded"));
    assert!(!is_deferral("550 5.1.1 No such user"));
}

#[test]
fn account_removal_takes_its_mailings() {
    let conn = conn();
    conn.execute("INSERT INTO accounts(id, email) VALUES('acct', 'sam@example.com')", []).unwrap();
    create(&conn, "b1", "acct", "sam@example.com", "Hello", &ready(), 3, 0, NOW).unwrap();
    crate::store::delete_account(&conn, "acct").unwrap();
    assert!(batches(&conn).unwrap().is_empty());
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM merge_items", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
}
