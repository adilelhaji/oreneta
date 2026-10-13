use std::cell::RefCell;
use std::collections::HashMap;

use super::client::{DavRequest, HttpReply, Transport};
use super::write::{delete_existing, save_existing, save_new, Outcome};
use crate::contacts::person::{people_from_vcards, EmailAddress, Person};

const BOOK: &str = "https://dav.example/alice/contacts/";

/// A CardDAV server that keeps cards and honours If-Match / If-None-Match.
#[derive(Default)]
struct Server {
    cards: RefCell<HashMap<String, (String, u32)>>,
    send_etag_on_put: bool,
    seen: RefCell<Vec<(String, Vec<(String, String)>)>>,
}

impl Server {
    fn with(card_url: &str, card: &str) -> Self {
        let server = Server { send_etag_on_put: true, ..Default::default() };
        server.cards.borrow_mut().insert(card_url.into(), (card.into(), 1));
        server
    }
    fn etag(n: u32) -> String {
        format!("\"v{n}\"")
    }
    /// Somebody else edits the card on the server.
    fn touch(&self, url: &str) {
        let mut cards = self.cards.borrow_mut();
        let entry = cards.get_mut(url).unwrap();
        entry.0 = entry.0.replace("FN:Ana Prat", "FN:Ana Prat (phone)");
        entry.1 += 1;
    }
}

impl Transport for Server {
    fn send(&self, request: &DavRequest) -> anyhow::Result<HttpReply> {
        let headers: Vec<(String, String)> = request.headers.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        self.seen.borrow_mut().push((request.method.to_string(), headers.clone()));
        let header = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
        let mut cards = self.cards.borrow_mut();
        let current = cards.get(&request.url).cloned();
        let reply = |status: u16, body: String, etag: Option<String>| HttpReply { status, body, url: request.url.clone(), etag };
        Ok(match request.method {
            "GET" => match current {
                Some((card, n)) => reply(200, card, Some(Self::etag(n))),
                None => reply(404, String::new(), None),
            },
            "PUT" => {
                let allowed = match (header("If-Match"), header("If-None-Match"), &current) {
                    (Some(tag), _, Some((_, n))) => tag == Self::etag(*n),
                    (Some(_), _, None) => false,
                    (None, Some(_), existing) => existing.is_none(),
                    (None, None, _) => true,
                };
                if !allowed {
                    return Ok(reply(412, String::new(), None));
                }
                let n = current.map(|(_, n)| n + 1).unwrap_or(1);
                cards.insert(request.url.clone(), (request.body.clone().unwrap_or_default(), n));
                reply(201, String::new(), self.send_etag_on_put.then(|| Self::etag(n)))
            }
            "DELETE" => match (current, header("If-Match")) {
                (None, _) => reply(404, String::new(), None),
                (Some((_, n)), Some(tag)) if tag == Self::etag(n) => {
                    cards.remove(&request.url);
                    reply(204, String::new(), None)
                }
                _ => reply(412, String::new(), None),
            },
            _ => reply(405, String::new(), None),
        })
    }
}

const ANA: &str = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:ana\r\nFN:Ana Prat\r\nN:Prat;Ana;;;\r\nEMAIL:ana@hospital.cat\r\nBDAY:1985-04-02\r\nEND:VCARD\r\n";
const ANA_URL: &str = "https://dav.example/alice/contacts/ana.vcf";

fn ana_edited() -> Person {
    let mut person = people_from_vcards(ANA.as_bytes()).remove(0);
    person.note = "call first".into();
    person
}

#[test]
fn an_edit_from_the_current_version_is_written_with_if_match_and_keeps_unknown_fields() {
    let server = Server::with(ANA_URL, ANA);
    let outcome = save_existing(&server, BOOK, ANA_URL, "\"v1\"", "ana", &ana_edited(), 0).unwrap();
    let Outcome::Saved { version, person, .. } = outcome else { panic!("{outcome:?}") };
    assert_eq!(version, "\"v2\"");
    assert_eq!(person.note, "call first");
    let stored = server.cards.borrow()[ANA_URL].0.clone();
    assert!(stored.contains("BDAY:1985-04-02"), "a field this app does not show is kept");
    let put = server.seen.borrow().iter().find(|(m, _)| m == "PUT").cloned().unwrap();
    assert!(put.1.contains(&("If-Match".into(), "\"v1\"".into())));
}

#[test]
fn an_edit_from_an_older_version_writes_nothing_and_returns_the_servers_copy() {
    let server = Server::with(ANA_URL, ANA);
    server.touch(ANA_URL);
    let outcome = save_existing(&server, BOOK, ANA_URL, "\"v1\"", "ana", &ana_edited(), 0).unwrap();
    match outcome {
        Outcome::Conflict { current: Some((person, version)) } => {
            assert_eq!(person.name, "Ana Prat (phone)");
            assert_eq!(version, "\"v2\"");
        }
        other => panic!("{other:?}"),
    }
    assert!(!server.seen.borrow().iter().any(|(m, _)| m == "PUT"), "nothing written");
    assert!(!server.cards.borrow()[ANA_URL].0.contains("call first"));
}

#[test]
fn keeping_mine_after_a_conflict_writes_over_the_version_now_shown() {
    let server = Server::with(ANA_URL, ANA);
    server.touch(ANA_URL);
    let outcome = save_existing(&server, BOOK, ANA_URL, "\"v2\"", "ana", &ana_edited(), 0).unwrap();
    assert!(matches!(outcome, Outcome::Saved { .. }), "{outcome:?}");
}

#[test]
fn a_card_deleted_on_the_server_is_a_conflict_with_nothing_current() {
    let server = Server::default();
    let outcome = save_existing(&server, BOOK, ANA_URL, "\"v1\"", "ana", &ana_edited(), 0).unwrap();
    assert_eq!(outcome, Outcome::Conflict { current: None });
}

#[test]
fn a_new_contact_is_put_only_where_nothing_is_and_its_version_is_learnt() {
    let server = Server::default(); // sends no ETag on PUT: asked again
    let person = Person {
        name: "Cy Dao".into(),
        emails: vec![EmailAddress { addr: "cy@example.com".into(), label: String::new() }],
        ..Default::default()
    };
    let Outcome::Saved { href, version, person: stored } = save_new(&server, BOOK, &person).unwrap() else { panic!() };
    assert!(href.starts_with(BOOK) && href.ends_with(".vcf"));
    assert_eq!(version, "\"v1\"", "read back when the PUT gave none");
    assert_eq!(stored.name, "Cy Dao");
    let put = server.seen.borrow().iter().find(|(m, _)| m == "PUT").cloned().unwrap();
    assert!(put.1.contains(&("If-None-Match".into(), "*".into())));
}

#[test]
fn deleting_from_an_older_version_deletes_nothing() {
    let server = Server::with(ANA_URL, ANA);
    server.touch(ANA_URL);
    assert!(matches!(delete_existing(&server, BOOK, ANA_URL, "\"v1\"").unwrap(), Outcome::Conflict { current: Some(_) }));
    assert!(server.cards.borrow().contains_key(ANA_URL));
    assert_eq!(delete_existing(&server, BOOK, ANA_URL, "\"v2\"").unwrap(), Outcome::Deleted);
    assert!(server.cards.borrow().is_empty());
}

#[test]
fn a_card_on_another_server_is_never_written_to() {
    let server = Server::with("https://evil.example/ana.vcf", ANA);
    assert!(save_existing(&server, BOOK, "https://evil.example/ana.vcf", "\"v1\"", "ana", &ana_edited(), 0).is_err());
    assert!(server.seen.borrow().is_empty(), "no request at all");
}

#[test]
fn a_contact_whose_version_was_never_known_is_not_written_over() {
    let server = Server::with(ANA_URL, ANA);
    let outcome = save_existing(&server, BOOK, ANA_URL, "", "ana", &ana_edited(), 0).unwrap();
    assert!(matches!(outcome, Outcome::Conflict { current: Some(_) }));
}

// ---- Groups (ADR-0052) ------------------------------------------------------

use super::write::{delete_group, save_group_existing, save_group_new, GroupOutcome};
use crate::contacts::groups::GroupStyle;

const GROUP: &str = "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Family;;;;\r\nFN:Family\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nUID:fam\r\nX-ADDRESSBOOKSERVER-MEMBER:urn:uuid:ana\r\nX-ADDRESSBOOKSERVER-MEMBER:urn:uuid:not-synced\r\nX-SHARED-BY:somebody\r\nEND:VCARD\r\n";
const GROUP_URL: &str = "https://dav.example/alice/contacts/fam.vcf";

#[test]
fn a_group_edit_from_the_current_version_changes_only_its_members() {
    let server = Server::with(GROUP_URL, GROUP);
    let outcome =
        save_group_existing(&server, BOOK, GROUP_URL, "\"v1\"", "Family", &["cy".into()], &["ana".into()], 0).unwrap();
    let GroupOutcome::Saved { version, group, .. } = outcome else { panic!("{outcome:?}") };
    assert_eq!(version, "\"v2\"");
    assert_eq!(group.members, vec!["not-synced", "cy"]);
    let stored = server.cards.borrow()[GROUP_URL].0.clone();
    assert!(stored.contains("X-SHARED-BY:somebody\r\n"), "{stored}");
    assert!(stored.contains("X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:cy\r\n"));
    let put = server.seen.borrow().iter().find(|(m, _)| m == "PUT").cloned().unwrap();
    assert!(put.1.contains(&("If-Match".into(), "\"v1\"".into())));
}

#[test]
fn a_group_edit_from_an_older_version_writes_nothing() {
    let server = Server::with(GROUP_URL, GROUP);
    {
        let mut cards = server.cards.borrow_mut();
        let entry = cards.get_mut(GROUP_URL).unwrap();
        entry.0 = entry.0.replace("FN:Family", "FN:Family (renamed on the phone)");
        entry.1 += 1;
    }
    let outcome = save_group_existing(&server, BOOK, GROUP_URL, "\"v1\"", "Family", &["cy".into()], &[], 0).unwrap();
    match outcome {
        GroupOutcome::Conflict { current: Some((group, version)) } => {
            assert_eq!(group.name, "Family (renamed on the phone)");
            assert_eq!(version, "\"v2\"");
        }
        other => panic!("{other:?}"),
    }
    assert!(!server.seen.borrow().iter().any(|(m, _)| m == "PUT"), "nothing written");
}

#[test]
fn a_new_group_is_put_where_nothing_is_in_the_books_style() {
    let server = Server::default();
    let outcome = save_group_new(&server, BOOK, "Climbing", &["ana".into()], GroupStyle::Vcard4).unwrap();
    let GroupOutcome::Saved { href, version, group } = outcome else { panic!("{outcome:?}") };
    assert!(href.starts_with(BOOK) && href.ends_with(".vcf"));
    assert_eq!(version, "\"v1\"");
    assert_eq!((group.name.as_str(), group.style), ("Climbing", GroupStyle::Vcard4));
    assert!(server.cards.borrow()[&href].0.contains("KIND:group\r\n"));
    let put = server.seen.borrow().iter().find(|(m, _)| m == "PUT").cloned().unwrap();
    assert!(put.1.contains(&("If-None-Match".into(), "*".into())));
}

#[test]
fn a_group_is_deleted_only_from_the_version_read() {
    let server = Server::with(GROUP_URL, GROUP);
    assert!(matches!(delete_group(&server, BOOK, GROUP_URL, "\"v0\"").unwrap(), GroupOutcome::Conflict { current: Some(_) }));
    assert_eq!(delete_group(&server, BOOK, GROUP_URL, "\"v1\"").unwrap(), GroupOutcome::Deleted);
    assert!(server.cards.borrow().is_empty());
}
