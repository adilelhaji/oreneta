use super::*;
use crate::contacts::person::{EmailAddress, PhoneNumber};

fn conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::store::db::run_migrations(&conn).unwrap();
    conn
}

fn ann() -> Person {
    Person {
        name: "  Ann Lee ".into(),
        emails: vec![
            EmailAddress { addr: "Ann@Example.com ".into(), label: "work".into() },
            EmailAddress { addr: "  ".into(), label: String::new() },
        ],
        phones: vec![PhoneNumber { number: "+34 600 000 000".into(), label: String::new() }],
        ..Default::default()
    }
}

fn saved(write: Write) -> (String, String) {
    match write {
        Write::Saved { id, version } => (id, version),
        other => panic!("expected a save, got {other:?}"),
    }
}

#[test]
fn a_local_contact_is_created_found_and_tidied() {
    let conn = conn();
    let (id, version) = saved(save(&conn, None, None, &ann(), 10).unwrap());
    assert_eq!(version, "1");
    let (stored, _) = get(&conn, &id).unwrap().unwrap();
    assert_eq!(stored.person.name, "Ann Lee");
    assert_eq!(stored.person.emails.len(), 1, "a blank address row is not a detail");
    assert_eq!(stored.person.emails[0].addr, "ann@example.com");
    let found = crate::store::find_people(&conn, "ann@example", 10).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].origin.source, "local");
}

#[test]
fn an_edit_from_the_version_read_is_saved_and_moves_the_version_on() {
    let conn = conn();
    let (id, v1) = saved(save(&conn, None, None, &ann(), 10).unwrap());
    let mut edited = ann();
    edited.organisation = "Acme".into();
    edited.emails.clear();
    let (_, v2) = saved(save(&conn, Some(&id), Some(&v1), &edited, 20).unwrap());
    assert_eq!(v2, "2");
    let (stored, _) = get(&conn, &id).unwrap().unwrap();
    assert_eq!(stored.person.organisation, "Acme");
    assert!(stored.person.emails.is_empty(), "a removed address is removed");
    assert_eq!(stored.person.phones.len(), 1);
}

#[test]
fn an_edit_from_an_older_version_saves_nothing_and_returns_the_current_copy() {
    let conn = conn();
    let (id, v1) = saved(save(&conn, None, None, &ann(), 10).unwrap());
    let mut first = ann();
    first.note = "from the other window".into();
    saved(save(&conn, Some(&id), Some(&v1), &first, 20).unwrap());

    let mut second = ann();
    second.note = "from this window".into();
    match save(&conn, Some(&id), Some(&v1), &second, 30).unwrap() {
        Write::Conflict { current: Some(current) } => {
            assert_eq!(current.person.note, "from the other window");
        }
        other => panic!("expected a conflict, got {other:?}"),
    }
    let (stored, version) = get(&conn, &id).unwrap().unwrap();
    assert_eq!((stored.person.note.as_str(), version.as_str()), ("from the other window", "2"));
}

#[test]
fn editing_a_contact_deleted_meanwhile_is_a_conflict_with_nothing_current() {
    let conn = conn();
    let (id, v1) = saved(save(&conn, None, None, &ann(), 10).unwrap());
    saved(delete(&conn, &id, &v1).unwrap());
    assert_eq!(save(&conn, Some(&id), Some(&v1), &ann(), 20).unwrap(), Write::Conflict { current: None });
    assert!(get(&conn, &id).unwrap().is_none(), "not brought back");
}

#[test]
fn deleting_from_an_older_version_deletes_nothing() {
    let conn = conn();
    let (id, v1) = saved(save(&conn, None, None, &ann(), 10).unwrap());
    saved(save(&conn, Some(&id), Some(&v1), &ann(), 20).unwrap());
    assert!(matches!(delete(&conn, &id, &v1).unwrap(), Write::Conflict { current: Some(_) }));
    assert!(get(&conn, &id).unwrap().is_some());
}

#[test]
fn a_contact_with_neither_name_nor_address_is_refused() {
    let conn = conn();
    let empty = Person { phones: ann().phones, ..Default::default() };
    assert!(save(&conn, None, None, &empty, 10).is_err());
}

#[test]
fn a_synced_contact_cannot_be_written_through_the_local_book() {
    let conn = conn();
    let origin = crate::store::BookOrigin { source: "carddav".into(), account: "a".into(), book: "b".into() };
    crate::store::replace_book(&conn, &origin, &[(Person { uid: "u".into(), ..ann() }, String::new())], 1).unwrap();
    let id = origin.person_id("u");
    assert_eq!(save(&conn, Some(&id), Some(""), &ann(), 2).unwrap(), Write::Conflict { current: None });
    let found = crate::store::find_people(&conn, "", 10).unwrap();
    assert_eq!(found[0].origin.source, "carddav", "untouched");
}
