use super::*;
use crate::imap::Recipient;
use std::collections::HashSet;

fn conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    store::run_migrations(&conn).unwrap();
    conn
}

fn scope(account: &str, folder: &str) -> Scope {
    Scope { account: account.into(), folder: folder.into() }
}

fn header(uid: u32, key: &str, date: i64, name: &str, subject: &str) -> MessageHeader {
    MessageHeader {
        uid, thread_key: key.into(), date, from_name: name.into(),
        from_addr: format!("sender{uid}@example.test"), subject: subject.into(), seen: true,
        ..Default::default()
    }
}

fn seed(conn: &Connection, scope: &Scope, messages: &[MessageHeader]) {
    store::ensure_folder(conn, &scope.account, &scope.folder).unwrap();
    store::upsert_messages(conn, &scope.account, &scope.folder, messages).unwrap();
}

fn request(sort: &str, filter: &str, limit: u32) -> ThreadListQuery {
    ThreadListQuery::from_params(&serde_json::json!({"sort": sort, "filter": filter, "limit": limit}), "folder")
}

#[test]
fn long_conversation_crosses_header_chunks_but_not_card_pages() {
    let conn = conn();
    let scope = scope("a", "INBOX");
    let mut messages: Vec<_> = (1..=HEADER_CHUNK + 7)
        .map(|uid| header(uid, "gmthrid:long", i64::from(uid), "Long", "Topic")).collect();
    messages.push(header(2_001, "gmthrid:other", 2_001, "Other", "Other"));
    seed(&conn, &scope, &messages);
    let query = request("date:asc", "all", 1);
    let first = page(&conn, vec![scope.clone()], "recent:a", &query, None).unwrap();
    assert_eq!(first.threads.len(), 1);
    assert_eq!(first.threads[0]["message_count"], HEADER_CHUNK + 7);
    assert_eq!(first.threads[0]["date"], HEADER_CHUNK + 7);
    let second = page(&conn, vec![scope], "recent:a", &query, first.next_cursor.as_deref()).unwrap();
    assert_eq!(second.threads.len(), 1);
    assert_eq!(second.threads[0]["subject"], "Other");
    assert!(second.next_cursor.is_none());
    assert_ne!(first.threads[0]["thread_id"], second.threads[0]["thread_id"]);
}

#[test]
fn all_sorts_traverse_complete_cards_across_qualified_scopes() {
    let conn = conn();
    let scopes = vec![scope("a", "INBOX"), scope("b", "INBOX"), scope("a", "Archive")];
    for scope in &scopes {
        seed(&conn, scope, &[
            header(1, "gmthrid:one", 10, "Zulu", "Zebra"),
            header(2, "gmthrid:one", 20, "Alpha", "Re: Zebra"),
            header(3, "gmthrid:two", 30, "Beta", "Apple"),
        ]);
    }
    for key in ["date", "sender", "subject"] {
        for direction in ["asc", "desc"] {
            let sort = format!("{key}:{direction}");
            let expected = page(&conn, scopes.clone(), "recent:unified", &request(&sort, "all", 100), None).unwrap();
            assert_eq!(expected.threads.len(), 6);
            for size in [1, 2, 3, 6, 7] {
                let query = request(&sort, "all", size);
                let mut cursor = None;
                let mut actual = Vec::new();
                for attempt in 0..=6 {
                    let result = page(&conn, scopes.clone(), "recent:unified", &query, cursor.as_deref()).unwrap();
                    assert!(result.threads.len() <= size as usize);
                    actual.extend(result.threads);
                    cursor = result.next_cursor;
                    if cursor.is_none() { break; }
                    assert!(attempt < 6);
                }
                assert_eq!(actual, expected.threads, "{sort}, size={size}");
                let ids: HashSet<_> = actual.iter().map(|card| card["thread_id"].as_str().unwrap()).collect();
                assert_eq!(ids.len(), 6);
            }
        }
    }
}

#[test]
fn filtered_representative_preserves_root_and_full_folder_aggregates() {
    let conn = conn();
    let scope = scope("a", "INBOX");
    let mut root = header(1, "gmthrid:topic", 999, "Root", "Canonical title");
    root.starred = true;
    let mut older = header(2, "gmthrid:topic", 100, "Older", "Re: Canonical title");
    older.seen = false;
    let mut latest = header(3, "gmthrid:topic", 200, "Latest", "Re: Canonical title");
    latest.seen = false;
    seed(&conn, &scope, &[root, older, latest]);
    for sort in ["date:asc", "date:desc", "sender:asc", "subject:desc"] {
        let result = page(&conn, vec![scope.clone()], "recent:a", &request(sort, "unread", 1), None).unwrap();
        let card = &result.threads[0];
        assert_eq!(card["subject"], "Canonical title");
        assert_eq!(card["from_name"], "Latest");
        assert_eq!(card["date"], 200);
        assert_eq!(card["unread_count"], 2);
        assert_eq!(card["message_count"], 3);
        assert_eq!(card["starred"], true);
        assert_eq!(card["unread"], true);
        assert!(result.next_cursor.is_none());
    }
    // Combining facets remains message eligibility, not independent card-wide
    // predicates: no one message is both unread and starred in this fixture.
    let result = page(&conn, vec![scope], "recent:a", &request("date", "unread,starred", 1), None).unwrap();
    assert!(result.threads.is_empty() && result.next_cursor.is_none());
}

#[test]
fn sender_sort_uses_outgoing_recipient_and_latest_uid_on_date_ties() {
    let conn = conn();
    let scope = scope("a", "Sent");
    let mut first = header(1, "gmthrid:one", 10, "Envelope Z", "First");
    first.to = vec![Recipient { name: "Zulu".into(), addr: "z@example.test".into() }];
    let mut reply = header(2, "gmthrid:one", 10, "Envelope Z", "Re: First");
    reply.to = vec![Recipient { name: "Alpha".into(), addr: "a@example.test".into() },
        Recipient { name: "Copy".into(), addr: "c@example.test".into() }];
    let mut second = header(3, "gmthrid:two", 30, "Envelope A", "Second");
    second.to = vec![Recipient { name: "Beta".into(), addr: "b@example.test".into() }];
    seed(&conn, &scope, &[first, reply, second]);
    let result = page(&conn, vec![scope], "recent:a:sent", &request("sender:asc", "all", 1), None).unwrap();
    assert_eq!(result.threads[0]["from_name"], "Alpha");
    assert_eq!(result.threads[0]["from_addr"], "a@example.test");
    assert_eq!(result.threads[0]["recipient_overflow"], 1);
    assert_eq!(result.threads[0]["subject"], "First");
}

#[test]
fn branches_and_canonical_root_survive_filters_and_snooze_precedes_limit() {
    let conn = conn();
    let scope = scope("a", "INBOX");
    let root = header(1, "refs-root", 1, "Root", "Alpha");
    let mut branch = header(2, "refs-root", 20, "Branch", "Beta");
    branch.seen = false;
    let other = header(3, "gmthrid:other", 10, "Other", "Other");
    seed(&conn, &scope, &[root, branch, other]);
    let filtered = page(&conn, vec![scope.clone()], "recent:a", &request("date", "unread", 1), None).unwrap();
    assert_eq!(filtered.threads[0]["subject"], "Alpha");
    assert_eq!(filtered.threads[0]["thread_id"], mail_model::format_thread_id("a", "INBOX", "refs-root#Beta"));
    assert_eq!(filtered.threads[0]["original_thread_id"], mail_model::format_thread_id("a", "INBOX", "refs-root#Alpha"));
    store::snooze_thread(&conn, "a", "refs-root#Beta", "INBOX", store::now_unix() + 600).unwrap();
    let first = page(&conn, vec![scope.clone()], "recent:a", &request("date", "all", 1), None).unwrap();
    assert_eq!(first.threads[0]["subject"], "Other");
    let next = page(&conn, vec![scope.clone()], "recent:a", &request("date", "all", 1), first.next_cursor.as_deref()).unwrap();
    assert_eq!(next.threads.len(), 1);
    assert!(next.next_cursor.is_none());
    store::snooze_thread(&conn, "a", "refs-root", "INBOX", store::now_unix() + 600).unwrap();
    let all = page(&conn, vec![scope], "recent:a", &request("date", "all", 10), None).unwrap();
    assert_eq!(all.threads.len(), 1);
}

#[test]
fn reader_scope_counts_deduplicate_copies_and_listing_never_marks_read() {
    let conn = conn();
    let inbox = scope("a", "INBOX");
    let sent = scope("a", "Sent");
    let mut incoming = header(1, "gmthrid:one", 10, "Alice", "Topic");
    incoming.message_id = "incoming@example.test".into();
    incoming.seen = false;
    let mut reply = header(2, "gmthrid:one", 20, "Me", "Re: Topic");
    reply.message_id = "reply@example.test".into();
    seed(&conn, &inbox, &[incoming, reply.clone()]);
    seed(&conn, &sent, &[reply]);
    conn.execute("UPDATE messages SET body = 'cached body'", []).unwrap();
    let before: (i64, i64) = conn.query_row("SELECT SUM(seen), COUNT(body) FROM messages", [],
        |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    store::set_folder_state(&conn, "a", "INBOX", 1, 2).unwrap();
    let result = page(&conn, vec![inbox], "recent:a", &request("date", "all", 1), None).unwrap();
    assert_eq!(result.threads[0]["message_count"], 2);
    assert_eq!(result.threads[0]["body"], "");
    assert_eq!(result.threads[0]["preview"], "");
    assert_eq!(result.folders[0].unread, 1);
    assert!(result.folders[0].synced);
    let after: (i64, i64) = conn.query_row("SELECT SUM(seen), COUNT(body) FROM messages", [],
        |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(before, after);
    assert!(conn.is_autocommit());
}

#[test]
fn scopes_are_canonical_and_errors_do_not_leave_a_transaction_open() {
    let conn = conn();
    let inbox = scope("a", "INBOX");
    seed(&conn, &inbox, &[header(1, "gmthrid:one", 1, "A", "One"), header(2, "gmthrid:two", 2, "B", "Two")]);
    let query = request("date", "all", 1);
    let first = page(&conn, vec![inbox.clone(), scope("a", "inbox")], "recent:a", &query, None).unwrap();
    assert_eq!(first.folders.len(), 1);
    let next = page(&conn, vec![inbox.clone()], "recent:a", &query, first.next_cursor.as_deref()).unwrap();
    assert_eq!(next.threads.len(), 1);
    assert!(next.next_cursor.is_none());
    for cursor in ["date:1:1", "conv1:bad"] {
        assert!(page(&conn, vec![inbox.clone()], "recent:a", &query, Some(cursor)).is_err());
        assert!(conn.is_autocommit());
    }
    assert!(page(&conn, vec![scope("b", "INBOX")], "recent:a", &query, first.next_cursor.as_deref()).is_err());
    assert!(conn.is_autocommit());
    for filter in ["starred", "snoozed"] {
        assert!(page(&conn, vec![inbox.clone()], "recent:a", &request("date", filter, 1), None).is_err());
    }
    let mut search = query;
    search.query = "search".into();
    assert!(page(&conn, vec![inbox], "recent:a", &search, None).is_err());
}

#[test]
fn attachment_and_priority_facets_require_matching_known_flags() {
    let conn = conn();
    let inbox = scope("a", "INBOX");
    seed(&conn, &inbox, &[
        header(1, "gmthrid:one", 30, "Newest", "Topic"),
        header(2, "gmthrid:one", 10, "Matching", "Re: Topic"),
        header(3, "gmthrid:other", 20, "Unknown", "Other"),
    ]);
    conn.execute("UPDATE messages SET has_attachments = NULL, priority = NULL", []).unwrap();
    conn.execute("UPDATE messages SET has_attachments = 1, priority = 1 WHERE uid = 2", []).unwrap();
    let result = page(&conn, vec![inbox], "recent:a", &request("date", "attachments,priority", 1), None).unwrap();
    assert_eq!(result.threads.len(), 1);
    assert_eq!(result.threads[0]["from_name"], "Matching");
    assert_eq!(result.threads[0]["message_count"], 2);
    assert_eq!(result.threads[0]["has_attachments"], true);
    assert!(result.next_cursor.is_none());
}

#[test]
fn labels_select_whole_thread_and_uid_snoozes_stay_folder_scoped() {
    let conn = conn();
    let inbox = scope("a", "INBOX");
    let archive = scope("a", "Archive");
    seed(&conn, &inbox, &[header(1, "uid:1", 1, "Inbox", "Inbox")]);
    seed(&conn, &archive, &[header(1, "uid:1", 1, "Archive", "Archive")]);
    conn.execute("INSERT INTO labels(id, name, colour, position) VALUES('label-1', 'Label', '#000000', 0)", []).unwrap();
    store::add_thread_label(&conn, "a", "uid:1", "label-1").unwrap();
    let query = request("date", "label:label-1", 10);
    assert_eq!(page(&conn, vec![inbox.clone()], "recent:a", &query, None).unwrap().threads.len(), 1);
    store::snooze_thread(&conn, "a", "uid:1", "INBOX", store::now_unix() + 600).unwrap();
    let result = page(&conn, vec![inbox, archive], "recent:all-folders", &query, None).unwrap();
    assert_eq!(result.threads.len(), 1);
    assert_eq!(result.threads[0]["folder_id"], "Archive");
}

#[test]
fn empty_scopes_are_empty_and_rss_is_an_explicit_unsupported_source() {
    let conn = conn();
    let query = request("date", "all", 10);
    let empty = page(&conn, vec![], "recent:unified", &query, None).unwrap();
    assert!(empty.threads.is_empty() && empty.folders.is_empty() && empty.next_cursor.is_none());
    conn.execute("INSERT INTO accounts(id, engine) VALUES('feed', 'rss')", []).unwrap();
    assert!(page(&conn, vec![scope("feed", "INBOX")], "recent:feed", &query, None).is_err());
    assert!(conn.is_autocommit());
}
