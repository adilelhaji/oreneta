//! The task lists that come with an account (#281, ADR-0070), on recorded
//! answers of a CalDAV server.

use std::cell::RefCell;
use std::sync::Arc;

use super::*;
use crate::calendar::caldav::RemoteCalendar;

const ACCOUNT: &str = "ana@dav.example";
const ROOT: &str = "https://dav.example";
const ORIGIN: &str = "https://dav.example";
/// Takes tasks only.
const TASKS: &str = "https://dav.example/ana/tasks/";
/// Takes events and tasks, and holds a task.
const MIXED: &str = "https://dav.example/ana/personal/";
/// Takes events and tasks, and holds none.
const EMPTY: &str = "https://dav.example/ana/empty/";
/// Does not say what it takes, and holds a task.
const PLAIN: &str = "https://dav.example/ana/plain/";
/// Takes events only.
const EVENTS: &str = "https://dav.example/ana/events/";
/// On another origin.
const ELSEWHERE: &str = "https://other.example/ana/tasks/";

fn todo(uid: &str, title: &str) -> String {
    format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VTODO\r\nUID:{uid}\r\nDTSTAMP:20260101T000000Z\r\n\
SUMMARY:{title}\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    )
}

struct Held {
    url: &'static str,
    /// What `supported-calendar-component-set` says, comma-separated.
    components: Option<&'static str>,
    name: &'static str,
    todos: Vec<(&'static str, String)>,
}

/// A CalDAV server answering as Nextcloud and Radicale do: discovery
/// through the principal, each collection's components, a task query and
/// a collection's name. Every request is logged.
struct Dav {
    held: Vec<Held>,
    log: RefCell<Vec<(String, String)>>,
    /// What the person does while a collection's tasks are read.
    during_read: RefCell<Option<Box<dyn Fn()>>>,
    /// Answers every request with this status instead.
    refuse: RefCell<Option<u16>>,
}

impl Dav {
    fn new() -> Self {
        Dav {
            held: vec![
                Held { url: TASKS, components: Some("VTODO"), name: "Feina", todos: vec![("t1.ics", todo("t1", "Informe")), ("t2.ics", todo("t2", "Factura"))] },
                Held { url: MIXED, components: Some("VEVENT,VTODO"), name: "Personal", todos: vec![("m1.ics", todo("m1", "Metge"))] },
                Held { url: EMPTY, components: Some("VEVENT,VTODO"), name: "Buit", todos: Vec::new() },
                Held { url: PLAIN, components: None, name: "Pla", todos: vec![("p1.ics", todo("p1", "Pintar"))] },
                Held { url: EVENTS, components: Some("VEVENT"), name: "Esdeveniments", todos: Vec::new() },
            ],
            log: RefCell::new(Vec::new()),
            during_read: RefCell::new(None),
            refuse: RefCell::new(None),
        }
    }

    fn find(&self, url: &str) -> Option<&Held> {
        self.held.iter().find(|held| held.url == url)
    }

    fn requests(&self, method: &str) -> Vec<String> {
        self.log.borrow().iter().filter(|(m, _)| m == method).map(|(_, url)| url.clone()).collect()
    }
}

fn multistatus(responses: &[String]) -> String {
    format!(
        r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">{}</d:multistatus>"#,
        responses.join("")
    )
}

fn found(href: &str, props: &str) -> String {
    format!(r#"<d:response><d:href>{href}</d:href><d:propstat><d:prop>{props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#)
}

fn href_of(url: &str) -> String {
    url.strip_prefix(ROOT).map(str::to_string).unwrap_or_else(|| url.to_string())
}

impl Transport for Dav {
    fn send(&self, request: &DavRequest) -> Result<HttpReply> {
        self.log.borrow_mut().push((request.method.to_string(), request.url.clone()));
        let reply = |status: u16, body: String| Ok(HttpReply { status, body, url: request.url.clone(), etag: None });
        if let Some(status) = *self.refuse.borrow() {
            return reply(status, String::new());
        }
        let body = request.body.clone().unwrap_or_default();
        match request.method {
            "PROPFIND" if body.contains("resourcetype") => {
                let mut responses = vec![found("/ana/", "<d:resourcetype><d:collection/></d:resourcetype>")];
                for held in &self.held {
                    let components = held
                        .components
                        .map(|list| {
                            let comps: String = list.split(',').map(|kind| format!(r#"<c:comp name="{kind}"/>"#)).collect();
                            format!("<c:supported-calendar-component-set>{comps}</c:supported-calendar-component-set>")
                        })
                        .unwrap_or_default();
                    responses.push(found(
                        &href_of(held.url),
                        &format!(
                            "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>{}</d:displayname>{components}",
                            held.name
                        ),
                    ));
                }
                reply(207, multistatus(&responses))
            }
            "PROPFIND" if body.contains("calendar-home-set") => {
                reply(207, multistatus(&[found("/ana/", "<c:calendar-home-set><d:href>/ana/</d:href></c:calendar-home-set>")]))
            }
            "PROPFIND" if body.contains("current-user-principal") => reply(
                207,
                multistatus(&[found(&href_of(&request.url), "<d:current-user-principal><d:href>/ana/</d:href></d:current-user-principal>")]),
            ),
            "PROPFIND" => match self.find(&request.url) {
                Some(held) => reply(207, multistatus(&[found(&href_of(held.url), &format!("<d:displayname>{}</d:displayname>", held.name))])),
                None => reply(404, String::new()),
            },
            "REPORT" => {
                if let Some(during) = self.during_read.borrow().as_ref() {
                    during();
                }
                let Some(held) = self.find(&request.url) else { return reply(404, String::new()) };
                let responses: Vec<String> = held
                    .todos
                    .iter()
                    .map(|(name, ics)| {
                        found(
                            &format!("{}{name}", href_of(held.url)),
                            &format!(
                                "<d:getetag>\"1\"</d:getetag><c:calendar-data>{}</c:calendar-data>",
                                ics.replace('&', "&amp;").replace('<', "&lt;")
                            ),
                        )
                    })
                    .collect();
                reply(207, multistatus(&responses))
            }
            _ => reply(405, String::new()),
        }
    }
}

/// A store with the account, and nothing else of it yet.
fn store() -> Arc<Mutex<Connection>> {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    conn.execute("INSERT INTO accounts(id, email, config) VALUES(?1, ?1, '{}')", params![ACCOUNT]).unwrap();
    Arc::new(Mutex::new(conn))
}

fn collection(url: &str) -> Collection {
    Collection {
        account: ACCOUNT.to_string(),
        url: normalize_url(url).unwrap(),
        username: "ana".to_string(),
        list_id: crate::store::task_lists::new_list_id(),
    }
}

fn entry_for(db: &Mutex<Connection>, url: &str) -> Option<Entry> {
    entry(&db.lock().unwrap(), ACCOUNT, &collection_source(url).unwrap()).unwrap()
}

/// `(id, name, remote_url)` of every list but the mail one.
fn lists(db: &Mutex<Connection>) -> Vec<(String, String, String)> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id, name, remote_url FROM task_lists WHERE id <> 'mail' ORDER BY position").unwrap();
    stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

fn task_count(db: &Mutex<Connection>, list: &str) -> i64 {
    db.lock().unwrap().query_row("SELECT COUNT(*) FROM tasks WHERE list_id = ?1", params![list], |row| row.get(0)).unwrap()
}

/// What the dialog sends when the person keeps `wanted` and unchecks `declined`.
fn choose(db: &Mutex<Connection>, wanted: &[&str], declined: &[&str]) -> Choice {
    let owned = |urls: &[&str]| urls.iter().map(|url| url.to_string()).collect::<Vec<_>>();
    record_choice(&db.lock().unwrap(), ACCOUNT, "ana", &[ORIGIN.to_string()], &owned(wanted), &owned(declined), 5).unwrap()
}

fn link(db: &Mutex<Connection>, dav: &Dav, url: &str, mode: Mode) -> Result<Linked> {
    link_collection(db, dav, &collection(url), mode, &|| Ok(()), 10)
}

#[test]
fn one_collection_written_two_ways_is_one_entry() {
    assert_eq!(normalize_url("HTTPS://Dav.Example:443/ana/%7eTasques%2f").unwrap(), "https://dav.example/ana/~Tasques%2F/");
    assert_eq!(normalize_url("http://dav.example:80/ana/tasks").unwrap(), "http://dav.example/ana/tasks/");
    assert_eq!(normalize_url("https://dav.example:8443/ana/%c3%a9s/").unwrap(), "https://dav.example:8443/ana/%C3%A9s/");
    assert_eq!(
        collection_source("https://DAV.example/ana/%74asks").unwrap(),
        collection_source(TASKS).unwrap(),
        "upper-case host, an unreserved letter encoded and no final slash name the same collection"
    );
    assert!(normalize_url("ftp://dav.example/ana/").is_err());
    assert!(normalize_url("not a url").is_err());
    assert_eq!(origin_of("https://Dav.Example:443/ana/tasks/").unwrap(), ORIGIN);
    assert_eq!(parse_source("ews"), Some(Source::Ews));
    assert_eq!(parse_source(&server_source(ORIGIN, "ana|bo")), Some(Source::Server { origin: ORIGIN, user: "ana|bo" }));
    assert_eq!(parse_source(&collection_source(TASKS).unwrap()), Some(Source::Collection(TASKS)));
    assert_eq!(parse_source("caldav:"), None);
}

#[test]
fn which_collections_are_an_accounts_task_lists() {
    let dav = Dav::new();
    let found = caldav::discover(&dav, "https://dav.example/ana/").unwrap();
    let kinds: Vec<(String, Option<Vec<String>>)> = found.iter().map(|c| (c.url.clone(), c.components.clone())).collect();
    assert_eq!(kinds[0], (TASKS.to_string(), Some(vec!["VTODO".to_string()])), "read from the same listing");
    assert_eq!(kinds[3], (PLAIN.to_string(), None));
    dav.log.borrow_mut().clear();
    let answers: Vec<(String, bool)> =
        classify(&dav, &found).into_iter().map(|(collection, answer)| (collection.url, answer.unwrap())).collect();
    assert_eq!(
        answers,
        [
            (TASKS.to_string(), true),
            (MIXED.to_string(), true),
            (EMPTY.to_string(), false),
            (PLAIN.to_string(), true),
            (EVENTS.to_string(), false),
        ]
    );
    // Only the ones that may hold tasks are asked: never one that takes
    // tasks only, nor one that takes none.
    assert_eq!(dav.requests("REPORT"), [MIXED, EMPTY, PLAIN]);
    let events = found.iter().find(|c| c.url == EVENTS).unwrap();
    assert!(events.takes_events() && !found[0].takes_events() && found[3].takes_events());

    // A question that cannot be answered is "cannot say", never "no".
    *dav.refuse.borrow_mut() = Some(500);
    let unknown = classify(&dav, &found);
    assert!(unknown[1].1.is_err() && unknown[0].1.as_ref().is_ok_and(|tasks| *tasks));
}

#[test]
fn a_chosen_collection_is_read_whole_and_then_made_with_its_tasks() {
    let (db, dav) = (store(), Dav::new());
    let choice = choose(&db, &[TASKS], &[EMPTY]);
    assert_eq!(choice.to_read, [TASKS]);
    assert_eq!(entry_for(&db, EMPTY).unwrap().state, "declined", "an unchecked collection is declined");
    let pending = entry_for(&db, TASKS).unwrap();
    assert_eq!((pending.state.as_str(), pending.notified), ("pending", true), "added now: no upgrade notice");
    // The person reads nothing as «cap tasca» meanwhile: the entry says it waits.
    assert!(entries(&db.lock().unwrap()).unwrap().iter().any(|e| e.url == TASKS && e.state == "pending"));

    let target = collection(TASKS);
    let watcher = db.clone();
    let kept = std::rc::Rc::new(std::cell::Cell::new(false));
    let seen = kept.clone();
    *dav.during_read.borrow_mut() = Some(Box::new(move || {
        // While the read is on the network, no list exists yet and no
        // password of its own is kept: an interrupted read leaves neither.
        let conn = watcher.lock().unwrap();
        let made: i64 = conn.query_row("SELECT COUNT(*) FROM task_lists WHERE remote_url <> ''", [], |row| row.get(0)).unwrap();
        assert_eq!(made, 0);
        assert!(!seen.get());
    }));
    let made_yet = db.clone();
    let keep = || -> Result<()> {
        // Kept after the read and before the list is written.
        let made: i64 =
            made_yet.lock().unwrap().query_row("SELECT COUNT(*) FROM task_lists WHERE remote_url <> ''", [], |row| row.get(0))?;
        assert_eq!(made, 0);
        kept.set(true);
        Ok(())
    };
    assert_eq!(link_collection(&db, &dav, &target, Mode::Retry, &keep, 10).unwrap(), Linked::Made(target.list_id.clone()));
    assert!(kept.get());
    assert_eq!(lists(&db), [(target.list_id.clone(), "Feina".to_string(), TASKS.to_string())]);
    assert_eq!(task_count(&db, &target.list_id), 2);
    let linked = entry_for(&db, TASKS).unwrap();
    assert_eq!((linked.state.as_str(), linked.list_id.as_str(), linked.adopted), ("linked", target.list_id.as_str(), false));
    let binding = crate::task_sync::binding(&db.lock().unwrap(), &target.list_id).unwrap().unwrap();
    assert_eq!((binding.url.as_str(), binding.username.as_str()), (TASKS, "ana"));
}

#[test]
fn a_read_that_fails_makes_nothing_and_waits_with_the_reason() {
    let (db, dav) = (store(), Dav::new());
    choose(&db, &[TASKS], &[]);
    *dav.refuse.borrow_mut() = Some(401);
    let error = link(&db, &dav, TASKS, Mode::Retry).unwrap_err();
    assert!(format!("{error:#}").contains("refused"), "{error:#}");
    assert!(lists(&db).is_empty());
    let waiting = entry_for(&db, TASKS).unwrap();
    assert_eq!(waiting.state, "pending");
    assert!(waiting.last_error.contains("refused"), "{}", waiting.last_error);
    // Tried again, it is read.
    *dav.refuse.borrow_mut() = None;
    assert!(matches!(link(&db, &dav, TASKS, Mode::Retry).unwrap(), Linked::Made(_)));
    let linked = entry_for(&db, TASKS).unwrap();
    assert_eq!((linked.state.as_str(), linked.last_error.as_str()), ("linked", ""));
}

#[test]
fn a_read_that_ends_after_the_person_declines_or_removes_the_account_writes_nothing() {
    let (db, dav) = (store(), Dav::new());
    choose(&db, &[TASKS], &[]);
    let person = db.clone();
    *dav.during_read.borrow_mut() = Some(Box::new(move || {
        let keys = decline(&person.lock().unwrap(), ACCOUNT, &collection_source(TASKS).unwrap(), 7).unwrap();
        assert_eq!(keys, [pending_secret_key(ACCOUNT, &collection_source(TASKS).unwrap())], "only the waiting password");
    }));
    assert_eq!(link(&db, &dav, TASKS, Mode::Retry).unwrap(), Linked::Discarded);
    assert!(lists(&db).is_empty());
    assert_eq!(entry_for(&db, TASKS).unwrap().state, "declined", "a late read never undoes a decline");

    let (db, dav) = (store(), Dav::new());
    choose(&db, &[TASKS], &[]);
    let person = db.clone();
    *dav.during_read.borrow_mut() = Some(Box::new(move || {
        crate::store::delete_account(&person.lock().unwrap(), ACCOUNT).unwrap();
    }));
    assert_eq!(link(&db, &dav, TASKS, Mode::Retry).unwrap(), Linked::Discarded);
    assert!(lists(&db).is_empty(), "nothing of a removed account is made again");
    assert!(entry_for(&db, TASKS).is_none());
}

/// Every transition of ADR-0070, §5.
#[test]
fn each_state_goes_only_where_the_table_says() {
    let (db, dav) = (store(), Dav::new());
    let source = collection_source(TASKS).unwrap();
    // — → pending; pending → linked.
    choose(&db, &[TASKS], &[]);
    let Linked::Made(list) = link(&db, &dav, TASKS, Mode::Retry).unwrap() else { panic!("not made") };
    // linked → declined («Suprimeix la llista»): the list and its tasks go
    // from here, the server is not touched.
    let writes_before = dav.log.borrow().len();
    delete_list(&db.lock().unwrap(), &list, 20).unwrap();
    assert_eq!(dav.log.borrow().len(), writes_before, "nothing is sent to the server");
    assert_eq!(entry_for(&db, TASKS).unwrap().state, "declined");
    assert!(lists(&db).is_empty() && task_count(&db, &list) == 0);
    // declined is never read again: not on opening Tasks…
    dav.log.borrow_mut().clear();
    assert_eq!(link(&db, &dav, TASKS, Mode::Retry).unwrap(), Linked::Discarded);
    assert!(dav.log.borrow().is_empty());
    assert!(pending(&db.lock().unwrap()).unwrap().is_empty());
    // …and not by upgrading again.
    db.lock().unwrap().execute_batch("PRAGMA user_version = 65;").unwrap();
    crate::store::run_migrations(&db.lock().unwrap()).unwrap();
    assert_eq!(entry_for(&db, TASKS).unwrap().state, "declined");
    // declined → «Afegeix una llista», read fails → declined, the dialog says why.
    *dav.refuse.borrow_mut() = Some(403);
    assert!(link(&db, &dav, TASKS, Mode::ByHand).is_err());
    let still = entry_for(&db, TASKS).unwrap();
    assert_eq!((still.state.as_str(), still.last_error.as_str()), ("declined", ""));
    // declined → «Afegeix una llista», read correct → linked.
    *dav.refuse.borrow_mut() = None;
    let Linked::Made(again) = link(&db, &dav, TASKS, Mode::ByHand).unwrap() else { panic!("not made") };
    assert_eq!(entry_for(&db, TASKS).unwrap().list_id, again);
    // linked → declined («Treu-la»): its own password goes, a calendar's never.
    let keys = decline(&db.lock().unwrap(), ACCOUNT, &source, 30).unwrap();
    assert!(keys.contains(&crate::task_sync::secret_key(&again)));
    assert!(keys.iter().all(|key| !key.starts_with("caldav:")), "{keys:?}");
    assert!(lists(&db).is_empty());
    // pending → declined («No l'afegeixis»).
    choose(&db, &[PLAIN], &[]);
    decline(&db.lock().unwrap(), ACCOUNT, &collection_source(PLAIN).unwrap(), 40).unwrap();
    assert_eq!(entry_for(&db, PLAIN).unwrap().state, "declined");
    // Declining twice is declining.
    assert!(decline(&db.lock().unwrap(), ACCOUNT, &collection_source(PLAIN).unwrap(), 41).unwrap().is_empty());
    // any → the account removed: the entry goes.
    crate::store::delete_account(&db.lock().unwrap(), ACCOUNT).unwrap();
    assert!(entries(&db.lock().unwrap()).unwrap().is_empty());
}

#[test]
fn deleting_an_accounts_list_leaves_its_calendars_alone() {
    let (db, dav) = (store(), Dav::new());
    let calendar = RemoteCalendar { url: EVENTS.into(), name: "Esdeveniments".into(), color: None, writable: Some(true), components: None };
    caldav::add_calendars(&db.lock().unwrap(), ACCOUNT, &[calendar], "ana").unwrap();
    choose(&db, &[TASKS], &[]);
    let Linked::Made(list) = link(&db, &dav, TASKS, Mode::Retry).unwrap() else { panic!("not made") };
    let keys = decline(&db.lock().unwrap(), ACCOUNT, &collection_source(TASKS).unwrap(), 20).unwrap();
    assert!(!keys.contains(&caldav::secret_key(ACCOUNT, EVENTS)), "the calendar's password stays");
    assert!(keys.contains(&crate::task_sync::secret_key(&list)));
    let signs_in = caldav::sign_in(&db.lock().unwrap(), ACCOUNT, EVENTS).unwrap();
    assert_eq!(signs_in, Some((EVENTS.to_string(), "ana".to_string())), "the calendar is kept, and syncs as before");
}

#[test]
fn removing_the_account_takes_the_lists_that_came_alone_and_keeps_adopted_ones() {
    let (db, dav) = (store(), Dav::new());
    // A list linked by hand before (ADR-0039), to a collection the account has.
    let mine = crate::task_sync::add_list(&db.lock().unwrap(), "Meva", "https://DAV.example/ana/personal", "", "ana", 1).unwrap();
    let choice = choose(&db, &[TASKS, MIXED, PLAIN], &[]);
    assert_eq!(choice.kept, [MIXED], "adopted, not doubled");
    assert_eq!(choice.to_read, [TASKS, PLAIN]);
    let adopted = entry_for(&db, MIXED).unwrap();
    assert_eq!((adopted.state.as_str(), adopted.list_id.as_str(), adopted.adopted, adopted.notified), ("linked", mine.as_str(), true, true));
    let Linked::Made(came) = link(&db, &dav, TASKS, Mode::Retry).unwrap() else { panic!("not made") };
    // Choosing again changes nothing: no second list.
    let again = choose(&db, &[TASKS, MIXED], &[]);
    assert_eq!(again.kept, [TASKS, MIXED]);
    assert!(again.to_read.is_empty());

    let removal = crate::store::delete_account(&db.lock().unwrap(), ACCOUNT).unwrap();
    for key in [
        crate::task_sync::secret_key(&came),
        pending_secret_key(ACCOUNT, &collection_source(TASKS).unwrap()),
        pending_secret_key(ACCOUNT, &collection_source(PLAIN).unwrap()),
    ] {
        assert!(removal.task_secrets.contains(&key), "{key} in {:?}", removal.task_secrets);
    }
    assert!(!removal.task_secrets.contains(&crate::task_sync::secret_key(&mine)), "an adopted list keeps its password");
    let left: Vec<String> = lists(&db).into_iter().map(|(id, ..)| id).collect();
    assert_eq!(left, [mine], "the adopted list stays, the one that came alone goes");
    assert_eq!(task_count(&db, &came), 0);
}

#[test]
fn a_server_added_now_is_listed_once_and_never_again() {
    let db = store();
    let choice = choose(&db, &[TASKS], &[MIXED]);
    assert_eq!(choice.to_read, [TASKS]);
    let mark = entry(&db.lock().unwrap(), ACCOUNT, &server_source(ORIGIN, "ana")).unwrap().unwrap();
    assert_eq!(mark.state, "scanned");
    assert!(rescans(&db.lock().unwrap()).unwrap().is_empty(), "a server added after the upgrade is not listed again");
    assert!(!entries(&db.lock().unwrap()).unwrap().iter().any(|e| e.kind == "caldav-server"), "a listed server says nothing");
    // A decline of a waiting one hands back its waiting password.
    let again = record_choice(&db.lock().unwrap(), ACCOUNT, "ana", &[ORIGIN.to_string()], &[], &[TASKS.to_string()], 6).unwrap();
    assert_eq!(again.dropped_keys, [pending_secret_key(ACCOUNT, &collection_source(TASKS).unwrap())]);
    assert_eq!(entry_for(&db, TASKS).unwrap().state, "declined");
}

/// A profile from before this version (ADR-0070, §4).
fn upgraded_profile() -> Arc<Mutex<Connection>> {
    let db = store();
    {
        let conn = db.lock().unwrap();
        let calendar = RemoteCalendar { url: EVENTS.into(), name: "Esdeveniments".into(), color: None, writable: Some(true), components: None };
        caldav::add_calendars(&conn, ACCOUNT, &[calendar], "ana").unwrap();
        // A calendar of an account that is gone has no server to list.
        conn.execute(
            "INSERT INTO calendars(account, provider_id, name, kind, url, dav_username) VALUES('gone@x', 'c', 'C', 'caldav', ?1, 'bo')",
            params![TASKS],
        )
        .unwrap();
        crate::task_sync::add_list(&conn, "Meva", MIXED, "", "ana", 1).unwrap();
        conn.execute_batch("DROP TABLE account_task_lists; PRAGMA user_version = 65;").unwrap();
        crate::store::run_migrations(&conn).unwrap();
    }
    db
}

#[test]
fn the_upgrade_lists_each_server_again_once_with_a_calendars_password_and_only_there() {
    let (db, dav) = (upgraded_profile(), Dav::new());
    let waiting = rescans(&db.lock().unwrap()).unwrap();
    assert_eq!(waiting.len(), 1, "one server of an account that is still here: {waiting:?}");
    let rescan = &waiting[0];
    assert_eq!((rescan.mark.url.as_str(), rescan.mark.username.as_str()), (ORIGIN, "ana"));
    assert_eq!(rescan.calendar, Some((EVENTS.to_string(), EVENTS.to_string())), "whose password signs in");

    let found = caldav::discover(&dav, EVENTS).unwrap();
    let mut task_lists: Vec<String> =
        classify(&dav, &found).into_iter().filter(|(_, answer)| *answer.as_ref().unwrap()).map(|(c, _)| c.url).collect();
    task_lists.push(ELSEWHERE.to_string());
    let candidates = rescan_candidates(&db.lock().unwrap(), &rescan.mark, &task_lists).unwrap();
    assert_eq!(candidates, [TASKS, MIXED, PLAIN], "a collection of another origin is never linked alone");
    let done = apply_rescan(&db.lock().unwrap(), &rescan.mark, &candidates, 20).unwrap();
    assert_eq!((done.created.clone(), done.adopted.clone()), (vec![TASKS.to_string(), PLAIN.to_string()], vec![MIXED.to_string()]));
    let came = entry_for(&db, TASKS).unwrap();
    assert_eq!((came.state.as_str(), came.notified), ("pending", false), "it will carry the upgrade's notice");
    let adopted = entry_for(&db, MIXED).unwrap();
    assert!(adopted.adopted && adopted.notified, "a list the person linked needs no notice");
    let mark = entry(&db.lock().unwrap(), ACCOUNT, &server_source(ORIGIN, "ana")).unwrap().unwrap();
    assert_eq!(mark.state, "scanned");
    assert!(rescans(&db.lock().unwrap()).unwrap().is_empty(), "listed once");

    // Upgrading again lists nothing again.
    db.lock().unwrap().execute_batch("PRAGMA user_version = 65;").unwrap();
    crate::store::run_migrations(&db.lock().unwrap()).unwrap();
    assert!(rescans(&db.lock().unwrap()).unwrap().is_empty());

    // Read, the list shows the notice until «D'acord», kept in the profile.
    let Linked::Made(_) = link(&db, &dav, TASKS, Mode::Retry).unwrap() else { panic!("not made") };
    let linked = entry_for(&db, TASKS).unwrap();
    assert_eq!((linked.state.as_str(), linked.notified), ("linked", false));
    acknowledge(&db.lock().unwrap(), ACCOUNT, &linked.source).unwrap();
    assert!(entry_for(&db, TASKS).unwrap().notified);
    assert!(acknowledge(&db.lock().unwrap(), ACCOUNT, "caldav:https://nowhere.example/").is_err());
}

#[test]
fn a_server_that_cannot_be_listed_again_waits_or_is_declined() {
    let db = upgraded_profile();
    let mark = rescans(&db.lock().unwrap()).unwrap().remove(0).mark;
    record_failure(&db.lock().unwrap(), ACCOUNT, &mark.source, "the server refused those credentials").unwrap();
    let shown = entries(&db.lock().unwrap()).unwrap().into_iter().find(|e| e.source == mark.source).unwrap();
    assert_eq!((shown.state.as_str(), shown.last_error.as_str()), ("pending", "the server refused those credentials"));
    // «No l'afegeixis» on it: declined, never listed again.
    assert!(decline(&db.lock().unwrap(), ACCOUNT, &mark.source, 30).unwrap().is_empty(), "a mark has no password");
    assert!(rescans(&db.lock().unwrap()).unwrap().is_empty());
    // A read that ends after it writes nothing.
    let done = apply_rescan(&db.lock().unwrap(), &mark, &[TASKS.to_string()], 31).unwrap();
    assert!(done.discarded && entry_for(&db, TASKS).is_none());
    // Adding the server from the dialog later does not undo the decline.
    choose(&db, &[], &[EMPTY]);
    assert_eq!(entry(&db.lock().unwrap(), ACCOUNT, &mark.source).unwrap().unwrap().state, "declined");
    // A server listed already has nothing to decline.
    let fresh = store();
    choose(&fresh, &[], &[EMPTY]);
    assert!(decline(&fresh.lock().unwrap(), ACCOUNT, &server_source(ORIGIN, "ana"), 32).is_err());

    // A server whose calendars are gone has nothing to sign in with.
    let db = upgraded_profile();
    db.lock().unwrap().execute("DELETE FROM calendars WHERE account = ?1", params![ACCOUNT]).unwrap();
    assert_eq!(rescans(&db.lock().unwrap()).unwrap()[0].calendar, None);
}

#[test]
fn the_upgrade_brings_each_exchange_account_its_list_once() {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    let ews = r#"{"ews_url":"https://mail.example.org/EWS/Exchange.asmx"}"#;
    conn.execute("INSERT INTO accounts(id, email, config) VALUES('with@x', 'with@x', ?1)", params![ews]).unwrap();
    conn.execute("INSERT INTO accounts(id, email, config) VALUES('without@x', 'without@x', ?1)", params![ews]).unwrap();
    conn.execute("INSERT INTO accounts(id, email, config) VALUES('imap@x', 'imap@x', '{}')", []).unwrap();
    let list = crate::task_sync::exchange::add_list(&conn, "with@x", "", 1).unwrap();
    conn.execute_batch("DROP TABLE account_task_lists; PRAGMA user_version = 65;").unwrap();
    crate::store::run_migrations(&conn).unwrap();
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
    assert_eq!(version, crate::store::SCHEMA_VERSION);

    let with = entry(&conn, "with@x", EWS).unwrap().unwrap();
    assert_eq!((with.state.as_str(), with.list_id.as_str(), with.notified), ("linked", list.as_str(), true), "the list it has");
    let without = entry(&conn, "without@x", EWS).unwrap().unwrap();
    assert_eq!((without.state.as_str(), without.notified), ("pending", false), "read on opening Tasks, with the notice");
    assert!(entry(&conn, "imap@x", EWS).unwrap().is_none(), "an account with no Tasks folder has none");

    // Once: declined, it stays declined however often the migration runs.
    decline(&conn, "without@x", EWS, 9).unwrap();
    conn.execute_batch("PRAGMA user_version = 65;").unwrap();
    crate::store::run_migrations(&conn).unwrap();
    crate::store::run_migrations(&conn).unwrap();
    assert_eq!(entry(&conn, "without@x", EWS).unwrap().unwrap().state, "declined");
    assert_eq!(entries(&conn).unwrap().len(), 2);
}

#[test]
fn a_waiting_list_signs_in_as_its_server_was_added() {
    let db = store();
    let conn = db.lock().unwrap();
    assert!(username_for(&conn, ACCOUNT, ORIGIN).is_err(), "no sign-in kept: said, not guessed");
    let calendar = RemoteCalendar { url: EVENTS.into(), name: "E".into(), color: None, writable: None, components: None };
    caldav::add_calendars(&conn, ACCOUNT, &[calendar], "ana").unwrap();
    assert_eq!(username_for(&conn, ACCOUNT, ORIGIN).unwrap(), "ana", "from the calendars");
    assert_eq!(calendar_for(&conn, ACCOUNT, ORIGIN, "ana").unwrap(), Some((EVENTS.to_string(), EVENTS.to_string())));
    assert_eq!(calendar_for(&conn, ACCOUNT, ORIGIN, "bo").unwrap(), None, "another user's password is not this one's");
    assert_eq!(calendar_for(&conn, ACCOUNT, "https://other.example", "ana").unwrap(), None, "nor another origin's");
    drop(conn);
    record_choice(&db.lock().unwrap(), ACCOUNT, "bo", &[ORIGIN.to_string()], &[], &[], 3).unwrap();
    assert_eq!(username_for(&db.lock().unwrap(), ACCOUNT, ORIGIN).unwrap(), "bo", "the mark says who added the server");
    record_choice(&db.lock().unwrap(), ACCOUNT, "carla", &[ORIGIN.to_string()], &[], &[], 4).unwrap();
    assert!(username_for(&db.lock().unwrap(), ACCOUNT, ORIGIN).is_err(), "two users cannot be told apart");
}

#[test]
fn the_password_goes_only_to_the_collections_origin() {
    let bound = OriginBound { inner: Dav::new(), origin: ORIGIN.to_string() };
    let request = DavRequest { method: "REPORT", url: ELSEWHERE.to_string(), ..Default::default() };
    let error = bound.send(&request).unwrap_err();
    assert!(format!("{error:#}").contains("nothing was sent"), "{error:#}");
    assert!(bound.inner.log.borrow().is_empty(), "the request never left");
    let fine = DavRequest { method: "PROPFIND", url: TASKS.to_string(), body: Some("<d:displayname/>".into()), ..Default::default() };
    assert_eq!(bound.send(&fine).unwrap().status, 207);
    let nobody = store();
    let wanted = [TASKS.to_string()];
    assert!(record_choice(&nobody.lock().unwrap(), "nobody@x", "ana", &[], &wanted, &[], 1).is_err(), "no account, no list");
    assert_eq!(record_choice(&nobody.lock().unwrap(), "nobody@x", "ana", &[ORIGIN.to_string()], &[], &[], 1).unwrap(), Choice::default());
    assert!(entries(&nobody.lock().unwrap()).unwrap().is_empty(), "nothing kept for an account that is not here");
}

#[test]
fn adding_the_server_again_from_the_dialog_does_not_bring_a_declined_list_back() {
    let (db, dav) = (store(), Dav::new());
    choose(&db, &[TASKS], &[]);
    let Linked::Made(list) = link(&db, &dav, TASKS, Mode::Retry).unwrap() else { panic!("not made") };
    delete_list(&db.lock().unwrap(), &list, 20).unwrap();
    // The dialog offers the server's lists again, and the person keeps them ticked.
    let again = choose(&db, &[TASKS], &[]);
    assert_eq!(again.still_declined, [TASKS]);
    assert!(again.to_read.is_empty());
    assert_eq!(entry_for(&db, TASKS).unwrap().state, "declined", "only «Afegeix una llista» brings it back");
}

#[test]
fn a_password_is_kept_only_once_the_read_is_whole() {
    let (db, dav) = (store(), Dav::new());
    choose(&db, &[TASKS], &[]);
    *dav.refuse.borrow_mut() = Some(500);
    let kept = std::cell::Cell::new(false);
    let keep = || -> Result<()> {
        kept.set(true);
        Ok(())
    };
    assert!(link_collection(&db, &dav, &collection(TASKS), Mode::Retry, &keep, 10).is_err());
    assert!(!kept.get(), "a read that failed keeps no password");
    // One that cannot be kept makes no list, and the entry says why.
    *dav.refuse.borrow_mut() = None;
    let refuse = || -> Result<()> { bail!("the keychain is locked") };
    assert!(link_collection(&db, &dav, &collection(TASKS), Mode::Retry, &refuse, 10).is_err());
    assert!(lists(&db).is_empty());
    assert!(entry_for(&db, TASKS).unwrap().last_error.contains("the keychain is locked"));
}

#[test]
fn a_waiting_list_linked_by_hand_meanwhile_is_adopted_not_doubled() {
    let (db, dav) = (store(), Dav::new());
    choose(&db, &[TASKS], &[]);
    let mine = crate::task_sync::add_list(&db.lock().unwrap(), "Meva", TASKS, "", "ana", 1).unwrap();
    dav.log.borrow_mut().clear();
    assert_eq!(link(&db, &dav, TASKS, Mode::Retry).unwrap(), Linked::Made(mine.clone()));
    assert!(dav.log.borrow().is_empty(), "nothing to read: the list is here");
    let adopted = entry_for(&db, TASKS).unwrap();
    assert_eq!((adopted.state.as_str(), adopted.list_id.as_str(), adopted.adopted), ("linked", mine.as_str(), true));
    assert_eq!(lists(&db).len(), 1);
    // Added again by hand it is refused instead: it is here already.
    let (db, dav) = (store(), Dav::new());
    crate::task_sync::add_list(&db.lock().unwrap(), "Meva", TASKS, "", "ana", 1).unwrap();
    assert!(link(&db, &dav, TASKS, Mode::ByHand).is_err());
}
