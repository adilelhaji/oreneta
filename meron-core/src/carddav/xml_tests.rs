use super::xml::*;

const PRINCIPAL: &str = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/</d:href>
    <d:propstat>
      <d:prop><d:current-user-principal><d:href>/dav/principals/ana/</d:href></d:current-user-principal></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>"#;

#[test]
fn reads_the_principal_out_of_its_own_element() {
    let parsed = parse_multistatus(PRINCIPAL).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].href, "/dav/");
    assert_eq!(parsed[0].prop_href("current-user-principal"), Some("/dav/principals/ana/"));
}

#[test]
fn the_prefix_the_server_chose_makes_no_difference() {
    // Same document, three ways real servers write it.
    for body in [
        PRINCIPAL.to_string(),
        PRINCIPAL.replace("d:", "D:").replace("xmlns:D", "xmlns:D"),
        PRINCIPAL.replace("d:", "").replace(r#"xmlns:="DAV:""#, r#"xmlns="DAV:""#),
    ] {
        let parsed = parse_multistatus(&body).unwrap();
        assert_eq!(
            parsed[0].prop_href("current-user-principal"),
            Some("/dav/principals/ana/"),
            "{body}"
        );
    }
}

#[test]
fn tells_an_address_book_from_a_plain_collection() {
    let body = r#"<multistatus xmlns="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
      <response>
        <href>/dav/ana/</href>
        <propstat><prop>
          <resourcetype><collection/></resourcetype>
          <displayname>Home</displayname>
        </prop><status>HTTP/1.1 200 OK</status></propstat>
      </response>
      <response>
        <href>/dav/ana/contacts/</href>
        <propstat><prop>
          <resourcetype><collection/><card:addressbook/></resourcetype>
          <displayname>Contacts</displayname>
        </prop><status>HTTP/1.1 200 OK</status></propstat>
      </response>
    </multistatus>"#;
    let parsed = parse_multistatus(body).unwrap();
    assert_eq!(parsed.len(), 2);
    assert!(!parsed[0].is_addressbook());
    assert!(parsed[1].is_addressbook());
    assert_eq!(parsed[1].prop("displayname"), Some("Contacts"));
}

#[test]
fn the_href_naming_the_response_is_not_confused_with_one_inside_a_property() {
    let body = r#"<multistatus xmlns="DAV:">
      <response>
        <href>/dav/principals/ana/</href>
        <propstat><prop>
          <addressbook-home-set xmlns="urn:ietf:params:xml:ns:carddav">
            <href xmlns="DAV:">/dav/ana/</href>
          </addressbook-home-set>
        </prop><status>HTTP/1.1 200 OK</status></propstat>
      </response>
    </multistatus>"#;
    let parsed = parse_multistatus(body).unwrap();
    assert_eq!(parsed[0].href, "/dav/principals/ana/");
    assert_eq!(parsed[0].prop_href("addressbook-home-set"), Some("/dav/ana/"));
}

#[test]
fn a_propstat_saying_it_has_no_such_property_is_marked_as_such() {
    let body = r#"<multistatus xmlns="DAV:">
      <response>
        <href>/dav/ana/contacts/</href>
        <propstat><prop><displayname>Contacts</displayname></prop><status>HTTP/1.1 200 OK</status></propstat>
        <propstat><prop><getctag/></prop><status>HTTP/1.1 404 Not Found</status></propstat>
      </response>
    </multistatus>"#;
    let parsed = parse_multistatus(body).unwrap();
    // Both propstats fold into the one response; the 404 leaves the property
    // absent rather than present and empty, which is the honest reading.
    assert_eq!(parsed[0].prop("displayname"), Some("Contacts"));
    assert_eq!(parsed[0].prop("getctag"), None);
}

#[test]
fn carries_the_card_itself_when_the_server_sent_one() {
    let body = "<multistatus xmlns=\"DAV:\" xmlns:card=\"urn:ietf:params:xml:ns:carddav\">
      <response>
        <href>/dav/ana/contacts/1.vcf</href>
        <propstat><prop>
          <getetag>\"abc\"</getetag>
          <card:address-data>BEGIN:VCARD
FN:Ana
END:VCARD</card:address-data>
        </prop><status>HTTP/1.1 200 OK</status></propstat>
      </response>
    </multistatus>";
    let parsed = parse_multistatus(body).unwrap();
    assert_eq!(parsed[0].prop("getetag"), Some("\"abc\""));
    assert!(parsed[0].prop("address-data").unwrap().contains("FN:Ana"));
}

#[test]
fn escaped_text_comes_back_as_the_characters_it_stood_for() {
    let body = r#"<multistatus xmlns="DAV:">
      <response><href>/x/</href>
        <propstat><prop><displayname>Ana &amp; Marc</displayname></prop>
        <status>HTTP/1.1 200 OK</status></propstat>
      </response>
    </multistatus>"#;
    assert_eq!(parse_multistatus(body).unwrap()[0].prop("displayname"), Some("Ana & Marc"));
}

#[test]
fn a_body_that_is_not_a_multistatus_yields_nothing_rather_than_failing() {
    for body in ["<html><body>Not found</body></html>", "", "not xml at all", "{\"json\":true}"] {
        assert!(parse_multistatus(body).unwrap().is_empty(), "{body}");
    }
}

#[test]
fn a_truncated_document_yields_what_it_managed_to_read() {
    let body = r#"<multistatus xmlns="DAV:">
      <response><href>/a/</href><propstat><prop><displayname>A</displayname></prop>
      <status>HTTP/1.1 200 OK</status></propstat></response>
      <response><href>/b/</href><propstat><prop><displayname>B</displayname>"#;
    let parsed = parse_multistatus(body).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].prop("displayname"), Some("A"));
}
