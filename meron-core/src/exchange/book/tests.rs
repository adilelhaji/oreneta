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
    let book = client(url).read_book().expect("read");
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
    let error = client(url).read_book().expect_err("refused");
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
