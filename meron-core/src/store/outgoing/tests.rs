use super::*;
use serde_json::json;

fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    super::super::db::run_migrations(&conn).unwrap();
    conn
}

fn request() -> Value {
    json!({
        "account": "acct",
        "to": "bob@example.com",
        "subject": "Hello",
        "body": "hi",
        "message_id": "<m1@example.com>",
        "attachments": [{ "filename": "a.txt", "mime": "text/plain", "data": "YQ==", "inline_id": "" }],
        "sign": true,
        "passphrase": "hunter2"
    })
}

#[test]
fn an_attempt_is_written_before_it_goes_and_without_its_passphrase() {
    let conn = test_conn();
    begin_attempt(&conn, "a-1", "acct", AttemptKind::Now, "<m1@example.com>", &request(), 100).unwrap();

    let row = attempt(&conn, "a-1").unwrap().expect("written");
    assert_eq!(row.state, AttemptState::Sending);
    assert_eq!(row.kind, AttemptKind::Now);
    assert_eq!(row.subject, "Hello");
    assert_eq!(row.recipients, "bob@example.com");
    assert_eq!(row.message_id, "<m1@example.com>");
    assert_eq!((row.created_at, row.updated_at), (100, 100));

    let stored: Value = serde_json::from_str(&row.payload).unwrap();
    assert!(stored.get("passphrase").is_none(), "{stored}");
    // Everything else the composer wrote, attachments included, is kept so
    // the message can be looked at or sent again after a restart.
    assert_eq!(stored["attachments"][0]["data"], "YQ==");
    assert_eq!(stored["sign"], true);
    assert_eq!(row.to_json()["message"]["to"], "bob@example.com");
}

#[test]
fn acceptance_then_archival_is_the_happy_path() {
    let conn = test_conn();
    begin_attempt(&conn, "a-1", "acct", AttemptKind::Now, "", &request(), 100).unwrap();
    mark_accepted(&conn, "a-1", 101).unwrap();
    assert_eq!(attempt(&conn, "a-1").unwrap().unwrap().state, AttemptState::Accepted);
    mark_archived(&conn, "a-1", 102).unwrap();
    let row = attempt(&conn, "a-1").unwrap().unwrap();
    assert_eq!(row.state, AttemptState::Archived);
    assert_eq!(row.updated_at, 102);
    assert!(unsettled(&conn, None).unwrap().is_empty(), "nothing for a person to do");
}

/// Acceptance criterion: failure to archive an accepted message never changes
/// its delivery status to not sent.
#[test]
fn a_failed_sent_copy_leaves_the_message_accepted() {
    let conn = test_conn();
    begin_attempt(&conn, "a-1", "acct", AttemptKind::Now, "", &request(), 100).unwrap();
    mark_accepted(&conn, "a-1", 101).unwrap();
    mark_archive_failed(&conn, "a-1", "no Sent folder found", 102).unwrap();

    let row = attempt(&conn, "a-1").unwrap().unwrap();
    assert_eq!(row.state, AttemptState::Accepted);
    assert_eq!(row.archive_error, "no Sent folder found");
    assert!(row.state.may_have_gone());
    // It is surfaced, as sent-but-unfiled, not hidden and not retried.
    let waiting = unsettled(&conn, Some("acct")).unwrap();
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].id, "a-1");

    // The archive error cannot be recorded against a message that did not go.
    begin_attempt(&conn, "a-2", "acct", AttemptKind::Now, "", &request(), 103).unwrap();
    mark_rejected(&conn, "a-2", "550 no", 104).unwrap();
    mark_archive_failed(&conn, "a-2", "ignored", 105).unwrap();
    let rejected = attempt(&conn, "a-2").unwrap().unwrap();
    assert_eq!(rejected.state, AttemptState::Rejected);
    assert_eq!(rejected.archive_error, "");
    assert!(!rejected.state.may_have_gone());
}

/// Acceptance criterion: an ambiguous outcome is persisted and is not
/// automatically retried as a confirmed rejection.
#[test]
fn an_uncertain_outcome_waits_for_a_person() {
    let conn = test_conn();
    begin_attempt(&conn, "a-1", "acct", AttemptKind::Scheduled, "", &request(), 100).unwrap();
    mark_uncertain(&conn, "a-1", "connection reset after the message was sent", 101).unwrap();

    let row = attempt(&conn, "a-1").unwrap().unwrap();
    assert_eq!(row.state, AttemptState::Uncertain);
    assert!(row.state.may_have_gone(), "sending again could deliver twice");
    assert_eq!(unsettled(&conn, None).unwrap().len(), 1);

    // Nothing but a person moves it on; and only once.
    assert!(resolve(&conn, "a-1", 102).unwrap());
    assert!(!resolve(&conn, "a-1", 103).unwrap());
    let row = attempt(&conn, "a-1").unwrap().unwrap();
    assert_eq!(row.state, AttemptState::Resolved);
    assert!(!row.state.may_have_gone());
    assert!(unsettled(&conn, None).unwrap().is_empty());
    // Resolving something that needs nobody is not a thing.
    begin_attempt(&conn, "a-2", "acct", AttemptKind::Now, "", &request(), 104).unwrap();
    mark_accepted(&conn, "a-2", 105).unwrap();
    assert!(!resolve(&conn, "a-2", 106).unwrap());
    assert_eq!(attempt(&conn, "a-2").unwrap().unwrap().state, AttemptState::Accepted);
    // A sent message without its Sent copy can be looked at and settled too.
    mark_archive_failed(&conn, "a-2", "no Sent folder", 107).unwrap();
    assert!(resolve(&conn, "a-2", 108).unwrap());
    assert!(unsettled(&conn, None).unwrap().is_empty());
}

/// A process that died mid-send leaves rows marked as going. At the next
/// start they are what they are: outcomes nobody knows.
#[test]
fn attempts_left_in_flight_by_a_crash_become_uncertain_at_startup() {
    let conn = test_conn();
    begin_attempt(&conn, "a-1", "acct", AttemptKind::Now, "", &request(), 100).unwrap();
    begin_attempt(&conn, "a-2", "acct", AttemptKind::Scheduled, "", &request(), 100).unwrap();
    begin_attempt(&conn, "a-3", "acct", AttemptKind::Now, "", &request(), 100).unwrap();
    mark_accepted(&conn, "a-3", 101).unwrap();

    assert_eq!(mark_interrupted_uncertain(&conn, 200).unwrap(), 2);
    for id in ["a-1", "a-2"] {
        let row = attempt(&conn, id).unwrap().unwrap();
        assert_eq!(row.state, AttemptState::Uncertain, "{id}");
        assert!(row.error.contains("stopped while this message was being sent"), "{id}: {}", row.error);
        assert_eq!(row.updated_at, 200);
    }
    // One that had already been accepted is not touched.
    assert_eq!(attempt(&conn, "a-3").unwrap().unwrap().state, AttemptState::Accepted);
    // Running it again at the next start changes nothing.
    assert_eq!(mark_interrupted_uncertain(&conn, 300).unwrap(), 0);
}

#[test]
fn a_rejected_attempt_tried_again_is_one_record() {
    let conn = test_conn();
    begin_attempt(&conn, "a-1", "acct", AttemptKind::Now, "", &request(), 100).unwrap();
    mark_rejected(&conn, "a-1", "550 no such user", 101).unwrap();
    assert_eq!(attempt(&conn, "a-1").unwrap().unwrap().error, "550 no such user");

    begin_attempt(&conn, "a-1", "acct", AttemptKind::Now, "", &request(), 200).unwrap();
    let row = attempt(&conn, "a-1").unwrap().unwrap();
    assert_eq!(row.state, AttemptState::Sending);
    assert_eq!(row.error, "", "the old refusal does not linger");
    assert_eq!(row.created_at, 200);
}

#[test]
fn settled_history_is_pruned_but_doubt_is_kept() {
    let conn = test_conn();
    for (id, state) in [
        ("old-archived", AttemptState::Archived),
        ("old-rejected", AttemptState::Rejected),
        ("old-resolved", AttemptState::Resolved),
        ("old-accepted", AttemptState::Accepted),
        ("old-uncertain", AttemptState::Uncertain),
    ] {
        begin_attempt(&conn, id, "acct", AttemptKind::Now, "", &request(), 10).unwrap();
        match state {
            AttemptState::Archived => {
                mark_accepted(&conn, id, 11).unwrap();
                mark_archived(&conn, id, 12).unwrap();
            }
            AttemptState::Rejected => mark_rejected(&conn, id, "no", 12).unwrap(),
            AttemptState::Resolved => {
                mark_uncertain(&conn, id, "?", 11).unwrap();
                resolve(&conn, id, 12).unwrap();
            }
            AttemptState::Accepted => mark_accepted(&conn, id, 12).unwrap(),
            AttemptState::Uncertain => mark_uncertain(&conn, id, "?", 12).unwrap(),
            AttemptState::Sending => unreachable!(),
        }
    }
    begin_attempt(&conn, "unfiled", "acct", AttemptKind::Now, "", &request(), 10).unwrap();
    mark_accepted(&conn, "unfiled", 11).unwrap();
    mark_archive_failed(&conn, "unfiled", "no Sent", 12).unwrap();
    begin_attempt(&conn, "recent", "acct", AttemptKind::Now, "", &request(), 500).unwrap();
    mark_rejected(&conn, "recent", "no", 501).unwrap();

    assert_eq!(prune_settled(&conn, 100).unwrap(), 4);
    for id in ["old-archived", "old-rejected", "old-resolved", "old-accepted"] {
        assert!(attempt(&conn, id).unwrap().is_none(), "{id} is history");
    }
    for id in ["old-uncertain", "unfiled", "recent"] {
        assert!(attempt(&conn, id).unwrap().is_some(), "{id} is kept");
    }
}

#[test]
fn unsettled_is_scoped_by_account_and_oldest_first() {
    let conn = test_conn();
    begin_attempt(&conn, "b-1", "other", AttemptKind::Now, "", &request(), 50).unwrap();
    mark_uncertain(&conn, "b-1", "?", 51).unwrap();
    begin_attempt(&conn, "a-2", "acct", AttemptKind::Now, "", &request(), 200).unwrap();
    mark_uncertain(&conn, "a-2", "?", 201).unwrap();
    begin_attempt(&conn, "a-1", "acct", AttemptKind::Now, "", &request(), 100).unwrap();
    mark_uncertain(&conn, "a-1", "?", 101).unwrap();

    let mine: Vec<String> = unsettled(&conn, Some("acct")).unwrap().into_iter().map(|row| row.id).collect();
    assert_eq!(mine, vec!["a-1", "a-2"]);
    assert_eq!(unsettled(&conn, None).unwrap().len(), 3);
    assert!(unsettled(&conn, Some("nobody")).unwrap().is_empty());
}

#[test]
fn states_and_kinds_round_trip_through_text() {
    for state in [
        AttemptState::Sending,
        AttemptState::Accepted,
        AttemptState::Archived,
        AttemptState::Rejected,
        AttemptState::Uncertain,
        AttemptState::Resolved,
    ] {
        assert_eq!(AttemptState::parse(state.as_str()).unwrap(), state);
    }
    assert!(AttemptState::parse("lost").is_err());
    assert_eq!(AttemptKind::parse("scheduled").unwrap(), AttemptKind::Scheduled);
    assert!(AttemptKind::parse("later").is_err());
}
