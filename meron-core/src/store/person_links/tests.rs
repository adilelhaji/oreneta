use super::*;
use crate::contacts::person::{EmailAddress, Person};
use crate::store::BookOrigin;

fn conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::store::db::run_migrations(&conn).unwrap();
    conn
}

fn person(uid: &str, name: &str, email: &str) -> (Person, String) {
    (
        Person {
            uid: uid.into(),
            name: name.into(),
            emails: vec![EmailAddress { addr: email.into(), label: String::new() }],
            ..Default::default()
        },
        String::new(),
    )
}

fn book(source: &str, id: &str) -> BookOrigin {
    BookOrigin { source: source.into(), account: String::new(), book: id.into() }
}

fn seed(conn: &Connection) -> (String, String, String) {
    let work = book("carddav", "work");
    let google = book("google", "g");
    crate::store::replace_book(conn, &work, &[person("a", "Ana Prat", "ana@x.cat"), person("c", "Cy", "cy@x.cat")], 1).unwrap();
    crate::store::replace_book(conn, &google, &[person("a2", "Ana P.", "ANA@x.cat")], 1).unwrap();
    (work.person_id("a"), google.person_id("a2"), work.person_id("c"))
}

#[test]
fn people_sharing_an_address_are_suggested_never_linked_alone() {
    let conn = conn();
    let (ana, ana2, _) = seed(&conn);
    assert_eq!(suggestions(&conn).unwrap(), vec![vec![ana.clone(), ana2.clone()].into_iter().collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>()]);
    assert!(links(&conn).unwrap().is_empty(), "nothing linked until the reader says so");
}

#[test]
fn linking_survives_a_resync_and_unlinking_undoes_it() {
    let conn = conn();
    let (ana, ana2, _) = seed(&conn);
    let link = link(&conn, &[ana.clone(), ana2.clone()]).unwrap();
    assert!(suggestions(&conn).unwrap().is_empty(), "a linked pair is not suggested again");
    // A resync replaces the rows with the same ids; the link stays.
    seed(&conn);
    assert_eq!(links(&conn).unwrap().get(&ana), Some(&link));
    unlink(&conn, &ana).unwrap();
    assert!(links(&conn).unwrap().is_empty(), "a link of one is no link");
    let people: i64 = conn.query_row("SELECT COUNT(*) FROM people", [], |r| r.get(0)).unwrap();
    assert_eq!(people, 3, "nothing was deleted, here or anywhere");
}

#[test]
fn not_the_same_is_remembered() {
    let conn = conn();
    let (ana, ana2, _) = seed(&conn);
    dismiss(&conn, &[ana2, ana]).unwrap();
    assert!(suggestions(&conn).unwrap().is_empty());
}

#[test]
fn linking_needs_two_real_people() {
    let conn = conn();
    let (ana, _, _) = seed(&conn);
    assert!(link(&conn, &[ana.clone()]).is_err());
    assert!(link(&conn, &[ana, "carddav::work:gone".into()]).is_err());
}
