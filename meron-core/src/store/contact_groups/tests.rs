use super::*;
use crate::contacts::person::{EmailAddress, Person};
use crate::store::{local_people, SyncedRow};

fn conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::store::db::run_migrations(&conn).unwrap();
    conn
}

fn local(conn: &Connection, name: &str, addr: &str) -> String {
    let person = Person {
        name: name.into(),
        emails: vec![EmailAddress { addr: addr.into(), label: String::new() }],
        ..Default::default()
    };
    match local_people::save(conn, None, None, &person, 1).unwrap() {
        local_people::Write::Saved { id, .. } => id,
        other => panic!("{other:?}"),
    }
}

fn saved(write: Write) -> (String, String) {
    match write {
        Write::Saved { id, version } => (id, version),
        other => panic!("expected a save, got {other:?}"),
    }
}

#[test]
fn a_local_group_is_created_renamed_and_its_members_changed_from_its_version() {
    let conn = conn();
    let ann = local(&conn, "Ann Lee", "ann@example.com");
    let bob = local(&conn, "Bob Roe", "bob@example.com");
    let (id, version) = saved(save_local(&conn, None, None, " Climbing ", &[ann.clone()], 1).unwrap());
    assert_eq!(version, "1");
    let group = get(&conn, &id).unwrap().unwrap();
    assert_eq!((group.name.as_str(), group.members.clone()), ("Climbing", vec![ann.clone()]));

    let (_, version) =
        saved(save_local(&conn, Some(&id), Some("1"), "Climbing club", &[ann.clone(), bob.clone(), "nobody".into()], 2).unwrap());
    assert_eq!(version, "2");
    let group = get(&conn, &id).unwrap().unwrap();
    assert_eq!(group.name, "Climbing club");
    assert_eq!(group.members, vec![ann.clone(), bob.clone()], "somebody not in the book is not added");

    // A window that read version 1 saves nothing and is shown the current copy.
    match save_local(&conn, Some(&id), Some("1"), "Other", &[], 3).unwrap() {
        Write::Conflict { current: Some(current) } => assert_eq!(current.name, "Climbing club"),
        other => panic!("{other:?}"),
    }
    assert_eq!(get(&conn, &id).unwrap().unwrap().members.len(), 2);
    assert!(save_local(&conn, None, None, "  ", &[], 1).is_err(), "a group needs a name");
}

#[test]
fn deleting_a_local_group_keeps_its_people_and_deleting_a_person_leaves_its_groups() {
    let conn = conn();
    let ann = local(&conn, "Ann Lee", "ann@example.com");
    let bob = local(&conn, "Bob Roe", "bob@example.com");
    let (id, _) = saved(save_local(&conn, None, None, "G", &[ann.clone(), bob.clone()], 1).unwrap());

    local_people::delete(&conn, &bob, "1").unwrap();
    assert_eq!(get(&conn, &id).unwrap().unwrap().members, vec![ann.clone()]);

    assert!(matches!(delete_local(&conn, &id, "0").unwrap(), Write::Conflict { current: Some(_) }));
    saved(delete_local(&conn, &id, "1").unwrap());
    assert!(get(&conn, &id).unwrap().is_none());
    assert!(local_people::get(&conn, &ann).unwrap().is_some(), "the people stay");
}

#[test]
fn a_sync_replaces_a_books_groups_and_keeps_them_pointing_at_its_people() {
    let conn = conn();
    let origin = BookOrigin { source: "carddav".into(), account: "a@example.com".into(), book: "book-1".into() };
    let people = ["ana", "marc"].map(|uid| SyncedRow {
        person: Person {
            uid: uid.into(),
            name: uid.into(),
            emails: vec![EmailAddress { addr: format!("{uid}@example.com"), label: String::new() }],
            ..Default::default()
        },
        ..Default::default()
    });
    crate::store::replace_book_rows(&conn, &origin, &people, 1).unwrap();
    let row = GroupRow {
        uid: "fam".into(),
        name: "Family".into(),
        members: vec!["ana".into(), "gone".into(), "marc".into()],
        href: "https://dav.example/fam.vcf".into(),
        version: "\"e1\"".into(),
        style: "apple".into(),
    };
    replace_book_groups(&conn, &origin, &[row.clone()], 1).unwrap();
    // The people re-synced: the group still finds them.
    crate::store::replace_book_rows(&conn, &origin, &people, 2).unwrap();

    let all = list(&conn).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, group_id(&origin, "fam"));
    assert_eq!(all[0].style, "apple");
    let details = member_details(&conn).unwrap();
    let names: Vec<&str> = details.iter().map(|member| member.name.as_str()).collect();
    assert_eq!(names, vec!["ana", "marc"], "a member with no card here is not listed");
    assert_eq!(details[0].addr, "ana@example.com");

    replace_book_groups(&conn, &origin, &[], 3).unwrap();
    assert!(list(&conn).unwrap().is_empty());
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM contact_group_members", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
}

#[test]
fn a_removed_account_takes_its_groups_and_their_members() {
    let conn = conn();
    conn.execute("INSERT INTO accounts(id, email) VALUES('gone', 'gone')", []).unwrap();
    let origin = BookOrigin { source: "google".into(), account: "gone".into(), book: "google-gone".into() };
    replace_book_groups(
        &conn,
        &origin,
        &[GroupRow { uid: "contactGroups/1".into(), name: "Work".into(), members: vec!["people/1".into()], ..Default::default() }],
        1,
    )
    .unwrap();
    let ann = local(&conn, "Ann", "ann@example.com");
    saved(save_local(&conn, None, None, "Mine", &[ann], 1).unwrap());
    crate::store::delete_account(&conn, "gone").unwrap();
    let groups: Vec<String> = list(&conn).unwrap().into_iter().map(|group| group.name).collect();
    assert_eq!(groups, vec!["Mine"]);
    let members: i64 = conn.query_row("SELECT COUNT(*) FROM contact_group_members", [], |r| r.get(0)).unwrap();
    assert_eq!(members, 1);
}

#[test]
fn the_books_names_are_found_by_address_local_first() {
    let conn = conn();
    let origin = BookOrigin { source: "carddav".into(), account: String::new(), book: "b".into() };
    crate::store::replace_book_rows(
        &conn,
        &origin,
        &[SyncedRow {
            person: Person {
                uid: "x".into(),
                name: "Zed Server".into(),
                emails: vec![EmailAddress { addr: "ann@example.com".into(), label: String::new() }],
                ..Default::default()
            },
            ..Default::default()
        }],
        1,
    )
    .unwrap();
    let person = Person {
        name: "Ann Lee".into(),
        given: "Ann".into(),
        family: "Lee".into(),
        emails: vec![EmailAddress { addr: "ann@example.com".into(), label: String::new() }],
        ..Default::default()
    };
    local_people::save(&conn, None, None, &person, 1).unwrap();
    let found = book_names(&conn, &["ann@example.com".into(), "nobody@example.com".into()]).unwrap();
    assert_eq!(found[0], ("ann@example.com".into(), "Ann Lee".into(), "Ann".into(), "Lee".into()));
    assert!(found.iter().all(|(addr, ..)| addr == "ann@example.com"));
}

#[test]
fn a_local_person_keeps_given_and_family_names() {
    let conn = conn();
    let person = Person { given: " Fang ".into(), family: "Wang".into(), ..Default::default() };
    let id = match local_people::save(&conn, None, None, &person, 1).unwrap() {
        local_people::Write::Saved { id, .. } => id,
        other => panic!("{other:?}"),
    };
    let (stored, _) = local_people::get(&conn, &id).unwrap().unwrap();
    assert_eq!((stored.person.given.as_str(), stored.person.family.as_str()), ("Fang", "Wang"));
    assert_eq!(stored.person.name, "Fang Wang", "a name typed only in parts still has one");
}
