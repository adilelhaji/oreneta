use std::cell::RefCell;
use std::collections::BTreeMap;

use super::*;
use crate::carddav::client::{DavRequest, HttpReply};
use crate::store::task_lists::{self, TaskFields};

const ROOT: &str = "https://dav.example";
const WORK: &str = "https://dav.example/ana/work/";
const HOME: &str = "https://dav.example/ana/home/";

/// A CalDAV server holding tasks: objects with versions, If-Match and
/// If-None-Match honoured, and every request logged with its condition.
#[derive(Default)]
struct Server {
    objects: RefCell<BTreeMap<String, (String, u32)>>,
    /// Listed in a collection's answer, but not sent.
    broken: RefCell<Option<String>>,
    /// Listed with an address on another server.
    foreign: RefCell<Option<String>>,
    log: RefCell<Vec<(String, String, String)>>,
}

impl Server {
    fn etag(n: u32) -> String {
        format!("\"e{n}\"")
    }
    fn seed(&self, href: &str, ics: &str) {
        self.objects.borrow_mut().insert(href.to_string(), (ics.to_string(), 1));
    }
    fn touch(&self, href: &str, from: &str, to: &str) {
        let mut objects = self.objects.borrow_mut();
        let entry = objects.get_mut(href).unwrap();
        assert!(entry.0.contains(from), "{from} not in {}", entry.0);
        entry.0 = entry.0.replace(from, to);
        entry.1 += 1;
    }
    fn body(&self, href: &str) -> String {
        self.objects.borrow()[href].0.clone()
    }
    fn writes(&self) -> Vec<(String, String, String)> {
        self.log.borrow().iter().filter(|(method, ..)| matches!(method.as_str(), "PUT" | "DELETE")).cloned().collect()
    }
}

fn multistatus(responses: &[String]) -> String {
    format!(
        r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">{}</d:multistatus>"#,
        responses.join("")
    )
}

impl Transport for Server {
    fn send(&self, request: &DavRequest) -> Result<HttpReply> {
        let header =
            |name: &str| request.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
        let condition = header("If-Match")
            .map(|tag| format!("If-Match {tag}"))
            .or_else(|| header("If-None-Match").map(|tag| format!("If-None-Match {tag}")))
            .unwrap_or_default();
        self.log.borrow_mut().push((request.method.to_string(), request.url.clone(), condition));
        assert!(request.url.starts_with(ROOT), "a request left the server: {}", request.url);
        let reply =
            |status: u16, body: String, etag: Option<String>| Ok(HttpReply { status, body, url: request.url.clone(), etag });
        let body = request.body.clone().unwrap_or_default();
        match (request.method, request.url.as_str()) {
            ("REPORT", collection) => {
                assert!(body.contains(r#"<c:comp-filter name="VTODO"/>"#), "{body}");
                let mut responses: Vec<String> = self
                    .objects
                    .borrow()
                    .iter()
                    .filter(|(url, _)| url.starts_with(collection))
                    .map(|(url, (ics, n))| {
                        format!(
                            r#"<d:response><d:href>{}</d:href><d:propstat><d:prop><d:getetag>{}</d:getetag><c:calendar-data>{}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#,
                            url.trim_start_matches(ROOT),
                            Server::etag(*n).replace('"', "&quot;"),
                            ics.replace('&', "&amp;").replace('<', "&lt;")
                        )
                    })
                    .collect();
                if let Some(broken) = self.broken.borrow().as_ref() {
                    responses.push(format!(
                        r#"<d:response><d:href>{broken}</d:href><d:status>HTTP/1.1 500 Server Error</d:status></d:response>"#
                    ));
                }
                if let Some(foreign) = self.foreign.borrow().as_ref() {
                    responses.push(format!(
                        r#"<d:response><d:href>{foreign}</d:href><d:propstat><d:prop><d:getetag>"x"</d:getetag><c:calendar-data>{}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#,
                        todo("evil", "Elsewhere")
                    ));
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

fn todo(uid: &str, summary: &str) -> String {
    format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Phone//EN\r\nBEGIN:VTODO\r\nUID:{uid}\r\nDTSTAMP:20260101T000000Z\r\n\
SUMMARY:{summary}\r\nX-PHONE-COLOR:red\r\nCATEGORIES:errands\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    )
}

fn store() -> Mutex<Connection> {
    Mutex::new(crate::store::open_in_memory_for_test().unwrap())
}

fn bind(db: &Mutex<Connection>, url: &str) -> String {
    add_list(&db.lock().unwrap(), "", url, "ana@dav.example", "ana", 1).unwrap()
}

/// The visible tasks of a list, by title.
fn titles(db: &Mutex<Connection>, list: &str) -> Vec<String> {
    let mut titles: Vec<String> = crate::store::list_tasks(&db.lock().unwrap(), true)
        .unwrap()
        .into_iter()
        .filter(|task| task.list_id == list)
        .map(|task| task.title)
        .collect();
    titles.sort();
    titles
}

fn task_id(db: &Mutex<Connection>, title: &str) -> i64 {
    db.lock().unwrap().query_row("SELECT id FROM tasks WHERE title = ?1", params![title], |row| row.get(0)).unwrap()
}

fn state(db: &Mutex<Connection>, id: i64) -> (String, String, String) {
    db.lock()
        .unwrap()
        .query_row("SELECT pending, conflict, remote_etag FROM tasks WHERE id = ?1", params![id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap()
}

fn edit(db: &Mutex<Connection>, id: i64, title: &str) {
    let conn = db.lock().unwrap();
    let (mut fields, revision, _) = task_lists::get(&conn, id).unwrap().unwrap();
    fields.title = title.into();
    task_lists::update(&conn, id, revision, &fields).unwrap();
}

const PLAN: &str = "https://dav.example/ana/work/plan.ics";
const MILK: &str = "https://dav.example/ana/work/milk.ics";

/// A bound list, read once, with two tasks from another client.
fn imported() -> (Server, Mutex<Connection>, String) {
    let server = Server::default();
    server.seed(PLAN, &todo("plan@phone", "Plan the week"));
    server.seed(MILK, &todo("milk@phone", "Buy milk"));
    let db = store();
    let list = bind(&db, WORK);
    let report = sync(&db, &server, &list, 10).unwrap();
    assert_eq!((report.pulled, report.pushed), (2, 0));
    (server, db, list)
}

#[test]
fn the_first_sync_imports_the_collections_tasks() {
    let (server, db, list) = imported();
    assert_eq!(titles(&db, &list), vec!["Buy milk", "Plan the week"]);
    let lists = task_lists::lists(&db.lock().unwrap()).unwrap();
    let bound = lists.iter().find(|l| l.id == list).unwrap();
    assert_eq!((bound.name.as_str(), bound.remote_url.as_str(), bound.synced_at), ("work", WORK, Some(10)));
    assert_eq!((bound.open, bound.last_error.as_str()), (2, ""));
    assert!(server.writes().is_empty(), "reading writes nothing");
    // A second read with nothing changed changes nothing.
    assert_eq!(sync(&db, &server, &list, 11).unwrap(), Report::default());
}

#[test]
fn a_local_edit_is_sent_against_the_version_read_and_keeps_the_other_clients_lines() {
    let (server, db, list) = imported();
    let id = task_id(&db, "Plan the week");
    edit(&db, id, "Plan the month");
    assert_eq!(state(&db, id).0, "put");
    let report = sync(&db, &server, &list, 20).unwrap();
    assert_eq!(report.pushed, 1);
    assert_eq!(server.writes(), vec![("PUT".to_string(), PLAN.to_string(), "If-Match \"e1\"".to_string())]);
    let body = server.body(PLAN);
    for kept in ["SUMMARY:Plan the month", "X-PHONE-COLOR:red", "CATEGORIES:errands", "UID:plan@phone", "SEQUENCE:1"] {
        assert!(body.contains(kept), "{kept} in {body}");
    }
    assert_eq!(state(&db, id), (String::new(), String::new(), "\"e2\"".to_string()));
}

#[test]
fn completing_and_deleting_here_are_sent_too() {
    let (server, db, list) = imported();
    let id = task_id(&db, "Buy milk");
    crate::store::set_task_completed(&db.lock().unwrap(), id, true, 30).unwrap();
    sync(&db, &server, &list, 31).unwrap();
    assert!(server.body(MILK).contains("STATUS:COMPLETED"));

    // Deleted here: hidden at once, kept until the server deletes it too.
    let plan = task_id(&db, "Plan the week");
    crate::store::delete_task(&db.lock().unwrap(), plan).unwrap();
    assert_eq!(titles(&db, &list), vec!["Buy milk"]);
    assert_eq!(task_lists::lists(&db.lock().unwrap()).unwrap().iter().find(|l| l.id == list).unwrap().open, 0);
    assert!(task_lists::get(&db.lock().unwrap(), plan).unwrap().is_none());
    assert_eq!(state(&db, plan).0, "delete");
    sync(&db, &server, &list, 32).unwrap();
    assert!(server.writes().contains(&("DELETE".to_string(), PLAN.to_string(), "If-Match \"e1\"".to_string())));
    assert!(!server.objects.borrow().contains_key(PLAN));
    let left: i64 = db.lock().unwrap().query_row("SELECT COUNT(*) FROM tasks WHERE id = ?1", params![plan], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
}

#[test]
fn a_new_task_is_created_only_where_nothing_is() {
    let (server, db, list) = imported();
    let fields = TaskFields { list_id: list.clone(), title: "Call the bank".into(), priority: 2, ..Default::default() };
    let id = task_lists::create(&db.lock().unwrap(), &fields, 40).unwrap();
    assert_eq!(state(&db, id).0, "put");
    sync(&db, &server, &list, 41).unwrap();
    let writes = server.writes();
    assert_eq!(writes.len(), 1);
    let (method, href, condition) = &writes[0];
    assert_eq!((method.as_str(), condition.as_str()), ("PUT", "If-None-Match *"));
    assert!(href.starts_with(WORK) && href.ends_with(".ics"), "{href}");
    let body = server.body(href);
    assert!(body.contains("@oreneta") && body.contains("SUMMARY:Call the bank") && body.contains("PRIORITY:1"));
    assert_eq!(state(&db, id), (String::new(), String::new(), "\"e1\"".to_string()));
    assert_eq!(titles(&db, &list).len(), 3, "read back once, not twice");
}

#[test]
fn a_change_on_the_server_is_taken_when_nothing_changed_here() {
    let (server, db, list) = imported();
    let id = task_id(&db, "Buy milk");
    let before = task_lists::get(&db.lock().unwrap(), id).unwrap().unwrap().1;
    server.touch(MILK, "SUMMARY:Buy milk", "SUMMARY:Buy oat milk\r\nPRIORITY:1");
    assert_eq!(sync(&db, &server, &list, 50).unwrap().pulled, 1);
    let (fields, revision, _) = task_lists::get(&db.lock().unwrap(), id).unwrap().unwrap();
    assert_eq!((fields.title.as_str(), fields.priority), ("Buy oat milk", 2));
    assert_eq!(revision, before + 1, "an editor open on the old copy sees a conflict");
    assert!(server.writes().is_empty());
}

#[test]
fn a_task_changed_on_both_sides_waits_and_nothing_is_overwritten() {
    let (server, db, list) = imported();
    let id = task_id(&db, "Buy milk");
    edit(&db, id, "Buy milk and bread");
    server.touch(MILK, "SUMMARY:Buy milk", "SUMMARY:Buy milk (phone)");
    let report = sync(&db, &server, &list, 60).unwrap();
    assert_eq!((report.conflicts, report.stopped), (1, true));
    assert!(server.body(MILK).contains("SUMMARY:Buy milk (phone)"), "the server's copy is untouched");
    assert_eq!(task_lists::get(&db.lock().unwrap(), id).unwrap().unwrap().0.title, "Buy milk and bread");
    assert_eq!(state(&db, id).1, "changed");
    assert_eq!(task_lists::lists(&db.lock().unwrap()).unwrap().iter().find(|l| l.id == list).unwrap().conflicts, 1);
    // Syncing again sends nothing and takes nothing.
    sync(&db, &server, &list, 61).unwrap();
    assert_eq!(server.writes().len(), 1, "only the refused write");
    assert_eq!(task_lists::get(&db.lock().unwrap(), id).unwrap().unwrap().0.title, "Buy milk and bread");
}

#[test]
fn a_refusal_stops_that_lists_queue_and_no_other() {
    let server = Server::default();
    server.seed(PLAN, &todo("plan@phone", "Plan the week"));
    server.seed(MILK, &todo("milk@phone", "Buy milk"));
    let errand = "https://dav.example/ana/home/errand.ics";
    server.seed(errand, &todo("errand@phone", "Post office"));
    let db = store();
    let work = bind(&db, WORK);
    let home = bind(&db, HOME);
    sync(&db, &server, &work, 1).unwrap();
    sync(&db, &server, &home, 1).unwrap();

    let milk = task_id(&db, "Buy milk");
    let plan = task_id(&db, "Plan the week");
    edit(&db, milk, "Buy milk today");
    edit(&db, plan, "Plan the month");
    edit(&db, task_id(&db, "Post office"), "Post office, parcel");
    server.touch(MILK, "SUMMARY:Buy milk", "SUMMARY:Buy milk (phone)");

    let report = sync(&db, &server, &work, 2).unwrap();
    assert!(report.stopped);
    assert_eq!(state(&db, milk).1, "changed");
    assert_eq!(state(&db, plan).0, "put", "the next change in that list waits");
    assert!(!server.writes().iter().any(|(_, href, _)| href == PLAN));
    assert!(server.body(PLAN).contains("SUMMARY:Plan the week"));

    assert_eq!(sync(&db, &server, &home, 2).unwrap().pushed, 1, "another list goes on");
    assert!(server.body(errand).contains("Post office\\, parcel"));

    // Still stopped while the conflict stands.
    sync(&db, &server, &work, 3).unwrap();
    assert_eq!(state(&db, plan).0, "put");
}

#[test]
fn a_task_deleted_on_the_server_goes_unless_it_was_changed_here() {
    let (server, db, list) = imported();
    let plan = task_id(&db, "Plan the week");
    edit(&db, plan, "Plan the month");
    // The edit is refused by a server that deleted it meanwhile.
    server.objects.borrow_mut().remove(PLAN);
    server.objects.borrow_mut().remove(MILK);
    let report = sync(&db, &server, &list, 70).unwrap();
    assert_eq!(report.removed, 1, "the unchanged one is removed here too");
    assert_eq!(titles(&db, &list), vec!["Plan the month"]);
    assert_eq!(state(&db, plan).1, "deleted");
    assert!(server.objects.borrow().is_empty(), "nothing is created again without asking");
}

#[test]
fn a_task_that_does_not_come_back_fails_the_whole_read() {
    let (server, db, list) = imported();
    server.touch(MILK, "SUMMARY:Buy milk", "SUMMARY:Buy oat milk");
    *server.broken.borrow_mut() = Some("/ana/work/lost.ics".into());
    let error = sync(&db, &server, &list, 80).unwrap_err().to_string();
    assert!(error.contains("could not be read"), "{error}");
    assert_eq!(titles(&db, &list), vec!["Buy milk", "Plan the week"], "nothing changed here");
    let bound = task_lists::lists(&db.lock().unwrap()).unwrap().into_iter().find(|l| l.id == list).unwrap();
    assert!(bound.last_error.contains("could not be read") && bound.synced_at == Some(10));

    // Nor does one that comes back but is not a task.
    *server.broken.borrow_mut() = None;
    server.seed("https://dav.example/ana/work/odd.ics", "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:x\r\n");
    assert!(sync(&db, &server, &list, 81).is_err());
    assert_eq!(titles(&db, &list), vec!["Buy milk", "Plan the week"]);

    server.objects.borrow_mut().remove("https://dav.example/ana/work/odd.ics");
    sync(&db, &server, &list, 82).unwrap();
    assert_eq!(titles(&db, &list), vec!["Buy oat milk", "Plan the week"]);
    let bound = task_lists::lists(&db.lock().unwrap()).unwrap().into_iter().find(|l| l.id == list).unwrap();
    assert_eq!((bound.last_error.as_str(), bound.synced_at), ("", Some(82)));
}

#[test]
fn the_password_never_goes_to_another_server() {
    let (server, db, list) = imported();
    // An answer naming an object elsewhere fails the read.
    *server.foreign.borrow_mut() = Some("https://evil.example/ana/work/x.ics".into());
    assert!(sync(&db, &server, &list, 90).is_err());
    *server.foreign.borrow_mut() = None;
    // A task whose stored address points elsewhere is not sent there.
    let id = task_id(&db, "Buy milk");
    db.lock()
        .unwrap()
        .execute("UPDATE tasks SET remote_href = 'https://evil.example/milk.ics' WHERE id = ?1", params![id])
        .unwrap();
    edit(&db, id, "Buy milk now");
    assert!(sync(&db, &server, &list, 91).is_err());
    assert!(server.log.borrow().iter().all(|(_, url, _)| url.starts_with(ROOT)));
    // Nor is a list bound where the password must not follow.
    let conn = db.lock().unwrap();
    assert!(add_list(&conn, "", "http://dav.example/ana/other/", "https://dav.example", "ana", 1).is_err());
    assert!(add_list(&conn, "", WORK, "ana@dav.example", "ana", 1).is_err(), "already bound");
}

#[test]
fn a_conflict_is_settled_with_the_servers_copy() {
    let (server, db, list) = imported();
    let id = task_id(&db, "Buy milk");
    edit(&db, id, "Buy milk and bread");
    server.touch(MILK, "SUMMARY:Buy milk", "SUMMARY:Buy milk (phone)");
    sync(&db, &server, &list, 100).unwrap();
    assert_eq!(resolve_conflict(&db, &server, id, Keep::Server, 101).unwrap(), list);
    assert_eq!(task_lists::get(&db.lock().unwrap(), id).unwrap().unwrap().0.title, "Buy milk (phone)");
    assert_eq!(state(&db, id), (String::new(), String::new(), "\"e2\"".to_string()));
    let report = sync(&db, &server, &list, 102).unwrap();
    assert_eq!((report.pushed, report.conflicts), (0, 0));
    assert!(resolve_conflict(&db, &server, id, Keep::Server, 103).is_err(), "nothing left to settle");
}

#[test]
fn a_conflict_is_settled_with_mine_over_the_servers_version() {
    let (server, db, list) = imported();
    let id = task_id(&db, "Buy milk");
    edit(&db, id, "Buy milk and bread");
    server.touch(MILK, "X-PHONE-COLOR:red", "X-PHONE-COLOR:blue");
    sync(&db, &server, &list, 110).unwrap();
    resolve_conflict(&db, &server, id, Keep::Mine, 111).unwrap();
    assert_eq!(state(&db, id).1, "");
    sync(&db, &server, &list, 112).unwrap();
    let body = server.body(MILK);
    assert!(body.contains("SUMMARY:Buy milk and bread"));
    assert!(body.contains("X-PHONE-COLOR:blue"), "what the other client changed is kept");
    assert!(server.writes().last().unwrap().2 == "If-Match \"e2\"");
    assert_eq!(state(&db, id), (String::new(), String::new(), "\"e3\"".to_string()));
}

#[test]
fn mine_creates_again_a_task_deleted_on_the_server() {
    let (server, db, list) = imported();
    let id = task_id(&db, "Plan the week");
    edit(&db, id, "Plan the month");
    server.objects.borrow_mut().remove(PLAN);
    sync(&db, &server, &list, 120).unwrap();
    assert_eq!(state(&db, id).1, "deleted");
    resolve_conflict(&db, &server, id, Keep::Mine, 121).unwrap();
    sync(&db, &server, &list, 122).unwrap();
    assert!(server.body(PLAN).contains("SUMMARY:Plan the month") && server.body(PLAN).contains("UID:plan@phone"));
    assert_eq!(server.writes().last().unwrap().2, "If-None-Match *");

    // And "the server's" removes it here.
    let milk = task_id(&db, "Buy milk");
    edit(&db, milk, "Buy milk now");
    server.objects.borrow_mut().remove(MILK);
    sync(&db, &server, &list, 123).unwrap();
    resolve_conflict(&db, &server, milk, Keep::Server, 124).unwrap();
    assert_eq!(titles(&db, &list), vec!["Plan the month"]);
}

#[test]
fn deleting_a_bound_list_touches_nothing_on_the_server() {
    let (server, db, list) = imported();
    let before = server.log.borrow().len();
    task_lists::delete_list(&db.lock().unwrap(), &list).unwrap();
    assert_eq!(server.log.borrow().len(), before);
    assert_eq!(server.objects.borrow().len(), 2);
    assert!(titles(&db, &list).is_empty());
    assert!(bindings(&db.lock().unwrap()).unwrap().is_empty());
}

#[test]
fn moving_between_a_server_list_and_another_and_editing_a_repeating_task_are_refused() {
    let (server, db, list) = imported();
    let id = task_id(&db, "Buy milk");
    let conn = db.lock().unwrap();
    let (mut fields, revision, _) = task_lists::get(&conn, id).unwrap().unwrap();
    fields.list_id = task_lists::MAIL_LIST.into();
    let error = task_lists::update(&conn, id, revision, &fields).unwrap_err().to_string();
    assert!(error.contains("not supported yet"), "{error}");
    let local = task_lists::create(&conn, &TaskFields { title: "Local".into(), priority: 1, ..Default::default() }, 1).unwrap();
    let (mut fields, revision, _) = task_lists::get(&conn, local).unwrap().unwrap();
    fields.list_id = list.clone();
    assert!(task_lists::update(&conn, local, revision, &fields).is_err());
    assert_eq!(state_of(&conn, local), "", "a local list's task is never pending");
    drop(conn);

    // A repetition beyond the editor's (the last weekday of the month).
    server.touch(
        PLAN,
        "STATUS:NEEDS-ACTION",
        "STATUS:NEEDS-ACTION\r\nDUE;VALUE=DATE:20261030\r\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
    );
    sync(&db, &server, &list, 130).unwrap();
    let plan = task_id(&db, "Plan the week");
    let conn = db.lock().unwrap();
    assert!(crate::store::list_tasks(&conn, false).unwrap().iter().any(|t| t.id == plan && t.recurring));
    assert!(crate::store::set_task_completed(&conn, plan, true, 131).unwrap_err().to_string().contains("repeats"));
    let (mut fields, revision, _) = task_lists::get(&conn, plan).unwrap().unwrap();
    fields.title = "x".into();
    assert!(task_lists::update(&conn, plan, revision, &fields).is_err());
}

fn state_of(conn: &Connection, id: i64) -> String {
    conn.query_row("SELECT pending FROM tasks WHERE id = ?1", params![id], |row| row.get(0)).unwrap()
}

#[test]
fn a_reminder_already_past_on_import_does_not_ring() {
    let server = Server::default();
    let ics = todo("r@phone", "Old")
        .replace("END:VTODO", "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER;VALUE=DATE-TIME:20200101T000000Z\r\nEND:VALARM\r\nEND:VTODO");
    server.seed("https://dav.example/ana/work/r.ics", &ics);
    let db = store();
    let list = bind(&db, WORK);
    sync(&db, &server, &list, 1_800_000_000).unwrap();
    assert!(task_lists::due_reminders(&db.lock().unwrap(), 1_800_000_001).unwrap().is_empty());
}

const WEEKLY: &str = "https://dav.example/ana/work/weekly.ics";

/// A weekly task from another client, due on Tuesday 13 October 2026, with
/// a reminder the evening before, set relative to it.
fn weekly_task() -> String {
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Phone//EN\r\nBEGIN:VTODO\r\nUID:weekly@phone\r\nDTSTAMP:20260101T000000Z\r\n\
SUMMARY:Water the plants\r\nX-PHONE-COLOR:green\r\nDTSTART;VALUE=DATE:20261013\r\nDUE;VALUE=DATE:20261013\r\n\
RRULE:FREQ=WEEKLY;COUNT=3\r\nSTATUS:NEEDS-ACTION\r\n\
BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Water\r\nTRIGGER;RELATED=END:-PT6H\r\nEND:VALARM\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
        .to_string()
}

fn local_midnight(y: i32, m: u32, d: u32) -> i64 {
    use chrono::TimeZone as _;
    chrono::Local
        .from_local_datetime(&chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .unwrap()
        .timestamp()
}

#[test]
fn completing_an_occurrence_moves_the_series_on_the_server_and_keeps_a_record() {
    let server = Server::default();
    server.seed(WEEKLY, &weekly_task());
    let db = store();
    let list = bind(&db, WORK);
    sync(&db, &server, &list, 10).unwrap();
    let id = task_id(&db, "Water the plants");
    {
        let conn = db.lock().unwrap();
        let card = crate::store::list_tasks(&conn, false).unwrap().into_iter().find(|t| t.id == id).unwrap();
        assert!(!card.recurring, "a weekly rule is one this client changes");
        assert_eq!(card.rrule, "FREQ=WEEKLY;BYDAY=TU;COUNT=3");
        let done = task_lists::set_completed(&conn, id, true, false, 20).unwrap();
        assert_eq!(done.next_due, Some(local_midnight(2026, 10, 20)));
    }
    let report = sync(&db, &server, &list, 30).unwrap();
    assert_eq!(report.pushed, 2, "the series and the record of the occurrence");

    let series = server.body(WEEKLY);
    for expected in [
        "DUE;VALUE=DATE:20261020",
        "DTSTART;VALUE=DATE:20261020",
        "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2",
        "STATUS:NEEDS-ACTION",
        "X-PHONE-COLOR:green",
        "TRIGGER;RELATED=END:-PT6H",
        "UID:weekly@phone",
    ] {
        assert!(series.contains(expected), "lost {expected}:\n{series}");
    }
    assert!(!series.contains("COMPLETED:"), "the series is not done:\n{series}");
    let record = server
        .objects
        .borrow()
        .iter()
        .find(|(href, _)| href.as_str() != WEEKLY)
        .map(|(_, (ics, _))| ics.clone())
        .expect("the record is on the server");
    assert!(record.contains("STATUS:COMPLETED") && record.contains("DUE;VALUE=DATE:20261013"), "{record}");
    assert!(!record.contains("RRULE") && record.contains("SUMMARY:Water the plants"), "{record}");

    // The reminder moved with it: 18:00 the evening before the new due date.
    let reminder: Option<i64> = db
        .lock()
        .unwrap()
        .query_row("SELECT reminder_at FROM tasks WHERE id = ?1", params![id], |row| row.get(0))
        .unwrap();
    assert_eq!(reminder, Some(local_midnight(2026, 10, 20) - 6 * 3600));

    // A sync later reads both back unchanged: no conflict, no copy.
    let again = sync(&db, &server, &list, 40).unwrap();
    assert_eq!((again.pulled, again.conflicts), (0, 0));
    assert_eq!(titles(&db, &list), vec!["Water the plants", "Water the plants"]);

    // Two more: the count runs out at the third, which completes the task.
    let conn = db.lock().unwrap();
    assert!(task_lists::set_completed(&conn, id, true, false, 50).unwrap().next_due.is_some());
    assert_eq!(task_lists::set_completed(&conn, id, true, false, 60).unwrap().next_due, None);
    let open = crate::store::list_tasks(&conn, false).unwrap();
    assert!(open.iter().all(|t| t.list_id != list), "every occurrence done");
    drop(conn);
    sync(&db, &server, &list, 70).unwrap();
    assert!(server.body(WEEKLY).contains("STATUS:COMPLETED"));
    assert_eq!(server.objects.borrow().len(), 3, "the series and two records");
}

#[test]
fn stopping_a_repetition_removes_the_rule_on_the_server_and_completes_the_task() {
    let server = Server::default();
    server.seed(WEEKLY, &weekly_task());
    let db = store();
    let list = bind(&db, WORK);
    sync(&db, &server, &list, 10).unwrap();
    let id = task_id(&db, "Water the plants");
    task_lists::set_completed(&db.lock().unwrap(), id, true, true, 20).unwrap();
    sync(&db, &server, &list, 30).unwrap();
    let body = server.body(WEEKLY);
    assert!(!body.contains("RRULE") && body.contains("STATUS:COMPLETED"), "{body}");
    assert!(body.contains("DUE;VALUE=DATE:20261013"), "it stays due when it was: {body}");
    assert_eq!(server.objects.borrow().len(), 1, "no record of an occurrence");
}

#[test]
fn a_repeating_task_made_here_is_sent_with_its_rule_and_start() {
    let db = store();
    let server = Server::default();
    let list = bind(&db, WORK);
    let rule = crate::calendar::Recurrence {
        freq: crate::calendar::Frequency::Monthly,
        interval: 1,
        month_week: Some(-1),
        weekdays: vec![4],
        ..Default::default()
    };
    let fields = TaskFields {
        list_id: list.clone(),
        title: "Pay the rent".into(),
        priority: 1,
        due_at: Some(local_midnight(2026, 10, 30)),
        recurrence: Some(rule),
        ..Default::default()
    };
    task_lists::create(&db.lock().unwrap(), &fields, 5).unwrap();
    sync(&db, &server, &list, 10).unwrap();
    let (_, (ics, _)) = server.objects.borrow().iter().next().map(|(k, v)| (k.clone(), v.clone())).unwrap();
    assert!(ics.contains("RRULE:FREQ=MONTHLY;BYDAY=-1FR"), "{ics}");
    assert!(ics.contains("DTSTART;VALUE=DATE:20261030") && ics.contains("DUE;VALUE=DATE:20261030"), "{ics}");
}

#[test]
fn tasks_read_before_repetition_was_editable_are_read_again_by_the_migration() {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    conn.execute(
        "INSERT INTO tasks(account, thread_key, folder, created_at, list_id, title, remote_ics, recurring)
         VALUES('', '', '', 1, 'mail', 'Old', ?1, 1)",
        params![weekly_task()],
    )
    .unwrap();
    migrate_recurrence(&conn).unwrap();
    let (recurring, rrule): (bool, String) =
        conn.query_row("SELECT recurring, rrule FROM tasks WHERE title = 'Old'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((recurring, rrule.as_str()), (false, "FREQ=WEEKLY;BYDAY=TU;COUNT=3"));
}
