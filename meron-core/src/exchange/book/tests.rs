//! The Contacts folder on recorded SOAP (ADR-0058).

use super::*;
use crate::exchange::tests::scripted::{client, error_response, ok, serve, Step};

pub(crate) fn contact_xml(id: &str, change_key: &str, name: &str, email: &str) -> String {
    format!(
        r#"<t:Contact><t:ItemId Id="{id}" ChangeKey="{change_key}"/><t:Subject>{name}</t:Subject><t:DisplayName>{name}</t:DisplayName><t:GivenName>{given}</t:GivenName><t:CompanyName>Consorci</t:CompanyName><t:EmailAddresses><t:Entry Key="EmailAddress1">SMTP:{email}</t:Entry><t:Entry Key="EmailAddress2">/O=CONSORCI/OU=GRUPO/CN=RECIPIENTS/CN=X</t:Entry></t:EmailAddresses><t:PhoneNumbers><t:Entry Key="MobilePhone">+34 600 000 000</t:Entry><t:Entry Key="HomePhone"/></t:PhoneNumbers></t:Contact>"#,
        given = name.split(' ').next().unwrap_or_default()
    )
}

/// A member as Exchange lists it: `kind` is the mailbox type.
pub(crate) fn member_xml(key: &str, name: &str, addr: &str, kind: &str, item: Option<&str>) -> String {
    let item = item.map(|id| format!(r#"<t:ItemId Id="{id}"/>"#)).unwrap_or_default();
    format!(
        r#"<t:Member Key="{key}"><t:Mailbox><t:Name>{name}</t:Name><t:EmailAddress>{addr}</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType><t:MailboxType>{kind}</t:MailboxType>{item}</t:Mailbox><t:Status>Normal</t:Status></t:Member>"#
    )
}

pub(crate) fn list_xml(id: &str, change_key: &str, name: &str, members: &[String]) -> String {
    format!(
        r#"<t:DistributionList><t:ItemId Id="{id}" ChangeKey="{change_key}"/><t:DisplayName>{name}</t:DisplayName><t:Members>{}</t:Members></t:DistributionList>"#,
        members.concat()
    )
}

/// A `GetItem` answer: one message per item, as Exchange gives them.
pub(crate) fn got(items: &[String]) -> String {
    let messages: String = items
        .iter()
        .map(|item| {
            format!(
                r#"<m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items>{item}</m:Items></m:GetItemResponseMessage>"#
            )
        })
        .collect();
    crate::exchange::tests::scripted::envelope(&format!(
        "<m:GetItemResponse><m:ResponseMessages>{messages}</m:ResponseMessages></m:GetItemResponse>"
    ))
}

/// A `FindItem` page of the Contacts folder.
pub(crate) fn found(items: &[(&str, &str)], last: bool) -> String {
    let items: String = items.iter().map(|(kind, id)| format!(r#"<t:{kind}><t:ItemId Id="{id}" ChangeKey="x"/></t:{kind}>"#)).collect();
    ok(
        "FindItem",
        &format!(
            r#"<m:RootFolder IndexedPagingOffset="0" TotalItemsInView="9" IncludesLastItemInRange="{last}"><t:Items>{items}</t:Items></m:RootFolder>"#
        ),
    )
}

#[test]
fn ews_distribution_list_read_takes_contacts_and_members_of_every_kind() {
    let (url, server) = serve(vec![
        Step::Reply(found(&[("Contact", "C1"), ("Contact", "C2"), ("Message", "M1")], false)),
        Step::Reply(found(&[("DistributionList", "D1")], true)),
        Step::Reply(got(&[
            contact_xml("C1", "ck-c1", "Ana Puig", "ana@example.org"),
            contact_xml("C2", "ck-c2", "Pere Clavé", "pere@example.org"),
            list_xml(
                "D1",
                "ck-d1",
                "Equip &amp; amics",
                &[
                    member_xml("k1", "Ana Puig", "ana@example.org", "Contact", Some("C1")),
                    member_xml("k2", "Joan Vila", "joan@example.net", "OneOff", None),
                    member_xml("k3", "Directori", "/O=CONSORCI/OU=GRUPO/CN=RECIPIENTS/CN=DIR", "Mailbox", None),
                ],
            ),
        ])),
    ]);
    let book = client(url).read_book("").expect("read");
    assert_eq!(book.contacts.len(), 2);
    let ana = &book.contacts[0].person;
    assert_eq!((ana.uid.as_str(), ana.name.as_str(), ana.given.as_str()), ("C1", "Ana Puig", "Ana"));
    assert_eq!(ana.emails.iter().map(|e| e.addr.as_str()).collect::<Vec<_>>(), ["ana@example.org"], "a directory identifier is no address");
    assert_eq!(ana.phones.len(), 1, "an empty number is none");
    assert_eq!(ana.phones[0].label, "cell");
    assert_eq!(book.contacts[0].change_key, "ck-c1");
    let list = &book.lists[0];
    assert_eq!((list.name.as_str(), list.change_key.as_str()), ("Equip & amics", "ck-d1"));
    let uids: Vec<Option<String>> = list.members.iter().map(Member::uid).collect();
    assert_eq!(uids, [Some("C1".to_string()), Some("mailto:joan@example.net".to_string()), None]);
    let requests = server.join().expect("server");
    assert!(requests[1].contains(r#"Offset="3""#), "the second page starts after the first: {}", requests[1]);
    assert!(requests[2].contains(r#"<t:ItemId Id="D1"/>"#) && !requests[2].contains("M1"), "only contacts and lists are read: {}", requests[2]);
}

#[test]
fn a_book_read_that_fails_on_one_item_fails_whole() {
    let (url, server) = serve(vec![
        Step::Reply(found(&[("Contact", "C1")], true)),
        Step::Reply(error_response("GetItem", "ErrorAccessDenied", "Access is denied.")),
    ]);
    let error = client(url).read_book("").expect_err("refused");
    assert_eq!(soap::error_code(&error), Some("ErrorAccessDenied"));
    server.join().expect("server");
}

#[test]
fn an_update_sends_only_the_change_against_the_version_read() {
    let (url, server) = serve(vec![Step::Reply(ok(
        "UpdateItem",
        r#"<m:Items><t:DistributionList><t:ItemId Id="D1" ChangeKey="ck-new"/></t:DistributionList></m:Items>"#,
    ))]);
    let written = client(url)
        .update_list(
            "D1",
            "ck-d1",
            Some("Equip <nou>"),
            &[NewMember { item_id: Some("C2".into()), name: "Pere".into(), addr: "pere@example.org".into() }],
            &["k2".to_string()],
        )
        .expect("update");
    assert_eq!(written, ListWrite::Saved { id: "D1".into(), change_key: "ck-new".into() });
    let request = &server.join().expect("server")[0];
    assert!(request.contains(r#"ConflictResolution="NeverOverwrite""#), "{request}");
    assert!(request.contains(r#"<t:ItemId Id="D1" ChangeKey="ck-d1"/>"#), "{request}");
    assert!(request.contains("<t:DisplayName>Equip &lt;nou&gt;</t:DisplayName>"), "{request}");
    assert!(request.contains(r#"<t:MailboxType>Contact</t:MailboxType><t:ItemId Id="C2"/>"#), "{request}");
    assert!(request.contains(r#"FieldURI="distributionlist:Members:Member" FieldIndex="k2""#), "{request}");
}

#[test]
fn an_update_the_server_refuses_as_changed_is_a_conflict() {
    for code in ["ErrorIrresolvableConflict", "ErrorItemNotFound"] {
        let (url, server) = serve(vec![Step::Reply(error_response("UpdateItem", code, "changed"))]);
        let written = client(url).update_list("D1", "ck-d1", Some("x"), &[], &[]).expect(code);
        assert_eq!(written, ListWrite::Conflict, "{code}");
        server.join().expect("server");
    }
}

#[test]
fn soap_text_is_escaped_and_answers_read_by_local_name() {
    assert_eq!(soap::escape("a&b<c>\"d'\u{1}"), "a&amp;b&lt;c&gt;&quot;d&apos;");
    let node = soap::parse(br#"<x:A xmlns:x="u"><B k="v">t &amp; u</B><y:B/></x:A>"#).unwrap();
    let a = node.child("A").unwrap();
    assert_eq!(a.children_named("B").count(), 2);
    assert_eq!(a.child("B").unwrap().attr("k"), Some("v"));
    assert_eq!(a.text_of("B"), Some("t & u"));
    assert!(soap::parse(b"<a><b></a>").is_err());
}

#[test]
fn a_soap_fault_fails_the_whole_answer() {
    let fault = crate::exchange::tests::scripted::envelope(
        r#"<s:Fault><faultcode>a:ErrorSchemaValidation</faultcode><faultstring>The request failed schema validation.</faultstring><detail><e:ResponseCode xmlns:e="x">ErrorSchemaValidation</e:ResponseCode></detail></s:Fault>"#,
    );
    let error = soap::messages(&soap::parse(fault.as_bytes()).unwrap(), "GetItem").unwrap_err();
    assert!(error.to_string().contains("ErrorSchemaValidation"), "{error}");
}

// ---- Contact folders and contacts (ADR-0066) ---------------------------------

/// A contact as Exchange gives it with its slots, its notes and what it is
/// filed as.
pub(crate) fn full_contact_xml(id: &str, change_key: &str) -> String {
    marked_contact_xml(id, change_key, "m-1")
}

/// [`full_contact_xml`] carrying our id `marker`.
pub(crate) fn marked_contact_xml(id: &str, change_key: &str, marker: &str) -> String {
    format!(
        r#"<t:Contact><t:ItemId Id="{id}" ChangeKey="{change_key}"/><t:Subject>Ana Puig</t:Subject><t:Body BodyType="Text">Vista a la fira</t:Body><t:ExtendedProperty><t:ExtendedFieldURI DistinguishedPropertySetId="PublicStrings" PropertyName="OrenetaContactUid" PropertyType="String"/><t:Value>{marker}</t:Value></t:ExtendedProperty><t:FileAs>Puig, Ana</t:FileAs><t:DisplayName>Ana Puig</t:DisplayName><t:GivenName>Ana</t:GivenName><t:CompanyName>Consorci</t:CompanyName><t:EmailAddresses><t:Entry Key="EmailAddress1">SMTP:Ana@Example.org</t:Entry><t:Entry Key="EmailAddress2">/O=CONSORCI/OU=GRUPO/CN=RECIPIENTS/CN=X</t:Entry></t:EmailAddresses><t:PhoneNumbers><t:Entry Key="MobilePhone">+34 600 000 000</t:Entry><t:Entry Key="BusinessPhone">+34 93 000 00 00</t:Entry><t:Entry Key="HomePhone"/></t:PhoneNumbers><t:Surname>Puig</t:Surname></t:Contact>"#
    )
}

pub(crate) fn read_full(id: &str, change_key: &str) -> Contact {
    let document = soap::parse(got(&[full_contact_xml(id, change_key)]).as_bytes()).unwrap();
    let item = soap::single(&document, "GetItem").unwrap();
    contact(item.path(&["Items", "Contact"]).unwrap()).unwrap()
}

pub(crate) fn folder_xml(id: &str, parent: &str, name: &str, class: &str, hidden: bool) -> String {
    let hidden = if hidden {
        r#"<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x10f4" PropertyType="Boolean"/><t:Value>true</t:Value></t:ExtendedProperty>"#
    } else {
        ""
    };
    format!(
        r#"<t:ContactsFolder><t:FolderId Id="{id}" ChangeKey="x"/><t:ParentFolderId Id="{parent}" ChangeKey="x"/><t:FolderClass>{class}</t:FolderClass><t:DisplayName>{name}</t:DisplayName>{hidden}</t:ContactsFolder>"#
    )
}

/// A `FindFolder` page under the Contacts folder.
pub(crate) fn found_folders(folders: &[String], last: bool) -> String {
    ok(
        "FindFolder",
        &format!(
            r#"<m:RootFolder IndexedPagingOffset="0" TotalFoldersInView="9" IncludesLastItemInRange="{last}"><t:Folders>{}</t:Folders></m:RootFolder>"#,
            folders.concat()
        ),
    )
}

fn no_server() -> crate::exchange::EwsClient {
    client("http://127.0.0.1:1".into())
}

#[test]
fn ews_contact_read_keeps_its_slots_notes_and_filing() {
    let ana = read_full("C1", "ck-1");
    assert_eq!(ana.person.note, "Vista a la fira");
    assert_eq!((ana.display_name.as_str(), ana.file_as.as_str()), ("Ana Puig", "Puig, Ana"));
    assert_eq!(ana.person.family, "Puig");
    assert_eq!(ana.marker.as_deref(), Some("m-1"));
    assert_eq!(ana.person.emails.iter().map(|e| e.addr.as_str()).collect::<Vec<_>>(), ["ana@example.org"]);
    assert_eq!(ana.email_slots.len(), 2, "the directory identifier takes a slot: {:?}", ana.email_slots);
    assert_eq!(
        ana.phone_slots,
        [
            ("MobilePhone".to_string(), "+34 600 000 000".to_string()),
            ("BusinessPhone".to_string(), "+34 93 000 00 00".to_string())
        ]
    );
    assert_eq!(ana.person.phones.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(), ["cell", "work"]);
}

#[test]
fn ews_contact_folders_are_real_visible_contact_folders_named_by_path() {
    let folders = [
        folder_xml("F1", "ROOT", "Feina", "IPF.Contact", false),
        folder_xml("F2", "F1", "Clients", "IPF.Contact", false),
        folder_xml("F3", "ROOT", "Recipient Cache", "IPF.Contact.RecipientCache", false),
        folder_xml("F4", "ROOT", "Amagada", "IPF.Contact", true),
        folder_xml("F5", "F4", "Sota l'amagada", "IPF.Contact", false),
        folder_xml("F6", "F7", "Bucle A", "IPF.Contact", false),
        folder_xml("F7", "F6", "Bucle B", "IPF.Contact", false),
        folder_xml("F8", "ROOT", "Notes", "IPF.StickyNote", false),
    ];
    let nodes: Vec<Node> = folders.iter().map(|xml| soap::parse(xml.as_bytes()).unwrap().children[0].clone()).collect();
    let found = contact_folders_of(&nodes);
    let paths: Vec<(&str, &str)> = found.iter().map(|folder| (folder.id.as_str(), folder.path.as_str())).collect();
    assert_eq!(
        paths,
        [("F7", "Bucle A/Bucle B"), ("F6", "Bucle B/Bucle A"), ("F1", "Feina"), ("F2", "Feina/Clients")],
        "system, hidden and other folders are left out; a looping chain is cut where it repeats"
    );
}

#[test]
fn ews_contact_folder_listing_is_paged_and_fails_whole() {
    let (url, server) = serve(vec![
        Step::Reply(found_folders(&[folder_xml("F1", "ROOT", "Feina", "IPF.Contact", false)], false)),
        Step::Reply(found_folders(&[folder_xml("F2", "F1", "Clients", "IPF.Contact", false)], true)),
    ]);
    let folders = client(url).contact_folders().expect("listed");
    assert_eq!(folders.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["Feina", "Feina/Clients"]);
    let requests = server.join().expect("server");
    assert!(
        requests[0].contains(r#"Traversal="Deep""#) && requests[0].contains(r#"<t:DistinguishedFolderId Id="contacts"/>"#),
        "{}",
        requests[0]
    );
    assert!(requests[1].contains(r#"Offset="1""#), "{}", requests[1]);

    let (url, server) = serve(vec![
        Step::Reply(found_folders(&[folder_xml("F1", "ROOT", "Feina", "IPF.Contact", false)], false)),
        Step::Reply(error_response("FindFolder", "ErrorAccessDenied", "Access is denied.")),
    ]);
    assert!(client(url).contact_folders().is_err(), "a page missing fails the listing");
    server.join().expect("server");
}

#[test]
fn ews_subfolder_book_read_names_the_folder_by_id() {
    let (url, server) = serve(vec![
        Step::Reply(found(&[("Contact", "C1")], true)),
        Step::Reply(got(&[contact_xml("C1", "ck", "Ana Puig", "ana@example.org")])),
    ]);
    let book = client(url).read_book("F1").expect("read");
    assert_eq!(book.contacts.len(), 1);
    let requests = server.join().expect("server");
    assert!(requests[0].contains(r#"<t:FolderId Id="F1"/>"#) && !requests[0].contains("DistinguishedFolderId"), "{}", requests[0]);
    assert!(requests[1].contains("<t:BodyType>Text</t:BodyType>") && requests[1].contains("OrenetaContactUid"), "{}", requests[1]);
}

#[test]
fn ews_contact_edit_sends_only_what_changed() {
    let before = read_full("C1", "ck-1");
    assert_eq!(contact_changes(&before, &before.person).unwrap(), "", "nothing changed, nothing sent");
    let mut after = before.person.clone();
    after.organisation = "Consorci <nou>".into();
    assert_eq!(
        contact_changes(&before, &after).unwrap(),
        r#"<t:SetItemField><t:FieldURI FieldURI="contacts:CompanyName"/><t:Contact><t:CompanyName>Consorci &lt;nou&gt;</t:CompanyName></t:Contact></t:SetItemField>"#
    );
    // Clearing a field deletes it; the note is written as text.
    let mut after = before.person.clone();
    after.given = String::new();
    after.note = "Nova nota".into();
    let changes = contact_changes(&before, &after).unwrap();
    assert!(changes.contains(r#"<t:DeleteItemField><t:FieldURI FieldURI="contacts:GivenName"/></t:DeleteItemField>"#), "{changes}");
    assert!(changes.contains(r#"<t:Body BodyType="Text">Nova nota</t:Body>"#), "{changes}");
    assert!(!changes.contains("DisplayName") && !changes.contains("EmailAddress") && !changes.contains("PhoneNumber"), "{changes}");
}

#[test]
fn ews_contact_rename_moves_filing_only_when_it_was_the_name() {
    let mut before = read_full("C1", "ck-1");
    let mut after = before.person.clone();
    after.name = "Ana Puig i Roca".into();
    // Filed as «Puig, Ana» on purpose: the filing stays.
    let changes = contact_changes(&before, &after).unwrap();
    assert!(changes.contains("<t:DisplayName>Ana Puig i Roca</t:DisplayName>") && !changes.contains("FileAs"), "{changes}");
    // Filed as the name: it follows.
    before.file_as = "Ana Puig".into();
    let changes = contact_changes(&before, &after).unwrap();
    assert!(changes.contains("<t:FileAs>Ana Puig i Roca</t:FileAs>"), "{changes}");
}

#[test]
fn ews_contact_addresses_keep_their_slots_and_take_free_ones() {
    let before = read_full("C1", "ck-1");
    // Ana's own address stays; a new one takes the free third slot (the
    // second holds a directory identifier, which is no address here).
    let mut after = before.person.clone();
    after.emails.push(EmailAddress { addr: "ana@casa.cat".into(), label: String::new() });
    assert_eq!(
        contact_changes(&before, &after).unwrap(),
        r#"<t:SetItemField><t:IndexedFieldURI FieldURI="contacts:EmailAddress" FieldIndex="EmailAddress3"/><t:Contact><t:EmailAddresses><t:Entry Key="EmailAddress3">ana@casa.cat</t:Entry></t:EmailAddresses></t:Contact></t:SetItemField>"#
    );
    // Replacing it reuses its slot with one change; taking it out clears it.
    let mut after = before.person.clone();
    after.emails = vec![EmailAddress { addr: "ana.puig@example.org".into(), label: String::new() }];
    let changes = contact_changes(&before, &after).unwrap();
    assert!(
        changes.contains(r#"FieldIndex="EmailAddress1"/><t:Contact><t:EmailAddresses><t:Entry Key="EmailAddress1">ana.puig@example.org"#),
        "{changes}"
    );
    assert!(!changes.contains("DeleteItemField") && !changes.contains("EmailAddress2"), "{changes}");
    let mut after = before.person.clone();
    after.emails.clear();
    assert_eq!(
        contact_changes(&before, &after).unwrap(),
        r#"<t:DeleteItemField><t:IndexedFieldURI FieldURI="contacts:EmailAddress" FieldIndex="EmailAddress1"/></t:DeleteItemField>"#
    );
    // The same address in another case is no change.
    let mut after = before.person.clone();
    after.emails[0].addr = "ANA@example.org".into();
    assert_eq!(contact_changes(&before, &after).unwrap(), "");
}

#[test]
fn ews_contact_change_exchange_cannot_hold_fails_before_sending() {
    let before = read_full("C1", "ck-1");
    let mut too_many = before.person.clone();
    too_many.emails.extend(["b@x.org", "c@x.org"].map(|addr| EmailAddress { addr: addr.into(), label: String::new() }));
    let error = contact_changes(&before, &too_many).unwrap_err();
    assert!(error.to_string().contains("at most three email addresses"), "{error}");
    let mut after = before.person.clone();
    after.emails.push(EmailAddress { addr: "no-address".into(), label: String::new() });
    let error = contact_changes(&before, &after).unwrap_err();
    assert!(error.to_string().contains("not an email address"), "{error}");
    let mut after = before.person.clone();
    after.name.clear();
    after.emails.clear();
    assert!(contact_changes(&before, &after).unwrap_err().to_string().contains("needs a name or an email address"));
    // Nothing reaches a server: there is none to reach.
    let error = no_server().update_contact(&before, &too_many).unwrap_err();
    assert!(error.to_string().contains("at most three email addresses"), "{error}");
}

#[test]
fn ews_contact_phones_keep_their_slots_by_kind() {
    let before = read_full("C1", "ck-1");
    // A new number with no label takes the general slot, not a fax.
    let mut after = before.person.clone();
    after.phones.push(PhoneNumber { number: "+34 611 111 111".into(), label: String::new() });
    assert_eq!(
        contact_changes(&before, &after).unwrap(),
        r#"<t:SetItemField><t:IndexedFieldURI FieldURI="contacts:PhoneNumber" FieldIndex="OtherTelephone"/><t:Contact><t:PhoneNumbers><t:Entry Key="OtherTelephone">+34 611 111 111</t:Entry></t:PhoneNumbers></t:Contact></t:SetItemField>"#
    );
    // A work number edited stays in its slot; another work number takes the
    // second work slot; the mobile one taken out is cleared.
    let mut after = before.person.clone();
    after.phones = vec![
        PhoneNumber { number: "+34 93 111 11 11".into(), label: "work".into() },
        PhoneNumber { number: "+34 93 222 22 22".into(), label: "work".into() },
    ];
    let changes = contact_changes(&before, &after).unwrap();
    assert!(changes.contains(r#"<t:Entry Key="BusinessPhone">+34 93 111 11 11</t:Entry>"#), "{changes}");
    assert!(changes.contains(r#"<t:Entry Key="BusinessPhone2">+34 93 222 22 22</t:Entry>"#), "{changes}");
    assert!(
        changes.contains(r#"<t:DeleteItemField><t:IndexedFieldURI FieldURI="contacts:PhoneNumber" FieldIndex="MobilePhone"/></t:DeleteItemField>"#),
        "{changes}"
    );
    assert!(!changes.contains(r#"FieldIndex="BusinessPhone"/></t:DeleteItemField>"#), "a slot written again is not also cleared: {changes}");
    // Faxes only go in fax slots, and four have no room.
    let mut after = before.person.clone();
    for n in 1..=4 {
        after.phones.push(PhoneNumber { number: format!("+34 93 400 00 0{n}"), label: "fax".into() });
    }
    let error = contact_changes(&before, &after).unwrap_err();
    assert!(error.to_string().contains("no room on this contact for another phone number"), "{error}");
}

#[test]
fn ews_contact_update_names_the_version_read_and_never_overwrites() {
    let before = read_full("C1", "ck-1");
    let mut after = before.person.clone();
    after.organisation = "Nova".into();
    let (url, server) = serve(vec![Step::Reply(ok(
        "UpdateItem",
        r#"<m:Items><t:Contact><t:ItemId Id="C1" ChangeKey="ck-2"/></t:Contact></m:Items>"#,
    ))]);
    assert_eq!(
        client(url).update_contact(&before, &after).unwrap(),
        ListWrite::Saved { id: "C1".into(), change_key: "ck-2".into() }
    );
    let request = &server.join().expect("server")[0];
    assert!(
        request.contains(r#"ConflictResolution="NeverOverwrite""#) && request.contains(r#"<t:ItemId Id="C1" ChangeKey="ck-1"/>"#),
        "{request}"
    );
    for code in ["ErrorIrresolvableConflict", "ErrorStaleObject", "ErrorItemNotFound"] {
        let (url, server) = serve(vec![Step::Reply(error_response("UpdateItem", code, "changed"))]);
        assert_eq!(client(url).update_contact(&before, &after).unwrap(), ListWrite::Conflict, "{code}");
        server.join().expect("server");
    }
    // Without the version it was read at nothing is sent, nor when nothing
    // changed.
    let mut blind = before.clone();
    blind.change_key.clear();
    assert_eq!(no_server().update_contact(&blind, &after).unwrap(), ListWrite::Conflict);
    assert_eq!(
        no_server().update_contact(&before, &before.person).unwrap(),
        ListWrite::Saved { id: "C1".into(), change_key: "ck-1".into() }
    );
}

#[test]
fn ews_contact_create_writes_the_schema_order_with_our_id() {
    let person = Person {
        name: "Pere Clavé".into(),
        given: "Pere".into(),
        family: "Clavé".into(),
        organisation: "Taller".into(),
        note: "Proveïdor".into(),
        emails: vec![EmailAddress { addr: "pere@example.org".into(), label: String::new() }],
        phones: vec![PhoneNumber { number: "+34 622 222 222".into(), label: "cell".into() }],
        ..Default::default()
    };
    let (url, server) = serve(vec![Step::Reply(ok(
        "CreateItem",
        r#"<m:Items><t:Contact><t:ItemId Id="C9" ChangeKey="ck-9"/></t:Contact></m:Items>"#,
    ))]);
    let created = client(url).create_contact("F1", &person, "m-9").expect("created");
    assert!(matches!(created, Created::Made { ref id, ref change_key } if id == "C9" && change_key == "ck-9"), "{created:?}");
    let request = &server.join().expect("server")[0];
    assert!(request.contains(r#"<m:SavedItemFolderId><t:FolderId Id="F1"/></m:SavedItemFolderId>"#), "{request}");
    let order = [
        "<t:Body",
        "OrenetaContactUid",
        "<t:FileAs>",
        "<t:DisplayName>",
        "<t:GivenName>",
        "<t:CompanyName>",
        "<t:EmailAddresses>",
        "<t:PhoneNumbers>",
        "<t:Surname>",
    ];
    let at: Vec<usize> = order.iter().map(|tag| request.find(tag).unwrap_or_else(|| panic!("{tag} missing: {request}"))).collect();
    assert!(at.windows(2).all(|pair| pair[0] < pair[1]), "schema order: {request}");
    assert!(
        request.contains("<t:Value>m-9</t:Value>") && request.contains(r#"<t:Entry Key="MobilePhone">+34 622 222 222</t:Entry>"#),
        "{request}"
    );
}

#[test]
fn ews_contact_create_outcomes() {
    let person = Person { name: "Pere".into(), ..Default::default() };
    // A lost answer is no failure yet: the contact may be there.
    let (url, server) = serve(vec![Step::Drop]);
    assert!(matches!(client(url).create_contact("", &person, "m").unwrap(), Created::Unknown(_)));
    server.join().expect("server");
    // A refusal is: nothing was created.
    let (url, server) = serve(vec![Step::Reply(error_response("CreateItem", "ErrorAccessDenied", "Access is denied."))]);
    assert!(client(url).create_contact("", &person, "m").is_err());
    server.join().expect("server");
    // A contact Exchange could not hold is never sent.
    assert!(no_server().create_contact("", &Person::default(), "m").is_err());
}

#[test]
fn ews_marked_contact_is_found_by_our_id() {
    let (url, server) = serve(vec![Step::Reply(found(&[("Contact", "C1")], true)), Step::Reply(got(&[full_contact_xml("C1", "ck-1")]))]);
    let marked = client(url).find_marked_contact("", "m-1").expect("searched").expect("found");
    assert_eq!(marked.person.uid, "C1");
    let requests = server.join().expect("server");
    assert!(
        requests[0].contains("<m:Restriction><t:IsEqualTo>") && requests[0].contains(r#"<t:Constant Value="m-1"/>"#),
        "{}",
        requests[0]
    );
    // Another id is not ours.
    let (url, server) = serve(vec![Step::Reply(found(&[("Contact", "C1")], true)), Step::Reply(got(&[full_contact_xml("C1", "ck-1")]))]);
    assert!(client(url).find_marked_contact("", "m-2").expect("searched").is_none());
    server.join().expect("server");
}

#[test]
fn ews_contact_delete_checks_the_version_first() {
    let (url, server) = serve(vec![Step::Reply(got(&[full_contact_xml("C1", "ck-moved")]))]);
    assert_eq!(client(url).delete_contact("C1", "ck-1").unwrap(), ListWrite::Conflict);
    assert!(!server.join().expect("server").iter().any(|r| r.contains("DeleteItem")));
    let (url, server) = serve(vec![Step::Reply(got(&[full_contact_xml("C1", "ck-1")])), Step::Reply(ok("DeleteItem", ""))]);
    assert!(matches!(client(url).delete_contact("C1", "ck-1").unwrap(), ListWrite::Saved { .. }));
    let requests = server.join().expect("server");
    assert!(
        requests[1].contains(r#"DeleteType="MoveToDeletedItems""#) && requests[1].contains(r#"ChangeKey="ck-1""#),
        "{}",
        requests[1]
    );
    assert_eq!(no_server().delete_contact("C1", "").unwrap(), ListWrite::Conflict);
    // Already gone: there is nothing left to delete.
    let (url, server) = serve(vec![Step::Reply(error_response("GetItem", "ErrorItemNotFound", "Gone."))]);
    assert!(matches!(client(url).delete_contact("C1", "ck-1").unwrap(), ListWrite::Saved { .. }));
    assert!(!server.join().expect("server").iter().any(|r| r.contains("DeleteItem")));
}

#[test]
fn ews_contact_addresses_are_written_as_typed_and_must_be_smtp() {
    let before = read_full("C1", "ck-1");
    let mut after = before.person.clone();
    after.emails.push(EmailAddress { addr: " smtp:Pere.Clave@Example.org ".into(), label: String::new() });
    let changes = contact_changes(&before, &after).unwrap();
    assert!(changes.contains(r#"<t:Entry Key="EmailAddress3">Pere.Clave@Example.org</t:Entry>"#), "{changes}");
    for wrong in ["sip:pere@example.org", "pere@", "@example.org", "pere clave@example.org", "/O=X/CN=Y@Z"] {
        let mut after = before.person.clone();
        after.emails.push(EmailAddress { addr: wrong.into(), label: String::new() });
        let error = contact_changes(&before, &after).unwrap_err();
        assert!(error.to_string().contains("not an email address"), "{wrong}: {error}");
    }
}

#[test]
fn ews_contact_note_line_ends_are_no_change() {
    let mut before = read_full("C1", "ck-1");
    before.person.note = "Primera línia\r\nSegona línia".into();
    let mut after = before.person.clone();
    after.note = "Primera línia\nSegona línia".into();
    assert_eq!(contact_changes(&before, &after).unwrap(), "");
}

#[test]
fn ews_contact_with_no_display_name_keeps_its_filing() {
    let mut before = read_full("C1", "ck-1");
    // Shown by what it is filed as, for want of a display name.
    before.display_name.clear();
    before.person.name = before.file_as.clone();
    assert_eq!(contact_changes(&before, &before.person).unwrap(), "", "nothing changed, nothing sent");
    let mut after = before.person.clone();
    after.name = "Ana Puig".into();
    let changes = contact_changes(&before, &after).unwrap();
    assert!(changes.contains("<t:DisplayName>Ana Puig</t:DisplayName>") && !changes.contains("FileAs"), "{changes}");
}

#[test]
fn ews_contact_phone_relabelled_moves_to_a_slot_of_its_kind() {
    let before = read_full("C1", "ck-1");
    let mut after = before.person.clone();
    after.phones[0].label = "work".into();
    // The same number twice is one.
    after.phones.push(after.phones[1].clone());
    let changes = contact_changes(&before, &after).unwrap();
    assert!(changes.contains(r#"<t:Entry Key="BusinessPhone2">+34 600 000 000</t:Entry>"#), "{changes}");
    assert!(
        changes.contains(r#"<t:DeleteItemField><t:IndexedFieldURI FieldURI="contacts:PhoneNumber" FieldIndex="MobilePhone"/></t:DeleteItemField>"#),
        "{changes}"
    );
    assert!(!changes.contains(r#"FieldIndex="BusinessPhone""#), "the work number stays: {changes}");
}

#[test]
fn ews_contact_create_answer_without_its_id_is_unknown() {
    let person = Person { name: "Pere".into(), ..Default::default() };
    let (url, server) = serve(vec![Step::Reply(ok("CreateItem", "<m:Items/>"))]);
    assert!(matches!(client(url).create_contact("", &person, "m").unwrap(), Created::Unknown(_)));
    server.join().expect("server");
}

#[test]
fn ews_contact_folder_listing_that_stops_early_fails() {
    let (url, server) = serve(vec![Step::Reply(found_folders(&[], false))]);
    let error = client(url).contact_folders().unwrap_err();
    assert!(error.to_string().contains("stopped giving folders"), "{error}");
    server.join().expect("server");
}
