use super::*;
use crate::store;

fn add(conn: &Connection, account: &str, uid: i64, from: &str, date: i64, attachments: &str, body: Option<&str>) {
    conn.execute(
        "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, thread_key, body, json)
         VALUES(?1, 'INBOX', ?2, ?3, 'Subject ' || ?3, ?4, ?4, ?5, 't' || ?3, ?6, ?7)",
        rusqlite::params![account, uid.to_string(), uid, from, date, body, format!("{{\"attachments\":{attachments}}}")],
    )
    .unwrap();
}

fn db() -> Connection {
    let conn = store::open_at(":memory:").unwrap();
    add(&conn, "a@x", 1, "ana@x.cat", 100, r#"[{"filename":"Budget 2026.xlsx","mime":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","size":2048,"key":"a/INBOX/1/0.xlsx"}]"#, Some("b"));
    add(&conn, "a@x", 2, "bo@y.com", 200, r#"[{"filename":"scan.pdf","mime":"application/pdf","size":900000,"key":null},{"filename":"","mime":"image/png","size":10,"key":"a/INBOX/2/1.png"},{"filename":"photo.jpg","mime":"image/jpeg","size":50000,"key":"a/INBOX/2/2.jpg"}]"#, Some("b"));
    add(&conn, "b@z", 3, "ana@x.cat", 300, r#"[{"filename":"cloud link","mime":"application/octet-stream","size":0,"key":null,"unavailable":"link"}]"#, Some("b"));
    add(&conn, "a@x", 4, "cy@q", 400, "[]", Some("b"));
    add(&conn, "a@x", 5, "cy@q", 500, "[]", None);
    conn
}

fn names(page: &Page) -> Vec<&str> {
    page.items.iter().map(|i| i.filename.as_str()).collect()
}

#[test]
fn every_attachment_is_listed_newest_first_with_where_it_came_from() {
    let conn = db();
    let page = list(&conn, &Query::default()).unwrap();
    assert_eq!(names(&page), vec!["cloud link", "scan.pdf", "photo.jpg", "Budget 2026.xlsx"], "an unnamed inline image is not a file");
    assert_eq!(page.total, 4);
    let scan = &page.items[1];
    assert_eq!((scan.account.as_str(), scan.uid, scan.index, scan.kind.as_str()), ("a@x", 2, 0, "pdf"));
    assert_eq!(scan.key, None, "not downloaded is said, not invented");
    assert_eq!(page.items[0].unavailable, "link");
    assert_eq!(page.coverage, Coverage { messages: 5, downloaded: 4 });
}

#[test]
fn files_are_found_by_account_name_sender_kind_date_and_size() {
    let conn = db();
    let q = |query: Query| names(&list(&conn, &query).unwrap()).into_iter().map(str::to_string).collect::<Vec<_>>();
    assert_eq!(q(Query { account: "b@z".into(), ..Default::default() }), vec!["cloud link"]);
    assert_eq!(q(Query { name: "budget 2026".into(), ..Default::default() }), vec!["Budget 2026.xlsx"]);
    assert_eq!(q(Query { sender: "ANA@".into(), ..Default::default() }), vec!["cloud link", "Budget 2026.xlsx"]);
    assert_eq!(q(Query { kind: "image".into(), ..Default::default() }), vec!["photo.jpg"]);
    assert_eq!(q(Query { kind: "spreadsheet".into(), ..Default::default() }), vec!["Budget 2026.xlsx"]);
    assert_eq!(q(Query { from: Some(150), to: Some(350), ..Default::default() }), vec!["cloud link", "scan.pdf", "photo.jpg"]);
    assert_eq!(q(Query { min_size: Some(100_000), ..Default::default() }), vec!["scan.pdf"]);
    assert_eq!(q(Query { name: "100%".into(), ..Default::default() }), Vec::<String>::new(), "% is a character");
    let coverage = list(&conn, &Query { account: "b@z".into(), ..Default::default() }).unwrap().coverage;
    assert_eq!(coverage, Coverage { messages: 1, downloaded: 1 });
}

#[test]
fn pages_are_bounded() {
    let conn = db();
    let first = list(&conn, &Query { limit: Some(2), ..Default::default() }).unwrap();
    let second = list(&conn, &Query { limit: Some(2), offset: Some(2), ..Default::default() }).unwrap();
    assert_eq!((first.items.len(), second.items.len(), first.total), (2, 2, 4));
    assert_ne!(first.items[0], second.items[0]);
    assert_eq!(list(&conn, &Query { limit: Some(100_000), ..Default::default() }).unwrap().items.len(), 4);
}

#[test]
fn kinds_come_from_the_type_or_else_the_extension() {
    assert_eq!(kind_of("application/octet-stream", "notes.DOCX"), "document");
    assert_eq!(kind_of("image/heic", "x"), "image");
    assert_eq!(kind_of("", "invite.ics"), "calendar");
    assert_eq!(kind_of("application/x-unknown", "thing.bin"), "other");
}
