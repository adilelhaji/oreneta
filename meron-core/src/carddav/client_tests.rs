use std::cell::RefCell;

use super::client::*;

/// A server made of canned answers, keyed by method and URL.
struct FakeServer {
    answers: Vec<(&'static str, &'static str, u16, String)>,
    /// Where each answer says the request ended up, for redirects.
    redirects: Vec<(&'static str, &'static str)>,
    seen: RefCell<Vec<(String, String)>>,
}

impl FakeServer {
    fn new(answers: Vec<(&'static str, &'static str, u16, String)>) -> Self {
        Self {
            answers,
            redirects: Vec::new(),
            seen: RefCell::new(Vec::new()),
        }
    }

    fn redirecting(mut self, from: &'static str, to: &'static str) -> Self {
        self.redirects.push((from, to));
        self
    }
}

impl Transport for FakeServer {
    fn send(&self, request: &DavRequest) -> anyhow::Result<HttpReply> {
        self.seen
            .borrow_mut()
            .push((request.method.to_string(), request.url.clone()));
        let landed = self
            .redirects
            .iter()
            .find(|(from, _)| *from == request.url)
            .map(|(_, to)| (*to).to_string())
            .unwrap_or_else(|| request.url.clone());

        for (method, url, status, body) in &self.answers {
            if *method == request.method && *url == landed {
                return Ok(HttpReply {
                    status: *status,
                    body: body.clone(),
                    url: landed,
                });
            }
        }
        Ok(HttpReply {
            status: 404,
            body: String::new(),
            url: landed,
        })
    }
}

fn principal_answer(href: &str) -> String {
    format!(
        r#"<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop>
        <current-user-principal><href>{href}</href></current-user-principal>
        </prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#
    )
}

fn home_answer(href: &str) -> String {
    format!(
        r#"<multistatus xmlns="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
        <response><href>/dav/principals/ana/</href><propstat><prop>
        <card:addressbook-home-set><href>{href}</href></card:addressbook-home-set>
        </prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#
    )
}

fn books_answer() -> String {
    r#"<multistatus xmlns="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"
       xmlns:cs="http://calendarserver.org/ns/">
      <response><href>/dav/ana/</href><propstat><prop>
        <resourcetype><collection/></resourcetype><displayname>Home</displayname>
      </prop><status>HTTP/1.1 200 OK</status></propstat></response>
      <response><href>/dav/ana/contacts/</href><propstat><prop>
        <resourcetype><collection/><card:addressbook/></resourcetype>
        <displayname>Contacts</displayname><cs:getctag>tok-1</cs:getctag>
      </prop><status>HTTP/1.1 200 OK</status></propstat></response>
    </multistatus>"#
        .to_string()
}

// ---------------------------------------------------------------------------
// Where to start looking
// ---------------------------------------------------------------------------

#[test]
fn an_email_address_means_the_domain_it_is_at() {
    assert_eq!(
        starting_point("ana@example.com").unwrap(),
        "https://example.com/.well-known/carddav"
    );
}

#[test]
fn a_bare_host_is_reached_over_tls() {
    assert_eq!(
        starting_point("dav.example.com").unwrap(),
        "https://dav.example.com/.well-known/carddav"
    );
}

#[test]
fn a_url_somebody_pasted_is_taken_as_given() {
    // They know their server better than a guess does.
    assert_eq!(
        starting_point("https://dav.example.com/books/ana/").unwrap(),
        "https://dav.example.com/books/ana/"
    );
}

#[test]
fn a_plain_http_url_is_honoured_rather_than_quietly_upgraded() {
    // Silently rewriting somebody's URL is how a local server stops working
    // with no explanation. If it should be refused, that is a decision for
    // the caller, said out loud.
    assert_eq!(
        starting_point("http://localhost:5232/ana/").unwrap(),
        "http://localhost:5232/ana/"
    );
}

#[test]
fn nothing_typed_is_an_error_rather_than_a_guess() {
    assert!(starting_point("   ").is_err());
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

#[test]
fn follows_the_chain_from_an_email_address_to_a_book() {
    let server = FakeServer::new(vec![
        ("PROPFIND", "https://example.com/dav/", 207, principal_answer("/dav/principals/ana/")),
        ("PROPFIND", "https://example.com/dav/principals/ana/", 207, home_answer("/dav/ana/")),
        ("PROPFIND", "https://example.com/dav/ana/", 207, books_answer()),
    ])
    .redirecting("https://example.com/.well-known/carddav", "https://example.com/dav/");

    let books = discover(&server, "ana@example.com").unwrap();
    assert_eq!(books.len(), 1);
    assert_eq!(books[0].url, "https://example.com/dav/ana/contacts/");
    assert_eq!(books[0].name, "Contacts");
    assert_eq!(books[0].ctag, "tok-1");
}

#[test]
fn hrefs_are_resolved_against_where_the_answer_came_from_not_where_it_was_asked() {
    // The whole point of .well-known is the redirect, and a client resolving
    // against the original URL builds a path that is not there.
    let server = FakeServer::new(vec![
        ("PROPFIND", "https://dav.example.com/remote.php/dav/", 207, principal_answer("/remote.php/dav/principals/ana/")),
        ("PROPFIND", "https://dav.example.com/remote.php/dav/principals/ana/", 207, home_answer("/remote.php/dav/addressbooks/ana/")),
        ("PROPFIND", "https://dav.example.com/remote.php/dav/addressbooks/ana/", 207,
         r#"<multistatus xmlns="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
            <response><href>/remote.php/dav/addressbooks/ana/contacts/</href><propstat><prop>
            <resourcetype><collection/><card:addressbook/></resourcetype>
            </prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#.to_string()),
    ])
    .redirecting("https://example.com/.well-known/carddav", "https://dav.example.com/remote.php/dav/");

    let books = discover(&server, "ana@example.com").unwrap();
    assert_eq!(books[0].url, "https://dav.example.com/remote.php/dav/addressbooks/ana/contacts/");
}

#[test]
fn a_server_that_answers_the_home_set_directly_needs_no_principal() {
    let server = FakeServer::new(vec![
        ("PROPFIND", "https://example.com/.well-known/carddav", 207, home_answer("/dav/ana/")),
        ("PROPFIND", "https://example.com/dav/ana/", 207, books_answer()),
    ]);
    assert_eq!(discover(&server, "ana@example.com").unwrap().len(), 1);
}

#[test]
fn a_collection_url_pasted_straight_in_needs_neither() {
    let server = FakeServer::new(vec![(
        "PROPFIND",
        "https://example.com/dav/ana/",
        207,
        books_answer(),
    )]);
    let books = discover(&server, "https://example.com/dav/ana/").unwrap();
    assert_eq!(books[0].name, "Contacts");
}

#[test]
fn a_book_the_server_did_not_name_gets_one_from_its_address() {
    let server = FakeServer::new(vec![(
        "PROPFIND",
        "https://example.com/dav/ana/",
        207,
        r#"<multistatus xmlns="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
           <response><href>/dav/ana/work-people/</href><propstat><prop>
           <resourcetype><collection/><card:addressbook/></resourcetype>
           </prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#
            .to_string(),
    )]);
    assert_eq!(discover(&server, "https://example.com/dav/ana/").unwrap()[0].name, "work-people");
}

#[test]
fn a_plain_collection_is_not_offered_as_an_address_book() {
    let server = FakeServer::new(vec![(
        "PROPFIND",
        "https://example.com/dav/ana/",
        207,
        r#"<multistatus xmlns="DAV:"><response><href>/dav/ana/files/</href><propstat><prop>
           <resourcetype><collection/></resourcetype>
           </prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#
            .to_string(),
    )]);
    assert!(discover(&server, "https://example.com/dav/ana/").is_err());
}

#[test]
fn refused_credentials_are_said_so_rather_than_reported_as_an_empty_book() {
    let server = FakeServer::new(vec![(
        "PROPFIND",
        "https://example.com/dav/ana/",
        401,
        String::new(),
    )]);
    let error = discover(&server, "https://example.com/dav/ana/").unwrap_err().to_string();
    assert!(error.contains("refused"), "{error}");
}

#[test]
fn a_server_with_nothing_on_it_is_an_error_and_not_an_empty_success() {
    // Reporting "zero contacts" for a server that was never found would look
    // like an empty address book, and the reader would go looking for their
    // contacts rather than for their settings.
    let server = FakeServer::new(vec![]);
    assert!(discover(&server, "ana@example.com").is_err());
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const TWO_CARDS: &str = "<multistatus xmlns=\"DAV:\" xmlns:card=\"urn:ietf:params:xml:ns:carddav\">
  <response><href>/dav/ana/contacts/1.vcf</href><propstat><prop><getetag>\"a\"</getetag>
    <card:address-data>BEGIN:VCARD
FN:Ana Prat
EMAIL:ana@example.com
END:VCARD</card:address-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/dav/ana/contacts/2.vcf</href><propstat><prop><getetag>\"b\"</getetag>
    <card:address-data>BEGIN:VCARD
FN:Marc Roca
EMAIL:marc@example.com
END:VCARD</card:address-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>";

#[test]
fn reads_a_whole_book_in_one_report() {
    let server = FakeServer::new(vec![(
        "REPORT",
        "https://example.com/dav/ana/contacts/",
        207,
        TWO_CARDS.to_string(),
    )]);
    let people = fetch_book(&server, "https://example.com/dav/ana/contacts/").unwrap();
    assert_eq!(people.len(), 2);
    assert_eq!(people[0].name, "Ana Prat");
    assert_eq!(people[1].emails[0].addr, "marc@example.com");
}

#[test]
fn an_empty_book_is_an_empty_book_and_not_a_failure() {
    let server = FakeServer::new(vec![(
        "REPORT",
        "https://example.com/dav/ana/contacts/",
        207,
        r#"<multistatus xmlns="DAV:"></multistatus>"#.to_string(),
    )]);
    // Nothing in the book and no fallback stampede: the report answered.
    assert!(fetch_book(&server, "https://example.com/dav/ana/contacts/").unwrap().is_empty());
}

#[test]
fn a_server_that_will_not_do_the_report_is_asked_the_long_way() {
    let server = FakeServer::new(vec![
        ("REPORT", "https://example.com/dav/ana/contacts/", 501, String::new()),
        (
            "PROPFIND",
            "https://example.com/dav/ana/contacts/",
            207,
            r#"<multistatus xmlns="DAV:">
              <response><href>/dav/ana/contacts/</href><propstat><prop>
                <resourcetype><collection/></resourcetype>
              </prop><status>HTTP/1.1 200 OK</status></propstat></response>
              <response><href>/dav/ana/contacts/1.vcf</href><propstat><prop>
                <getetag>"a"</getetag><resourcetype/>
              </prop><status>HTTP/1.1 200 OK</status></propstat></response>
            </multistatus>"#
                .to_string(),
        ),
        (
            "GET",
            "https://example.com/dav/ana/contacts/1.vcf",
            200,
            "BEGIN:VCARD\nFN:Ana Prat\nEMAIL:ana@example.com\nEND:VCARD".to_string(),
        ),
    ]);
    let people = fetch_book(&server, "https://example.com/dav/ana/contacts/").unwrap();
    assert_eq!(people.len(), 1);
    assert_eq!(people[0].name, "Ana Prat");
}

/// #28: a card that will not come is not silently left out of the book —
/// the caller would replace the local book with the rest. It is an error
/// that names what was missed, and the last complete copy stays.
#[test]
fn one_card_that_will_not_come_keeps_the_last_complete_copy() {
    let server = FakeServer::new(vec![
        ("REPORT", "https://example.com/dav/ana/contacts/", 501, String::new()),
        (
            "PROPFIND",
            "https://example.com/dav/ana/contacts/",
            207,
            r#"<multistatus xmlns="DAV:">
              <response><href>/dav/ana/contacts/1.vcf</href><propstat><prop><getetag>"a"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>
              <response><href>/dav/ana/contacts/2.vcf</href><propstat><prop><getetag>"b"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>
            </multistatus>"#
                .to_string(),
        ),
        ("GET", "https://example.com/dav/ana/contacts/2.vcf", 200,
         "BEGIN:VCARD\nFN:Marc\nEMAIL:marc@example.com\nEND:VCARD".to_string()),
    ]);
    let err = fetch_book(&server, "https://example.com/dav/ana/contacts/").unwrap_err().to_string();
    assert!(err.contains("1 of 2 contacts could not be read"), "{err}");
    assert!(err.contains("1.vcf"), "{err}");
    assert!(err.contains("last complete copy is kept"), "{err}");
}

fn report_book(body: &str) -> FakeServer {
    FakeServer::new(vec![(
        "REPORT",
        "https://example.com/dav/ana/contacts/",
        207,
        body.to_string(),
    )])
}

#[test]
fn a_card_the_report_failed_to_send_is_an_error_not_a_smaller_book() {
    let server = report_book(
        r#"<multistatus xmlns="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
          <response><href>/dav/ana/contacts/1.vcf</href><propstat><prop><getetag>"a"</getetag>
            <card:address-data>BEGIN:VCARD
FN:Ana Prat
END:VCARD</card:address-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>
          <response><href>/dav/ana/contacts/2.vcf</href><status>HTTP/1.1 500 Internal Server Error</status></response>
        </multistatus>"#,
    );
    let err = fetch_book(&server, "https://example.com/dav/ana/contacts/").unwrap_err().to_string();
    assert!(err.contains("1 of 2"), "{err}");
    assert!(err.contains("500"), "{err}");
}

#[test]
fn a_card_whose_data_propstat_failed_is_an_error_even_when_another_propstat_is_fine() {
    // Two propstats for one card: the etag came, the card did not. The good
    // one coming last must not make the response read as fine.
    let server = report_book(
        r#"<multistatus xmlns="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
          <response><href>/dav/ana/contacts/1.vcf</href>
            <propstat><prop><card:address-data/></prop><status>HTTP/1.1 403 Forbidden</status></propstat>
            <propstat><prop><getetag>"a"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat>
          </response>
        </multistatus>"#,
    );
    let err = fetch_book(&server, "https://example.com/dav/ana/contacts/").unwrap_err().to_string();
    assert!(err.contains("403"), "{err}");
}

#[test]
fn an_answer_cut_off_mid_way_is_an_error_not_the_cards_before_the_cut() {
    let cut = &TWO_CARDS[..TWO_CARDS.find("Marc Roca").unwrap()];
    let err = fetch_book(&report_book(cut), "https://example.com/dav/ana/contacts/")
        .unwrap_err()
        .to_string();
    assert!(err.contains("cut off"), "{err}");
}

#[test]
fn a_card_that_is_not_a_vcard_is_an_error() {
    let server = report_book(
        r#"<multistatus xmlns="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
          <response><href>/dav/ana/contacts/1.vcf</href><propstat><prop>
            <card:address-data>this is not a vcard</card:address-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>
        </multistatus>"#,
    );
    assert!(fetch_book(&server, "https://example.com/dav/ana/contacts/").is_err());
}

#[test]
fn an_empty_book_needs_no_second_request() {
    let server = report_book(r#"<multistatus xmlns="DAV:"></multistatus>"#);
    assert!(fetch_book(&server, "https://example.com/dav/ana/contacts/").unwrap().is_empty());
    assert_eq!(server.seen.borrow().len(), 1, "an empty answer is an answer: {:?}", server.seen.borrow());
}

#[test]
fn the_book_listing_itself_in_a_report_is_not_a_missing_card() {
    let server = report_book(
        r#"<multistatus xmlns="DAV:"><response><href>/dav/ana/contacts/</href><propstat><prop><getetag>"x"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#,
    );
    assert!(fetch_book(&server, "https://example.com/dav/ana/contacts/").unwrap().is_empty());
}

/// #28: the password goes with every request, so a card href on another
/// host is not followed.
#[test]
fn a_card_on_another_host_is_not_fetched_and_the_copy_is_kept() {
    let server = FakeServer::new(vec![
        ("REPORT", "https://example.com/dav/ana/contacts/", 501, String::new()),
        (
            "PROPFIND",
            "https://example.com/dav/ana/contacts/",
            207,
            r#"<multistatus xmlns="DAV:">
              <response><href>https://attacker.example.net/steal.vcf</href><propstat><prop><getetag>"a"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>
            </multistatus>"#
                .to_string(),
        ),
    ]);
    let err = fetch_book(&server, "https://example.com/dav/ana/contacts/").unwrap_err().to_string();
    assert!(err.contains("another server"), "{err}");
    assert!(
        !server.seen.borrow().iter().any(|(_, url)| url.contains("attacker")),
        "nothing may be sent there: {:?}",
        server.seen.borrow()
    );
}

#[test]
fn credentials_never_go_down_to_plain_http_or_to_another_plain_http_host() {
    assert!(credentials_may_follow("https://a.example.com/x/", "https://a.example.com/y/"));
    assert!(credentials_may_follow("https://a.example.com/", "https://p01-contacts.example.com/"));
    assert!(!credentials_may_follow("https://a.example.com/", "http://a.example.com/"));
    assert!(credentials_may_follow("http://127.0.0.1:5232/", "http://127.0.0.1:5232/alice/"));
    assert!(!credentials_may_follow("http://127.0.0.1:5232/", "http://10.0.0.9/"));
    assert!(!credentials_may_follow("https://a.example.com/", "not a url"));
}

#[test]
fn discovery_does_not_follow_a_principal_down_to_plain_http() {
    let server = FakeServer::new(vec![(
        "PROPFIND",
        "https://example.com/dav/",
        207,
        principal_answer("http://example.com/dav/principals/ana/"),
    )]);
    let _ = discover(&server, "https://example.com/dav/");
    assert!(
        !server.seen.borrow().iter().any(|(_, url)| url.starts_with("http://")),
        "the password went over plain HTTP: {:?}",
        server.seen.borrow()
    );
}

#[test]
fn refused_credentials_while_fetching_are_said_so_too() {
    let server = FakeServer::new(vec![(
        "REPORT",
        "https://example.com/dav/ana/contacts/",
        401,
        String::new(),
    )]);
    assert!(fetch_book(&server, "https://example.com/dav/ana/contacts/")
        .unwrap_err()
        .to_string()
        .contains("refused"));
}
