use std::cell::RefCell;
use std::collections::BTreeMap;

use super::*;
use crate::calendar::{Frequency, Recurrence};
use crate::carddav::client::HttpReply;

const ROOT: &str = "https://dav.example";
const CAL: &str = "https://dav.example/ana/work/";

/// A CalDAV server: discovery answers, objects with versions, If-Match and
/// If-None-Match honoured.
#[derive(Default)]
struct Server {
    objects: RefCell<BTreeMap<String, (String, u32)>>,
    /// An object listed in the window that the server fails to send.
    broken: Option<String>,
    log: RefCell<Vec<(String, String)>>,
}

impl Server {
    fn etag(n: u32) -> String {
        format!("\"e{n}\"")
    }
    fn touch(&self, url: &str, from: &str, to: &str) {
        let mut objects = self.objects.borrow_mut();
        let entry = objects.get_mut(url).unwrap();
        entry.0 = entry.0.replace(from, to);
        entry.1 += 1;
    }
}

fn multistatus(responses: &[String]) -> String {
    format!(r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">{}</d:multistatus>"#, responses.join(""))
}

impl Transport for Server {
    fn send(&self, request: &DavRequest) -> Result<HttpReply> {
        self.log.borrow_mut().push((request.method.to_string(), request.url.clone()));
        let header = |name: &str| request.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
        let reply = |status: u16, body: String, etag: Option<String>| Ok(HttpReply { status, body, url: request.url.clone(), etag });
        let body = request.body.clone().unwrap_or_default();
        match (request.method, request.url.as_str()) {
            ("PROPFIND", "https://dav.example/.well-known/caldav") => reply(207, multistatus(&[
                r#"<d:response><d:href>/.well-known/caldav</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/ana/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#.into(),
            ]), None),
            ("PROPFIND", "https://dav.example/ana/") if body.contains("calendar-home-set") => reply(207, multistatus(&[
                r#"<d:response><d:href>/ana/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/ana/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#.into(),
            ]), None),
            ("PROPFIND", "https://dav.example/ana/") => reply(207, multistatus(&[
                r#"<d:response><d:href>/ana/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#.into(),
                r##"<d:response><d:href>/ana/work/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Work</d:displayname><a:calendar-color>#33AA55FF</a:calendar-color><d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write-content/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"##.into(),
                r#"<d:response><d:href>/ana/holidays/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#.into(),
                r#"<d:response><d:href>/ana/contacts/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><card:addressbook xmlns:card="urn:ietf:params:xml:ns:carddav"/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#.into(),
            ]), None),
            ("REPORT", CAL) => {
                let mut responses: Vec<String> = self.objects.borrow().iter().map(|(url, (ics, n))| {
                    format!(r#"<d:response><d:href>{}</d:href><d:propstat><d:prop><d:getetag>{}</d:getetag><c:calendar-data>{}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#,
                        url.trim_start_matches(ROOT), Server::etag(*n).replace('"', "&quot;"), ics.replace('&', "&amp;").replace('<', "&lt;"))
                }).collect();
                if let Some(broken) = &self.broken {
                    responses.push(format!(r#"<d:response><d:href>{broken}</d:href><d:status>HTTP/1.1 500 Server Error</d:status></d:response>"#));
                }
                reply(207, multistatus(&responses), None)
            }
            ("GET", url) => match self.objects.borrow().get(url) {
                Some((ics, n)) => reply(200, ics.clone(), Some(Server::etag(*n))),
                None => reply(404, String::new(), None),
            },
            ("PUT", url) => {
                let mut objects = self.objects.borrow_mut();
                let current = objects.get(url).map(|(_, n)| *n);
                let allowed = match (header("If-Match"), header("If-None-Match"), current) {
                    (Some(tag), _, Some(n)) => tag == Server::etag(n),
                    (Some(_), _, None) => false,
                    (None, Some(_), existing) => existing.is_none(),
                    (None, None, _) => true,
                };
                if !allowed {
                    return reply(412, String::new(), None);
                }
                let n = current.map(|n| n + 1).unwrap_or(1);
                objects.insert(url.to_string(), (body, n));
                reply(201, String::new(), Some(Server::etag(n)))
            }
            ("DELETE", url) => {
                let mut objects = self.objects.borrow_mut();
                match (objects.get(url).map(|(_, n)| *n), header("If-Match")) {
                    (None, _) => reply(404, String::new(), None),
                    (Some(n), Some(tag)) if tag == Server::etag(n) => {
                        objects.remove(url);
                        reply(204, String::new(), None)
                    }
                    _ => reply(412, String::new(), None),
                }
            }
            _ => reply(405, String::new(), None),
        }
    }
}

fn at(text: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(text).unwrap().timestamp()
}

const MARCH: (i64, i64) = (1_772_323_200, 1_775_001_600); // 2026-03-01 .. 2026-04-01

#[test]
fn calendars_are_found_through_the_principal_with_their_rights_and_colours() {
    let server = Server::default();
    let found = discover(&server, "ana@dav.example").unwrap();
    assert_eq!(found.len(), 2, "the address book is not a calendar");
    assert_eq!(found[0], RemoteCalendar { url: CAL.into(), name: "Work".into(), color: Some("#33AA55".into()), writable: Some(true) });
    assert_eq!(found[1].name, "holidays");
    assert_eq!(found[1].writable, Some(false));
}

fn new_event(subject: &str) -> Event {
    Event { subject: subject.into(), start: at("2026-03-10T09:00:00Z"), end: at("2026-03-10T10:00:00Z"), ..Default::default() }
}

#[test]
fn an_event_is_created_read_back_with_its_version_and_edited_only_from_it() {
    let server = Server::default();
    let (uid, change) = create(&server, CAL, &new_event("Plan"), 1).unwrap();
    let Change::Saved { href, .. } = change else { panic!("saved") };
    assert!(href.starts_with(CAL) && href.ends_with(".ics"));

    let objects = fetch_window(&server, CAL, MARCH.0, MARCH.1).unwrap();
    let (events, located, skipped) = events_from(&objects, CAL, MARCH.0, MARCH.1);
    assert_eq!((events.len(), skipped), (1, 0));
    assert_eq!(located[0].uid, uid);
    assert_eq!(events[0].change_key.as_deref(), Some("\"e1\""));

    // Someone else changes it on their phone first.
    server.touch(&href, "SUMMARY:Plan", "SUMMARY:Plan (phone)");
    let mut mine = events[0].clone();
    mine.subject = "Plan (mine)".into();
    assert_eq!(update(&server, CAL, &href, "\"e1\"", &mine, false, 2).unwrap(), Change::Conflict);
    assert!(server.objects.borrow()[&href].0.contains("SUMMARY:Plan (phone)"), "nothing was written over it");

    // From the version now on the server, the edit goes through.
    let Change::Saved { etag, .. } = update(&server, CAL, &href, "\"e2\"", &mine, false, 2).unwrap() else { panic!() };
    assert_eq!(etag.as_deref(), Some("\"e3\""));
    assert!(server.objects.borrow()[&href].0.contains("SUMMARY:Plan (mine)"));
}

#[test]
fn an_occurrence_is_changed_or_removed_without_touching_the_rest_of_the_series() {
    let server = Server::default();
    let mut weekly = new_event("Stand-up");
    weekly.recurrence = Some(Recurrence { freq: Frequency::Weekly, interval: 1, count: Some(3), ..Default::default() });
    let (_, Change::Saved { href, .. }) = create(&server, CAL, &weekly, 1).unwrap() else { panic!() };
    let read = |server: &Server| {
        let objects = fetch_window(server, CAL, MARCH.0, MARCH.1).unwrap();
        let mut events = events_from(&objects, CAL, MARCH.0, MARCH.1).0;
        events.sort_by_key(|e| e.start);
        events
    };
    let events = read(&server);
    assert_eq!(events.len(), 3);
    let mut second = events[1].clone();
    second.subject = "Stand-up (moved)".into();
    second.start += 1800;
    second.end += 1800;
    let version = second.change_key.clone().unwrap();
    assert!(matches!(update(&server, CAL, &href, &version, &second, false, 2).unwrap(), Change::Saved { .. }));
    let events = read(&server);
    assert_eq!(events.iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), vec!["Stand-up", "Stand-up (moved)", "Stand-up"]);

    let third = events[2].clone();
    let version = third.change_key.clone().unwrap();
    assert!(matches!(delete(&server, CAL, &href, &version, &third.id, false, true).unwrap(), Change::Saved { .. }));
    assert_eq!(read(&server).len(), 2);

    let version = read(&server)[0].change_key.clone().unwrap();
    assert_eq!(delete(&server, CAL, &href, "\"stale\"", &third.id, false, false).unwrap(), Change::Conflict);
    assert!(matches!(delete(&server, CAL, &href, &version, &third.id, false, false).unwrap(), Change::Saved { .. }));
    assert!(read(&server).is_empty());
}

#[test]
fn a_window_with_an_unreadable_event_is_not_taken_as_the_whole_calendar() {
    let server = Server { broken: Some("/ana/work/lost.ics".into()), ..Default::default() };
    create(&server, CAL, &new_event("Kept"), 1).unwrap();
    let error = fetch_window(&server, CAL, MARCH.0, MARCH.1).unwrap_err().to_string();
    assert!(error.contains("could not be read"), "{error}");
}

#[test]
fn nothing_is_sent_to_another_server() {
    let server = Server::default();
    let foreign = "https://elsewhere.example/ana/work/x.ics";
    assert!(get_object(&server, CAL, foreign).is_err());
    assert!(put_object(&server, CAL, foreign, "x", None).is_err());
    assert!(delete_object(&server, CAL, foreign, "\"e1\"").is_err());
    assert!(server.log.borrow().is_empty());
}
