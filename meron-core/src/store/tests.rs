use super::*;

fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    db::run_migrations(&conn).unwrap();
    conn
}

fn insert_message(
    conn: &Connection,
    uid: u32,
    subject: &str,
    from_name: &str,
    from_addr: &str,
    body: Option<&str>,
) {
    conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, seen, body)
             VALUES('acct', 'INBOX', ?1, ?2, ?3, ?4, ?5, 1779580800, 0, ?6)",
            params![uid.to_string(), uid, subject, from_name, from_addr, body],
        )
        .unwrap();
}

#[test]
fn folders_round_trip_special_use_and_ensure_folder_keeps_it() {
    let conn = test_conn();
    upsert_folders(
        &conn,
        "acct",
        &[
            Folder {
                name: "INBOX".to_string(),
                delimiter: Some("/".to_string()),
                ..Default::default()
            },
            Folder {
                name: "Mail/Entwürfe".to_string(),
                delimiter: Some("/".to_string()),
                special_use: Some("drafts".to_string()),
                ..Default::default()
            },
        ],
    )
    .unwrap();
    // Message syncs call ensure_folder on every pass; it must not clobber the
    // role recorded by the folder LIST sync.
    ensure_folder(&conn, "acct", "Mail/Entwürfe").unwrap();

    let folders = get_folders(&conn, "acct").unwrap();
    let drafts = folders.iter().find(|f| f.name == "Mail/Entwürfe").unwrap();
    assert_eq!(drafts.special_use.as_deref(), Some("drafts"));
    let inbox = folders.iter().find(|f| f.name == "INBOX").unwrap();
    assert_eq!(inbox.special_use, None);
}

#[test]
fn folder_unread_counts_messages_without_requiring_a_folder_row() {
    let conn = test_conn();
    insert_message(&conn, 1, "Unread", "Ada", "ada@example.com", None);
    conn.execute(
        "UPDATE messages SET seen = 1 WHERE account = 'acct' AND folder = 'INBOX' AND uid = 1",
        [],
    )
    .unwrap();
    insert_message(&conn, 2, "Unread", "Bea", "bea@example.com", None);

    assert_eq!(get_folder_unread(&conn, "acct", "INBOX").unwrap(), 1);
    assert_eq!(get_folder_unread(&conn, "acct", "Archive").unwrap(), 0);
}

#[test]
fn delete_folder_drops_the_row_its_messages_and_its_sync_state() {
    let conn = test_conn();
    upsert_folders(
        &conn,
        "acct",
        &[
            Folder {
                name: "INBOX".to_string(),
                delimiter: Some("/".to_string()),
                ..Default::default()
            },
            Folder {
                name: "Work".to_string(),
                delimiter: Some("/".to_string()),
                ..Default::default()
            },
            Folder {
                name: "Work/Reports".to_string(),
                delimiter: Some("/".to_string()),
                ..Default::default()
            },
        ],
    )
    .unwrap();
    insert_message(&conn, 1, "Kept", "Ada", "ada@example.com", None);
    conn.execute(
        "INSERT INTO messages(account, folder, msg_id, uid, subject, date, seen)
         VALUES('acct', 'Work/Reports', '7', 7, 'Q3', 1779580800, 0)",
        [],
    )
    .unwrap();
    set_folder_state(&conn, "acct", "Work/Reports", 1, 8).unwrap();

    // Nesting is read off each row's own delimiter, so the parent knows it has
    // children while the leaf has none.
    assert_eq!(
        child_folders(&conn, "acct", "Work").unwrap(),
        vec!["Work/Reports".to_string()]
    );
    assert!(
        child_folders(&conn, "acct", "Work/Reports")
            .unwrap()
            .is_empty()
    );

    assert_eq!(delete_folder(&conn, "acct", "Work/Reports").unwrap(), 1);
    let names: Vec<String> = get_folders(&conn, "acct")
        .unwrap()
        .into_iter()
        .map(|folder| folder.name)
        .collect();
    assert_eq!(names, vec!["INBOX".to_string(), "Work".to_string()]);
    assert_eq!(
        get_folder_state(&conn, "acct", "Work/Reports").unwrap(),
        None
    );
    // Untouched folders keep their mail.
    assert_eq!(get_folder_unread(&conn, "acct", "INBOX").unwrap(), 1);
}

#[test]
fn delimiterless_folder_names_do_not_form_a_delete_subtree() {
    let conn = test_conn();
    upsert_folders(
        &conn,
        "acct",
        &[
            Folder {
                name: "Work".to_string(),
                delimiter: None,
                ..Default::default()
            },
            Folder {
                name: "Work/Reports".to_string(),
                delimiter: None,
                ..Default::default()
            },
        ],
    )
    .unwrap();

    assert!(child_folders(&conn, "acct", "Work").unwrap().is_empty());
}

#[test]
fn folder_role_assignment_uses_special_use_then_name_fallback() {
    let cases = [
        ("Mail/Entwürfe", Some("drafts"), "drafts"),
        ("Archive", Some("sent"), "sent"),
        ("INBOX", None, "inbox"),
        ("Sent Mail", None, "sent"),
        ("Drafts", None, "drafts"),
        ("Deleted Items", None, "trash"),
        ("Spam", None, "junk"),
        ("All Mail", None, "archive"),
        ("Projects", None, "folder"),
    ];
    for (name, special_use, role) in cases {
        assert_eq!(classify_folder_role(name, special_use), role, "{name}");
    }
}

#[test]
fn a_thread_put_aside_stays_out_of_the_way_until_its_time() {
    let conn = test_conn();
    let now = 1_700_000_000i64;

    snooze_thread(&conn, "acct", "t-1", "INBOX", now + 3600).unwrap();
    snooze_thread(&conn, "acct", "t-2", "Archive", now - 60).unwrap();

    // Out of the list while it waits, back in it once the moment passes.
    let hidden = snoozed_thread_keys(&conn, "acct", now).unwrap();
    assert!(hidden.contains("t-1"));
    assert!(!hidden.contains("t-2"), "its time has come, so it is not hidden");

    // And findable meanwhile: a thread that vanishes with no way to look it
    // up is lost, not postponed.
    let listed = snoozed_threads(&conn, "acct").unwrap();
    assert_eq!(listed.len(), 2);

    // What is due carries where to put it back.
    let due = due_snoozes(&conn, now).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0], ("acct".to_string(), "t-2".to_string(), "Archive".to_string()));

    unsnooze_thread(&conn, "acct", "t-2").unwrap();
    assert!(due_snoozes(&conn, now).unwrap().is_empty());
    assert_eq!(snoozed_threads(&conn, "acct").unwrap().len(), 1);
}

#[test]
fn a_recent_page_can_be_narrowed_by_more_than_one_thing_at_once() {
    let conn = test_conn();
    let message = |uid: u32, date: i64, seen: bool, starred: bool| MessageHeader {
        uid,
        subject: format!("Message {uid}"),
        date,
        seen,
        starred,
        ..Default::default()
    };
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            message(1, 100, true, true),   // read, starred
            message(2, 200, false, false), // unread, plain
            message(3, 300, false, true),  // unread and starred
        ],
    )
    .unwrap();

    let uids = |filter: RecentFilter| {
        get_recent_page(&conn, "acct", "INBOX", 50, None, filter)
            .unwrap()
            .0
            .into_iter()
            .map(|header| header.uid)
            .collect::<Vec<_>>()
    };

    assert_eq!(uids(RecentFilter::default()), vec![3, 2, 1]);
    assert_eq!(uids(RecentFilter::unread()), vec![3, 2]);
    assert_eq!(
        uids(RecentFilter { unread_only: false, starred_only: true, ..Default::default() }),
        vec![3, 1]
    );
    // Both at once is one question, answered by the query rather than by
    // narrowing a page after it was already counted out.
    assert_eq!(
        uids(RecentFilter { unread_only: true, starred_only: true, ..Default::default() }),
        vec![3]
    );
}

#[test]
fn recent_headers_carry_what_a_rule_needs_to_match_on() {
    let conn = test_conn();
    let recipient = |name: &str, addr: &str| crate::imap::Recipient {
        name: name.to_string(),
        addr: addr.to_string(),
    };
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            MessageHeader {
                uid: 1,
                subject: "Older".to_string(),
                from_name: "Team".to_string(),
                from_addr: "team@example.com".to_string(),
                date: 100,
                to: vec![recipient("Me", "me@example.com")],
                cc: vec![recipient("List", "list@example.com")],
                ..Default::default()
            },
            MessageHeader {
                uid: 2,
                subject: "Newer".to_string(),
                from_addr: "other@example.com".to_string(),
                date: 200,
                ..Default::default()
            },
        ],
    )
    .unwrap();

    let headers = recent_headers(&conn, "acct", "INBOX", 10).unwrap();
    assert_eq!(headers.len(), 2);
    assert_eq!(headers[0].subject, "Newer", "newest first");

    // Cc comes along with To: a rule can match on either, and a dry run that
    // looked at less than the real run would be a dry run that lies.
    let older = &headers[1];
    assert_eq!(older.to.len(), 1);
    assert_eq!(older.cc.len(), 1);
    assert_eq!(older.cc[0].addr, "list@example.com");
    assert_eq!(older.from_name, "Team");
    assert_eq!(older.folder, "INBOX");

    assert_eq!(recent_headers(&conn, "acct", "INBOX", 1).unwrap().len(), 1);
    assert!(recent_headers(&conn, "acct", "Archive", 10).unwrap().is_empty());
}

#[test]
fn an_unknown_attachment_answer_is_not_a_no() {
    let conn = test_conn();
    let msg = |uid: u32, has: Option<bool>| MessageHeader {
        uid,
        date: 100 + uid as i64,
        thread_key: format!("t-{uid}"),
        has_attachments: has,
        ..Default::default()
    };
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[msg(1, Some(true)), msg(2, Some(false)), msg(3, None)],
    )
    .unwrap();

    let uids = |filter: RecentFilter| {
        get_recent_page(&conn, "acct", "INBOX", 50, None, filter)
            .unwrap()
            .0
            .into_iter()
            .map(|header| header.uid)
            .collect::<Vec<_>>()
    };

    // Only what is known to carry one. A message nobody has looked at is not
    // a message without an attachment.
    assert_eq!(
        uids(RecentFilter { with_attachments: true, ..Default::default() }),
        vec![1]
    );
    assert_eq!(uids(RecentFilter::default()), vec![3, 2, 1]);

    // And the one nobody has looked at is exactly what the backfill asks about.
    assert_eq!(uids_without_structure(&conn, "acct", "INBOX", 10).unwrap(), vec![3]);
}

#[test]
fn a_resync_carrying_no_structure_does_not_forget_what_was_known() {
    let conn = test_conn();
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader { uid: 1, has_attachments: Some(true), ..Default::default() }],
    )
    .unwrap();

    // A flag-only resync carries no BODYSTRUCTURE. Turning a known answer back
    // into an unknown one would make the filter forget mail it had already
    // found, over and over.
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader { uid: 1, seen: true, has_attachments: None, ..Default::default() }],
    )
    .unwrap();

    assert!(uids_without_structure(&conn, "acct", "INBOX", 10).unwrap().is_empty());
    let found = get_recent_page(
        &conn,
        "acct",
        "INBOX",
        50,
        None,
        RecentFilter { with_attachments: true, ..Default::default() },
    )
    .unwrap()
    .0;
    assert_eq!(found.len(), 1);
}

#[test]
fn asking_the_server_makes_an_unknown_message_known() {
    let conn = test_conn();
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            MessageHeader { uid: 1, thread_key: "t-1".into(), ..Default::default() },
            MessageHeader { uid: 2, thread_key: "t-2".into(), ..Default::default() },
        ],
    )
    .unwrap();
    assert_eq!(uids_without_structure(&conn, "acct", "INBOX", 10).unwrap().len(), 2);

    set_has_attachments(&conn, "acct", "INBOX", &[(1, true), (2, false)]).unwrap();

    assert!(uids_without_structure(&conn, "acct", "INBOX", 10).unwrap().is_empty());
    // A paperclip belongs to the conversation: the thread whose message
    // carries the invoice has an invoice in it.
    let flagged = threads_with_attachments(&conn, "acct", &["t-1".into(), "t-2".into()]).unwrap();
    assert!(flagged.contains("t-1"));
    assert!(!flagged.contains("t-2"));
}

fn label(id: &str, name: &str) -> Label {
    Label {
        id: id.to_string(),
        name: name.to_string(),
        colour: "#2056dd".to_string(),
    }
}

/// A small mailbox to try searches against.
fn searchable_conn() -> Connection {
    let conn = test_conn();
    let recipient = |addr: &str| crate::imap::Recipient {
        name: String::new(),
        addr: addr.to_string(),
    };
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            MessageHeader {
                uid: 1,
                subject: "Weekly report".into(),
                from_name: "Ann Example".into(),
                from_addr: "ann@example.com".into(),
                date: 1_767_312_000, // 2026-01-02
                seen: false,
                starred: true,
                thread_key: "t-1".into(),
                to: vec![recipient("team@example.com")],
                has_attachments: Some(true),
                ..Default::default()
            },
            MessageHeader {
                uid: 2,
                subject: "Lunch".into(),
                from_name: "Bob Other".into(),
                from_addr: "bob@example.com".into(),
                date: 1_769_990_400, // 2026-02-02
                seen: true,
                thread_key: "t-2".into(),
                to: vec![recipient("me@example.com")],
                has_attachments: Some(false),
                ..Default::default()
            },
            MessageHeader {
                uid: 3,
                subject: "Weekly report".into(),
                from_name: "Carol".into(),
                from_addr: "carol@example.com".into(),
                date: 1_772_409_600, // 2026-03-02
                seen: false,
                thread_key: "t-3".into(),
                to: vec![recipient("team@example.com")],
                ..Default::default() // attachment unknown
            },
        ],
    )
    .unwrap();
    conn
}

fn found(conn: &Connection, query: &str) -> Vec<u32> {
    search_messages(conn, "acct", "INBOX", query, 50, None)
        .unwrap()
        .into_iter()
        .map(|header| header.uid)
        .collect()
}

#[test]
fn an_operator_narrows_the_search_it_names() {
    let conn = searchable_conn();
    assert_eq!(found(&conn, "from:ann"), vec![1]);
    // The sender is name and address together: a term in the display name
    // finds it just as one in the address does.
    assert_eq!(found(&conn, r#"from:"Ann Example""#), vec![1]);
    assert_eq!(found(&conn, "from:Other"), vec![2]);
    // And a term that is in every address finds every one of them, which is
    // what a substring search over a shared domain has to mean.
    assert_eq!(found(&conn, "from:example.com"), vec![3, 2, 1]);
    assert_eq!(found(&conn, "to:team"), vec![3, 1]);
    assert_eq!(found(&conn, "subject:weekly"), vec![3, 1]);
    assert_eq!(found(&conn, "is:unread"), vec![3, 1]);
    assert_eq!(found(&conn, "is:read"), vec![2]);
    assert_eq!(found(&conn, "is:starred"), vec![1]);
}

#[test]
fn operators_asked_for_together_narrow_one_query() {
    let conn = searchable_conn();
    // One statement, not a page narrowed afterwards.
    assert_eq!(found(&conn, "subject:weekly is:unread from:carol"), vec![3]);
    assert!(found(&conn, "from:ann is:read").is_empty());
}

#[test]
fn two_terms_for_one_field_mean_either_of_them() {
    let conn = searchable_conn();
    // Nobody writing this means a message from both people at once.
    assert_eq!(found(&conn, "from:ann from:bob"), vec![2, 1]);
}

#[test]
fn a_search_can_be_only_operators() {
    let conn = searchable_conn();
    // No free text at all: the index is not consulted, the predicates are the
    // whole question.
    assert_eq!(found(&conn, "is:starred"), vec![1]);
    assert!(found(&conn, "").is_empty());
}

#[test]
fn free_text_still_searches_as_it_always_did_beside_an_operator() {
    let conn = searchable_conn();
    assert_eq!(found(&conn, "weekly"), vec![3, 1]);
    assert_eq!(found(&conn, "weekly from:carol"), vec![3]);
}

#[test]
fn dates_bound_the_search_at_the_day() {
    let conn = searchable_conn();
    assert_eq!(found(&conn, "after:2026-02-01"), vec![3, 2]);
    assert_eq!(found(&conn, "before:2026-02-01"), vec![1]);
    assert_eq!(found(&conn, "after:2026-01-15 before:2026-02-15"), vec![2]);
}

#[test]
fn an_attachment_nobody_has_looked_for_is_not_an_answer() {
    let conn = searchable_conn();
    // uid 3's structure has never been fetched. Offering it here would make
    // the operator mean nothing.
    assert_eq!(found(&conn, "has:attachment"), vec![1]);
}

#[test]
fn a_label_can_be_searched_for_by_the_name_that_was_typed() {
    let conn = searchable_conn();
    replace_labels(&conn, &[label("l-1", "Work")]).unwrap();
    set_thread_labels(&conn, "acct", "t-2", &["l-1".into()]).unwrap();

    assert_eq!(found(&conn, "label:Work"), vec![2]);
    // The name as typed, in whatever case.
    assert_eq!(found(&conn, "label:work"), vec![2]);
    assert!(found(&conn, "label:Nonexistent").is_empty());
}

#[test]
fn a_message_is_judged_as_it_lands_and_can_say_why() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO accounts(id, email) VALUES('acct', 'me@example.com')",
        [],
    )
    .unwrap();
    let to_me = vec![crate::imap::Recipient {
        name: String::new(),
        addr: "me@example.com".into(),
    }];

    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            // Addressed to me by a person: worth interrupting for.
            MessageHeader {
                uid: 1,
                from_addr: "ann@example.com".into(),
                to: to_me.clone(),
                thread_key: "t-1".into(),
                date: 300,
                ..Default::default()
            },
            // A robot nobody knows, addressed to a list: not.
            MessageHeader {
                uid: 2,
                from_addr: "no-reply@shop.example".into(),
                thread_key: "t-2".into(),
                date: 200,
                ..Default::default()
            },
        ],
    )
    .unwrap();

    let priority = |uid: u32| -> Option<bool> {
        conn.query_row(
            "SELECT priority FROM messages WHERE account = 'acct' AND uid = ?1",
            params![uid],
            |row| row.get::<_, Option<i64>>(0),
        )
        .unwrap()
        .map(|value| value != 0)
    };
    assert_eq!(priority(1), Some(true));
    assert_eq!(priority(2), Some(false));
}

#[test]
fn writing_to_someone_makes_them_worth_hearing_from() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO accounts(id, email) VALUES('acct', 'me@example.com')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO folders(account, name, delimiter) VALUES('acct', 'Sent', '/')",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE folders SET special_use = '\\Sent' WHERE account = 'acct' AND name = 'Sent'",
        [],
    )
    .ok();

    // Nothing known about them yet: a bare sender is not priority.
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader {
            uid: 1,
            from_addr: "carol@example.com".into(),
            thread_key: "t-1".into(),
            ..Default::default()
        }],
    )
    .unwrap();
    assert!(!has_written_to(&conn, "acct", "carol@example.com"));

    // Writing to them is what changes it, noted from the Sent folder.
    note_correspondents(&conn, "acct", &["Carol@Example.com".into()]).unwrap();
    assert!(has_written_to(&conn, "acct", "carol@example.com"));
    // Case and spacing are not the point of an address.
    assert!(has_written_to(&conn, "acct", "  CAROL@example.com "));

    // And the judgement is redone rather than left stale.
    assert_eq!(rejudge_priority(&conn, "acct", false).unwrap(), 1);
    let priority: Option<i64> = conn
        .query_row(
            "SELECT priority FROM messages WHERE account = 'acct' AND uid = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(priority, Some(1));
}

#[test]
fn what_the_reader_says_about_a_sender_sticks_and_can_be_taken_back() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO accounts(id, email) VALUES('acct', 'me@example.com')",
        [],
    )
    .unwrap();
    let to_me = vec![crate::imap::Recipient {
        name: String::new(),
        addr: "me@example.com".into(),
    }];
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader {
            uid: 1,
            from_addr: "ann@example.com".into(),
            to: to_me,
            thread_key: "t-1".into(),
            ..Default::default()
        }],
    )
    .unwrap();

    let priority = || -> Option<i64> {
        conn.query_row(
            "SELECT priority FROM messages WHERE account = 'acct' AND uid = 1",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(priority(), Some(1));

    // Said in so many words, and it outranks what the app worked out.
    set_sender_priority(&conn, "acct", "ann@example.com", Some(false)).unwrap();
    rejudge_priority(&conn, "acct", false).unwrap();
    assert_eq!(priority(), Some(0));

    // Taking it back goes to whatever the signals say, not to the opposite of
    // whichever way it was last pushed.
    set_sender_priority(&conn, "acct", "ann@example.com", None).unwrap();
    assert_eq!(sender_priority(&conn, "acct", "ann@example.com"), None);
    rejudge_priority(&conn, "acct", false).unwrap();
    assert_eq!(priority(), Some(1));
}

#[test]
fn a_list_can_be_ordered_by_something_other_than_the_date() {
    use crate::thread_list::{Sort, SortDir, SortKey};
    let conn = test_conn();
    let msg = |uid: u32, date: i64, name: &str, addr: &str, subject: &str| MessageHeader {
        uid,
        date,
        from_name: name.to_string(),
        from_addr: addr.to_string(),
        subject: subject.to_string(),
        thread_key: format!("t-{uid}"),
        ..Default::default()
    };
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            msg(1, 300, "Carol", "carol@example.com", "Zebra"),
            msg(2, 200, "ann", "ann@example.com", "apple"),
            msg(3, 100, "", "bob@example.com", "Mango"),
        ],
    )
    .unwrap();

    let uids = |sort: Sort| {
        get_recent_page_sorted(&conn, "acct", "INBOX", 50, None, RecentFilter::default(), sort)
            .unwrap()
            .0
            .into_iter()
            .map(|header| header.uid)
            .collect::<Vec<_>>()
    };

    // Newest first is still what a mailbox means by default.
    assert_eq!(uids(Sort::default()), vec![1, 2, 3]);
    assert_eq!(
        uids(Sort { key: SortKey::Date, dir: SortDir::Asc }),
        vec![3, 2, 1]
    );

    // By sender: the name when there is one, the address when there is not —
    // which is what the list shows, and so what someone sorting by sender is
    // looking at. Case is not part of a name's order.
    assert_eq!(
        uids(Sort { key: SortKey::Sender, dir: SortDir::Asc }),
        vec![2, 3, 1]
    );
    assert_eq!(
        uids(Sort { key: SortKey::Subject, dir: SortDir::Asc }),
        vec![2, 3, 1]
    );
    assert_eq!(
        uids(Sort { key: SortKey::Subject, dir: SortDir::Desc }),
        vec![1, 3, 2]
    );
}

#[test]
fn a_sorted_list_pages_without_repeating_or_skipping_a_row() {
    use crate::thread_list::{Sort, SortDir, SortKey};
    let conn = test_conn();
    let msg = |uid: u32, subject: &str| MessageHeader {
        uid,
        date: 100,
        subject: subject.to_string(),
        thread_key: format!("t-{uid}"),
        ..Default::default()
    };
    // Every message shares a date, so only the ordering key and the uid
    // tiebreaker keep the walk straight. This is the case that goes wrong when
    // a cursor knows the wrong thing.
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[msg(1, "alpha"), msg(2, "bravo"), msg(3, "charlie"), msg(4, "delta"), msg(5, "echo")],
    )
    .unwrap();

    let sort = Sort { key: SortKey::Subject, dir: SortDir::Asc };
    let mut seen = Vec::new();
    let mut cursor = None;
    for _ in 0..5 {
        let (page, next) =
            get_recent_page_sorted(&conn, "acct", "INBOX", 2, cursor, RecentFilter::default(), sort)
                .unwrap();
        seen.extend(page.into_iter().map(|header| header.uid));
        match next {
            Some(token) => cursor = crate::thread_list::parse_mail_cursor(&token),
            None => break,
        }
    }
    assert_eq!(seen, vec![1, 2, 3, 4, 5]);
}

#[test]
fn a_sweep_says_what_it_would_move_and_keeps_the_newest() {
    let conn = test_conn();
    let from = |uid: u32, date: i64, addr: &str| MessageHeader {
        uid,
        date,
        subject: format!("Offer {uid}"),
        from_addr: addr.to_string(),
        thread_key: format!("t-{uid}"),
        ..Default::default()
    };
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            from(1, 100, "shop@example.com"),
            from(2, 200, "shop@example.com"),
            from(3, 300, "shop@example.com"),
            from(4, 400, "ann@example.com"),
        ],
    )
    .unwrap();

    let uids = |keep: u32| {
        sweep_candidates(&conn, "acct", "INBOX", "shop@example.com", keep)
            .unwrap()
            .into_iter()
            .map(|candidate| candidate.uid)
            .collect::<Vec<_>>()
    };

    // The newest survives; the rest are what would go. Somebody else's mail is
    // never in the answer, whatever the count.
    assert_eq!(uids(1), vec![2, 1]);
    assert_eq!(uids(2), vec![1]);
    assert!(uids(3).is_empty());
    assert!(uids(99).is_empty());

    // Zero is a thing someone may mean, and it means all of them.
    assert_eq!(uids(0), vec![3, 2, 1]);

    // The address is matched whole and case-insensitively — a sweep that
    // caught a substring would reach mail nobody named.
    assert_eq!(
        sweep_candidates(&conn, "acct", "INBOX", "  SHOP@Example.com ", 1)
            .unwrap()
            .len(),
        2
    );
    assert!(sweep_candidates(&conn, "acct", "INBOX", "shop", 0).unwrap().is_empty());

    // And it says what each one is, so the list can be read before it is
    // agreed to.
    let shown = sweep_candidates(&conn, "acct", "INBOX", "shop@example.com", 1).unwrap();
    assert_eq!(shown[0].subject, "Offer 2");
    assert_eq!(shown[0].date, 200);
}

#[test]
fn the_reason_shown_is_the_real_one() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO accounts(id, email) VALUES('acct', 'me@example.com')",
        [],
    )
    .unwrap();
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader {
            uid: 1,
            from_addr: "ann@example.com".into(),
            to: vec![crate::imap::Recipient {
                name: String::new(),
                addr: "me@example.com".into(),
            }],
            thread_key: "t-1".into(),
            ..Default::default()
        }],
    )
    .unwrap();

    // Recipients are what make this message priority, so the signals have to
    // carry them. Reading them from a query that does not — the thread-header
    // one does not — produced "nothing known" for a message addressed to the
    // reader by name, which is an explanation that is quietly false. A wrong
    // reason is worse here than no reason at all.
    let (sender, signals) = thread_priority_signals(&conn, "acct", "INBOX", "t-1")
        .unwrap()
        .expect("the conversation is there");
    assert_eq!(sender, "ann@example.com");
    assert!(signals.addressed_directly);

    let verdict = crate::priority::verdict(signals);
    assert!(verdict.priority);
    assert_eq!(verdict.reasons, vec![crate::priority::Reason::AddressedDirectly]);

    // A conversation nobody has is nothing, not a guess.
    assert!(thread_priority_signals(&conn, "acct", "INBOX", "t-9").unwrap().is_none());
}

#[test]
fn a_page_can_be_narrowed_to_what_is_worth_interrupting_for() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO accounts(id, email) VALUES('acct', 'me@example.com')",
        [],
    )
    .unwrap();
    let to_me = vec![crate::imap::Recipient {
        name: String::new(),
        addr: "me@example.com".into(),
    }];
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            MessageHeader { uid: 1, from_addr: "ann@example.com".into(), to: to_me, date: 300, thread_key: "t-1".into(), ..Default::default() },
            MessageHeader { uid: 2, from_addr: "no-reply@shop.example".into(), date: 200, thread_key: "t-2".into(), ..Default::default() },
        ],
    )
    .unwrap();

    let uids = |filter: RecentFilter| {
        get_recent_page(&conn, "acct", "INBOX", 50, None, filter)
            .unwrap()
            .0
            .into_iter()
            .map(|header| header.uid)
            .collect::<Vec<_>>()
    };
    assert_eq!(uids(RecentFilter::default()), vec![1, 2]);
    assert_eq!(
        uids(RecentFilter { priority_only: true, ..Default::default() }),
        vec![1]
    );
}

#[test]
fn labels_are_kept_in_the_order_they_were_arranged() {
    let conn = test_conn();
    replace_labels(&conn, &[label("l-1", "Work"), label("l-2", "Home")]).unwrap();

    let stored = labels(&conn).unwrap();
    assert_eq!(stored.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), vec!["l-1", "l-2"]);
    assert_eq!(stored[0].name, "Work");

    // Saving replaces the whole set rather than adding to it.
    replace_labels(&conn, &[label("l-2", "Home")]).unwrap();
    assert_eq!(labels(&conn).unwrap().len(), 1);
}

#[test]
fn a_label_that_is_deleted_takes_its_conversations_with_it() {
    let conn = test_conn();
    replace_labels(&conn, &[label("l-1", "Work"), label("l-2", "Home")]).unwrap();
    set_thread_labels(&conn, "acct", "t-1", &["l-1".into(), "l-2".into()]).unwrap();
    assert_eq!(thread_labels(&conn, "acct", "t-1").unwrap(), vec!["l-1", "l-2"]);

    replace_labels(&conn, &[label("l-2", "Home")]).unwrap();

    // Left behind, they would be a label nobody can see, name or remove — and
    // a filter counting conversations it cannot show.
    assert_eq!(thread_labels(&conn, "acct", "t-1").unwrap(), vec!["l-2"]);
}

#[test]
fn setting_the_labels_of_a_conversation_states_the_whole_set() {
    let conn = test_conn();
    replace_labels(&conn, &[label("l-1", "Work"), label("l-2", "Home")]).unwrap();

    set_thread_labels(&conn, "acct", "t-1", &["l-1".into()]).unwrap();
    set_thread_labels(&conn, "acct", "t-1", &["l-2".into()]).unwrap();
    assert_eq!(thread_labels(&conn, "acct", "t-1").unwrap(), vec!["l-2"]);

    // A label nobody made cannot be put on anything, however it is asked for.
    set_thread_labels(&conn, "acct", "t-1", &["l-9".into()]).unwrap();
    assert!(thread_labels(&conn, "acct", "t-1").unwrap().is_empty());

    // Another account's conversation of the same name is a different one.
    set_thread_labels(&conn, "acct", "t-1", &["l-1".into()]).unwrap();
    assert!(thread_labels(&conn, "other", "t-1").unwrap().is_empty());
}

#[test]
fn a_rule_adds_a_label_without_removing_the_ones_already_there() {
    let conn = test_conn();
    replace_labels(&conn, &[label("l-1", "Work"), label("l-2", "Home")]).unwrap();
    set_thread_labels(&conn, "acct", "t-1", &["l-1".into()]).unwrap();

    add_thread_label(&conn, "acct", "t-1", "l-2").unwrap();

    // "Also label this" is not "these are now its labels": a rule must not
    // quietly strip what the reader put there by hand.
    assert_eq!(thread_labels(&conn, "acct", "t-1").unwrap(), vec!["l-1", "l-2"]);

    // Saying it twice changes nothing.
    add_thread_label(&conn, "acct", "t-1", "l-2").unwrap();
    assert_eq!(thread_labels(&conn, "acct", "t-1").unwrap().len(), 2);
}

#[test]
fn a_page_can_be_narrowed_to_one_label() {
    let conn = test_conn();
    replace_labels(&conn, &[label("l-1", "Work")]).unwrap();
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            MessageHeader { uid: 1, date: 100, thread_key: "t-1".into(), ..Default::default() },
            MessageHeader { uid: 2, date: 200, thread_key: "t-2".into(), ..Default::default() },
            // A second message of the labelled thread: a label is on the
            // conversation, so this one is in the answer too.
            MessageHeader { uid: 3, date: 300, thread_key: "t-1".into(), ..Default::default() },
        ],
    )
    .unwrap();
    set_thread_labels(&conn, "acct", "t-1", &["l-1".into()]).unwrap();

    let labelled = RecentFilter {
        label_id: Some("l-1".into()),
        ..Default::default()
    };
    let uids = get_recent_page(&conn, "acct", "INBOX", 50, None, labelled)
        .unwrap()
        .0
        .into_iter()
        .map(|header| header.uid)
        .collect::<Vec<_>>();
    assert_eq!(uids, vec![3, 1]);
}

#[test]
fn the_labels_of_a_whole_page_are_read_in_one_go() {
    let conn = test_conn();
    replace_labels(&conn, &[label("l-1", "Work"), label("l-2", "Home")]).unwrap();
    set_thread_labels(&conn, "acct", "t-1", &["l-2".into(), "l-1".into()]).unwrap();
    set_thread_labels(&conn, "acct", "t-2", &["l-2".into()]).unwrap();

    let found = labels_for_threads(&conn, "acct", &["t-1".into(), "t-2".into(), "t-3".into()]).unwrap();
    // In the order the labels were arranged, not the order they were applied.
    assert_eq!(found.get("t-1"), Some(&vec!["l-1".to_string(), "l-2".to_string()]));
    assert_eq!(found.get("t-2"), Some(&vec!["l-2".to_string()]));
    assert_eq!(found.get("t-3"), None);
    assert!(labels_for_threads(&conn, "acct", &[]).unwrap().is_empty());
}

#[test]
fn rules_are_kept_and_returned_in_the_order_they_run() {
    let conn = test_conn();
    replace_rules(
        &conn,
        &[
            ("r-1".into(), String::new(), true, "{\"name\":\"first\"}".into()),
            ("r-2".into(), "acct".into(), false, "{\"name\":\"second\"}".into()),
        ],
    )
    .unwrap();

    // Order is part of the meaning: rules run top to bottom and one can stop
    // the rest, so it cannot be left to however SQLite feels like answering.
    let stored = rules(&conn).unwrap();
    assert_eq!(stored, vec!["{\"name\":\"first\"}", "{\"name\":\"second\"}"]);

    // Saving replaces the whole list rather than adding to it.
    replace_rules(&conn, &[("r-3".into(), String::new(), true, "{\"name\":\"only\"}".into())]).unwrap();
    assert_eq!(rules(&conn).unwrap(), vec!["{\"name\":\"only\"}"]);

    replace_rules(&conn, &[]).unwrap();
    assert!(rules(&conn).unwrap().is_empty());
}

#[test]
fn the_record_of_what_the_rules_did_is_kept_newest_first_and_bounded() {
    let conn = test_conn();
    let entry = |n: i64| RuleLogEntry {
        at: 1_700_000_000 + n,
        account: "acct".into(),
        rule_id: "r-1".into(),
        rule_name: "Reports".into(),
        folder: "INBOX".into(),
        uid: n as u32,
        subject: format!("Message {n}"),
        from_addr: "team@example.com".into(),
        action: "moveTo:Reports".into(),
        outcome: "done".into(),
    };
    for n in 0..3 {
        log_rule_action(&conn, &entry(n)).unwrap();
    }

    // Most recent first: the question a reader asks is "what just moved my
    // mail", not "what moved it first".
    let read = rule_log(&conn, 10).unwrap();
    assert_eq!(read.len(), 3);
    assert_eq!(read[0].subject, "Message 2");
    assert_eq!(read[0].action, "moveTo:Reports");

    assert_eq!(rule_log(&conn, 1).unwrap().len(), 1);

    clear_rule_log(&conn).unwrap();
    assert!(rule_log(&conn, 10).unwrap().is_empty());
}

#[test]
fn the_record_stops_growing_at_its_limit() {
    let conn = test_conn();
    let entry = |n: i64| RuleLogEntry {
        at: n,
        account: "acct".into(),
        rule_id: "r-1".into(),
        rule_name: "Reports".into(),
        folder: "INBOX".into(),
        uid: n as u32,
        subject: format!("Message {n}"),
        from_addr: "team@example.com".into(),
        action: "star".into(),
        outcome: "done".into(),
    };
    for n in 0..(RULE_LOG_LIMIT + 5) {
        log_rule_action(&conn, &entry(n)).unwrap();
    }

    // A busy mailbox must not grow a log without end.
    let read = rule_log(&conn, RULE_LOG_LIMIT * 2).unwrap();
    assert_eq!(read.len() as i64, RULE_LOG_LIMIT);
    // And what is dropped is the oldest, not the newest.
    assert_eq!(read[0].subject, format!("Message {}", RULE_LOG_LIMIT + 4));
}

#[test]
fn a_message_written_now_waits_for_its_hour_and_then_is_due() {
    let conn = test_conn();
    let now = 1_700_000_000i64;

    schedule_send(&conn, "s-1", "acct", now + 3600, "Later", r#"{"to":"you@example.com"}"#)
        .unwrap();
    schedule_send(&conn, "s-2", "acct", now - 60, "Now", r#"{"to":"you@example.com"}"#).unwrap();

    // Both are findable: a message put off is one the writer can still change
    // their mind about.
    let waiting = scheduled_sends(&conn, Some("acct")).unwrap();
    assert_eq!(waiting.len(), 2);
    assert_eq!(waiting[0].id, "s-2", "soonest first");

    // Only the one whose hour has come is handed to the watch.
    let due = due_scheduled_sends(&conn, now).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].id, "s-2");
    assert_eq!(due[0].payload, r#"{"to":"you@example.com"}"#, "the message itself is kept");

    // Cancelling gives the message back rather than taking it away.
    let cancelled = cancel_scheduled_send(&conn, "s-2").unwrap().expect("was scheduled");
    assert_eq!(cancelled.payload, r#"{"to":"you@example.com"}"#);
    assert!(due_scheduled_sends(&conn, now).unwrap().is_empty());
    assert_eq!(scheduled_sends(&conn, Some("acct")).unwrap().len(), 1);

    // Cancelling something already gone is not an error, and says so.
    assert!(cancel_scheduled_send(&conn, "s-2").unwrap().is_none());
}

#[test]
fn a_refused_message_waits_longer_each_time_and_eventually_stops() {
    let conn = test_conn();
    let now = 1_700_000_000i64;
    schedule_send(&conn, "s-1", "acct", now - 10, "Later", "{}").unwrap();

    let mut attempts = 0;
    let mut clock = now;
    // Each refusal doubles the wait, so the tries spread over half an hour
    // rather than being spent in five minutes of one outage.
    for _ in 0..MAX_SEND_ATTEMPTS {
        assert_eq!(due_scheduled_sends(&conn, clock).unwrap().len(), 1, "due at {clock}");
        attempts = record_send_failure(&conn, "s-1", "no route to host", clock).unwrap();
        assert!(
            due_scheduled_sends(&conn, clock).unwrap().is_empty(),
            "not tried twice in the same moment"
        );
        clock += RETRY_BACKOFF_SECONDS * (1 << attempts);
    }
    assert_eq!(attempts, MAX_SEND_ATTEMPTS);

    // Having given up, it is no longer tried — but it is still there, with the
    // reason, because a message that failed is the one its writer most needs
    // to see.
    assert!(due_scheduled_sends(&conn, clock + 86_400).unwrap().is_empty());
    let left = scheduled_sends(&conn, None).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].last_error, "no route to host");
    assert_eq!(left[0].attempts, MAX_SEND_ATTEMPTS);
}

#[test]
fn a_message_no_retry_could_help_is_failed_at_once() {
    let conn = test_conn();
    let now = 1_700_000_000i64;
    schedule_send(&conn, "s-1", "acct", now - 10, "Later", "not json").unwrap();

    give_up_on_send(&conn, "s-1", "this message can no longer be read", now).unwrap();

    // Not retried for half an hour on the pretence that something might
    // change, and not dropped either.
    assert!(due_scheduled_sends(&conn, now + 86_400).unwrap().is_empty());
    let left = scheduled_sends(&conn, None).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].attempts, MAX_SEND_ATTEMPTS);
    assert_eq!(left[0].last_error, "this message can no longer be read");
}

#[test]
fn rescheduling_a_message_moves_it_rather_than_copying_it() {
    let conn = test_conn();
    let now = 1_700_000_000i64;
    schedule_send(&conn, "s-1", "acct", now + 3600, "Later", "{}").unwrap();
    record_send_failure(&conn, "s-1", "refused", now).unwrap();
    schedule_send(&conn, "s-1", "acct", now + 7200, "Later", "{}").unwrap();

    let waiting = scheduled_sends(&conn, None).unwrap();
    assert_eq!(waiting.len(), 1, "one message goes once");
    assert_eq!(waiting[0].due_at, now + 7200);
    assert_eq!(waiting[0].attempts, 0, "a new hour is a fresh start, not a spent one");
    assert_eq!(waiting[0].last_error, "");
}

#[test]
fn putting_one_thread_aside_twice_replaces_the_first_answer() {
    let conn = test_conn();
    let now = 1_700_000_000i64;
    snooze_thread(&conn, "acct", "t-1", "INBOX", now + 3600).unwrap();
    snooze_thread(&conn, "acct", "t-1", "INBOX", now + 7200).unwrap();

    let listed = snoozed_threads(&conn, "acct").unwrap();
    assert_eq!(listed.len(), 1, "one thread is set aside once, for one time");
    assert_eq!(listed[0].2, now + 7200, "and the later answer is the one that stands");
}

#[test]
fn draft_thread_keys_detects_special_use_and_name_fallback() {
    let conn = test_conn();
    upsert_folders(
        &conn,
        "acct",
        &[
            Folder {
                name: "Mail/Entwürfe".to_string(),
                special_use: Some("drafts".to_string()),
                ..Default::default()
            },
            Folder {
                name: "[Gmail]/Drafts".to_string(),
                ..Default::default()
            },
            Folder {
                name: "INBOX".to_string(),
                ..Default::default()
            },
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO messages(account, folder, msg_id, uid, subject, thread_key)
         VALUES('acct', 'Mail/Entwürfe', '1', 1, 'draft', 'root@h'),
               ('acct', '[Gmail]/Drafts', '2', 2, 'draft', 'other@h'),
               ('acct', 'INBOX', '3', 3, 'not draft', 'inbox@h')",
        [],
    )
    .unwrap();

    let keys = draft_thread_keys(&conn, "acct").unwrap();
    assert!(keys.contains("root@h"));
    assert!(keys.contains("other@h"));
    assert!(!keys.contains("inbox@h"));
}

#[test]
fn search_messages_matches_subject_sender_and_body_case_insensitively() {
    let conn = test_conn();
    insert_message(&conn, 1, "Quarterly Plan", "Aki", "aki@example.com", None);
    insert_message(&conn, 2, "Hello", "Launch Team", "team@example.com", None);
    insert_message(
        &conn,
        3,
        "Notes",
        "Ops",
        "ops@example.com",
        Some("The deploy window is confirmed."),
    );
    insert_message(&conn, 4, "Other", "No Match", "other@example.com", None);

    let subject = search_messages(&conn, "acct", "INBOX", "quarterly", 10, None).unwrap();
    assert_eq!(subject.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![1]);

    let sender = search_messages(&conn, "acct", "INBOX", "launch", 10, None).unwrap();
    assert_eq!(sender.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![2]);

    let body = search_messages(&conn, "acct", "INBOX", "DEPLOY", 10, None).unwrap();
    assert_eq!(body.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![3]);
}

#[test]
fn search_messages_matches_substrings_including_cjk() {
    let conn = test_conn();
    insert_message(
        &conn,
        1,
        "Quarterly planning",
        "Aki",
        "aki@example.com",
        None,
    );
    insert_message(&conn, 2, "上海会议通知", "Aki", "aki@example.com", None);

    // Mid-word Latin substring (trigram, >= 3 chars).
    let latin = search_messages(&conn, "acct", "INBOX", "arter", 10, None).unwrap();
    assert_eq!(latin.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![1]);

    // CJK substring with no surrounding word breaks (>= 3 chars -> FTS).
    let cjk = search_messages(&conn, "acct", "INBOX", "会议通", 10, None).unwrap();
    assert_eq!(cjk.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![2]);

    let miss = search_messages(&conn, "acct", "INBOX", "zzz", 10, None).unwrap();
    assert!(miss.is_empty());
}

#[test]
fn search_messages_short_query_falls_back_to_like() {
    // Queries below the trigram minimum (3 codepoints) must still match via
    // the LIKE fallback — important for 2-character CJK words.
    let conn = test_conn();
    insert_message(&conn, 1, "上海会议通知", "Aki", "aki@example.com", None);
    insert_message(&conn, 2, "Other", "Aki", "aki@example.com", None);

    let hit = search_messages(&conn, "acct", "INBOX", "上海", 10, None).unwrap();
    assert_eq!(hit.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![1]);
}

#[test]
fn search_messages_reindexes_on_body_update() {
    // The FTS triggers must follow a later body write, not just the initial insert.
    let conn = test_conn();
    insert_message(&conn, 1, "Notes", "Ops", "ops@example.com", None);
    assert!(
        search_messages(&conn, "acct", "INBOX", "deploy", 10, None)
            .unwrap()
            .is_empty()
    );

    conn.execute(
        "UPDATE messages SET body = 'deploy window confirmed' WHERE uid = 1",
        [],
    )
    .unwrap();

    let hit = search_messages(&conn, "acct", "INBOX", "deploy", 10, None).unwrap();
    assert_eq!(hit.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![1]);
}

#[test]
fn search_messages_matches_to_and_cc_recipients() {
    // Recipients live in the JSON catch-all, so they are searchable only through
    // the mirrored `recipients` column and its index — both the trigram path and
    // the short-query LIKE fallback must see them.
    let conn = test_conn();
    upsert_messages(
        &conn,
        "acct",
        "Sent",
        &[MessageHeader {
            uid: 1,
            subject: "Lunch".to_string(),
            from_addr: "me@example.com".to_string(),
            to: vec![crate::imap::Recipient {
                name: "Ann Baker".to_string(),
                addr: "ann@example.com".to_string(),
            }],
            cc: vec![crate::imap::Recipient {
                name: String::new(),
                addr: "ops@example.com".to_string(),
            }],
            ..Default::default()
        }],
    )
    .unwrap();

    for query in ["Ann Baker", "ann@example", "ops@example", "an"] {
        let hits = search_messages(&conn, "acct", "Sent", query, 10, None).unwrap();
        assert_eq!(
            hits.iter().map(|m| m.uid).collect::<Vec<_>>(),
            vec![1],
            "query: {query}"
        );
    }
    assert!(
        search_messages(&conn, "acct", "Sent", "zoe@example", 10, None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn search_messages_keeps_indexed_recipients_through_a_flag_only_resync() {
    // A flag-only resync carries no envelope; it must not blank the recipients
    // the envelope fetch already indexed.
    let conn = test_conn();
    let envelope = MessageHeader {
        uid: 1,
        subject: "Lunch".to_string(),
        to: vec![crate::imap::Recipient {
            name: "Ann".to_string(),
            addr: "ann@example.com".to_string(),
        }],
        ..Default::default()
    };
    upsert_messages(&conn, "acct", "INBOX", &[envelope]).unwrap();
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader {
            uid: 1,
            subject: "Lunch".to_string(),
            seen: true,
            ..Default::default()
        }],
    )
    .unwrap();

    let hits = search_messages(&conn, "acct", "INBOX", "ann@example", 10, None).unwrap();
    assert_eq!(hits.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![1]);
}

#[test]
fn migration_indexes_recipients_already_cached_before_v6() {
    // An existing install carries its recipients only in `json`; the upgrade has
    // to backfill and index them, or search stays blind to everything synced
    // before it.
    let conn = Connection::open_in_memory().unwrap();
    db::migrate_to_v5(&conn).unwrap();
    conn.execute(
        "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, json)
         VALUES('acct', 'Sent', '1', 1, 'Lunch', 'Me', 'me@example.com', 100,
                '{\"to\":[{\"name\":\"Ann Baker\",\"addr\":\"ann@example.com\"}]}')",
        [],
    )
    .unwrap();

    db::run_migrations(&conn).unwrap();

    let hits = search_messages(&conn, "acct", "Sent", "ann@example", 10, None).unwrap();
    assert_eq!(hits.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![1]);
}

#[test]
fn search_messages_pages_with_a_keyset_cursor() {
    let conn = test_conn();
    for uid in 1..=3u32 {
        conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date)
             VALUES('acct', 'INBOX', ?1, ?2, 'deploy notes', 'Ops', 'ops@example.com', ?3)",
            params![uid.to_string(), uid, 100 * uid as i64],
        )
        .unwrap();
    }

    let first = search_messages(&conn, "acct", "INBOX", "deploy", 2, None).unwrap();
    assert_eq!(first.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![3, 2]);
    let cursor = crate::thread_list::SearchCursor {
        date: 200,
        uid: 2,
        folder: "INBOX".to_string(),
        scanned: 2,
        snapshot: None,
        offset: 0,
    };

    let second = search_messages(&conn, "acct", "INBOX", "deploy", 2, Some(&cursor)).unwrap();
    assert_eq!(second.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![1]);
    // A short page means the result set is exhausted, so paging stops.
    assert!(search_next_cursor(&second, 2, 4).is_none());
}

#[test]
fn search_messages_in_folders_merges_newest_first_and_tags_the_folder() {
    let conn = test_conn();
    let insert = |folder: &str, uid: u32, date: i64| {
        conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date)
             VALUES('acct', ?1, ?2, ?3, 'deploy notes', 'Ops', 'ops@example.com', ?4)",
            params![folder, uid.to_string(), uid, date],
        )
        .unwrap();
    };
    insert("INBOX", 1, 100);
    insert("Sent", 1, 200);
    insert("Archive", 9, 300);

    let hits = search_messages_in_folders(
        &conn,
        "acct",
        &["INBOX".to_string(), "Sent".to_string()],
        "deploy",
        10,
        None,
    )
    .unwrap();
    // Folder-scoped UIDs collide across mailboxes, so both uid-1 rows survive;
    // the un-searched folder does not.
    assert_eq!(
        hits.iter()
            .map(|m| (m.folder.as_str(), m.uid))
            .collect::<Vec<_>>(),
        vec![("Sent", 1), ("INBOX", 1)]
    );
}

#[test]
fn search_messages_in_folders_pages_across_equal_folder_scoped_uids() {
    let conn = test_conn();
    for folder in ["INBOX", "Sent"] {
        conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date)
             VALUES('acct', ?1, '1', 1, 'deploy notes', 'Ops', 'ops@example.com', 100)",
            params![folder],
        )
        .unwrap();
    }

    let folders = ["INBOX".to_string(), "Sent".to_string()];
    let first = search_messages_in_folders(&conn, "acct", &folders, "deploy", 1, None).unwrap();
    assert_eq!(first[0].folder, "Sent");

    let cursor = crate::thread_list::parse_search_cursor(
        &search_next_cursor(&first, 1, 1).expect("full page has a cursor"),
    )
    .unwrap();
    let second =
        search_messages_in_folders(&conn, "acct", &folders, "deploy", 1, Some(&cursor)).unwrap();
    assert_eq!(second[0].folder, "INBOX");
}

#[test]
fn search_snapshot_pages_in_resolved_date_order_when_uids_diverge() {
    let conn = test_conn();
    for (uid, date) in [(3u32, 100i64), (2, 300), (1, 200)] {
        conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date)
             VALUES('acct', 'INBOX', ?1, ?2, 'deploy notes', 'Ops', 'ops@example.com', ?3)",
            params![uid.to_string(), uid, date],
        )
        .unwrap();
    }
    let folders = ["INBOX".to_string()];
    let mut hits =
        search_messages_in_folders(&conn, "acct", &folders, "deploy", u32::MAX, None).unwrap();
    sort_search_hits_all(&mut hits);
    assert_eq!(
        hits.iter().map(|message| message.uid).collect::<Vec<_>>(),
        vec![2, 1, 3]
    );

    let token = save_search_snapshot(&conn, "acct", "deploy", &folders, &hits).unwrap();
    let first = get_search_snapshot_page(&conn, "acct", "deploy", &folders, &token, 0, 1)
        .unwrap()
        .unwrap();
    assert_eq!(first.messages[0].uid, 2);
    assert!(first.has_more);

    let second = get_search_snapshot_page(
        &conn,
        "acct",
        "deploy",
        &folders,
        &token,
        first.next_offset,
        1,
    )
    .unwrap()
    .unwrap();
    assert_eq!(second.messages[0].uid, 1);
    assert!(
        get_search_snapshot_page(&conn, "acct", "different", &folders, &token, 0, 1)
            .unwrap()
            .is_none()
    );
}

#[test]
fn get_starred_all_accounts_spans_accounts_and_skips_rss_rows() {
    let conn = test_conn();
    let insert = |account: &str, folder: &str, uid: u32, subject: &str, date: i64, starred: i64| {
        conn.execute(
                "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, seen, starred)
                 VALUES(?1, ?2, ?3, ?4, ?5, 'Aki', 'aki@example.com', ?6, 1, ?7)",
                params![account, folder, uid.to_string(), uid, subject, date, starred],
            )
            .unwrap();
    };
    insert("a1", "INBOX", 1, "Starred newer", 1_767_312_000, 1); // 2026-01-02
    insert("a1", "INBOX", 2, "Not starred", 1_767_398_400, 0); // 2026-01-03
    insert("a2", "Sent", 5, "Starred older", 1_767_225_600, 1); // 2026-01-01
    // RSS row: uid = 0, must be excluded even when starred.
    conn.execute(
        "INSERT INTO messages(account, folder, msg_id, uid, subject, date, seen, starred)
             VALUES('rss-acct', 'feed-1', 'item-1', 0, 'Feed item', 0, 1, 1)",
        [],
    )
    .unwrap();

    let starred = get_starred_all_accounts(&conn, 10).unwrap();
    assert_eq!(
        starred
            .iter()
            .map(|(account, m)| (account.as_str(), m.folder.as_str(), m.uid))
            .collect::<Vec<_>>(),
        vec![("a1", "INBOX", 1), ("a2", "Sent", 5)]
    );
    assert!(starred.iter().all(|(_, m)| m.starred));
}

#[test]
fn get_starred_all_accounts_budgets_threads_not_rows() {
    let conn = test_conn();
    let insert = |folder: &str, uid: u32, thread_key: &str, date: i64| {
        conn.execute(
                "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, seen, starred, thread_key)
                 VALUES('a1', ?1, ?2, ?3, 'Subject', 'Aki', 'aki@example.com', ?4, 1, 1, ?5)",
                params![folder, format!("{folder}-{uid}"), uid, date, thread_key],
            )
            .unwrap();
    };
    // Two conversations, each cached in Inbox and All Mail the way Gmail files
    // them, plus an older third conversation.
    for (folder, uid_base) in [("INBOX", 10), ("All Mail", 20)] {
        insert(folder, uid_base + 1, "newest@example.com", 300);
        insert(folder, uid_base + 2, "middle@example.com", 200);
        insert(folder, uid_base + 3, "oldest@example.com", 100);
    }

    // A budget of two threads spends nothing on the duplicate folder copies: it
    // reaches back through both copies of the two newest conversations.
    let starred = get_starred_all_accounts(&conn, 2).unwrap();
    let mut keys = starred
        .iter()
        .map(|(_, m)| m.thread_key.as_str())
        .collect::<Vec<_>>();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(keys, vec!["middle@example.com", "newest@example.com"]);
    assert_eq!(starred.len(), 4);

    // Room for every conversation still returns every copy of each.
    assert_eq!(get_starred_all_accounts(&conn, 3).unwrap().len(), 6);
}

#[test]
fn get_starred_all_accounts_counts_unthreaded_messages_per_folder() {
    let conn = test_conn();
    // No thread_key at all: these fall back to "uid:<uid>", and a UID only means
    // something inside its own mailbox, so these are two conversations.
    for (folder, date) in [("INBOX", 200), ("Archive", 100)] {
        conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, seen, starred)
             VALUES('a1', ?1, ?2, 1, 'Subject', 'Aki', 'aki@example.com', ?3, 1, 1)",
            params![folder, format!("{folder}-1"), date],
        )
        .unwrap();
    }

    let one = get_starred_all_accounts(&conn, 1).unwrap();
    assert_eq!(
        one.iter()
            .map(|(_, m)| m.folder.as_str())
            .collect::<Vec<_>>(),
        vec!["INBOX"]
    );
    let both = get_starred_all_accounts(&conn, 2).unwrap();
    assert_eq!(both.len(), 2);
}

#[test]
fn get_starred_all_accounts_counts_subject_branches_as_separate_conversations() {
    let conn = test_conn();
    // One root thread key that branched by subject: the list shows a card per
    // branch, so the budget has to count them the same way.
    for (uid, subject, date) in [(1, "Sprint planning", 300), (2, "Lunch orders", 200)] {
        conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, seen, starred, thread_key)
             VALUES('a1', 'INBOX', ?1, ?2, ?3, 'Aki', 'aki@example.com', ?4, 1, 1, 'root@example.com')",
            params![format!("m-{uid}"), uid, subject, date],
        )
        .unwrap();
    }

    let one = get_starred_all_accounts(&conn, 1).unwrap();
    assert_eq!(
        one.iter()
            .map(|(_, m)| m.subject.as_str())
            .collect::<Vec<_>>(),
        vec!["Sprint planning"]
    );
    assert_eq!(get_starred_all_accounts(&conn, 2).unwrap().len(), 2);
}

#[test]
fn get_starred_all_accounts_keeps_copies_of_admitted_threads_past_the_budget() {
    let conn = test_conn();
    let insert = |folder: &str, uid: u32, thread_key: &str, date: i64| {
        conn.execute(
                "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, seen, starred, thread_key)
                 VALUES('a1', ?1, ?2, ?3, 'Subject', 'Aki', 'aki@example.com', ?4, 1, 1, ?5)",
                params![folder, format!("{folder}-{uid}"), uid, date, thread_key],
            )
            .unwrap();
    };
    // Two folders' copies of one message can hold different cached dates, which
    // puts an over-budget conversation between them in this ordering.
    insert("All Mail", 1, "kept@example.com", 300);
    insert("INBOX", 2, "over-budget@example.com", 200);
    insert("INBOX", 3, "kept@example.com", 100);

    let starred = get_starred_all_accounts(&conn, 1).unwrap();
    assert!(
        starred
            .iter()
            .all(|(_, m)| m.thread_key == "kept@example.com"),
        "over-budget conversation must not be admitted"
    );
    // Both copies of the admitted conversation come back: the caller chooses
    // which folder's card to show from this set, and dropping the Inbox copy
    // here would file the thread under All Mail instead.
    let mut folders = starred
        .iter()
        .map(|(_, m)| m.folder.as_str())
        .collect::<Vec<_>>();
    folders.sort_unstable();
    assert_eq!(folders, vec!["All Mail", "INBOX"]);
}

#[test]
fn card_message_counts_span_the_folder_not_the_page() {
    use crate::imap::MessageHeader;
    let conn = test_conn();
    let insert = |uid: u32, subject: &str, seen: i64| {
        conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr,
                                  date, seen, thread_key)
             VALUES('acct', 'INBOX', ?1, ?2, ?3, 'Aki', 'aki@example.com', 1779580800, ?4,
                    'root@example.com')",
            params![uid.to_string(), uid, subject, seen],
        )
        .unwrap();
    };
    insert(1, "Old topic", 1);
    insert(2, "Re: Old topic", 1);
    insert(3, "Re: Old topic", 0);
    insert(4, "New topic", 0);

    let card_key = |uid: u32, subject: &str| {
        card_thread_key(&MessageHeader {
            uid,
            subject: subject.to_string(),
            thread_key: "root@example.com".to_string(),
            ..Default::default()
        })
    };
    let old_key = card_key(1, "Old topic");
    let new_key = card_key(4, "New topic");

    // The unread view hands grouping only the two unread messages, so the cards
    // it produces tally one message each.
    let (page, _) = get_recent_page(&conn, "acct", "INBOX", 50, None, RecentFilter::unread()).unwrap();
    let cards = group_thread_cards(page, "INBOX");
    let keys = cards
        .iter()
        .map(|card| card.thread_key.clone())
        .collect::<Vec<_>>();
    assert!(cards.iter().all(|card| card.message_count == 1));

    // The cache knows better: the old branch holds three messages (one unread),
    // and the drifted subject is counted as its own branch, not folded in.
    let counts = card_message_counts(&conn, "acct", "INBOX", &keys).unwrap();
    assert_eq!(counts.get(&old_key).copied(), Some(3));
    assert_eq!(counts.get(&new_key).copied(), Some(1));
}

#[test]
fn card_message_counts_span_folders_and_dedupe_self_sent_copies() {
    use crate::imap::MessageHeader;
    let conn = test_conn();
    let insert = |folder: &str, uid: u32, subject: &str, thread_key: &str, message_id: &str| {
        conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr,
                                  date, seen, thread_key, json)
             VALUES('acct', ?1, ?2, ?3, ?4, 'Aki', 'aki@example.com', 1779580800, 1, ?5,
                    json_object('message_id', ?6))",
            params![
                folder,
                format!("{folder}-{uid}"),
                uid,
                subject,
                thread_key,
                message_id
            ],
        )
        .unwrap();
    };
    // A received message and the reply the user sent back: one thread, two
    // folders. The Sent reply is also cached in All Mail, as Gmail serves it.
    insert(
        "INBOX",
        1,
        "Old topic",
        "root@example.com",
        "<a@example.com>",
    );
    insert(
        "Sent",
        7,
        "Re: Old topic",
        "root@example.com",
        "<b@example.com>",
    );
    insert(
        "All Mail",
        9,
        "Re: Old topic",
        "root@example.com",
        "<b@example.com>",
    );
    insert(
        "INBOX",
        10,
        "Gmail topic",
        "gmthrid:123",
        "<gmail-a@example.com>",
    );
    insert(
        "Sent",
        11,
        "Different Gmail subject",
        "gmthrid:123",
        "<gmail-b@example.com>",
    );
    // Same UID, different folder, no threading headers of its own.
    insert("INBOX", 4, "Standalone", "", "<c@example.com>");
    insert("Archive", 4, "Unrelated", "", "<d@example.com>");

    let threaded = card_thread_key(&MessageHeader {
        uid: 1,
        subject: "Old topic".to_string(),
        thread_key: "root@example.com".to_string(),
        ..Default::default()
    });
    let gmail_threaded = "gmthrid:123".to_string();
    let counts = card_message_counts(
        &conn,
        "acct",
        "INBOX",
        &[
            threaded.clone(),
            gmail_threaded.clone(),
            "uid:4".to_string(),
        ],
    )
    .unwrap();

    // Two bubbles open in the reader, so the row says two: the All Mail copy of
    // the Sent reply is folded by Message-ID, not counted twice.
    assert_eq!(counts.get(&threaded).copied(), Some(2));
    // Gmail's atomic thread key also spans folders even though it does not
    // branch by subject: only synthetic uid: keys are folder-local.
    assert_eq!(counts.get(&gmail_threaded).copied(), Some(2));
    // A synthetic uid: key stays folder-local; the unrelated Archive row that
    // happens to share UID 4 is not part of this thread.
    assert_eq!(counts.get("uid:4").copied(), Some(1));
}

#[test]
fn get_recent_page_can_return_only_unread_messages() {
    let conn = test_conn();
    insert_message(&conn, 2, "Unread older", "Aki", "aki@example.com", None);
    insert_message(&conn, 3, "Unread middle", "Aki", "aki@example.com", None);
    insert_message(&conn, 4, "Read middle", "Aki", "aki@example.com", None);
    insert_message(&conn, 5, "Unread newest", "Aki", "aki@example.com", None);
    conn.execute(
        "UPDATE messages SET seen = 1 WHERE account = 'acct' AND folder = 'INBOX' AND uid = 4",
        [],
    )
    .unwrap();

    // insert_message stamps every row with the same date, so the date-ordered
    // list ties break on uid DESC and the cursor carries that shared date.
    const D: i64 = 1779580800;
    let (all, all_cursor) = get_recent_page(&conn, "acct", "INBOX", 2, None, RecentFilter::default()).unwrap();
    assert_eq!(all.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![5, 4]);
    assert_eq!(all_cursor.as_deref(), Some(format!("date:{D}:4").as_str()));

    let (unread, unread_cursor) = get_recent_page(&conn, "acct", "INBOX", 2, None, RecentFilter::unread()).unwrap();
    assert_eq!(unread.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![5, 3]);
    assert_eq!(
        unread_cursor.as_deref(),
        Some(format!("date:{D}:3").as_str())
    );
    assert!(unread.iter().all(|m| !m.seen));

    let (next_unread, next_cursor) =
        get_recent_page(&conn, "acct", "INBOX", 2, Some(crate::thread_list::PageCursor { date: D, text: String::new(), uid: 3 }), RecentFilter::unread()).unwrap();
    assert_eq!(
        next_unread.iter().map(|m| m.uid).collect::<Vec<_>>(),
        vec![2]
    );
    assert_eq!(next_cursor, None);
}

#[test]
fn new_unread_inbox_messages_counts_uid_window_and_latest_unread() {
    let conn = test_conn();
    let inbox_messages = vec![
        MessageHeader {
            uid: 1,
            subject: "Before window".to_string(),
            from_addr: "old@example.com".to_string(),
            thread_key: "old".to_string(),
            ..Default::default()
        },
        MessageHeader {
            uid: 2,
            subject: "Lower bound".to_string(),
            from_addr: "lower@example.com".to_string(),
            thread_key: String::new(),
            ..Default::default()
        },
        MessageHeader {
            uid: 3,
            subject: "Already read".to_string(),
            from_addr: "read@example.com".to_string(),
            seen: true,
            thread_key: "read".to_string(),
            ..Default::default()
        },
        MessageHeader {
            uid: 4,
            subject: "Latest unread".to_string(),
            from_name: "Aki".to_string(),
            from_addr: "aki@example.com".to_string(),
            thread_key: "fresh".to_string(),
            ..Default::default()
        },
        MessageHeader {
            uid: 5,
            subject: "Upper bound excluded".to_string(),
            from_addr: "upper@example.com".to_string(),
            thread_key: "upper".to_string(),
            ..Default::default()
        },
    ];
    upsert_messages(&conn, "acct", "INBOX", &inbox_messages).unwrap();
    upsert_messages(
        &conn,
        "acct",
        "Archive",
        &[MessageHeader {
            uid: 4,
            subject: "Wrong folder".to_string(),
            from_addr: "archive@example.com".to_string(),
            thread_key: "archive".to_string(),
            ..Default::default()
        }],
    )
    .unwrap();

    let synced = inbox_messages[1..4].to_vec();
    let arrivals = new_unread_inbox_messages(&conn, "acct", 2, 5, &synced)
        .unwrap()
        .unwrap();
    assert_eq!(arrivals.len(), 2);
    let latest = &arrivals[0];
    assert_eq!(latest.uid, 4);
    assert_eq!(latest.subject, "Latest unread");
    assert_eq!(latest.thread_key, "fresh");

    let conn = test_conn();
    let lower = vec![MessageHeader {
        uid: 2,
        subject: "Lower bound".to_string(),
        from_addr: "lower@example.com".to_string(),
        thread_key: String::new(),
        ..Default::default()
    }];
    upsert_messages(&conn, "acct", "INBOX", &lower).unwrap();
    let lower_bound = new_unread_inbox_messages(&conn, "acct", 2, 3, &lower)
        .unwrap()
        .unwrap()
        .remove(0);
    assert_eq!(lower_bound.uid, 2);
    assert_eq!(lower_bound.thread_key, "uid:2");
}

#[test]
fn cached_body_preview_collapses_body_and_misses_without_a_cached_body() {
    let conn = test_conn();
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader {
            uid: 7,
            subject: "Lunch".to_string(),
            from_addr: "aki@example.com".to_string(),
            ..Default::default()
        }],
    )
    .unwrap();

    // Header only: no snippet to show yet.
    assert!(cached_body_preview(&conn, "acct", "INBOX", 7).is_none());

    save_cached_message(
        &conn,
        "acct",
        "INBOX",
        7,
        &Message {
            subject: "Lunch".into(),
            body: "  Are we still on\n\n  for lunch?  ".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        cached_body_preview(&conn, "acct", "INBOX", 7).unwrap(),
        "Are we still on for lunch?"
    );

    // A whitespace-only body is a miss, not an empty snippet line.
    save_cached_message(
        &conn,
        "acct",
        "INBOX",
        7,
        &Message {
            subject: "Lunch".into(),
            body: "   \n  ".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(cached_body_preview(&conn, "acct", "INBOX", 7).is_none());
}

#[test]
fn new_unread_inbox_messages_ignores_empty_or_non_growing_windows() {
    let conn = test_conn();
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader {
            uid: 1,
            subject: "Unread".to_string(),
            from_addr: "new@example.com".to_string(),
            thread_key: "new".to_string(),
            ..Default::default()
        }],
    )
    .unwrap();

    assert!(
        new_unread_inbox_messages(&conn, "acct", 0, 2, &[])
            .unwrap()
            .is_none()
    );
    assert!(
        new_unread_inbox_messages(&conn, "acct", 2, 2, &[])
            .unwrap()
            .is_none()
    );
    assert!(
        new_unread_inbox_messages(&conn, "acct", 3, 2, &[])
            .unwrap()
            .is_none()
    );
}

#[test]
fn new_unread_inbox_messages_ignores_observed_gmail_message_restored_with_new_uid() {
    let conn = test_conn();
    let old = vec![MessageHeader {
        uid: 10,
        subject: "Old unread".to_string(),
        from_addr: "old@example.com".to_string(),
        thread_key: "gmthrid:1".to_string(),
        gmail_msg_id: Some(999),
        ..Default::default()
    }];
    upsert_messages(&conn, "acct", "INBOX", &old).unwrap();
    backfill_observed_mail_identities(&conn, "acct").unwrap();
    delete_messages_by_uid(&conn, "acct", "INBOX", &[10]).unwrap();

    let restored = vec![MessageHeader {
        uid: 20,
        subject: "Old unread".to_string(),
        from_addr: "old@example.com".to_string(),
        thread_key: "gmthrid:1".to_string(),
        gmail_msg_id: Some(999),
        ..Default::default()
    }];
    upsert_messages(&conn, "acct", "INBOX", &restored).unwrap();

    assert!(
        new_unread_inbox_messages(&conn, "acct", 20, 21, &restored)
            .unwrap()
            .is_none()
    );
}

#[test]
fn new_unread_inbox_messages_ignores_observed_message_id_restored_with_new_uid() {
    let conn = test_conn();
    let old = vec![MessageHeader {
        uid: 10,
        subject: "Old unread".to_string(),
        from_addr: "old@example.com".to_string(),
        thread_key: "mid@example.com".to_string(),
        message_id: "Mid@Example.com".to_string(),
        ..Default::default()
    }];
    upsert_messages(&conn, "acct", "INBOX", &old).unwrap();
    backfill_observed_mail_identities(&conn, "acct").unwrap();
    delete_messages_by_uid(&conn, "acct", "INBOX", &[10]).unwrap();

    let restored = vec![MessageHeader {
        uid: 20,
        subject: "Old unread".to_string(),
        from_addr: "old@example.com".to_string(),
        thread_key: "mid@example.com".to_string(),
        message_id: "mid@example.com".to_string(),
        ..Default::default()
    }];
    upsert_messages(&conn, "acct", "INBOX", &restored).unwrap();

    assert!(
        new_unread_inbox_messages(&conn, "acct", 20, 21, &restored)
            .unwrap()
            .is_none()
    );
}

#[test]
fn resolve_message_uids_prefers_explicit_then_single_then_thread() {
    let conn = test_conn();
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            MessageHeader {
                uid: 10,
                subject: "Root".to_string(),
                from_addr: "root@example.com".to_string(),
                thread_key: "thread-a".to_string(),
                ..Default::default()
            },
            MessageHeader {
                uid: 11,
                subject: "Reply".to_string(),
                from_addr: "reply@example.com".to_string(),
                thread_key: "thread-a".to_string(),
                ..Default::default()
            },
        ],
    )
    .unwrap();

    assert_eq!(
        resolve_message_uids(
            &conn,
            "acct",
            "INBOX",
            "thread-a",
            None,
            Some(10),
            &[42, 43]
        )
        .unwrap(),
        vec![42, 43]
    );
    assert_eq!(
        resolve_message_uids(&conn, "acct", "INBOX", "", None, Some(10), &[]).unwrap(),
        vec![10]
    );
    assert_eq!(
        resolve_message_uids(&conn, "acct", "INBOX", "", None, None, &[]).unwrap(),
        Vec::<u32>::new()
    );
    assert_eq!(
        resolve_message_uids(&conn, "acct", "INBOX", "thread-a", None, None, &[]).unwrap(),
        vec![10, 11]
    );
}

#[test]
fn thread_subject_normalization_matches_desktop_prefix_semantics() {
    // Parity with the Go subjectPrefixRegex alternation in mailjson.go: every
    // listed prefix must strip when followed by a colon, including the ones
    // that share a shorter list entry ("fwd" behind "fw", "res" behind "re").
    let cases = [
        ("Re: Topic", "Topic"),
        ("Fwd: Topic", "Topic"),
        ("FWD: Topic", "Topic"),
        ("Res: Topic", "Topic"),
        ("Re[2]: Topic", "Topic"),
        ("FW(3): Topic", "Topic"),
        ("回复：主题", "主题"),
        ("Re: Fwd: Topic", "Topic"),
        // Not reply prefixes: the colon check must reject these.
        ("Ready: set", "Ready: set"),
        ("Fwdish: nope", "Fwdish: nope"),
        ("Topic", "Topic"),
    ];
    for (subject, expected) in cases {
        assert_eq!(normalize_thread_subject(subject), expected, "{subject}");
    }
    // The grouping variant additionally drops leading bracket tags.
    assert_eq!(thread_grouping_subject("[EXTERNAL] Re: Topic"), "Topic");
    assert_eq!(thread_grouping_subject("[JIRA-1] Topic"), "Topic");
}

#[test]
fn branch_compound_key_round_trips_hash_and_percent_in_root() {
    let cases = ["abc#123@host", "plain@host", "50%25#done@host"];
    for root in cases {
        let compound = branch_compound_key(root, "Topic");
        assert_eq!(
            split_branch_compound_key(&compound),
            (root.to_string(), Some("Topic".to_string())),
            "{root}"
        );
    }
    // Unbranched legacy keys pass through verbatim.
    assert_eq!(
        split_branch_compound_key("plain@host"),
        ("plain@host".to_string(), None)
    );
}

#[test]
fn group_thread_cards_branches_subject_drift_and_links_to_root() {
    use crate::imap::MessageHeader;
    let messages = vec![
        MessageHeader {
            uid: 3,
            subject: "New topic".to_string(),
            from_name: "Newest".to_string(),
            from_addr: "new@example.com".to_string(),
            date: 300,
            seen: false,
            thread_key: "refs-root".to_string(),
            ..Default::default()
        },
        MessageHeader {
            uid: 2,
            subject: "Re: Old topic".to_string(),
            from_name: "Reply".to_string(),
            from_addr: "reply@example.com".to_string(),
            date: 200,
            seen: true,
            thread_key: "refs-root".to_string(),
            ..Default::default()
        },
        MessageHeader {
            uid: 1,
            subject: "Old topic".to_string(),
            from_name: "Root".to_string(),
            from_addr: "root@example.com".to_string(),
            date: 100,
            seen: false,
            thread_key: "refs-root".to_string(),
            ..Default::default()
        },
    ];

    let cards = group_thread_cards(messages, "INBOX");
    assert_eq!(cards.len(), 2);
    assert_eq!(cards[0].thread_key, "refs-root#New topic");
    assert_eq!(
        cards[0].original_thread_key.as_deref(),
        Some("refs-root#Old topic")
    );
    assert_eq!(cards[0].header.subject, "Old topic");
    assert_eq!(cards[0].unread_count, 1);
    // Counts follow the branch, not the root thread key: the drifted subject
    // stands alone while the original keeps its reply.
    assert_eq!(cards[0].message_count, 1);
    assert!(!cards[0].header.seen);

    assert_eq!(cards[1].thread_key, "refs-root#Old topic");
    assert_eq!(cards[1].original_thread_key, None);
    assert_eq!(cards[1].header.subject, "Old topic");
    assert_eq!(cards[1].unread_count, 1);
    assert_eq!(cards[1].message_count, 2);
}

#[test]
fn group_thread_cards_keeps_uid_and_gmail_threads_atomic() {
    use crate::imap::MessageHeader;
    let uid_cards = group_thread_cards(
        vec![
            MessageHeader {
                uid: 2,
                subject: "Other".to_string(),
                thread_key: "uid:2".to_string(),
                ..Default::default()
            },
            MessageHeader {
                uid: 1,
                subject: "Root".to_string(),
                thread_key: "uid:2".to_string(),
                ..Default::default()
            },
        ],
        "INBOX",
    );
    assert_eq!(uid_cards.len(), 1);
    assert_eq!(uid_cards[0].thread_key, "uid:2");
    // Read messages count too; the badge is thread size, not unread size.
    assert_eq!(uid_cards[0].message_count, 2);

    let gmail_cards = group_thread_cards(
        vec![
            MessageHeader {
                uid: 2,
                subject: "Other".to_string(),
                thread_key: "gmthrid:abc".to_string(),
                ..Default::default()
            },
            MessageHeader {
                uid: 1,
                subject: "Root".to_string(),
                thread_key: "gmthrid:abc".to_string(),
                ..Default::default()
            },
        ],
        "INBOX",
    );
    assert_eq!(gmail_cards.len(), 1);
    assert_eq!(gmail_cards[0].thread_key, "gmthrid:abc");
    assert_eq!(gmail_cards[0].message_count, 2);
}

#[test]
fn group_thread_cards_accumulates_unread_and_starred_across_group() {
    use crate::imap::MessageHeader;
    let cards = group_thread_cards(
        vec![
            MessageHeader {
                uid: 3,
                subject: "Re: [EXTERNAL] Topic".to_string(),
                seen: false,
                starred: false,
                thread_key: "refs-root".to_string(),
                ..Default::default()
            },
            MessageHeader {
                uid: 2,
                subject: "[EXTERNAL] Topic".to_string(),
                seen: false,
                starred: true,
                thread_key: "refs-root".to_string(),
                ..Default::default()
            },
            MessageHeader {
                uid: 1,
                subject: "Topic".to_string(),
                seen: true,
                starred: false,
                thread_key: "refs-root".to_string(),
                ..Default::default()
            },
        ],
        "INBOX",
    );

    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].thread_key, "refs-root#Topic");
    assert_eq!(cards[0].header.subject, "Topic");
    assert_eq!(cards[0].unread_count, 2);
    assert!(cards[0].header.starred);
}

#[test]
fn group_thread_cards_marks_groups_with_cached_drafts() {
    use crate::imap::MessageHeader;
    let draft_keys = ["refs-root".to_string()].into_iter().collect();
    let cards = group_thread_cards_with_drafts(
        vec![
            MessageHeader {
                uid: 2,
                subject: "Re: Topic".to_string(),
                thread_key: "refs-root".to_string(),
                ..Default::default()
            },
            MessageHeader {
                uid: 1,
                subject: "Other".to_string(),
                thread_key: "other-root".to_string(),
                ..Default::default()
            },
        ],
        "INBOX",
        &draft_keys,
    );

    let marked = cards
        .iter()
        .find(|card| card.thread_key == "refs-root#Topic")
        .unwrap();
    let unmarked = cards
        .iter()
        .find(|card| card.thread_key == "other-root#Other")
        .unwrap();
    assert!(marked.has_draft);
    assert!(!unmarked.has_draft);
}

#[test]
fn suggest_contacts_dedupes_by_address_and_ranks_by_frequency() {
    let conn = test_conn();
    // aki appears twice → ranks above bea; the duplicate collapses to one row.
    insert_message(&conn, 1, "Hi", "Aki", "aki@example.com", None);
    insert_message(&conn, 2, "Re: Hi", "Aki", "aki@example.com", None);
    insert_message(&conn, 3, "Plan", "Bea", "bea@example.com", None);

    let top = suggest_contacts(&conn, "acct", "", 10).unwrap();
    assert_eq!(
        top.iter().map(|c| c.addr.as_str()).collect::<Vec<_>>(),
        vec!["aki@example.com", "bea@example.com"]
    );

    // Query matches on both address and display name, case-insensitively.
    let by_name = suggest_contacts(&conn, "acct", "BEA", 10).unwrap();
    assert_eq!(by_name.len(), 1);
    assert_eq!(by_name[0].addr, "bea@example.com");
    assert_eq!(by_name[0].name, "Bea");

    // A different account sees none of acct's correspondents.
    assert!(suggest_contacts(&conn, "other", "", 10).unwrap().is_empty());
}

#[test]
fn suggest_contacts_includes_to_and_cc_recipients() {
    use crate::imap::MessageHeader;
    let conn = test_conn();
    // A sent message we authored: the useful contacts are its To/Cc, not us.
    let msg = MessageHeader {
        uid: 10,
        subject: "Lunch".into(),
        from_name: "Me".into(),
        from_addr: "me@example.com".into(),
        date: 1_779_580_800, // 2026-05-24
        to: vec![crate::imap::Recipient {
            name: "Cleo".into(),
            addr: "cleo@example.com".into(),
        }],
        cc: vec![crate::imap::Recipient {
            name: String::new(),
            addr: "dan@example.com".into(),
        }],
        ..Default::default()
    };
    upsert_messages(&conn, "acct", "Sent", &[msg]).unwrap();

    let cleo = suggest_contacts(&conn, "acct", "cleo", 10).unwrap();
    assert_eq!(cleo.len(), 1);
    assert_eq!(cleo[0].addr, "cleo@example.com");
    assert_eq!(cleo[0].name, "Cleo");

    // A Cc-only address with no display name is still suggested by address.
    let dan = suggest_contacts(&conn, "acct", "dan@", 10).unwrap();
    assert_eq!(
        dan.iter().map(|c| c.addr.as_str()).collect::<Vec<_>>(),
        vec!["dan@example.com"]
    );
}

#[test]
fn apply_card_identity_rewrites_outbound_to_counterparty() {
    use crate::imap::{MessageHeader, Recipient};
    let conn = test_conn();
    conn.execute(
            "INSERT INTO accounts(id, engine, email, prefs)
             VALUES('acct', 'mail', 'me@example.com', '{\"aliases\":[{\"email\":\"alias@other.jp\"}]}')",
            [],
        )
        .unwrap();

    let recipient = |name: &str, addr: &str| Recipient {
        name: name.into(),
        addr: addr.into(),
    };
    let mut headers = vec![
        // Outbound from the primary address → shows first recipient, +1 overflow.
        MessageHeader {
            uid: 1,
            from_name: "Me".into(),
            from_addr: "me@example.com".into(),
            to: vec![
                recipient("Cleo", "cleo@example.com"),
                recipient("Dan", "dan@example.com"),
            ],
            ..Default::default()
        },
        // Outbound from an alias counts as self too.
        MessageHeader {
            uid: 2,
            from_name: "Me".into(),
            from_addr: "Alias@Other.JP".into(),
            to: vec![recipient("Cleo", "cleo@example.com")],
            ..Default::default()
        },
        // Inbound stays untouched.
        MessageHeader {
            uid: 3,
            from_name: "Cleo".into(),
            from_addr: "cleo@example.com".into(),
            ..Default::default()
        },
        // Outbound with no cached recipients (old row / Bcc-only) stays untouched.
        MessageHeader {
            uid: 4,
            from_name: "Me".into(),
            from_addr: "me@example.com".into(),
            ..Default::default()
        },
        // Sent-folder row from an *unconfigured* alias (e.g. webmail send-as):
        // folder provenance alone marks it outbound.
        MessageHeader {
            uid: 5,
            folder: "[Gmail]/Sent Mail".into(),
            from_name: "Me".into(),
            from_addr: "unknown-alias@other.jp".into(),
            to: vec![recipient("Cleo", "cleo@example.com")],
            ..Default::default()
        },
    ];
    apply_card_identity(&conn, "acct", "INBOX", &mut headers);

    assert_eq!(headers[0].from_name, "Cleo");
    assert_eq!(headers[0].from_addr, "cleo@example.com");
    assert_eq!(headers[0].recipient_overflow, 1);
    assert_eq!(headers[1].from_name, "Cleo");
    assert_eq!(headers[1].recipient_overflow, 0);
    assert_eq!(headers[2].from_name, "Cleo");
    assert_eq!(headers[2].from_addr, "cleo@example.com");
    assert_eq!(headers[3].from_name, "Me");
    assert_eq!(headers[3].from_addr, "me@example.com");
    assert_eq!(headers[4].from_name, "Cleo");
    assert_eq!(headers[4].from_addr, "cleo@example.com");
}

#[test]
fn is_outgoing_matches_own_addresses_and_sent_folder_provenance() {
    let mine: std::collections::HashSet<String> =
        ["me@example.com".to_string(), "alias@other.jp".to_string()].into();
    // Own address (any casing), regardless of folder.
    assert!(is_outgoing(&mine, "INBOX", "Me@Example.Com", false));
    assert!(is_outgoing(&mine, "", "alias@other.jp", false));
    // Sent-folder provenance wins even for an unconfigured alias.
    assert!(is_outgoing(
        &mine,
        "[Gmail]/Sent Mail",
        "unknown@other.jp",
        false
    ));
    assert!(is_outgoing(&mine, "Sent", "unknown@other.jp", false));
    // Inbound in a regular folder is not ours.
    assert!(!is_outgoing(&mine, "INBOX", "cleo@example.com", false));
    assert!(!is_outgoing(&mine, "INBOX", "", false));
    // A colleague sending from a shared address configured here as an alias:
    // delivery headers say we received it, wherever it has since been filed.
    assert!(!is_outgoing(&mine, "INBOX", "alias@other.jp", true));
    assert!(!is_outgoing(&mine, "Archive", "alias@other.jp", true));
    assert!(!is_outgoing(&mine, "Trash", "alias@other.jp", true));
    // Our own copy, moved out of Sent, keeps no delivery headers.
    assert!(is_outgoing(&mine, "Archive", "alias@other.jp", false));
    // A self-addressed copy in Sent stays outgoing despite being delivered too.
    assert!(is_outgoing(&mine, "Sent", "me@example.com", true));
}

#[test]
fn apply_card_identity_resolves_junk_display_names() {
    use crate::imap::MessageHeader;
    let conn = test_conn();
    conn.execute(
        "INSERT INTO accounts(id, engine, email) VALUES('acct', 'mail', 'me@example.com')",
        [],
    )
    .unwrap();
    // A cached inbound message carries the bot's proper display name.
    insert_message(&conn, 1, "Hi", "Austin Mentions", "bot@example.com", None);

    let mut headers = vec![
        // Outbound reply whose To name is the junk "addr addr" pattern.
        MessageHeader {
            uid: 2,
            from_name: "Me".into(),
            from_addr: "me@example.com".into(),
            to: vec![crate::imap::Recipient {
                name: "bot@example.com bot@example.com".into(),
                addr: "bot@example.com".into(),
            }],
            ..Default::default()
        },
        // Inbound with the same junk in From resolves too.
        MessageHeader {
            uid: 3,
            from_name: "bot@example.com bot@example.com".into(),
            from_addr: "bot@example.com".into(),
            ..Default::default()
        },
        // Junk name with no better name cached anywhere is cleared.
        MessageHeader {
            uid: 4,
            from_name: "stranger@example.com".into(),
            from_addr: "stranger@example.com".into(),
            ..Default::default()
        },
    ];
    apply_card_identity(&conn, "acct", "INBOX", &mut headers);

    assert_eq!(headers[0].from_name, "Austin Mentions");
    assert_eq!(headers[0].from_addr, "bot@example.com");
    assert_eq!(headers[1].from_name, "Austin Mentions");
    assert_eq!(headers[2].from_name, "");
}

#[test]
fn save_cached_message_preserves_envelope_recipients_in_json() {
    use crate::imap::MessageHeader;
    let conn = test_conn();
    let header = MessageHeader {
        uid: 42,
        subject: "Hi".into(),
        from_name: "Sender".into(),
        from_addr: "sender@example.com".into(),
        date: 1_779_580_800, // 2026-05-24
        to: vec![crate::imap::Recipient {
            name: "Me".into(),
            addr: "me@example.com".into(),
        }],
        ..Default::default()
    };
    upsert_messages(&conn, "acct", "INBOX", &[header]).unwrap();

    save_cached_message(
        &conn,
        "acct",
        "INBOX",
        42,
        &Message {
            subject: "Hi".into(),
            from_name: "Sender".into(),
            from_addr: "sender@example.com".into(),
            body: "hello".into(),
            ..Default::default()
        },
    )
    .unwrap();

    let contacts = suggest_contacts(&conn, "acct", "me@", 10).unwrap();
    assert_eq!(
        contacts.iter().map(|c| c.addr.as_str()).collect::<Vec<_>>(),
        vec!["me@example.com"]
    );
    let message = get_cached_message(&conn, "acct", "INBOX", 42)
        .unwrap()
        .unwrap();
    assert_eq!(message.to, "Me <me@example.com>");
}

#[test]
fn run_migrations_creates_schema_and_bumps_version() {
    let conn = Connection::open_in_memory().unwrap();
    db::run_migrations(&conn).unwrap();

    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 24);

    for table in [
        "accounts",
        "messages",
        "messages_fts",
        "messages_recipients_fts",
        "mail_search_hits",
        "folders",
        "folder_state",
        "subscriptions",
        "meta",
        "settings",
        "observed_mail_identities",
        "ews_item_ids",
        "calendars",
        "calendar_events",
        "templates",
        "people",
        "person_emails",
        "person_phones",
        "contact_sources",
        "pgp_certs",
    ] {
        let exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                params![table],
                |_| Ok(()),
            )
            .optional()
            .unwrap()
            .is_some();
        assert!(exists, "missing table: {table}");
    }

    // Re-running is a no-op: version is already current, so nothing reapplies.
    db::run_migrations(&conn).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 24);
}

#[test]
fn concurrent_first_open_runs_migrations_once() {
    let dir = std::env::temp_dir().join(format!("meron-store-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("meron.db");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(6));
    let handles = (0..6)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                db::open_at(&path).map(|_| ())
            })
        })
        .collect::<Vec<_>>();

    for handle in handles {
        handle.join().unwrap().unwrap();
    }

    let conn = Connection::open(&path).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 24);

    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn delete_account_removes_account_scoped_state_only() {
    let conn = test_conn();
    for account in ["acct", "other"] {
        conn.execute(
            "INSERT INTO accounts(id, email) VALUES(?1, ?1)",
            params![account],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folders(account, name) VALUES(?1, 'INBOX')",
            params![account],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid) VALUES(?1, 'INBOX', '1', 1)",
            params![account],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folder_state(account, folder, uid_next) VALUES(?1, 'INBOX', 2)",
            params![account],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO subscriptions(id, account, url, title) VALUES(?2, ?1, ?3, 'Feed')",
            params![
                account,
                format!("feed-{account}"),
                format!("https://{account}.example")
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO account_secrets(account_id, blob) VALUES(?1, 'secret')",
            params![account],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO observed_mail_identities(account, identity, first_seen_at)
             VALUES(?1, 'message-id:seen@example.com', 1)",
            params![account],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO mail_search_hits(
               token, account, query, scope, position, folder, uid, created_at
             ) VALUES(?2, ?1, 'query', '[\"INBOX\"]', 0, 'INBOX', 1, 1)",
            params![account, format!("token-{account}")],
        )
        .unwrap();
    }

    delete_account(&conn, "acct").unwrap();

    for (table, column) in [
        ("accounts", "id"),
        ("folders", "account"),
        ("messages", "account"),
        ("folder_state", "account"),
        ("subscriptions", "account"),
        ("account_secrets", "account_id"),
        ("observed_mail_identities", "account"),
        ("mail_search_hits", "account"),
    ] {
        let deleted_count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE {column} = 'acct'"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(deleted_count, 0, "{table} retained deleted account rows");

        let other_count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE {column} = 'other'"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(other_count, 1, "{table} removed another account's row");
    }
}

#[test]
fn prefs_resolve_engine_default_and_persist_without_clobbering() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(db::ACCOUNTS_DDL).unwrap();
    conn.execute(
        "INSERT INTO accounts(id, engine) VALUES('rss-1', 'rss')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO accounts(id, engine) VALUES('mail-1', 'mail')",
        [],
    )
    .unwrap();

    // Unset: resolved by engine (RSS on, mail off).
    assert!(load_remote_images(&conn, "rss-1").unwrap());
    assert!(!load_remote_images(&conn, "mail-1").unwrap());
    assert!(!load_remote_images(&conn, "missing").unwrap());

    // A sibling pref must survive an images toggle (json_set is in-place).
    conn.execute(
        "UPDATE accounts SET prefs = json_set(prefs, '$.other', 7) WHERE id = 'mail-1'",
        [],
    )
    .unwrap();
    set_load_remote_images(&conn, "mail-1", true).unwrap();
    assert!(load_remote_images(&conn, "mail-1").unwrap());
    let prefs: String = conn
        .query_row("SELECT prefs FROM accounts WHERE id = 'mail-1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(
        prefs.contains("\"other\""),
        "sibling pref clobbered: {prefs}"
    );

    // Explicit override of the engine default round-trips.
    set_load_remote_images(&conn, "rss-1", false).unwrap();
    assert!(!load_remote_images(&conn, "rss-1").unwrap());
}

#[test]
fn conversation_html_defaults_on_and_respects_explicit_overrides() {
    let conn = Connection::open_in_memory().unwrap();
    db::run_migrations(&conn).unwrap();
    conn.execute(
        "INSERT INTO accounts(id, engine, provider, prefs) VALUES
                ('unset', 'mail', 'custom', '{}'),
                ('plain', 'mail', 'custom', '{\"conversation_html\":false}'),
                ('html', 'mail', 'custom', '{\"conversation_html\":true}')",
        [],
    )
    .unwrap();

    let accounts = list_accounts(&conn).unwrap();
    let by_id = |id: &str| {
        accounts
            .iter()
            .find(|account| account["id"] == id)
            .expect("account present")
    };

    assert_eq!(by_id("unset")["conversation_html"], true);
    assert_eq!(by_id("plain")["conversation_html"], false);
    assert_eq!(by_id("html")["conversation_html"], true);
}

#[test]
fn chat_wallpaper_round_trips_and_can_be_cleared() {
    let conn = Connection::open_in_memory().unwrap();
    db::run_migrations(&conn).unwrap();
    conn.execute(
        "INSERT INTO accounts(id, engine, provider, prefs) VALUES('acct', 'mail', 'custom', '{}')",
        [],
    )
    .unwrap();

    let wallpaper = json!({"kind":"preset","presetId":"grid"});
    set_account_pref_json(&conn, "acct", "chat_wallpaper", Some(wallpaper.clone())).unwrap();
    let accounts = list_accounts(&conn).unwrap();
    assert_eq!(accounts[0]["chat_wallpaper"], wallpaper);

    conn.execute(
        "UPDATE accounts SET prefs = json_set(prefs, '$.other', 7) WHERE id = 'acct'",
        [],
    )
    .unwrap();
    set_account_pref_json(&conn, "acct", "chat_wallpaper", None).unwrap();
    let prefs: String = conn
        .query_row("SELECT prefs FROM accounts WHERE id = 'acct'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let value: Value = serde_json::from_str(&prefs).unwrap();
    assert_eq!(value["chat_wallpaper"], Value::Null);
    assert_eq!(value["other"], 7);
}

#[test]
fn signature_pref_round_trips_and_can_be_cleared() {
    let conn = Connection::open_in_memory().unwrap();
    db::run_migrations(&conn).unwrap();
    conn.execute(
        "INSERT INTO accounts(id, engine, provider, prefs) VALUES('acct', 'mail', 'custom', '{}')",
        [],
    )
    .unwrap();

    // Absent means "follow the app-wide signature".
    assert_eq!(list_accounts(&conn).unwrap()[0]["signature"], Value::Null);

    let signature =
        AccountSignature::from_param(Some(&json!({"mode":"custom","html":"<p>Ping</p>"})))
            .unwrap()
            .unwrap();
    set_account_pref_json(&conn, "acct", "signature", Some(json!(signature))).unwrap();
    assert_eq!(
        list_accounts(&conn).unwrap()[0]["signature"],
        json!({"mode":"custom","html":"<p>Ping</p>"})
    );

    set_account_pref_json(&conn, "acct", "signature", None).unwrap();
    assert_eq!(list_accounts(&conn).unwrap()[0]["signature"], Value::Null);
}

#[test]
fn an_unreadable_pref_does_not_reset_the_others() {
    let conn = Connection::open_in_memory().unwrap();
    db::run_migrations(&conn).unwrap();
    // `signature` carries a mode this build cannot read, next to prefs that are
    // perfectly valid: only the signature falls back to its default.
    conn.execute(
        r#"INSERT INTO accounts(id, engine, provider, prefs)
           VALUES('acct', 'mail', 'custom',
                  '{"muted":true,"paused":true,"included_in_unified":false,
                    "conversation_html":false,"signature":"<p>Ping</p>"}')"#,
        [],
    )
    .unwrap();

    let account = list_accounts(&conn).unwrap().remove(0);
    assert_eq!(account["muted"], true);
    assert_eq!(account["paused"], true);
    assert_eq!(account["included_in_unified"], false);
    assert_eq!(account["conversation_html"], false);
    assert_eq!(account["signature"], Value::Null);
}

#[test]
fn signature_param_validates_its_mode_and_size() {
    assert!(AccountSignature::from_param(None).unwrap().is_none());
    assert!(
        AccountSignature::from_param(Some(&Value::Null))
            .unwrap()
            .is_none()
    );
    assert!(AccountSignature::from_param(Some(&json!({"mode":"sometimes"}))).is_err());
    assert!(AccountSignature::from_param(Some(&json!("<p>Ping</p>"))).is_err());
    assert!(
        AccountSignature::from_param(Some(&json!({
            "mode": "custom",
            "html": "x".repeat(MAX_SIGNATURE_HTML + 1),
        })))
        .is_err()
    );

    // The html is kept in every mode, so toggling back restores what was written.
    let kept = AccountSignature::from_param(Some(&json!({"mode":"none","html":" <p>Ping</p> "})))
        .unwrap()
        .unwrap();
    assert_eq!(kept.mode, SignatureMode::None);
    assert_eq!(kept.html, "<p>Ping</p>");
}

#[test]
fn save_sent_copy_pref_round_trips_and_can_be_cleared() {
    let conn = Connection::open_in_memory().unwrap();
    db::run_migrations(&conn).unwrap();
    conn.execute(
        "INSERT INTO accounts(id, engine, provider, prefs) VALUES('acct', 'mail', 'custom', '{}')",
        [],
    )
    .unwrap();

    assert_eq!(save_sent_copy_pref(&conn, "acct").unwrap(), None);
    set_account_pref_json(&conn, "acct", "save_sent_copy", Some(json!(false))).unwrap();
    assert_eq!(save_sent_copy_pref(&conn, "acct").unwrap(), Some(false));
    assert_eq!(list_accounts(&conn).unwrap()[0]["save_sent_copy"], false);

    conn.execute(
        "UPDATE accounts SET prefs = json_set(prefs, '$.other', 7) WHERE id = 'acct'",
        [],
    )
    .unwrap();
    set_account_pref_json(&conn, "acct", "save_sent_copy", None).unwrap();
    assert_eq!(save_sent_copy_pref(&conn, "acct").unwrap(), None);
    let prefs: String = conn
        .query_row("SELECT prefs FROM accounts WHERE id = 'acct'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let value: Value = serde_json::from_str(&prefs).unwrap();
    assert_eq!(value["save_sent_copy"], Value::Null);
    assert_eq!(value["other"], 7);
}

#[test]
fn rss_sync_interval_defaults_and_persists_without_clobbering() {
    let conn = Connection::open_in_memory().unwrap();
    db::run_migrations(&conn).unwrap();
    conn.execute(
        "INSERT INTO accounts(id, engine, provider) VALUES('rss-1', 'rss', 'rss')",
        [],
    )
    .unwrap();

    let accounts = list_accounts(&conn).unwrap();
    assert_eq!(
        accounts[0]["rss_sync_interval_minutes"],
        DEFAULT_RSS_SYNC_INTERVAL_MINUTES
    );

    conn.execute(
        "UPDATE accounts SET prefs = json_set(prefs, '$.other', 7) WHERE id = 'rss-1'",
        [],
    )
    .unwrap();
    set_account_pref_u64(&conn, "rss-1", "rss_sync_interval_minutes", 30).unwrap();

    let accounts = list_accounts(&conn).unwrap();
    assert_eq!(accounts[0]["rss_sync_interval_minutes"], 30);
    let prefs: String = conn
        .query_row("SELECT prefs FROM accounts WHERE id = 'rss-1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(
        prefs.contains("\"other\""),
        "sibling pref clobbered: {prefs}"
    );
}

#[test]
fn search_messages_returns_empty_for_blank_query() {
    let conn = test_conn();
    insert_message(&conn, 1, "Hello", "Aki", "aki@example.com", None);

    let results = search_messages(&conn, "acct", "INBOX", "  ", 10, None).unwrap();
    assert!(results.is_empty());
}

#[test]
fn newest_thread_uids_names_only_the_latest_message() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, seen, thread_key)
         VALUES('acct', 'INBOX', '1', 1, 'Topic', 'Them', 'them@example.com', 100, 1, 'topic-key'),
               ('acct', 'INBOX', '2', 2, 'Topic', 'Them', 'them@example.com', 300, 1, 'topic-key'),
               ('acct', 'INBOX', '3', 3, 'Topic', 'Them', 'them@example.com', 200, 1, 'topic-key')",
        params![],
    )
    .unwrap();

    // Marking a thread unread flags this one message, so the thread comes back
    // as a single unread message rather than an all-unread thread.
    let uids = newest_thread_uids(&conn, "acct", "INBOX", "topic-key", None).unwrap();

    assert_eq!(uids, vec![2]);
}

#[test]
fn newest_thread_uids_stays_within_a_subject_branch() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, seen, thread_key)
         VALUES('acct', 'INBOX', '1', 1, 'Invoice', 'Them', 'them@example.com', 100, 1, 'root'),
               ('acct', 'INBOX', '2', 2, 'Re: Receipt', 'Them', 'them@example.com', 400, 1, 'root'),
               ('acct', 'INBOX', '3', 3, 'Re: Invoice', 'Them', 'them@example.com', 300, 1, 'root')",
        params![],
    )
    .unwrap();

    let uids = newest_thread_uids(&conn, "acct", "INBOX", "root", Some("Invoice")).unwrap();

    assert_eq!(uids, vec![3]);
}

#[test]
fn newest_thread_uids_is_empty_for_an_unknown_thread() {
    let conn = test_conn();

    assert!(
        newest_thread_uids(&conn, "acct", "INBOX", "missing", None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn get_thread_headers_all_folders_sorts_chronologically_by_parsed_date() {
    let conn = test_conn();
    // Insert via the real RFC 2822 parser (the ingestion path), so this also
    // covers parse_date_to_epoch; ordering is then done by the stored epoch.
    let d = |s: &str| crate::parse::parse_date_to_epoch(s);
    conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, seen, thread_key)
             VALUES('acct', 'Sent', '2', 2, 'Re: Topic', 'Me', 'me@example.com', ?1, 1, 'topic-key'),
                   ('acct', 'INBOX', '3', 3, 'Re: Topic', 'Them', 'them@example.com', ?2, 1, 'topic-key'),
                   ('acct', 'INBOX', '1', 1, 'Topic', 'Them', 'them@example.com', ?3, 1, 'topic-key')",
            params![
                d("Fri, 22 May 2026 21:05:20 -0700"),
                d("Fri, 22 May 2026 21:13:27 -0700"),
                d("Thu, 21 May 2026 22:02:02 -0700"),
            ],
        )
        .unwrap();

    let headers = get_thread_headers_all_folders(&conn, "acct", "topic-key").unwrap();
    let uids: Vec<u32> = headers.iter().map(|h| h.uid).collect();
    assert_eq!(uids, vec![1, 2, 3]);
}

#[test]
fn get_thread_headers_all_folders_dedupes_self_sent_by_message_id() {
    let conn = test_conn();
    // A message sent to yourself lands in both Sent and the Inbox with the
    // same RFC Message-ID but distinct per-folder UIDs. The thread view must
    // collapse the pair into one bubble.
    conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, seen, thread_key, json)
             VALUES('acct', '[Gmail]/Sent Mail', '462', 462, 'test', 'Me', 'me@example.com', 100, 1, 'self-key',
                      '{\"message_id\":\"mid@host\"}'),
                   ('acct', 'INBOX', '1440', 1440, 'test', 'Me', 'me@example.com', 100, 0, 'self-key',
                      '{\"message_id\":\"mid@host\"}'),
                   ('acct', 'INBOX', '1441', 1441, 'reply', 'Them', 'them@example.com', 200, 1, 'self-key',
                      '{\"message_id\":\"other@host\"}')",
            [],
        )
        .unwrap();

    let headers = get_thread_headers_all_folders(&conn, "acct", "self-key").unwrap();
    let uids: Vec<u32> = headers.iter().map(|h| h.uid).collect();
    // The self-sent pair collapses to the unread copy when one exists, so the
    // visible bubble can be marked read and clear the thread badge.
    assert_eq!(uids, vec![1440, 1441]);
}

#[test]
fn get_thread_headers_all_folders_keeps_rows_without_message_id() {
    let conn = test_conn();
    // Rows lacking a Message-ID (e.g. drafts) must never be collapsed into
    // each other — a NULL Message-ID never equates in SQL.
    conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, thread_key, json)
             VALUES('acct', 'Drafts', '10', 10, 'draft a', 'Me', 'me@example.com', 100, 'k', '{}'),
                   ('acct', 'Drafts', '11', 11, 'draft b', 'Me', 'me@example.com', 200, 'k', '{}')",
            [],
        )
        .unwrap();

    let headers = get_thread_headers_all_folders(&conn, "acct", "k").unwrap();
    let uids: Vec<u32> = headers.iter().map(|h| h.uid).collect();
    assert_eq!(uids, vec![10, 11]);
}

#[test]
fn thread_reference_gaps_are_referenced_ids_not_yet_cached() {
    let conn = test_conn();
    // A draft replying into a thread: thread_key is the (lowercased) root id;
    // its json carries its own Message-ID and the full References chain. The
    // referenced ancestors aren't cached, so they're all gaps — except the
    // one ancestor we also store as a cached row below.
    conn.execute(
        "INSERT INTO messages(account, folder, msg_id, uid, subject, date, thread_key, json)
             VALUES('acct', 'Drafts', '99', 99, 'Re: Hi', 0, 'root@h',
               '{\"message_id\":\"leaf@h\",\"references\":\"root@h MID-ONE@h mid-two@h\"}')",
        [],
    )
    .unwrap();
    // An already-cached ancestor (its own Message-ID present) must be excluded.
    conn.execute(
        "INSERT INTO messages(account, folder, msg_id, uid, subject, date, thread_key, json)
             VALUES('acct', 'INBOX', '50', 50, 'Hi', 0, 'root@h',
               '{\"message_id\":\"mid-two@h\",\"references\":\"root@h\"}')",
        [],
    )
    .unwrap();

    let mut gaps = get_thread_reference_gaps(&conn, "acct", "root@h").unwrap();
    gaps.sort();
    // root@h and mid-one@h are referenced but uncached; mid-two@h is present;
    // leaf@h is a Message-ID, never a gap. Comparison is case-insensitive.
    assert_eq!(gaps, vec!["mid-one@h".to_string(), "root@h".to_string()]);
}

#[test]
fn body_cache_invalidation_works() {
    let conn = test_conn();

    // Save an HTML-only message (body_is_rendered = true)
    let html = "<p>rendered plain</p>";
    let msg_html = Message {
        subject: "HTML only".into(),
        body: "stale render".into(),
        body_html: Some(html.into()),
        body_is_rendered: true,
        ..Default::default()
    };
    save_cached_message(&conn, "acct", "INBOX", 101, &msg_html).unwrap();

    // Save a plain-text message (body_is_rendered = false)
    let msg_plain = Message {
        subject: "Plain only".into(),
        body: "original plain".into(),
        body_is_rendered: false,
        ..Default::default()
    };
    save_cached_message(&conn, "acct", "INBOX", 102, &msg_plain).unwrap();

    // Verify they are initially saved with their bodies
    let retrieved_html = get_cached_message(&conn, "acct", "INBOX", 101)
        .unwrap()
        .unwrap();
    assert_eq!(retrieved_html.body, "stale render");
    assert!(retrieved_html.body_is_rendered);

    let retrieved_plain = get_cached_message(&conn, "acct", "INBOX", 102)
        .unwrap()
        .unwrap();
    assert_eq!(retrieved_plain.body, "original plain");
    assert!(!retrieved_plain.body_is_rendered);

    // Force cache invalidation by setting the meta version in DB to an older one
    db::meta_set(&conn, "body_cache_version", "old_version").unwrap();

    // Call the invalidator
    db::invalidate_body_cache_if_needed(&conn).unwrap();

    // The html-only body is re-rendered in place (not nulled), so the FTS
    // `body` column stays populated across the bump.
    let html_body_in_db: Option<String> = conn
        .query_row("SELECT body FROM messages WHERE uid = 101", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(html_body_in_db, Some(crate::parse::render_body(html)));

    // The plain-only body is left untouched.
    let plain_body_in_db: Option<String> = conn
        .query_row("SELECT body FROM messages WHERE uid = 102", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(plain_body_in_db, Some("original plain".to_string()));

    // FTS still matches the re-rendered html-only message after the bump.
    let hits = search_messages(&conn, "acct", "INBOX", "rendered", 10, None).unwrap();
    assert!(hits.iter().any(|m| m.subject == "HTML only"));
}

#[test]
fn upsert_messages_preserves_message_id_casing_in_json() {
    use crate::imap::MessageHeader;
    let conn = test_conn();
    // The stored ids feed reply In-Reply-To/References headers verbatim, and
    // receivers (Gmail, GitHub) match Message-IDs case-sensitively — a synced
    // row must never lowercase them.
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader {
            uid: 1,
            subject: "Wont download videos".into(),
            date: 100,
            thread_key: "nonbili/NouTube/issues/253@github.com".into(),
            message_id: "nonbili/NouTube/issues/253@github.com".into(),
            ..Default::default()
        }],
    )
    .unwrap();

    let (message_id, thread_key): (String, String) = conn
        .query_row(
            "SELECT json_extract(json, '$.message_id'), thread_key FROM messages WHERE uid = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(message_id, "nonbili/NouTube/issues/253@github.com");
    assert_eq!(thread_key, "nonbili/NouTube/issues/253@github.com");
}

#[test]
fn delete_draft_copies_removes_stale_autosaves_keeping_live_uid() {
    use crate::imap::MessageHeader;
    let conn = test_conn();
    // Two autosaves of the same draft (stable Message-ID, fresh UID per APPEND)
    // plus an unrelated draft that must survive.
    let draft = |uid: u32, message_id: &str| MessageHeader {
        uid,
        subject: "Re: test".into(),
        date: 100 + uid as i64,
        thread_key: "root@mail.example".into(),
        message_id: message_id.into(),
        ..Default::default()
    };
    upsert_messages(
        &conn,
        "acct",
        "Drafts",
        &[
            draft(10, "Meron-Draft-1@meron"),
            draft(11, "meron-draft-1@meron"),
            draft(12, "meron-draft-2@meron"),
        ],
    )
    .unwrap();

    // Replace path: keep the newest copy, drop the stale one (id compared
    // case-insensitively, matching the thread-key inheritance lookup).
    let deleted =
        delete_draft_copies(&conn, "acct", "Drafts", "meron-draft-1@meron", Some(11)).unwrap();
    assert_eq!(deleted, 1);
    let uids: Vec<u32> = conn
        .prepare("SELECT uid FROM messages WHERE folder = 'Drafts' ORDER BY uid")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(uids, vec![11, 12]);

    // Discard path: no survivor, every copy goes.
    let deleted =
        delete_draft_copies(&conn, "acct", "Drafts", "meron-draft-1@meron", None).unwrap();
    assert_eq!(deleted, 1);
    // Blank id is a no-op, never a mass delete.
    assert_eq!(
        delete_draft_copies(&conn, "acct", "Drafts", " ", None).unwrap(),
        0
    );
}

#[test]
fn delete_draft_sibling_copies_drops_hidden_same_id_rows() {
    use crate::imap::MessageHeader;
    let conn = test_conn();
    let draft = |uid: u32, message_id: &str| MessageHeader {
        uid,
        subject: "Re: test".into(),
        date: 100 + uid as i64,
        thread_key: "root@mail.example".into(),
        message_id: message_id.into(),
        ..Default::default()
    };
    // The pane dedupes uid 10/11 (same Message-ID) into one bubble; discarding
    // it deletes only the visible uid, so the sibling cleanup must catch the
    // hidden copy — while leaving the unrelated draft alone.
    upsert_messages(
        &conn,
        "acct",
        "Drafts",
        &[
            draft(10, "meron-draft-1@meron"),
            draft(11, "meron-draft-1@meron"),
            draft(12, "meron-draft-2@meron"),
        ],
    )
    .unwrap();

    let deleted = delete_draft_sibling_copies(&conn, "acct", "Drafts", &[11]).unwrap();
    assert_eq!(deleted, 1);
    delete_messages_by_uid(&conn, "acct", "Drafts", &[11]).unwrap();
    let uids: Vec<u32> = conn
        .prepare("SELECT uid FROM messages WHERE folder = 'Drafts' ORDER BY uid")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(uids, vec![12]);
}

#[test]
fn delete_quick_reply_drafts_in_thread_removes_only_meron_drafts() {
    use crate::imap::MessageHeader;
    let conn = test_conn();
    let draft = |uid: u32, thread_key: &str, message_id: &str| MessageHeader {
        uid,
        subject: "Re: test".into(),
        date: 100 + uid as i64,
        thread_key: thread_key.into(),
        message_id: message_id.into(),
        ..Default::default()
    };
    upsert_messages(
        &conn,
        "acct",
        "Drafts",
        &[
            draft(10, "root@mail.example", "meron-draft-old@meron"),
            draft(11, "root@mail.example", "meron-draft-new@meron"),
            draft(12, "root@mail.example", "manual-draft@example.com"),
            draft(13, "other@mail.example", "meron-draft-other@meron"),
        ],
    )
    .unwrap();

    let deleted =
        delete_quick_reply_drafts_in_thread(&conn, "acct", "Drafts", "root@mail.example").unwrap();
    assert_eq!(deleted, 2);
    let uids: Vec<u32> = conn
        .prepare("SELECT uid FROM messages WHERE folder = 'Drafts' ORDER BY uid")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(uids, vec![12, 13]);
}

#[test]
fn collapse_thread_draft_headers_keeps_newest_draft_only() {
    use crate::imap::MessageHeader;
    let conn = test_conn();
    upsert_folders(
        &conn,
        "acct",
        &[crate::imap::Folder {
            name: "Drafts".into(),
            display_name: "Drafts".into(),
            delimiter: None,
            special_use: Some("drafts".into()),
            role: "drafts".into(),
            unread: 0,
        }],
    )
    .unwrap();
    let header = |uid: u32, folder: &str, date: i64| MessageHeader {
        uid,
        folder: folder.into(),
        subject: "Re: test".into(),
        date,
        thread_key: "root@example.com".into(),
        message_id: format!("draft-{uid}@example.com"),
        ..Default::default()
    };

    let collapsed = collapse_thread_draft_headers(
        &conn,
        "acct",
        "INBOX",
        vec![
            header(1, "INBOX", 100),
            header(10, "Drafts", 110),
            header(11, "Drafts", 120),
        ],
    )
    .unwrap();

    let uids = collapsed
        .into_iter()
        .map(|header| header.uid)
        .collect::<Vec<_>>();
    assert_eq!(uids, vec![1, 11]);
}

#[test]
fn thread_key_inheritance_matches_parent_message_id_case_insensitively() {
    use crate::imap::MessageHeader;
    let conn = test_conn();
    // Parent cached with its original mixed-case Message-ID.
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader {
            uid: 1,
            subject: "test".into(),
            date: 100,
            thread_key: "Root@Mail.example".into(),
            message_id: "Root@Mail.example".into(),
            ..Default::default()
        }],
    )
    .unwrap();
    // A reply whose computed key fell back to In-Reply-To, with different
    // casing than the cached parent (e.g. a row synced before ids preserved
    // case): the parent lookup must still match and hand down the root key.
    upsert_messages(
        &conn,
        "acct",
        "Sent",
        &[MessageHeader {
            uid: 2,
            subject: "Re: test".into(),
            date: 200,
            thread_key: "root@mail.example".into(),
            message_id: "reply@mailo.com".into(),
            in_reply_to: "root@mail.example".into(),
            ..Default::default()
        }],
    )
    .unwrap();

    let child_key: String = conn
        .query_row("SELECT thread_key FROM messages WHERE uid = 2", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(child_key, "Root@Mail.example");
}

#[test]
fn thread_key_inheritance_settles_a_reply_cached_before_its_parent() {
    use crate::imap::MessageHeader;
    let conn = test_conn();

    // Newest-first sync: the reply lands while the message its key names is
    // still unknown, so nothing can be inherited yet.
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader {
            uid: 2,
            subject: "Re: test".into(),
            date: 200,
            thread_key: "first-reply@local".into(),
            message_id: "second-reply@local".into(),
            ..Default::default()
        }],
    )
    .unwrap();

    // The parent arrives with the canonical root, and hands it down.
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[MessageHeader {
            uid: 1,
            subject: "Re: test".into(),
            date: 100,
            thread_key: "root@mail.example".into(),
            message_id: "First-Reply@Local".into(),
            ..Default::default()
        }],
    )
    .unwrap();

    let child_key: String = conn
        .query_row("SELECT thread_key FROM messages WHERE uid = 2", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(child_key, "root@mail.example");
}

#[test]
fn thread_key_inheritance_terminates_on_a_reference_cycle() {
    use crate::imap::MessageHeader;
    let conn = test_conn();

    // Two messages naming each other: whatever key they settle on, the walk
    // must stop rather than trade keys back and forth.
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            MessageHeader {
                uid: 1,
                subject: "test".into(),
                date: 100,
                thread_key: "b@local".into(),
                message_id: "a@local".into(),
                ..Default::default()
            },
            MessageHeader {
                uid: 2,
                subject: "Re: test".into(),
                date: 200,
                thread_key: "a@local".into(),
                message_id: "b@local".into(),
                ..Default::default()
            },
        ],
    )
    .unwrap();

    let keys: Vec<String> = conn
        .prepare("SELECT thread_key FROM messages ORDER BY uid")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(keys.len(), 2);
}

/// The inheritance lookups match rows on `lower(json_extract(...))` and
/// `lower(thread_key)`, which only hit an index when the query spells the
/// expression exactly as `MESSAGES_THREAD_KEY_INDEXES_DDL` does. Without them
/// every upserted reply scans the account's whole message cache, so guard the
/// access path, not just the result.
#[test]
fn thread_key_lookups_use_their_expression_indexes() {
    let conn = test_conn();
    let plan_of = |sql: &str| -> String {
        conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map([], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("\n")
    };

    let by_message_id = plan_of(
        "SELECT thread_key FROM messages
         WHERE account = 'acct'
           AND lower(COALESCE(json_extract(json, '$.message_id'), '')) = 'x'
           AND COALESCE(thread_key, '') <> ''
         ORDER BY date ASC, uid ASC
         LIMIT 1",
    );
    assert!(
        by_message_id.contains("messages_message_id_idx"),
        "message-id lookup fell back to a scan: {by_message_id}"
    );

    let by_thread_key = plan_of(
        "SELECT id FROM messages
         WHERE account = 'acct'
           AND uid <> 0
           AND lower(COALESCE(thread_key, '')) = 'x'
           AND thread_key <> 'y'
           AND thread_key NOT LIKE 'uid:%'
           AND thread_key NOT LIKE 'gmthrid:%'",
    );
    assert!(
        by_thread_key.contains("messages_thread_key_idx"),
        "thread-key lookup fell back to a scan: {by_thread_key}"
    );
}

#[test]
fn thread_key_inheritance_follows_referenced_message_to_canonical_root() {
    use crate::imap::MessageHeader;
    let conn = test_conn();

    // Proton Bridge can return a later reply whose References root is the
    // first sent reply, while In-Reply-To names the newest received message.
    // The first reply has already inherited the conversation's older root.
    upsert_messages(
        &conn,
        "acct",
        "Sent",
        &[MessageHeader {
            uid: 1,
            subject: "Re: test".into(),
            date: 100,
            thread_key: "proton-root@protonmail.internalid".into(),
            message_id: "first-reply@local".into(),
            in_reply_to: "proton-root@protonmail.internalid".into(),
            ..Default::default()
        }],
    )
    .unwrap();

    upsert_messages(
        &conn,
        "acct",
        "Sent",
        &[MessageHeader {
            uid: 2,
            subject: "Re: test".into(),
            date: 200,
            thread_key: "first-reply@local".into(),
            message_id: "second-reply@local".into(),
            in_reply_to: "received-between-replies@example.com".into(),
            ..Default::default()
        }],
    )
    .unwrap();

    let child_key: String = conn
        .query_row("SELECT thread_key FROM messages WHERE uid = 2", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(child_key, "proton-root@protonmail.internalid");
}

/// The account address and the mailbox login are separate fields, so both are
/// identities the user owns — a custom account whose server authenticates by
/// user name has them differ, and picking its own address used to fall through
/// to the login.
#[test]
fn resolve_send_from_honors_account_address_login_and_aliases() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO accounts(id, engine, email, sender_name, prefs)
         VALUES('acct', 'mail', 'me@example.com', 'Me',
                '{\"aliases\":[{\"email\":\"Sales@Example.JP\",\"name\":\"Sales\"},
                               {\"email\":\"quiet@example.com\"}]}')",
        [],
    )
    .unwrap();
    let resolve = |requested| resolve_send_from(&conn, "acct", "login-name", requested);

    // No request: the account's own address, not the login it authenticates as.
    assert_eq!(
        resolve("").unwrap(),
        ("me@example.com".to_string(), "Me".to_string())
    );
    assert_eq!(
        resolve("ME@example.com").unwrap(),
        ("me@example.com".to_string(), "Me".to_string())
    );
    // The login is still a legitimate send-as identity.
    assert_eq!(
        resolve("login-name").unwrap(),
        ("login-name".to_string(), "Me".to_string())
    );
    // Aliases match case-insensitively and keep their own display name.
    assert_eq!(
        resolve(" sales@example.jp ").unwrap(),
        ("Sales@Example.JP".to_string(), "Sales".to_string())
    );
    // A blank alias name inherits the account's sender name.
    assert_eq!(
        resolve("quiet@example.com").unwrap(),
        ("quiet@example.com".to_string(), "Me".to_string())
    );
}

/// An address the account doesn't own must fail the send rather than quietly
/// going out as someone else — a silent substitution is invisible to the sender.
#[test]
fn resolve_send_from_rejects_an_unowned_address() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO accounts(id, engine, email, sender_name, prefs)
         VALUES('acct', 'mail', 'me@example.com', 'Me', '{}')",
        [],
    )
    .unwrap();

    let err = resolve_send_from(&conn, "acct", "me@example.com", "someone@else.com").unwrap_err();
    assert!(
        err.to_string().contains("someone@else.com"),
        "error should name the rejected address: {err}"
    );
}

/// Accounts stored without an explicit address fall back to the login, matching
/// what `account.list` shows as the account's address.
#[test]
fn resolve_send_from_falls_back_to_the_login_without_an_account_address() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO accounts(id, engine, email, sender_name) VALUES('acct', 'mail', '', 'Me')",
        [],
    )
    .unwrap();

    assert_eq!(
        resolve_send_from(&conn, "acct", "me@example.com", "").unwrap(),
        ("me@example.com".to_string(), "Me".to_string())
    );
}

/// A minimal mail account so proxy persistence can be exercised without the
/// rest of the connection metadata mattering.
fn proxy_test_account(conn: &Connection, id: &str, proxy: crate::proxy::ProxyChoice) {
    let creds = proxy_test_creds(proxy);
    let meta = AccountMeta {
        engine: "mail".to_string(),
        provider: "custom".to_string(),
        email: "user@example.com".to_string(),
        display_name: String::new(),
        avatar_url: String::new(),
        sender_name: String::new(),
    };
    upsert_account(conn, id, &meta, &creds).unwrap();
}

fn proxy_test_creds(proxy: crate::proxy::ProxyChoice) -> crate::imap::Creds {
    crate::imap::Creds {
        host: "imap.example.com".to_string(),
        port: 993,
        user: "user@example.com".to_string(),
        password: String::new(),
        tls: true,
        starttls: false,
        smtp_host: "smtp.example.com".to_string(),
        smtp_port: 587,
        smtp_tls: false,
        smtp_starttls: true,
        auth_type: "password".to_string(),
        access_token: None,
        refresh_token: None,
        token_expires_at: 0,
        oauth_client_id: String::new(),
        oauth_client_secret: String::new(),
        oauth_token_url: String::new(),
        oauth_scope: String::new(),
        proxy,
        cert_pin: None,
        smtp_cert_pin: None,
        ews_url: String::new(),
    }
}

fn stored_creds(conn: &Connection, id: &str) -> crate::imap::Creds {
    load_accounts(conn)
        .unwrap()
        .into_iter()
        .find(|(account, _)| account == id)
        .map(|(_, creds)| creds)
        .expect("account not found")
}

fn stored_proxy(conn: &Connection, id: &str) -> crate::proxy::ProxyChoice {
    stored_creds(conn, id).proxy
}

/// The pin an account carries for a server whose certificate webpki refuses
/// (Proton Bridge and friends) has to survive a restart, or every launch would
/// re-prompt.
#[test]
fn account_cert_pin_round_trips_and_defaults_to_none() {
    let conn = test_conn();
    let mut creds = proxy_test_creds(crate::proxy::ProxyChoice::Global);
    creds.cert_pin = Some("a".repeat(64));
    creds.smtp_cert_pin = Some("b".repeat(64));
    let meta = AccountMeta {
        engine: "mail".to_string(),
        provider: "custom".to_string(),
        email: "user@example.com".to_string(),
        display_name: String::new(),
        avatar_url: String::new(),
        sender_name: String::new(),
    };
    upsert_account(&conn, "acct", &meta, &creds).unwrap();
    let stored = stored_creds(&conn, "acct");
    assert_eq!(stored.cert_pin.as_deref(), Some("a".repeat(64).as_str()));
    assert_eq!(
        stored.smtp_cert_pin.as_deref(),
        Some("b".repeat(64).as_str())
    );

    // Accounts written before pinning existed have no keys in their config JSON.
    conn.execute(
        "UPDATE accounts SET config = json_remove(config, '$.cert_pin', '$.smtp_cert_pin') WHERE id = 'acct'",
        [],
    )
    .unwrap();
    let stored = stored_creds(&conn, "acct");
    assert_eq!(stored.cert_pin, None);
    assert_eq!(stored.smtp_cert_pin, None);
}

/// Reconnecting resends the setup form, which has no field for the account's
/// proxy or the certificates it accepted. Saving credentials again must not
/// reset settings the form never carried.
#[test]
fn saving_an_account_again_keeps_settings_the_form_does_not_carry() {
    let conn = test_conn();
    let custom = crate::proxy::ProxyChoice::from_json(&json!({
        "mode": "socks5",
        "host": "127.0.0.1",
        "port": 9050,
    }));
    let mut creds = proxy_test_creds(custom.clone());
    creds.cert_pin = Some("a".repeat(64));
    creds.smtp_cert_pin = Some("b".repeat(64));
    let meta = AccountMeta {
        engine: "mail".to_string(),
        provider: "custom".to_string(),
        email: "user@example.com".to_string(),
        display_name: String::new(),
        avatar_url: String::new(),
        sender_name: String::new(),
    };
    upsert_account(&conn, "acct", &meta, &creds).unwrap();

    // What a reconnect builds: servers and credentials, nothing else.
    let mut reconnected = proxy_test_creds(crate::proxy::ProxyChoice::Global);
    let stored = load_account(&conn, "acct").unwrap().expect("account");
    reconnected.carry_over(
        &stored,
        crate::imap::OmittedSettings {
            proxy: true,
            cert_pin: true,
            smtp_cert_pin: true,
            password: true,
        },
    );
    upsert_account(&conn, "acct", &meta, &reconnected).unwrap();

    let after = stored_creds(&conn, "acct");
    assert_eq!(after.proxy, custom);
    assert_eq!(after.cert_pin.as_deref(), Some("a".repeat(64).as_str()));
    assert_eq!(
        after.smtp_cert_pin.as_deref(),
        Some("b".repeat(64).as_str())
    );
}

/// A setting the caller *did* send wins: that is how the user changes it, and
/// how accepting a new certificate replaces the pin.
#[test]
fn a_setting_that_was_sent_is_not_carried_over() {
    let mut creds = proxy_test_creds(crate::proxy::ProxyChoice::Direct);
    creds.cert_pin = Some("a".repeat(64));
    let mut replacement = proxy_test_creds(crate::proxy::ProxyChoice::Global);
    replacement.cert_pin = None;
    replacement.carry_over(
        &creds,
        crate::imap::OmittedSettings {
            proxy: false,
            cert_pin: false,
            smtp_cert_pin: true,
            password: false,
        },
    );

    assert_eq!(replacement.proxy, crate::proxy::ProxyChoice::Global);
    assert_eq!(replacement.cert_pin, None);
}

/// Editing an account's servers from Settings resends the form without a
/// password — the UI never holds one. An omitted password must keep the stored
/// credential rather than blank it, or saving a port change would lock the
/// account out.
#[test]
fn an_omitted_password_is_carried_over() {
    let mut stored = proxy_test_creds(crate::proxy::ProxyChoice::Direct);
    stored.password = "hunter2".to_string();

    let mut edited = proxy_test_creds(crate::proxy::ProxyChoice::Direct);
    edited.password = String::new();
    edited.port = 1143;
    edited.carry_over(
        &stored,
        crate::imap::OmittedSettings {
            proxy: false,
            cert_pin: false,
            smtp_cert_pin: false,
            password: true,
        },
    );

    assert_eq!(edited.password, "hunter2");
    // The edit itself still applies.
    assert_eq!(edited.port, 1143);
}

/// A password the caller *did* send replaces the stored one — that is how the
/// user changes it after a server-side reset.
#[test]
fn a_sent_password_replaces_the_stored_one() {
    let mut stored = proxy_test_creds(crate::proxy::ProxyChoice::Direct);
    stored.password = "old".to_string();

    let mut replacement = proxy_test_creds(crate::proxy::ProxyChoice::Direct);
    replacement.password = "new".to_string();
    replacement.carry_over(
        &stored,
        crate::imap::OmittedSettings {
            proxy: false,
            cert_pin: false,
            smtp_cert_pin: false,
            password: false,
        },
    );

    assert_eq!(replacement.password, "new");
}

/// Editing an existing account (server settings, reconnect) re-runs the upsert
/// with no avatar; the custom one the user picked must survive it.
#[test]
fn upsert_account_keeps_an_existing_avatar() {
    let conn = test_conn();
    proxy_test_account(&conn, "acct", crate::proxy::ProxyChoice::Direct);
    conn.execute(
        "UPDATE accounts SET avatar_url = ?1 WHERE id = ?2",
        rusqlite::params!["/media/avatars/acct.png", "acct"],
    )
    .unwrap();

    proxy_test_account(&conn, "acct", crate::proxy::ProxyChoice::Direct);

    let stored: String = conn
        .query_row(
            "SELECT avatar_url FROM accounts WHERE id = ?1",
            ["acct"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, "/media/avatars/acct.png");
}

/// Accepting a certificate for an account that already exists must not disturb
/// the rest of its connection settings — the user is not re-entering them.
#[test]
fn set_account_cert_pins_replaces_only_the_pins() {
    let conn = test_conn();
    proxy_test_account(&conn, "acct", crate::proxy::ProxyChoice::Direct);
    set_account_cert_pins(&conn, "acct", Some(&"c".repeat(64)), None).unwrap();

    let stored = stored_creds(&conn, "acct");
    assert_eq!(stored.cert_pin.as_deref(), Some("c".repeat(64).as_str()));
    assert_eq!(stored.smtp_cert_pin, None);
    assert_eq!(stored.host, "imap.example.com");
    assert_eq!(stored.smtp_port, 587);
    assert_eq!(stored.proxy, crate::proxy::ProxyChoice::Direct);

    // Clearing is explicit: pass no pin and the account stops trusting it.
    set_account_cert_pins(&conn, "acct", None, None).unwrap();
    assert_eq!(stored_creds(&conn, "acct").cert_pin, None);
}

#[test]
fn account_proxy_round_trips_and_defaults_to_global() {
    let conn = test_conn();
    let custom = crate::proxy::ProxyChoice::from_json(&json!({
        "mode": "socks5",
        "host": "127.0.0.1",
        "port": 9050,
        "username": "u",
        "password": "p",
    }));
    proxy_test_account(&conn, "acct", custom.clone());
    assert_eq!(stored_proxy(&conn, "acct"), custom);

    // An account written before proxy support has no key in its config JSON.
    conn.execute(
        "UPDATE accounts SET config = json_remove(config, '$.proxy') WHERE id = 'acct'",
        [],
    )
    .unwrap();
    assert_eq!(
        stored_proxy(&conn, "acct"),
        crate::proxy::ProxyChoice::Global
    );
}

#[test]
fn set_account_proxy_replaces_only_the_proxy_entry() {
    let conn = test_conn();
    proxy_test_account(&conn, "acct", crate::proxy::ProxyChoice::Global);
    set_account_proxy(&conn, "acct", &crate::proxy::ProxyChoice::Direct).unwrap();

    let (_, creds) = load_accounts(&conn)
        .unwrap()
        .into_iter()
        .find(|(account, _)| account == "acct")
        .unwrap();
    assert_eq!(creds.proxy, crate::proxy::ProxyChoice::Direct);
    // The rest of the connection config survives the targeted update.
    assert_eq!(creds.host, "imap.example.com");
    assert_eq!(creds.smtp_port, 587);
    assert!(creds.smtp_starttls);
}

#[test]
fn ews_item_map_mints_uids_and_refreshes_change_keys() {
    let conn = test_conn();

    let first = map_ews_item(&conn, "acct", "INBOX", "AAMkONE=", Some("CK1")).unwrap();
    let second = map_ews_item(&conn, "acct", "INBOX", "AAMkTWO=", Some("CK2")).unwrap();
    assert_eq!((first, second), (1, 2), "uids ascend with discovery order");

    // The same item resolves to its established uid, and a re-sync carrying a
    // newer version stamp updates it in place — writes with a stale change key
    // are rejected by Exchange.
    assert_eq!(
        map_ews_item(&conn, "acct", "INBOX", "AAMkONE=", Some("CK1-NEW")).unwrap(),
        first
    );
    assert_eq!(
        ews_item_for_uid(&conn, "acct", "INBOX", first).unwrap(),
        Some(("AAMkONE=".to_string(), Some("CK1-NEW".to_string())))
    );

    // Folders are independent id spaces, as they are on the server.
    assert_eq!(
        map_ews_item(&conn, "acct", "Sent", "AAMkONE=", None).unwrap(),
        1
    );

    assert_eq!(ews_item_for_uid(&conn, "acct", "INBOX", 99).unwrap(), None);
}

#[test]
fn forgetting_an_ews_item_does_not_recycle_its_uid() {
    let conn = test_conn();
    map_ews_item(&conn, "acct", "INBOX", "AAMkONE=", None).unwrap();
    let second = map_ews_item(&conn, "acct", "INBOX", "AAMkTWO=", None).unwrap();

    forget_ews_item(&conn, "acct", "INBOX", "AAMkTWO=").unwrap();
    assert_eq!(ews_item_for_uid(&conn, "acct", "INBOX", second).unwrap(), None);

    // Cached rows, saved Kanban columns and open search snapshots may still
    // reference the retired uid, so the next item must not inherit it.
    let third = map_ews_item(&conn, "acct", "INBOX", "AAMkTHREE=", None).unwrap();
    assert_eq!(third, 3);
}

#[test]
fn folder_sync_state_round_trips_and_is_folder_scoped() {
    let conn = test_conn();
    assert_eq!(get_folder_sync_state(&conn, "acct", "INBOX").unwrap(), None);

    set_folder_sync_state(&conn, "acct", "INBOX", "c3RhdGUx").unwrap();
    set_folder_sync_state(&conn, "acct", "Sent", "c3RhdGVT").unwrap();
    set_folder_sync_state(&conn, "acct", "INBOX", "c3RhdGUy").unwrap();

    assert_eq!(
        get_folder_sync_state(&conn, "acct", "INBOX").unwrap(),
        Some("c3RhdGUy".to_string())
    );
    assert_eq!(
        get_folder_sync_state(&conn, "acct", "Sent").unwrap(),
        Some("c3RhdGVT".to_string())
    );

    // The IMAP columns of the same row are untouched by an EWS sync round.
    set_folder_state(&conn, "acct", "INBOX", 1, 42).unwrap();
    assert_eq!(
        get_folder_sync_state(&conn, "acct", "INBOX").unwrap(),
        Some("c3RhdGUy".to_string())
    );
}

#[test]
fn cached_unseen_since_covers_only_recent_unread_mail() {
    let conn = test_conn();
    let now = 1787562900_i64;
    let day = 24 * 60 * 60;
    for (uid, seen, date) in [
        (1_u32, false, now - day),          // recent, unread
        (2, true, now - day),               // recent, already read
        (3, false, now - 30 * day),         // unread but old
        (4, false, now - 2 * day),          // recent, unread
    ] {
        conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, seen, date)
             VALUES('acct', 'INBOX', ?1, ?2, ?3, ?4)",
            params![uid.to_string(), uid, seen as i64, date],
        )
        .unwrap();
    }
    // Another account's unread mail must not leak into the prefetch set.
    conn.execute(
        "INSERT INTO messages(account, folder, msg_id, uid, seen, date)
         VALUES('other', 'INBOX', '9', 9, 0, ?1)",
        params![now - day],
    )
    .unwrap();

    assert_eq!(
        cached_unseen_uids_since(&conn, "acct", "INBOX", now - 7 * day).unwrap(),
        vec![1, 4]
    );
    // A window that reaches back far enough picks up the older one too.
    assert_eq!(
        cached_unseen_uids_since(&conn, "acct", "INBOX", now - 60 * day).unwrap(),
        vec![1, 3, 4]
    );
}


// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

fn book(source: &str, account: &str, name: &str) -> BookOrigin {
    BookOrigin {
        source: source.into(),
        account: account.into(),
        book: name.into(),
    }
}

fn someone(uid: &str, name: &str, addresses: &[&str]) -> crate::contacts::person::Person {
    crate::contacts::person::Person {
        uid: uid.into(),
        name: name.into(),
        organisation: String::new(),
        note: String::new(),
        emails: addresses
            .iter()
            .map(|addr| crate::contacts::person::EmailAddress {
                addr: addr.to_string(),
                label: String::new(),
            })
            .collect(),
        phones: Vec::new(),
        photo: None,
    }
}

#[test]
fn a_book_is_stored_with_its_addresses_and_read_back_whole() {
    let conn = test_conn();
    let origin = book("carddav", "acct", "default");
    replace_book(
        &conn,
        &origin,
        &[(someone("u1", "Ana Prat", &["ana@work.com", "ana@home.com"]), String::new())],
        100,
    )
    .unwrap();

    let found = find_people(&conn, "", 50).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].person.name, "Ana Prat");
    assert_eq!(found[0].person.emails.len(), 2);
    // The order the book gave them is the order they come back in.
    assert_eq!(found[0].person.emails[0].addr, "ana@work.com");
}

#[test]
fn a_re_sync_updates_in_place_rather_than_adding_everybody_again() {
    let conn = test_conn();
    let origin = book("carddav", "acct", "default");
    replace_book(&conn, &origin, &[(someone("u1", "Ana", &["ana@x.com"]), String::new())], 100).unwrap();
    replace_book(&conn, &origin, &[(someone("u1", "Ana Prat", &["ana@x.com"]), String::new())], 200).unwrap();

    let found = find_people(&conn, "", 50).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].person.name, "Ana Prat");
}

#[test]
fn somebody_the_server_deleted_goes_away() {
    let conn = test_conn();
    let origin = book("carddav", "acct", "default");
    replace_book(
        &conn,
        &origin,
        &[
            (someone("u1", "Ana", &["ana@x.com"]), String::new()),
            (someone("u2", "Marc", &["marc@x.com"]), String::new()),
        ],
        100,
    )
    .unwrap();
    replace_book(&conn, &origin, &[(someone("u1", "Ana", &["ana@x.com"]), String::new())], 200).unwrap();

    let found = find_people(&conn, "", 50).unwrap();
    assert_eq!(found.len(), 1);
    // Their addresses go with them, rather than being left behind pointing at
    // a person who is no longer there.
    let orphans: i64 = conn
        .query_row("SELECT COUNT(*) FROM person_emails", [], |row| row.get(0))
        .unwrap();
    assert_eq!(orphans, 1);
}

#[test]
fn syncing_one_book_does_not_empty_another() {
    let conn = test_conn();
    replace_book(
        &conn,
        &book("carddav", "acct", "work"),
        &[(someone("u1", "Ana", &["ana@x.com"]), String::new())],
        100,
    )
    .unwrap();
    replace_book(
        &conn,
        &book("google", "acct", "default"),
        &[(someone("g1", "Marc", &["marc@x.com"]), String::new())],
        100,
    )
    .unwrap();
    replace_book(&conn, &book("carddav", "acct", "work"), &[], 200).unwrap();

    let found = find_people(&conn, "", 50).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].person.name, "Marc");
}

#[test]
fn the_same_person_in_two_books_stays_two_rows() {
    let conn = test_conn();
    for source in ["carddav", "google"] {
        replace_book(
            &conn,
            &book(source, "acct", "default"),
            &[(someone("u1", "Ana", &["ana@x.com"]), String::new())],
            100,
        )
        .unwrap();
    }
    // Merging them would be a guess about two books that disagree; showing
    // both is the truthful answer and the reader can see which is which.
    assert_eq!(find_people(&conn, "", 50).unwrap().len(), 2);
}

#[test]
fn people_are_found_by_name_by_organisation_and_by_address() {
    let conn = test_conn();
    let mut ana = someone("u1", "Ana Prat", &["ana@hospital.cat"]);
    ana.organisation = "Hospital de Mataró".into();
    replace_book(
        &conn,
        &book("carddav", "acct", "default"),
        &[(ana, String::new()), (someone("u2", "Marc", &["marc@x.com"]), String::new())],
        100,
    )
    .unwrap();

    assert_eq!(find_people(&conn, "prat", 50).unwrap().len(), 1);
    assert_eq!(find_people(&conn, "mataró", 50).unwrap().len(), 1);
    assert_eq!(find_people(&conn, "hospital.cat", 50).unwrap().len(), 1);
    assert_eq!(find_people(&conn, "nobody", 50).unwrap().len(), 0);
}

#[test]
fn a_book_that_names_nobody_still_keeps_its_people_apart() {
    let conn = test_conn();
    replace_book(
        &conn,
        &book("carddav", "acct", "default"),
        &[
            (someone("", "Ana", &["ana@x.com"]), String::new()),
            (someone("", "Marc", &["marc@x.com"]), String::new()),
        ],
        100,
    )
    .unwrap();
    assert_eq!(find_people(&conn, "", 50).unwrap().len(), 2);
}

#[test]
fn a_person_the_reader_keeps_outranks_an_address_that_merely_went_past() {
    let conn = test_conn();
    // A no-reply that has written many times.
    for uid in 1..=5u32 {
        insert_message(
            &conn,
            uid,
            "Newsletter",
            "Shop",
            "no-reply@shop.com",
            None,
        );
    }
    // And one person in the book, never seen in mail.
    replace_book(
        &conn,
        &book("carddav", "acct", "default"),
        &[(someone("u1", "Ana Prat", &["ana@hospital.cat"]), String::new())],
        100,
    )
    .unwrap();

    let suggestions = suggest_contacts(&conn, "acct", "", 8).unwrap();
    assert_eq!(suggestions[0].addr, "ana@hospital.cat");
    assert!(suggestions[0].known);
    assert!(suggestions.iter().any(|c| c.addr == "no-reply@shop.com" && !c.known));
}

#[test]
fn an_address_in_the_book_is_not_offered_twice() {
    let conn = test_conn();
    insert_message(&conn, 1, "Hi", "Ana", "ana@hospital.cat", None);
    replace_book(
        &conn,
        &book("carddav", "acct", "default"),
        &[(someone("u1", "Ana Prat", &["ana@hospital.cat"]), String::new())],
        100,
    )
    .unwrap();

    let suggestions = suggest_contacts(&conn, "acct", "", 8).unwrap();
    assert_eq!(suggestions.len(), 1);
    // And it is the book's version, with the name the reader gave them.
    assert_eq!(suggestions[0].name, "Ana Prat");
}

#[test]
fn somebody_with_two_addresses_is_two_things_to_choose_between() {
    let conn = test_conn();
    replace_book(
        &conn,
        &book("carddav", "acct", "default"),
        &[(someone("u1", "Ana", &["ana@work.com", "ana@home.com"]), String::new())],
        100,
    )
    .unwrap();
    let suggestions = suggest_contacts(&conn, "acct", "ana", 8).unwrap();
    assert_eq!(suggestions.len(), 2);
    assert!(suggestions.iter().all(|c| c.name == "Ana"));
}

#[test]
fn the_book_is_searched_by_name_even_when_no_mail_matches() {
    let conn = test_conn();
    replace_book(
        &conn,
        &book("carddav", "acct", "default"),
        &[(someone("u1", "Ana Prat", &["aprat@hospital.cat"]), String::new())],
        100,
    )
    .unwrap();
    let suggestions = suggest_contacts(&conn, "acct", "prat", 8).unwrap();
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].addr, "aprat@hospital.cat");
}

#[test]
fn removing_a_source_takes_its_people_with_it_and_nobody_else() {
    let conn = test_conn();
    let source = ContactSource {
        id: "src-1".into(),
        kind: "carddav".into(),
        account: String::new(),
        url: "https://dav.example.com/ana/contacts/".into(),
        username: "ana".into(),
        name: "Work".into(),
        enabled: true,
        ctag: String::new(),
        last_sync_at: 0,
        last_error: String::new(),
    };
    upsert_contact_source(&conn, &source, 100).unwrap();
    replace_book(
        &conn,
        &book("carddav", "", "src-1"),
        &[(someone("u1", "Ana", &["ana@x.com"]), String::new())],
        100,
    )
    .unwrap();
    // Somebody from another book, who must survive.
    replace_book(
        &conn,
        &book("google", "acct", "default"),
        &[(someone("g1", "Marc", &["marc@x.com"]), String::new())],
        100,
    )
    .unwrap();

    delete_contact_source(&conn, "src-1").unwrap();

    assert!(contact_sources(&conn).unwrap().is_empty());
    let left = find_people(&conn, "", 50).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].person.name, "Marc");
}

#[test]
fn a_sync_outcome_is_recorded_and_a_good_one_clears_a_bad_one() {
    let conn = test_conn();
    let source = ContactSource {
        id: "src-1".into(),
        kind: "carddav".into(),
        account: String::new(),
        url: "https://dav.example.com/".into(),
        username: String::new(),
        name: String::new(),
        enabled: true,
        ctag: String::new(),
        last_sync_at: 0,
        last_error: String::new(),
    };
    upsert_contact_source(&conn, &source, 100).unwrap();
    mark_contact_source_synced(&conn, "src-1", "", "refused", 200).unwrap();
    assert_eq!(contact_source(&conn, "src-1").unwrap().unwrap().last_error, "refused");
    mark_contact_source_synced(&conn, "src-1", "tok", "", 300).unwrap();
    let after = contact_source(&conn, "src-1").unwrap().unwrap();
    assert_eq!(after.last_error, "");
    assert_eq!(after.last_sync_at, 300);
}
