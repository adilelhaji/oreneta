//! Exchange distribution lists as contact groups (ADR-0058), on recorded SOAP.

use std::sync::Mutex;

use super::*;
use crate::exchange::book::tests::{got, list_xml, member_xml};
use crate::exchange::book::{Book, Contact, Member};
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
    store_book(&conn, &origin(A), &book(), 1).unwrap();
    Mutex::new(conn)
}

fn stored(db: &Mutex<Connection>) -> contact_groups::StoredGroup {
    contact_groups::get(&db.lock().unwrap(), &contact_groups::group_id(&origin(A), "D1")).unwrap().unwrap()
}

/// The list's members as the Personas view and the composer get them.
fn shown(db: &Mutex<Connection>) -> Vec<(String, String)> {
    let id = contact_groups::group_id(&origin(A), "D1");
    contact_groups::member_details(&db.lock().unwrap())
        .unwrap()
        .into_iter()
        .filter(|member| member.group_id == id)
        .map(|member| (member.name, member.addr))
        .collect()
}

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
    let conn = db.lock().unwrap();
    let ana = crate::store::synced_person(&conn, &origin(A).person_id("C1")).unwrap().unwrap();
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
    let written = save_group(&client(url), &db, &o, Some(&stored(&db)), "ck-d1", "Equip nou", &wanted, 2).expect("save");
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
        save_group(&client(url), &db, &o, Some(&stored(&db)), "ck-d1", "Equip nou", &[o.person_id("C1")], 2).expect("save");
    let GroupWrite::Conflict { current: Some((name, members, version)) } = written else { panic!("{written:?}") };
    assert_eq!((name.as_str(), version.as_str()), ("Equip (Outlook)", "ck-other"));
    assert!(members.contains(&o.person_id("mailto:joan@example.net")), "{members:?}");
    assert_eq!(server.join().expect("server").len(), 1, "nothing was written");
    assert_eq!(stored(&db).version, "ck-d1", "the local copy is as it was");
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
    let written = save_group(&client(url), &db, &o, Some(&stored(&db)), "ck-d1", "Equip", &[o.person_id("C1")], 2).expect("save");
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
        save_group(&client(url), &db, &o, Some(&stored(&db)), "ck-d1", "Equip nou", &[o.person_id("C1")], 2)
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
        save_group(&client(url), &db, &o, None, "", "Nova", &[o.person_id("mailto:joan@example.net")], 2).expect("create");
    assert_eq!(written, GroupWrite::Saved { id: contact_groups::group_id(&o, "D2"), version: "ck-n".into() });
    let create = &server.join().expect("server")[0];
    assert!(create.contains(r#"<t:DistinguishedFolderId Id="contacts"/>"#), "{create}");
    assert!(create.contains("<t:MailboxType>OneOff</t:MailboxType>") && create.contains("joan@example.net"), "{create}");

    // Deleting from a stale version is refused; from the current one it goes.
    let group = contact_groups::get(&db.lock().unwrap(), &contact_groups::group_id(&o, "D2")).unwrap().unwrap();
    let (url, server) = serve(vec![Step::Reply(got(&[list_xml("D2", "ck-moved", "Nova", &[])])), Step::Reply(got(&[list_xml("D2", "ck-moved", "Nova", &[])]))]);
    assert!(matches!(delete_group(&client(url), &db, &o, &group, "ck-n").unwrap(), GroupWrite::Conflict { .. }));
    assert!(!server.join().expect("server").iter().any(|r| r.contains("DeleteItem")));
    let (url, server) = serve(vec![
        Step::Reply(got(&[list_xml("D2", "ck-n", "Nova", &[])])),
        Step::Reply(ok("DeleteItem", "")),
    ]);
    assert_eq!(delete_group(&client(url), &db, &o, &group, "ck-n").unwrap(), GroupWrite::Deleted);
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
    let error = save_group(&client(url), &db, &o, Some(&group), "ck-d1", "Equip", &[origin(A).person_id("C1")], 3)
        .expect_err("another book");
    assert!(error.to_string().contains("same address book"), "{error}");
    assert!(!server.join().expect("server").iter().any(|r| r.contains("UpdateItem")));
}
