//! An Exchange account's address books (ADR-0058, ADR-0066), on recorded
//! SOAP: distribution lists as contact groups, people written with their
//! change keys, and the contact folders under Contacts as books of their own.

use std::sync::Mutex;

use super::*;
use crate::contacts::person::EmailAddress;
use crate::exchange::book::tests::{found, full_contact_xml, got, list_xml, marked_contact_xml, member_xml, read_full};
use crate::exchange::book::{Book, Contact, ContactFolder, Member};
use crate::exchange::tests::scripted::{client, error_response, ok, serve, Step};

const A: &str = "work@example.org";
const B: &str = "other@example.org";

fn person(id: &str, name: &str, email: &str) -> Contact {
    Contact {
        change_key: format!("ck-{id}"),
        person: crate::contacts::person::Person {
            uid: id.to_string(),
            name: name.to_string(),
            emails: vec![crate::contacts::person::EmailAddress { addr: email.to_string(), label: String::new() }],
            ..Default::default()
        },
        ..Default::default()
    }
}

fn member(key: &str, name: &str, addr: &str, item: Option<&str>) -> Member {
    Member { key: key.into(), name: name.into(), addr: addr.into(), item_id: item.map(str::to_string) }
}

/// The book of these tests: Ana and Pere, and a list with Ana, an address
/// typed in (Joan) and a directory entry with no address.
fn book() -> Book {
    Book {
        contacts: vec![person("C1", "Ana Puig", "ana@example.org"), person("C2", "Pere Clavé", "pere@example.org")],
        lists: vec![DistributionList {
            id: "D1".into(),
            change_key: "ck-d1".into(),
            name: "Equip".into(),
            members: vec![
                member("k1", "Ana Puig", "ana@example.org", Some("C1")),
                member("k2", "Joan Vila", "joan@example.net", None),
                member("k3", "Directori", "", None),
            ],
        }],
    }
}

/// The server's copy of the list, as XML, at `change_key`.
fn server_list(change_key: &str, name: &str) -> String {
    got(&[list_xml(
        "D1",
        change_key,
        name,
        &[
            member_xml("k1", "Ana Puig", "ana@example.org", "Contact", Some("C1")),
            member_xml("k2", "Joan Vila", "joan@example.net", "OneOff", None),
            member_xml("k3", "Directori", "/O=X/CN=DIR", "Mailbox", None),
        ],
    )])
}

fn store() -> Mutex<Connection> {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    ensure_source(&conn, A, A, 1).unwrap();
    store_book(&conn, &origin(A), &book(), 1).unwrap();
    Mutex::new(conn)
}

fn root() -> Target {
    Target::root(A)
}

fn stored(db: &Mutex<Connection>) -> contact_groups::StoredGroup {
    contact_groups::get(&db.lock().unwrap(), &contact_groups::group_id(&origin(A), "D1")).unwrap().unwrap()
}

/// A group's members as the Personas view and the composer get them.
fn shown_in(db: &Mutex<Connection>, origin: &BookOrigin, list: &str) -> Vec<(String, String)> {
    let id = contact_groups::group_id(origin, list);
    contact_groups::member_details(&db.lock().unwrap())
        .unwrap()
        .into_iter()
        .filter(|member| member.group_id == id)
        .map(|member| (member.name, member.addr))
        .collect()
}

fn shown(db: &Mutex<Connection>) -> Vec<(String, String)> {
    shown_in(db, &origin(A), "D1")
}

fn ana(db: &Mutex<Connection>) -> Option<store::SyncedPerson> {
    store::synced_person(&db.lock().unwrap(), &origin(A).person_id("C1")).unwrap()
}

// ---- Lists (ADR-0058) ----------------------------------------------------------

#[test]
fn ews_distribution_list_read_shows_contacts_and_typed_addresses() {
    let db = store();
    assert_eq!(
        shown(&db),
        [("Ana Puig".to_string(), "ana@example.org".to_string()), ("Joan Vila".to_string(), "joan@example.net".to_string())],
        "a member with no address cannot be written to, and is not shown; it stays in the list"
    );
    let group = stored(&db);
    assert_eq!(group.version, "ck-d1");
    assert_eq!(group.members.len(), 2, "{:?}", group.members);
    let ana = ana(&db).unwrap();
    assert_eq!((ana.origin.source.as_str(), ana.version.as_str()), ("exchange", "ck-C1"));
}

#[test]
fn ews_distribution_list_edit_success_sends_the_difference_and_records_the_server_copy() {
    let db = store();
    let after = got(&[list_xml(
        "D1",
        "ck-d2",
        "Equip nou",
        &[
            member_xml("k1", "Ana Puig", "ana@example.org", "Contact", Some("C1")),
            member_xml("k3", "Directori", "/O=X/CN=DIR", "Mailbox", None),
            member_xml("k4", "Pere Clavé", "pere@example.org", "Contact", Some("C2")),
        ],
    )]);
    let (url, server) = serve(vec![
        Step::Reply(server_list("ck-d1", "Equip")),
        Step::Reply(ok(
            "UpdateItem",
            r#"<m:Items><t:DistributionList><t:ItemId Id="D1" ChangeKey="ck-d2"/></t:DistributionList></m:Items>"#,
        )),
        Step::Reply(after),
    ]);
    let o = origin(A);
    // The editor shows Ana and Joan; it keeps Ana, drops Joan, adds Pere.
    let wanted = [o.person_id("C1"), o.person_id("C2")];
    let written = save_group(&client(url), &db, &root(), Some(&stored(&db)), "ck-d1", "Equip nou", &wanted, 2).expect("save");
    assert_eq!(written, GroupWrite::Saved { id: contact_groups::group_id(&o, "D1"), version: "ck-d2".into() });
    let requests = server.join().expect("server");
    let update = &requests[1];
    assert!(update.contains(r#"ChangeKey="ck-d1""#) && update.contains("NeverOverwrite"), "{update}");
    assert!(update.contains(r#"<t:ItemId Id="C2"/>"#), "Pere added by his contact: {update}");
    assert!(update.contains(r#"FieldIndex="k2""#), "Joan taken out by his key: {update}");
    assert!(!update.contains(r#"FieldIndex="k1""#) && !update.contains(r#"FieldIndex="k3""#), "nobody else touched: {update}");
    assert!(update.contains("<t:DisplayName>Equip nou</t:DisplayName>"), "{update}");
    assert_eq!(stored(&db).version, "ck-d2");
    assert_eq!(shown(&db).iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["Ana Puig", "Pere Clavé"]);
}

#[test]
fn ews_distribution_list_stale_local_edit_never_overwrites_a_server_change() {
    let db = store();
    // Changed in Outlook since this copy was read: the change key moved on.
    let (url, server) = serve(vec![Step::Reply(server_list("ck-other", "Equip (Outlook)"))]);
    let o = origin(A);
    let written =
        save_group(&client(url), &db, &root(), Some(&stored(&db)), "ck-d1", "Equip nou", &[o.person_id("C1")], 2).expect("save");
    let GroupWrite::Conflict { current: Some((name, members, version)) } = written else { panic!("{written:?}") };
    assert_eq!((name.as_str(), version.as_str()), ("Equip (Outlook)", "ck-other"));
    assert!(members.contains(&o.person_id("mailto:joan@example.net")), "{members:?}");
    assert_eq!(server.join().expect("server").len(), 1, "nothing was written");
    // The server's copy is kept here, so looking again and retrying starts
    // from it.
    let group = stored(&db);
    assert_eq!((group.name.as_str(), group.version.as_str()), ("Equip (Outlook)", "ck-other"));
    assert_eq!(shown(&db).len(), 2, "with its members, Joan included");
}

#[test]
fn ews_distribution_list_gone_from_the_server_is_a_conflict_that_drops_it_here() {
    let db = store();
    let (url, server) = serve(vec![Step::Reply(error_response(
        "GetItem",
        "ErrorItemNotFound",
        "The specified object was not found in the store.",
    ))]);
    let o = origin(A);
    let written = save_group(&client(url), &db, &root(), Some(&stored(&db)), "ck-d1", "Equip", &[], 2).expect("save");
    assert_eq!(written, GroupWrite::Conflict { current: None });
    server.join().expect("server");
    assert!(contact_groups::get(&db.lock().unwrap(), &contact_groups::group_id(&o, "D1")).unwrap().is_none());
}

#[test]
fn ews_distribution_list_is_never_written_without_the_version_it_was_read_at() {
    // No server: nothing may reach it.
    let written = client("http://127.0.0.1:1".into()).update_list("D1", "", Some("x"), &[], &[]).unwrap();
    assert_eq!(written, ListWrite::Conflict);
    assert_eq!(client("http://127.0.0.1:1".into()).delete_list("D1", "").unwrap(), ListWrite::Conflict);
}

#[test]
fn ews_distribution_list_conflict_found_by_the_server_saves_nothing() {
    let db = store();
    let (url, server) = serve(vec![
        Step::Reply(server_list("ck-d1", "Equip")),
        Step::Reply(error_response("UpdateItem", "ErrorIrresolvableConflict", "The change conflicts.")),
        Step::Reply(server_list("ck-d9", "Equip")),
    ]);
    let o = origin(A);
    let written =
        save_group(&client(url), &db, &root(), Some(&stored(&db)), "ck-d1", "Equip", &[o.person_id("C1")], 2).expect("save");
    assert!(matches!(written, GroupWrite::Conflict { current: Some((_, _, ref version)) } if version == "ck-d9"), "{written:?}");
    server.join().expect("server");
    assert_eq!(shown(&db).len(), 2, "Joan is still here: nothing was taken out");
}

#[test]
fn ews_distribution_list_error_and_lost_answer_change_nothing_here() {
    for last in [Step::Reply(error_response("UpdateItem", "ErrorAccessDenied", "Access is denied.")), Step::Drop] {
        let db = store();
        let (url, server) = serve(vec![Step::Reply(server_list("ck-d1", "Equip")), last]);
        let o = origin(A);
        save_group(&client(url), &db, &root(), Some(&stored(&db)), "ck-d1", "Equip nou", &[o.person_id("C1")], 2)
            .expect_err("failed");
        let requests = server.join().expect("server");
        assert_eq!(requests.iter().filter(|r| r.contains("UpdateItem")).count(), 1, "never sent twice");
        assert_eq!((stored(&db).name.as_str(), stored(&db).version.as_str()), ("Equip", "ck-d1"));
        assert_eq!(shown(&db).len(), 2);
    }
    // After a lost answer the next read of the book tells what happened.
    let db = store();
    let mut changed = book();
    changed.lists[0].change_key = "ck-d2".into();
    changed.lists[0].members.remove(1);
    store_book(&db.lock().unwrap(), &origin(A), &changed, 3).unwrap();
    assert_eq!(shown(&db).len(), 1);
}

#[test]
fn ews_distribution_list_create_and_delete() {
    let db = store();
    let o = origin(A);
    let (url, server) = serve(vec![
        Step::Reply(ok(
            "CreateItem",
            r#"<m:Items><t:DistributionList><t:ItemId Id="D2" ChangeKey="ck-n"/></t:DistributionList></m:Items>"#,
        )),
        Step::Reply(got(&[list_xml("D2", "ck-n", "Nova", &[member_xml("k1", "Joan Vila", "joan@example.net", "OneOff", None)])])),
    ]);
    // Joan is no contact: he is written as the address he is.
    let written =
        save_group(&client(url), &db, &root(), None, "", "Nova", &[o.person_id("mailto:joan@example.net")], 2).expect("create");
    assert_eq!(written, GroupWrite::Saved { id: contact_groups::group_id(&o, "D2"), version: "ck-n".into() });
    let create = &server.join().expect("server")[0];
    assert!(create.contains(r#"<t:DistinguishedFolderId Id="contacts"/>"#), "{create}");
    assert!(create.contains("<t:MailboxType>OneOff</t:MailboxType>") && create.contains("joan@example.net"), "{create}");

    // Deleting from a stale version is refused; from the current one it goes.
    let group = contact_groups::get(&db.lock().unwrap(), &contact_groups::group_id(&o, "D2")).unwrap().unwrap();
    let (url, server) = serve(vec![
        Step::Reply(got(&[list_xml("D2", "ck-moved", "Nova", &[])])),
        Step::Reply(got(&[list_xml("D2", "ck-moved", "Nova", &[])])),
    ]);
    assert!(matches!(delete_group(&client(url), &db, &root(), &group, "ck-n", 9).unwrap(), GroupWrite::Conflict { .. }));
    assert!(!server.join().expect("server").iter().any(|r| r.contains("DeleteItem")));
    let (url, server) = serve(vec![Step::Reply(got(&[list_xml("D2", "ck-n", "Nova", &[])])), Step::Reply(ok("DeleteItem", ""))]);
    assert_eq!(delete_group(&client(url), &db, &root(), &group, "ck-n", 9).unwrap(), GroupWrite::Deleted);
    assert!(server.join().expect("server")[1].contains(r#"DeleteType="MoveToDeletedItems""#));
    assert!(contact_groups::get(&db.lock().unwrap(), &group.id).unwrap().is_none());
}

#[test]
fn ews_distribution_lists_of_two_accounts_stay_apart() {
    let db = store();
    store_book(&db.lock().unwrap(), &origin(B), &book(), 1).unwrap();
    // Reading A again with no lists leaves B's alone.
    store_book(&db.lock().unwrap(), &origin(A), &Book { contacts: book().contacts, lists: Vec::new() }, 2).unwrap();
    let groups = contact_groups::list(&db.lock().unwrap()).unwrap();
    assert_eq!(groups.iter().map(|g| g.origin.account.as_str()).collect::<Vec<_>>(), [B]);
    // A person of another book cannot go into a list on this server; nothing is sent.
    let o = origin(B);
    let group = contact_groups::get(&db.lock().unwrap(), &contact_groups::group_id(&o, "D1")).unwrap().unwrap();
    let (url, server) = serve(vec![Step::Reply(server_list("ck-d1", "Equip"))]);
    let error = save_group(&client(url), &db, &Target::root(B), Some(&group), "ck-d1", "Equip", &[origin(A).person_id("C1")], 3)
        .expect_err("another book");
    assert!(error.to_string().contains("same address book"), "{error}");
    assert!(!server.join().expect("server").iter().any(|r| r.contains("UpdateItem")));
}

// ---- People (ADR-0066) ---------------------------------------------------------

/// Ana as the editor sends her: the server's copy with one change.
fn ana_edited(change: impl FnOnce(&mut Person)) -> Person {
    let mut person = read_full("C1", "ck-C1").person;
    change(&mut person);
    person
}

#[test]
fn ews_contact_edit_success_sends_the_difference_and_records_the_server_copy() {
    let db = store();
    let (url, server) = serve(vec![
        Step::Reply(got(&[full_contact_xml("C1", "ck-C1")])),
        Step::Reply(ok("UpdateItem", r#"<m:Items><t:Contact><t:ItemId Id="C1" ChangeKey="ck-2"/></t:Contact></m:Items>"#)),
        Step::Reply(got(&[full_contact_xml("C1", "ck-2")])),
    ]);
    let edited = ana_edited(|person| person.organisation = "Nova".into());
    let written = save_person(&client(url), &db, &root(), ana(&db).as_ref(), "ck-C1", &edited, None, 2).expect("save");
    assert_eq!(written, PersonWrite::Saved { id: origin(A).person_id("C1"), version: "ck-2".into() });
    let requests = server.join().expect("server");
    let update = &requests[1];
    assert!(update.contains(r#"<t:ItemId Id="C1" ChangeKey="ck-C1"/>"#) && update.contains("NeverOverwrite"), "{update}");
    assert!(update.contains("<t:CompanyName>Nova</t:CompanyName>"), "{update}");
    assert!(!update.contains("DisplayName") && !update.contains("EmailAddress"), "only what changed: {update}");
    // Kept here as the server holds it now, its notes included.
    let ana = ana(&db).unwrap();
    assert_eq!((ana.version.as_str(), ana.person.note.as_str()), ("ck-2", "Vista a la fira"));
}

#[test]
fn ews_contact_stale_local_edit_never_overwrites_a_server_change() {
    let db = store();
    let (url, server) = serve(vec![Step::Reply(got(&[full_contact_xml("C1", "ck-outlook")]))]);
    let edited = ana_edited(|person| person.organisation = "Nova".into());
    let written = save_person(&client(url), &db, &root(), ana(&db).as_ref(), "ck-C1", &edited, None, 2).expect("save");
    let PersonWrite::Conflict { current: Some((current, version)) } = &written else { panic!("{written:?}") };
    assert_eq!((current.organisation.as_str(), version.as_str()), ("Consorci", "ck-outlook"));
    assert_eq!(server.join().expect("server").len(), 1, "nothing was written");
    assert_eq!(ana(&db).unwrap().version, "ck-outlook", "the server copy is kept here to retry from");
    let json = written.to_json(&origin(A).person_id("C1"));
    assert_eq!((json["conflict"].as_bool(), json["current"]["version"].as_str()), (Some(true), Some("ck-outlook")));
}

#[test]
fn ews_contact_gone_from_the_server_is_a_conflict_that_drops_it_here() {
    let db = store();
    let (url, server) = serve(vec![Step::Reply(error_response("GetItem", "ErrorItemNotFound", "Not found."))]);
    let written = save_person(&client(url), &db, &root(), ana(&db).as_ref(), "ck-C1", &ana_edited(|_| {}), None, 2).expect("save");
    assert_eq!(written, PersonWrite::Conflict { current: None });
    server.join().expect("server");
    assert!(ana(&db).is_none());
}

#[test]
fn ews_contact_conflict_found_by_the_server_saves_nothing() {
    let db = store();
    let (url, server) = serve(vec![
        Step::Reply(got(&[full_contact_xml("C1", "ck-C1")])),
        Step::Reply(error_response("UpdateItem", "ErrorIrresolvableConflict", "The change conflicts.")),
        Step::Reply(got(&[full_contact_xml("C1", "ck-9")])),
    ]);
    let edited = ana_edited(|person| person.organisation = "Nova".into());
    let written = save_person(&client(url), &db, &root(), ana(&db).as_ref(), "ck-C1", &edited, None, 2).expect("save");
    assert!(matches!(written, PersonWrite::Conflict { current: Some((_, ref version)) } if version == "ck-9"), "{written:?}");
    server.join().expect("server");
}

#[test]
fn ews_contact_error_lost_answer_and_unwritable_change_change_nothing_here() {
    for last in [Step::Reply(error_response("UpdateItem", "ErrorAccessDenied", "Access is denied.")), Step::Drop] {
        let db = store();
        let (url, server) = serve(vec![Step::Reply(got(&[full_contact_xml("C1", "ck-C1")])), last]);
        let edited = ana_edited(|person| person.organisation = "Nova".into());
        save_person(&client(url), &db, &root(), ana(&db).as_ref(), "ck-C1", &edited, None, 2).expect_err("failed");
        let requests = server.join().expect("server");
        assert_eq!(requests.iter().filter(|r| r.contains("UpdateItem")).count(), 1, "never sent twice");
        assert_eq!(ana(&db).unwrap().version, "ck-C1");
    }
    // More addresses than Exchange keeps: refused before any write.
    let db = store();
    let (url, server) = serve(vec![Step::Reply(got(&[full_contact_xml("C1", "ck-C1")]))]);
    let edited = ana_edited(|person| {
        for addr in ["b@x.org", "c@x.org"] {
            person.emails.push(EmailAddress { addr: addr.into(), label: String::new() });
        }
    });
    let error = save_person(&client(url), &db, &root(), ana(&db).as_ref(), "ck-C1", &edited, None, 2).expect_err("unwritable");
    assert!(error.to_string().contains("at most three email addresses"), "{error}");
    assert!(!server.join().expect("server").iter().any(|r| r.contains("UpdateItem")));
}

fn feina() -> Target {
    Target {
        origin: BookOrigin { source: "exchange".into(), account: A.into(), book: folder_source_id(A, "F1") },
        folder: "F1".into(),
    }
}

fn pau() -> Person {
    Person {
        name: "  Pau Roca ".into(),
        // The empty row an editor leaves is no address.
        emails: vec![
            EmailAddress { addr: "pau@example.org".into(), label: String::new() },
            EmailAddress { addr: " ".into(), label: String::new() },
        ],
        ..Default::default()
    }
}

#[test]
fn ews_contact_create_in_a_folder_is_kept_in_that_folders_book() {
    let db = store();
    let (url, server) = serve(vec![
        Step::Reply(ok("CreateItem", r#"<m:Items><t:Contact><t:ItemId Id="C9" ChangeKey="ck-9"/></t:Contact></m:Items>"#)),
        Step::Reply(got(&[full_contact_xml("C9", "ck-9")])),
    ]);
    let written = save_person(&client(url), &db, &feina(), None, "", &pau(), None, 2).expect("create");
    assert_eq!(written, PersonWrite::Saved { id: feina().origin.person_id("C9"), version: "ck-9".into() });
    let requests = server.join().expect("server");
    assert!(requests[0].contains(r#"<t:FolderId Id="F1"/>"#), "{}", requests[0]);
    assert!(requests[0].contains("<t:DisplayName>Pau Roca</t:DisplayName>") && !requests[0].contains("EmailAddress2"), "{}", requests[0]);
    let kept = store::synced_person(&db.lock().unwrap(), &feina().origin.person_id("C9")).unwrap().unwrap();
    assert_eq!(kept.origin.book, folder_source_id(A, "F1"));
}

#[test]
fn ews_contact_create_whose_answer_is_lost_is_found_again_not_made_twice() {
    let db = store();
    let (url, server) = serve(vec![
        Step::Drop,
        Step::Reply(found(&[("Contact", "C9")], true)),
        Step::Reply(got(&[marked_contact_xml("C9", "ck-9", "m-9")])),
        Step::Reply(got(&[marked_contact_xml("C9", "ck-9", "m-9")])),
    ]);
    let written = create_person(&client(url), &db, &feina(), &pau(), "m-9", false, 2).expect("adopted");
    assert_eq!(written, PersonWrite::Saved { id: feina().origin.person_id("C9"), version: "ck-9".into() });
    let requests = server.join().expect("server");
    assert_eq!(requests.iter().filter(|r| r.contains("CreateItem")).count(), 1, "created once");
    assert!(requests[1].contains(r#"<t:Constant Value="m-9"/>"#), "{}", requests[1]);

    // Not there: it was not created, and nothing is kept.
    let (url, server) = serve(vec![Step::Drop, Step::Reply(found(&[], true))]);
    let error = create_person(&client(url), &db, &feina(), &pau(), "m-10", false, 3).expect_err("not created");
    assert!(format!("{error:#}").contains("the contact is not there"), "{error:#}");
    server.join().expect("server");
    // The search failed too: it may be there, and the reader is told to look.
    let (url, server) = serve(vec![Step::Drop, Step::Reply(error_response("FindItem", "ErrorServerBusy", "Busy."))]);
    let error = create_person(&client(url), &db, &feina(), &pau(), "m-11", false, 3).expect_err("unknown");
    assert!(format!("{error:#}").contains("may have been created"), "{error:#}");
    server.join().expect("server");
    let in_feina: Vec<String> = store::find_people(&db.lock().unwrap(), "", 500)
        .unwrap()
        .into_iter()
        .filter(|stored| stored.origin.book == folder_source_id(A, "F1"))
        .map(|stored| stored.id)
        .collect();
    assert_eq!(in_feina, [feina().origin.person_id("C9")], "only the contact adopted above");
}

#[test]
fn ews_contact_delete_from_the_version_read() {
    let db = store();
    let stale = serve(vec![Step::Reply(got(&[full_contact_xml("C1", "ck-moved")])), Step::Reply(got(&[full_contact_xml("C1", "ck-moved")]))]);
    let written = delete_person(&client(stale.0), &db, &root(), &ana(&db).unwrap(), "ck-C1", 2).unwrap();
    assert!(matches!(written, PersonWrite::Conflict { current: Some(_) }), "{written:?}");
    assert!(!stale.1.join().expect("server").iter().any(|r| r.contains("DeleteItem")));
    assert_eq!(ana(&db).unwrap().version, "ck-moved");

    let (url, server) = serve(vec![Step::Reply(got(&[full_contact_xml("C1", "ck-moved")])), Step::Reply(ok("DeleteItem", ""))]);
    assert_eq!(delete_person(&client(url), &db, &root(), &ana(&db).unwrap(), "ck-moved", 3).unwrap(), PersonWrite::Deleted);
    assert!(server.join().expect("server")[1].contains(r#"DeleteType="MoveToDeletedItems""#));
    assert!(ana(&db).is_none());
}

// ---- Contact folders as books (ADR-0066) ---------------------------------------

fn root_source(db: &Mutex<Connection>) -> store::ContactSource {
    store::contact_source(&db.lock().unwrap(), &source_id(A)).unwrap().unwrap()
}

fn folder_book(db: &Mutex<Connection>, folder: &str) -> Option<store::ContactSource> {
    store::contact_source(&db.lock().unwrap(), &folder_source_id(A, folder)).unwrap()
}

/// Keeps what a read brought for `source`. The source is looked up before
/// the store is locked: the lock is not re-entrant.
fn keep(db: &Mutex<Connection>, source: store::ContactSource, read: Read, now: i64) -> Result<()> {
    record(&db.lock().unwrap(), &source, read, now)
}

fn folder(id: &str, path: &str) -> ContactFolder {
    ContactFolder { id: id.into(), path: path.into() }
}

/// What the folder «Feina» holds: Pau, and a list with Pau and Ana, who is a
/// contact of the Contacts folder, not of this one.
fn feina_book() -> Book {
    Book {
        contacts: vec![person("C5", "Pau Roca", "pau@example.org")],
        lists: vec![DistributionList {
            id: "D5".into(),
            change_key: "ck-d5".into(),
            name: "Projecte".into(),
            members: vec![
                member("k1", "Pau Roca", "pau@example.org", Some("C5")),
                member("k2", "Ana Puig", "ana@example.org", Some("C1")),
            ],
        }],
    }
}

#[test]
fn ews_contact_folders_become_books_that_follow_their_folders() {
    let db = store();
    let read = Read {
        book: Ok(book()),
        folders: Some(Ok(vec![
            (folder("F1", "Feina"), Ok(feina_book())),
            (folder("F2", "Feina/Clients"), Err(anyhow::anyhow!("refused"))),
        ])),
    };
    let error = keep(&db, root_source(&db), read, 2).expect_err("one folder failed");
    assert!(format!("{error:#}").contains("Feina/Clients"), "{error:#}");
    assert!(root_source(&db).last_error.contains("Feina/Clients"), "the account's book says it was incomplete");
    let feina = folder_book(&db, "F1").unwrap();
    assert_eq!((feina.name.as_str(), feina.url.as_str(), feina.last_error.as_str()), ("work@example.org / Feina", "F1", ""));
    assert!(is_folder_book(&feina) && !is_folder_book(&root_source(&db)));
    assert_eq!(folder_book(&db, "F2").unwrap().last_error, "refused", "the folder that failed says why");
    let fb = Target::of(&feina).unwrap();
    assert!(store::synced_person(&db.lock().unwrap(), &fb.origin.person_id("C5")).unwrap().is_some());
    // Ana is a contact of another folder: the list shows her by her address.
    assert_eq!(
        shown_in(&db, &fb.origin, "D5"),
        [("Pau Roca".to_string(), "pau@example.org".to_string()), ("Ana Puig".to_string(), "ana@example.org".to_string())]
    );

    // Renamed on the server: same book, new name. Gone: its book and people go.
    let read = Read { book: Ok(book()), folders: Some(Ok(vec![(folder("F1", "Feina 2026"), Ok(feina_book()))])) };
    keep(&db, root_source(&db), read, 3).expect("complete");
    assert_eq!(folder_book(&db, "F1").unwrap().name, "work@example.org / Feina 2026");
    assert!(folder_book(&db, "F2").is_none());
    assert_eq!(root_source(&db).last_error, "");

    // A listing that fails removes nothing.
    let read = Read { book: Ok(book()), folders: Some(Err(anyhow::anyhow!("busy"))) };
    let error = keep(&db, root_source(&db), read, 4).expect_err("listing failed");
    assert!(format!("{error:#}").contains("could not be listed"), "{error:#}");
    assert!(folder_book(&db, "F1").is_some());
    assert!(store::synced_person(&db.lock().unwrap(), &fb.origin.person_id("C5")).unwrap().is_some());

    // A folder book read alone keeps its own people only; a failed read keeps
    // what it had and says why.
    let alone = Read { book: Ok(Book { contacts: Vec::new(), lists: Vec::new() }), folders: None };
    keep(&db, folder_book(&db, "F1").unwrap(), alone, 5).expect("read");
    assert!(store::synced_person(&db.lock().unwrap(), &fb.origin.person_id("C5")).unwrap().is_none());
    assert!(ana(&db).is_some(), "the Contacts folder's people stay");
    let failed = Read { book: Err(anyhow::anyhow!("offline")), folders: None };
    assert!(keep(&db, root_source(&db), failed, 6).is_err());
    assert_eq!(root_source(&db).last_error, "offline");
    assert!(ana(&db).is_some() && folder_book(&db, "F1").is_some());
}

#[test]
fn ews_contact_folder_books_go_with_the_accounts_book() {
    let db = store();
    let read = Read { book: Ok(book()), folders: Some(Ok(vec![(folder("F1", "Feina"), Ok(feina_book()))])) };
    keep(&db, root_source(&db), read, 2).unwrap();
    let error = { let feina = folder_book(&db, "F1").unwrap(); remove_source(&db.lock().unwrap(), &feina) }.expect_err("alone");
    assert!(error.to_string().contains("comes with the account"), "{error}");
    let removed = { let account = root_source(&db); remove_source(&db.lock().unwrap(), &account) }.unwrap();
    assert_eq!(removed, [folder_source_id(A, "F1"), source_id(A)]);
    assert!(store::contact_sources(&db.lock().unwrap()).unwrap().is_empty());
    assert!(ana(&db).is_none());
}

#[test]
fn ews_book_targets_name_their_folder() {
    let db = store();
    let read = Read { book: Ok(book()), folders: Some(Ok(vec![(folder("F1", "Feina"), Ok(feina_book()))])) };
    keep(&db, root_source(&db), read, 2).unwrap();
    assert_eq!(target(&db.lock().unwrap(), &source_id(A)).unwrap(), root());
    assert_eq!(target(&db.lock().unwrap(), &folder_source_id(A, "F1")).unwrap(), feina());
    assert!(target(&db.lock().unwrap(), "nowhere").is_err());
    let mut carddav = root_source(&db);
    carddav.kind = "carddav".into();
    assert!(Target::of(&carddav).is_err());
}

#[test]
fn ews_distribution_list_created_in_a_folder_goes_there() {
    let db = store();
    let (url, server) = serve(vec![
        Step::Reply(ok("CreateItem", r#"<m:Items><t:DistributionList><t:ItemId Id="D7" ChangeKey="ck-7"/></t:DistributionList></m:Items>"#)),
        Step::Reply(got(&[list_xml("D7", "ck-7", "Nova", &[])])),
    ]);
    let written = save_group(&client(url), &db, &feina(), None, "", "Nova", &[], 2).expect("create");
    assert_eq!(written, GroupWrite::Saved { id: contact_groups::group_id(&feina().origin, "D7"), version: "ck-7".into() });
    assert!(server.join().expect("server")[0].contains(r#"<m:SavedItemFolderId><t:FolderId Id="F1"/></m:SavedItemFolderId>"#));
}

#[test]
fn ews_contact_saved_again_with_the_editors_id_adopts_the_first_copy() {
    // The editor's id names a contact already there (an earlier try whose
    // answer was lost): it is adopted and nothing is created.
    let db = store();
    let (url, server) = serve(vec![
        Step::Reply(found(&[("Contact", "C9")], true)),
        Step::Reply(got(&[marked_contact_xml("C9", "ck-9", "editor-1")])),
        Step::Reply(got(&[marked_contact_xml("C9", "ck-9", "editor-1")])),
    ]);
    let written = save_person(&client(url), &db, &feina(), None, "", &pau(), Some("editor-1"), 2).expect("adopted");
    assert_eq!(written, PersonWrite::Saved { id: feina().origin.person_id("C9"), version: "ck-9".into() });
    let requests = server.join().expect("server");
    assert!(!requests.iter().any(|r| r.contains("CreateItem")), "nothing created twice");
    // Not there yet: it is created with that id.
    let (url, server) = serve(vec![
        Step::Reply(found(&[], true)),
        Step::Reply(ok("CreateItem", r#"<m:Items><t:Contact><t:ItemId Id="C10" ChangeKey="ck-10"/></t:Contact></m:Items>"#)),
        Step::Reply(got(&[marked_contact_xml("C10", "ck-10", "editor-2")])),
    ]);
    save_person(&client(url), &db, &feina(), None, "", &pau(), Some("editor-2"), 3).expect("created");
    assert!(server.join().expect("server")[1].contains("<t:Value>editor-2</t:Value>"));
    // The search failing first sends nothing.
    let (url, server) = serve(vec![Step::Reply(error_response("FindItem", "ErrorServerBusy", "Busy."))]);
    save_person(&client(url), &db, &feina(), None, "", &pau(), Some("editor-3"), 4).expect_err("not searched");
    assert!(!server.join().expect("server").iter().any(|r| r.contains("CreateItem")));
}

#[test]
fn ews_contact_written_but_not_read_back_says_it_was_saved() {
    let db = store();
    let (url, server) = serve(vec![
        Step::Reply(ok("CreateItem", r#"<m:Items><t:Contact><t:ItemId Id="C9" ChangeKey="ck-9"/></t:Contact></m:Items>"#)),
        Step::Reply(error_response("GetItem", "ErrorServerBusy", "Busy.")),
    ]);
    let error = create_person(&client(url), &db, &feina(), &pau(), "m-9", false, 2).expect_err("not read back");
    assert!(format!("{error:#}").contains("saved on Exchange but could not be read back"), "{error:#}");
    server.join().expect("server");
    let (url, server) = serve(vec![
        Step::Reply(got(&[full_contact_xml("C1", "ck-C1")])),
        Step::Reply(ok("UpdateItem", r#"<m:Items><t:Contact><t:ItemId Id="C1" ChangeKey="ck-2"/></t:Contact></m:Items>"#)),
        Step::Reply(error_response("GetItem", "ErrorItemNotFound", "Gone.")),
    ]);
    let edited = ana_edited(|person| person.organisation = "Nova".into());
    let error = save_person(&client(url), &db, &root(), ana(&db).as_ref(), "ck-C1", &edited, None, 3).expect_err("not read back");
    assert!(format!("{error:#}").contains("saved on Exchange but could not be read back"), "{error:#}");
    server.join().expect("server");
}

#[test]
fn ews_contact_edit_without_the_version_read_is_a_conflict() {
    let db = store();
    let (url, server) = serve(vec![Step::Reply(got(&[full_contact_xml("C1", "ck-C1")]))]);
    let written = save_person(&client(url), &db, &root(), ana(&db).as_ref(), "", &ana_edited(|_| {}), None, 2).expect("save");
    assert!(matches!(written, PersonWrite::Conflict { current: Some(_) }), "{written:?}");
    assert!(!server.join().expect("server").iter().any(|r| r.contains("UpdateItem")));
}

#[test]
fn ews_contact_already_gone_counts_as_deleted() {
    let db = store();
    let (url, server) = serve(vec![Step::Reply(error_response("GetItem", "ErrorItemNotFound", "Gone."))]);
    assert_eq!(delete_person(&client(url), &db, &root(), &ana(&db).unwrap(), "ck-C1", 2).unwrap(), PersonWrite::Deleted);
    assert!(!server.join().expect("server").iter().any(|r| r.contains("DeleteItem")));
    assert!(ana(&db).is_none());
}

#[test]
fn removing_a_book_that_is_no_exchange_one_removes_it_alone() {
    let db = store();
    let carddav = store::ContactSource {
        id: "cd-1".into(),
        kind: "carddav".into(),
        account: String::new(),
        url: "https://dav.example/".into(),
        username: "u".into(),
        name: "Equip".into(),
        enabled: true,
        ctag: String::new(),
        last_sync_at: 0,
        last_error: String::new(),
        writable: None,
    };
    store::upsert_contact_source(&db.lock().unwrap(), &carddav, 1).unwrap();
    let conn = db.lock().unwrap();
    assert_eq!(crate::pim::people::remove_source(&conn, "cd-1").unwrap(), ["cd-1"]);
    assert_eq!(crate::pim::people::remove_source(&conn, "missing").unwrap(), ["missing"]);
    assert_eq!(crate::pim::people::remove_source(&conn, &source_id(A)).unwrap(), [source_id(A)]);
    assert!(store::contact_sources(&conn).unwrap().is_empty());
}
