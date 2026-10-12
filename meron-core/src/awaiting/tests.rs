use super::*;
use crate::imap::{MessageHeader, Recipient};
use crate::store::{set_account_aliases, upsert_messages, Alias};

const NOW: i64 = 1_800_000_000;

fn person(addr: &str) -> Recipient {
    Recipient { name: String::new(), addr: addr.into() }
}

fn conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::store::run_migrations(&conn).unwrap();
    conn.execute("INSERT INTO accounts(id, email) VALUES('acct', 'me@example.com')", []).unwrap();
    set_account_aliases(&conn, "acct", &[Alias { email: "Desk@Example.com".into(), name: String::new() }]).unwrap();
    // What I sent, in Sent, to Ann with Bob copied.
    upsert_messages(
        &conn,
        "acct",
        "Sent",
        &[MessageHeader {
            uid: 1,
            from_addr: "me@example.com".into(),
            to: vec![person("ann@example.com")],
            cc: vec![person("bob@example.com")],
            subject: "Quote for the roof".into(),
            message_id: "<q1@example.com>".into(),
            thread_key: "t-roof".into(),
            date: NOW - 86_400,
            ..Default::default()
        }],
    )
    .unwrap();
    conn
}

fn arrive(conn: &Connection, uid: u32, from: &str, id: &str, in_reply_to: &str, thread: &str, date: i64) {
    upsert_messages(
        conn,
        "acct",
        "INBOX",
        &[MessageHeader {
            uid,
            from_addr: from.into(),
            subject: "anything at all".into(),
            message_id: id.into(),
            in_reply_to: in_reply_to.into(),
            thread_key: thread.into(),
            date,
            ..Default::default()
        }],
    )
    .unwrap();
}

#[test]
fn waits_until_someone_it_was_sent_to_answers() {
    let conn = conn();
    let item = add(&conn, "acct", "t-roof", Some(NOW + 3_600), NOW).unwrap();
    assert_eq!(item.message_id, "q1@example.com");
    assert_eq!(item.recipients, vec!["ann@example.com", "bob@example.com"]);
    assert_eq!(item.status, "waiting");

    // Bob, who was copied, answers directly.
    arrive(&conn, 5, "Bob@Example.com", "<r1@example.com>", "<Q1@example.com>", "t-other", NOW - 100);
    let item = super::item(&conn, "acct", "<q1@example.com>", NOW).unwrap().unwrap();
    assert_eq!(item.status, "answered");
    let answer = item.answer.unwrap();
    assert_eq!((answer.from.as_str(), answer.link.as_str()), ("bob@example.com", "direct"));
}

#[test]
fn a_later_message_in_the_conversation_from_a_recipient_answers_without_in_reply_to() {
    let conn = conn();
    add(&conn, "acct", "t-roof", None, NOW).unwrap();
    arrive(&conn, 5, "ann@example.com", "<r2@example.com>", "", "t-roof", NOW - 50);
    let item = item(&conn, "acct", "q1@example.com", NOW).unwrap().unwrap();
    assert_eq!(item.answer.unwrap().link, "conversation");
}

#[test]
fn subjects_alone_never_answer() {
    let conn = conn();
    add(&conn, "acct", "t-roof", None, NOW).unwrap();
    // Same subject, from Ann, in another conversation and not a reply.
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader {
            uid: 6,
            from_addr: "ann@example.com".into(),
            subject: "Re: Quote for the roof".into(),
            message_id: "<x@example.com>".into(),
            thread_key: "t-elsewhere".into(),
            date: NOW - 10,
            ..Default::default()
        }],
    )
    .unwrap();
    assert_eq!(item(&conn, "acct", "q1@example.com", NOW).unwrap().unwrap().status, "waiting");
}

#[test]
fn my_own_addresses_and_earlier_mail_never_answer() {
    let conn = conn();
    add(&conn, "acct", "t-roof", None, NOW).unwrap();
    // A follow-up I sent from my alias, and a message older than mine.
    arrive(&conn, 7, "desk@example.com", "<f@example.com>", "<q1@example.com>", "t-roof", NOW - 10);
    arrive(&conn, 8, "ann@example.com", "<old@example.com>", "", "t-roof", NOW - 2 * 86_400);
    assert_eq!(item(&conn, "acct", "q1@example.com", NOW).unwrap().unwrap().status, "waiting");
}

#[test]
fn automatic_answers_and_strangers_are_possible_and_the_person_rules() {
    let conn = conn();
    add(&conn, "acct", "t-roof", None, NOW).unwrap();
    arrive(&conn, 9, "no-reply@example.com", "<auto@example.com>", "<q1@example.com>", "t-roof", NOW - 30);
    arrive(&conn, 10, "carol@example.com", "<c@example.com>", "<q1@example.com>", "t-roof", NOW - 20);
    let found = item(&conn, "acct", "q1@example.com", NOW).unwrap().unwrap();
    assert_eq!(found.status, "possible");
    let doubts: Vec<&str> = found.possible.iter().map(|e| e.doubt.as_str()).collect();
    assert_eq!(doubts, vec!["automated", "notRecipient"]);

    // Not the automatic one; Carol's counts.
    rule_on(&conn, "acct", "q1@example.com", "auto@example.com", false).unwrap();
    assert_eq!(item(&conn, "acct", "q1@example.com", NOW).unwrap().unwrap().possible.len(), 1);
    rule_on(&conn, "acct", "q1@example.com", "<c@example.com>", true).unwrap();
    let found = item(&conn, "acct", "q1@example.com", NOW).unwrap().unwrap();
    assert_eq!(found.status, "answered");
    assert_eq!(found.answer.unwrap().from, "carol@example.com");

    // And a real answer the person says is not one stays ruled out.
    rule_on(&conn, "acct", "q1@example.com", "c@example.com", false).unwrap();
    arrive(&conn, 11, "ann@example.com", "<a@example.com>", "<q1@example.com>", "t-roof", NOW - 5);
    rule_on(&conn, "acct", "q1@example.com", "a@example.com", false).unwrap();
    // Everything that arrived has been ruled out: still waiting.
    assert_eq!(item(&conn, "acct", "q1@example.com", NOW).unwrap().unwrap().status, "waiting");
}

#[test]
fn survives_a_move_a_redownload_and_a_restart() {
    let dir = std::env::temp_dir().join(format!("oreneta-awaiting-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("store.db");
    let _ = std::fs::remove_file(&path);
    {
        let file = Connection::open(&path).unwrap();
        crate::store::run_migrations(&file).unwrap();
        file.execute("INSERT INTO accounts(id, email) VALUES('acct', 'me@example.com')", []).unwrap();
        upsert_messages(
            &file,
            "acct",
            "Sent",
            &[MessageHeader {
                uid: 1,
                from_addr: "me@example.com".into(),
                to: vec![person("ann@example.com")],
                message_id: "<q1@example.com>".into(),
                thread_key: "t-roof".into(),
                date: NOW - 100,
                ..Default::default()
            }],
        )
        .unwrap();
        add(&file, "acct", "t-roof", Some(NOW + 60), NOW).unwrap();
        // The sent copy is filed elsewhere and comes back with a new uid.
        file.execute("DELETE FROM messages", []).unwrap();
        upsert_messages(
            &file,
            "acct",
            "Archive",
            &[MessageHeader {
                uid: 44,
                from_addr: "me@example.com".into(),
                to: vec![person("ann@example.com")],
                message_id: "<q1@example.com>".into(),
                thread_key: "t-roof".into(),
                date: NOW - 100,
                ..Default::default()
            }],
        )
        .unwrap();
    }
    let file = Connection::open(&path).unwrap();
    crate::store::run_migrations(&file).unwrap();
    let listed = list(&file, Some("acct"), false, NOW).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].status, "waiting");
    arrive(&file, 3, "ann@example.com", "<r@example.com>", "<q1@example.com>", "t-roof", NOW);
    assert_eq!(list(&file, Some("acct"), false, NOW).unwrap()[0].status, "answered");
    drop(file);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_reminder_is_handed_out_once_and_not_for_what_was_answered() {
    let conn = conn();
    add(&conn, "acct", "t-roof", Some(NOW + 60), NOW).unwrap();
    assert!(due_reminders(&conn, NOW).unwrap().is_empty());
    let due = due_reminders(&conn, NOW + 61).unwrap();
    assert_eq!(due.len(), 1);
    assert!(due[0].overdue);
    assert!(due_reminders(&conn, NOW + 120).unwrap().is_empty(), "once");

    // A new reminder after an answer arrives says nothing.
    add(&conn, "acct", "t-roof", Some(NOW + 200), NOW + 100).unwrap();
    arrive(&conn, 5, "ann@example.com", "<r@example.com>", "<q1@example.com>", "t-roof", NOW + 150);
    assert!(due_reminders(&conn, NOW + 300).unwrap().is_empty());
}

#[test]
fn settling_and_errors() {
    let conn = conn();
    assert!(add(&conn, "acct", "t-nobody", None, NOW).is_err(), "nothing I sent there");
    assert!(add(&conn, "acct", "t-roof", Some(NOW - 1), NOW).is_err(), "a reminder in the past");
    add(&conn, "acct", "t-roof", None, NOW).unwrap();
    set_state(&conn, "acct", "q1@example.com", "done").unwrap();
    assert!(list(&conn, Some("acct"), false, NOW).unwrap().is_empty());
    assert_eq!(list(&conn, Some("acct"), true, NOW).unwrap()[0].status, "done");
    assert!(set_state(&conn, "acct", "q1@example.com", "sent").is_err());
    assert!(set_state(&conn, "acct", "nope@example.com", "done").is_err());
    remove(&conn, "acct", "q1@example.com").unwrap();
    assert!(list(&conn, None, true, NOW).unwrap().is_empty());
}

#[test]
fn account_removal_takes_the_records() {
    let conn = conn();
    add(&conn, "acct", "t-roof", None, NOW).unwrap();
    crate::store::delete_account(&conn, "acct").unwrap();
    assert!(list(&conn, None, true, NOW).unwrap().is_empty());
}
