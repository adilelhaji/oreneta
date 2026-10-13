use super::*;
use chrono::FixedOffset;
use std::collections::{BTreeMap, HashSet};

const ACCOUNT: &str = "ana@x.cat";
const DAY: i64 = 24 * 3600;

/// `run` lets one run go at a time across the process, so tests that call it
/// take turns.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn folder(name: &str, role: Option<&str>) -> imap::Folder {
    imap::Folder {
        name: name.into(),
        display_name: name.into(),
        special_use: role.map(str::to_string),
        ..Default::default()
    }
}

fn folders() -> Vec<imap::Folder> {
    vec![
        folder("INBOX", None),
        folder("Projects", None),
        folder("Sent", Some("sent")),
        folder("Drafts", Some("drafts")),
        folder("Trash", Some("trash")),
        folder("Junk", Some("junk")),
        folder("Archive", Some("archive")),
    ]
}

fn db() -> Mutex<Connection> {
    let conn = crate::store::open_at(":memory:").unwrap();
    conn.execute("INSERT INTO accounts(id, email, display_name, config) VALUES(?1, ?1, 'Ana', '{}')", params![ACCOUNT])
        .unwrap();
    Mutex::new(conn)
}

fn media() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("oreneta-auto-archive-test-{}", std::process::id()))
}

fn madrid_summer() -> FixedOffset {
    FixedOffset::east_opt(2 * 3600).unwrap()
}

/// 2026-10-13 10:00 at +02:00.
fn now() -> DateTime<FixedOffset> {
    madrid_summer().with_ymd_and_hms(2026, 10, 13, 10, 0, 0).unwrap()
}

fn at(y: i32, m: u32, d: u32, h: u32, min: u32, s: u32) -> i64 {
    madrid_summer().with_ymd_and_hms(y, m, d, h, min, s).unwrap().timestamp()
}

fn candidate(uid: u32, date: i64, seen: bool, starred: bool) -> Candidate {
    Candidate { uid, date, seen, starred, message_id: format!("m{uid}@x.cat"), subject: format!("Message {uid}") }
}

fn raw(uid: u32) -> Vec<u8> {
    format!(
        "From: Bo <bo@x.cat>\r\nTo: ana@x.cat\r\nSubject: Message {uid}\r\nDate: Mon, 5 Jan 2026 09:00:00 +0000\r\nMessage-ID: <m{uid}@x.cat>\r\n\r\nBody {uid}\r\n"
    )
    .into_bytes()
}

fn policy(destination: Destination) -> Policy {
    Policy {
        enabled: true,
        older_than: Age { value: 30, unit: AgeUnit::Days },
        folders: vec![FolderChoice { name: "INBOX".into(), older_than: None }],
        destination,
        ..Default::default()
    }
}

// ---- Selection --------------------------------------------------------------

#[test]
fn the_age_boundary_is_the_start_of_the_local_day() {
    let age = Age { value: 30, unit: AgeUnit::Days };
    let cut = cutoff(&now(), age);
    assert_eq!(cut, at(2026, 9, 13, 0, 0, 0), "30 days before 13 October, at local midnight");
    let p = Policy { include_unread: true, ..policy(Destination::Server) };
    let messages = [
        candidate(1, at(2026, 9, 12, 23, 59, 59), true, false),
        candidate(2, at(2026, 9, 13, 0, 0, 0), true, false),
        candidate(3, at(2026, 9, 13, 9, 0, 0), true, false),
    ];
    let chosen: Vec<u32> = select(&messages, cut, &p).iter().map(|c| c.uid).collect();
    assert_eq!(chosen, vec![1], "a message from the boundary day itself is not old enough");

    // The same instant, seen from another zone, is another local day.
    let utc_now = now().with_timezone(&FixedOffset::east_opt(-10 * 3600).unwrap());
    assert_eq!(cutoff(&utc_now, age), FixedOffset::east_opt(-10 * 3600).unwrap().with_ymd_and_hms(2026, 9, 12, 0, 0, 0).unwrap().timestamp());
}

#[test]
fn months_count_calendar_months_and_clamp_to_the_month_end() {
    let end_of_march = madrid_summer().with_ymd_and_hms(2026, 3, 31, 8, 0, 0).unwrap();
    assert_eq!(cutoff(&end_of_march, Age { value: 1, unit: AgeUnit::Months }), at(2026, 2, 28, 0, 0, 0));
    assert_eq!(cutoff(&now(), Age { value: 6, unit: AgeUnit::Months }), at(2026, 4, 13, 0, 0, 0));
    assert_eq!(cutoff(&now(), Age { value: 12, unit: AgeUnit::Months }), at(2025, 10, 13, 0, 0, 0));
}

#[test]
fn a_day_that_starts_in_a_clock_change_starts_when_the_clock_does() {
    // Havana moves its clocks from midnight to one on 8 March 2026: that
    // day has no midnight.
    let zone = chrono_tz::America::Havana;
    let midnight = chrono::NaiveDate::from_ymd_opt(2026, 3, 8).unwrap().and_hms_opt(0, 0, 0).unwrap();
    assert!(zone.from_local_datetime(&midnight).earliest().is_none(), "the fixture day must have no midnight");
    let now = zone.with_ymd_and_hms(2026, 3, 18, 12, 0, 0).unwrap();
    let cut = cutoff(&now, Age { value: 10, unit: AgeUnit::Days });
    let local = zone.timestamp_opt(cut, 0).unwrap();
    assert_eq!(local.date_naive(), chrono::NaiveDate::from_ymd_opt(2026, 3, 8).unwrap());
    assert_eq!(local.format("%H:%M").to_string(), "01:00");
    let before = zone.timestamp_opt(cut - 1, 0).unwrap();
    assert_eq!(before.date_naive(), chrono::NaiveDate::from_ymd_opt(2026, 3, 7).unwrap());
}

#[test]
fn flagged_and_unread_mail_stay_unless_asked_and_unknown_dates_never_go() {
    let cut = at(2026, 9, 13, 0, 0, 0);
    let old = at(2026, 1, 5, 9, 0, 0);
    let messages = [
        candidate(1, old, true, false),
        candidate(2, old, false, false),
        candidate(3, old, true, true),
        candidate(4, 0, true, false),
        candidate(5, old, false, true),
    ];
    let pick = |p: &Policy| select(&messages, cut, p).iter().map(|c| c.uid).collect::<Vec<_>>();
    let mut p = policy(Destination::Server);
    assert_eq!(pick(&p), vec![1]);
    p.include_unread = true;
    assert_eq!(pick(&p), vec![1, 2]);
    p.include_starred = true;
    assert_eq!(pick(&p), vec![1, 2, 3, 5]);
    p.include_unread = false;
    assert_eq!(pick(&p), vec![1, 3]);
}

#[test]
fn special_folders_are_never_a_source() {
    for (name, role, reason) in [
        ("Drafts", Some("drafts"), "drafts"),
        ("Brouillons", Some("drafts"), "drafts"),
        ("INBOX.Drafts", None, "drafts"),
        ("Trash", None, "trash"),
        ("[Gmail]/Trash", None, "trash"),
        ("Deleted Items", None, "trash"),
        ("Spam", None, "junk"),
        ("Correo no deseado", Some("junk"), "junk"),
        ("Outbox", None, "outbox"),
        ("INBOX/Outbox", None, "outbox"),
        ("Archive", None, "archive"),
        ("[Gmail]/All Mail", Some("all"), "archive"),
    ] {
        assert_eq!(refusal(&folder(name, role)), Some(reason), "{name}");
    }
    for name in ["INBOX", "Sent", "Projects", "Receipts/2025"] {
        assert_eq!(refusal(&folder(name, None)), None, "{name}");
    }
}

#[test]
fn a_policy_is_checked_against_the_account_and_its_folders() {
    let all = folders();
    let ok = policy(Destination::Local);
    validate(&ok, AccountKind::Imap, &all).unwrap();
    for name in ["Drafts", "Trash", "Junk", "Archive"] {
        let mut p = ok.clone();
        p.folders.push(FolderChoice { name: name.into(), older_than: None });
        let error = validate(&p, AccountKind::Imap, &all).unwrap_err().to_string();
        assert!(error.contains("never archived"), "{name}: {error}");
    }
    let mut missing = ok.clone();
    missing.folders = vec![FolderChoice { name: "Nowhere".into(), older_than: None }];
    assert!(validate(&missing, AccountKind::Imap, &all).is_err());
    let mut none = ok.clone();
    none.folders.clear();
    assert!(validate(&none, AccountKind::Imap, &all).is_err());
    let mut twice = ok.clone();
    twice.folders.push(FolderChoice { name: "INBOX".into(), older_than: None });
    assert!(validate(&twice, AccountKind::Imap, &all).is_err());
    for age in [Age { value: 0, unit: AgeUnit::Days }, Age { value: MAX_MONTHS + 1, unit: AgeUnit::Months }] {
        assert!(validate(&Policy { older_than: age, ..ok.clone() }, AccountKind::Imap, &all).is_err());
    }
    let mut per_folder = ok.clone();
    per_folder.folders[0].older_than = Some(Age { value: MAX_DAYS + 1, unit: AgeUnit::Days });
    assert!(validate(&per_folder, AccountKind::Imap, &all).is_err());
    // Graph and EWS cannot hand over original bytes: server archive only.
    assert!(validate(&ok, AccountKind::Graph, &all).is_err());
    validate(&policy(Destination::Server), AccountKind::Ews, &all).unwrap();
    assert!(validate(&ok, AccountKind::LocalStore, &all).is_err());
    let keep_on_server = Policy { keep_server_copy: true, ..policy(Destination::Server) };
    assert!(validate(&keep_on_server, AccountKind::Imap, &all).is_err());
}

#[test]
fn turning_a_policy_on_needs_its_preview_confirmed_and_a_change_asks_again() {
    let db = db();
    let conn = db.lock().unwrap();
    let all = folders();
    let p = policy(Destination::Server);
    let off = Policy { enabled: false, ..p.clone() };
    assert_eq!(load(&conn, ACCOUNT).unwrap().policy, Policy::default());
    assert!(!Policy::default().enabled, "off by default");

    let error = save(&conn, ACCOUNT, &p, None, AccountKind::Imap, &all).unwrap_err().to_string();
    assert!(error.contains("confirm"), "{error}");
    assert!(save(&conn, ACCOUNT, &p, Some("stale"), AccountKind::Imap, &all).is_err());
    // Saving it off needs no confirmation, and is not one.
    let stored = save(&conn, ACCOUNT, &off, None, AccountKind::Imap, &all).unwrap();
    assert!(!is_confirmed(ACCOUNT, &stored));

    let print = fingerprint(ACCOUNT, &p);
    assert_eq!(print, fingerprint(ACCOUNT, &off), "being on is not part of what is confirmed");
    assert_ne!(print, fingerprint("other@x.cat", &p), "a confirmation is for one account");
    let stored = save(&conn, ACCOUNT, &p, Some(&print), AccountKind::Imap, &all).unwrap();
    assert!(is_confirmed(ACCOUNT, &stored) && stored.policy.enabled);
    assert_eq!(next_run(ACCOUNT, &stored), Some(0), "the first run comes at the next check");

    // Turning it off and on again keeps the confirmation...
    save(&conn, ACCOUNT, &off, None, AccountKind::Imap, &all).unwrap();
    assert!(save(&conn, ACCOUNT, &p, None, AccountKind::Imap, &all).unwrap().policy.enabled);
    // ...but anything that changes what moves asks again.
    let changed = Policy { older_than: Age { value: 10, unit: AgeUnit::Days }, ..p.clone() };
    assert!(save(&conn, ACCOUNT, &changed, None, AccountKind::Imap, &all).is_err());
    let changed_off = Policy { enabled: false, ..changed.clone() };
    let stored = save(&conn, ACCOUNT, &changed_off, None, AccountKind::Imap, &all).unwrap();
    assert!(!is_confirmed(ACCOUNT, &stored));
    assert_eq!(next_run(ACCOUNT, &stored), None);

    let mut reordered = p.clone();
    reordered.folders.push(FolderChoice { name: "Projects".into(), older_than: None });
    let mut other_order = reordered.clone();
    other_order.folders.reverse();
    assert_eq!(fingerprint(ACCOUNT, &reordered), fingerprint(ACCOUNT, &other_order));
}

#[test]
fn a_policy_runs_daily_and_retries_an_hour_after_a_run_that_could_not_start() {
    let p = policy(Destination::Server);
    let confirmed = Some(fingerprint(ACCOUNT, &p));
    let stored = |attempt, success| Stored {
        policy: p.clone(),
        confirmed: confirmed.clone(),
        last_attempt: attempt,
        last_success: success,
        last_error: None,
    };
    assert_eq!(next_run(ACCOUNT, &stored(Some(100), Some(100))), Some(100 + DAY));
    assert_eq!(next_run(ACCOUNT, &stored(Some(5000), Some(100))), Some(100 + DAY));
    assert_eq!(next_run(ACCOUNT, &stored(Some(DAY * 2), Some(100))), Some(DAY * 2 + RETRY_SECONDS));
    assert_eq!(next_run(ACCOUNT, &stored(Some(100), None)), Some(100 + RETRY_SECONDS));
    let off = Stored { policy: Policy { enabled: false, ..p.clone() }, ..stored(None, None) };
    assert_eq!(next_run(ACCOUNT, &off), None);
    let unconfirmed = Stored { confirmed: None, ..stored(None, None) };
    assert_eq!(next_run(ACCOUNT, &unconfirmed), None);

    let db = db();
    let conn = db.lock().unwrap();
    save(&conn, ACCOUNT, &p, confirmed.as_deref(), AccountKind::Imap, &folders()).unwrap();
    assert_eq!(due(&conn, 10).unwrap(), vec![ACCOUNT.to_string()]);
    conn.execute("UPDATE auto_archive_policies SET last_attempt = 10, last_success = 10", []).unwrap();
    assert!(due(&conn, 10 + DAY - 1).unwrap().is_empty());
    assert_eq!(due(&conn, 10 + DAY).unwrap().len(), 1);
}

// ---- Running, with a stand-in server ----------------------------------------

#[derive(Default)]
struct Fake<'a> {
    db: Option<&'a Mutex<Connection>>,
    server: BTreeMap<String, BTreeMap<u32, (Candidate, Vec<u8>)>>,
    archive: Option<String>,
    fail_fetch: HashSet<u32>,
    fail_store: HashSet<u32>,
    /// Writes something other than the original, as a damaged disk would.
    corrupt_store: HashSet<u32>,
    fail_read: bool,
    fail_delete: bool,
    fail_move: bool,
    fail_search: bool,
    stores: usize,
    deletes: Vec<Vec<u32>>,
}

impl<'a> Fake<'a> {
    fn new(db: &'a Mutex<Connection>, messages: &[Candidate]) -> Self {
        let mut fake = Fake { db: Some(db), archive: Some("Archive".into()), ..Default::default() };
        for c in messages {
            fake.server.entry("INBOX".into()).or_default().insert(c.uid, (c.clone(), raw(c.uid)));
        }
        fake.server.entry("Archive".into()).or_default();
        fake
    }

    fn local(&self) -> LocalArchive<'a> {
        LocalArchive { db: self.db.unwrap(), media_root: media() }
    }

    fn uids(&self, folder: &str) -> Vec<u32> {
        self.server.get(folder).map(|m| m.keys().copied().collect()).unwrap_or_default()
    }
}

impl Steps for Fake<'_> {
    fn candidates(&mut self, folder: &str, _cutoff: i64) -> impl Future<Output = Result<Vec<Candidate>>> + Send {
        let result = if self.fail_search {
            Err(anyhow::anyhow!("connection reset"))
        } else {
            Ok(self.server.get(folder).map(|m| m.values().map(|(c, _)| c.clone()).collect()).unwrap_or_default())
        };
        async move { result }
    }

    fn archive_folder(&mut self) -> impl Future<Output = Result<Option<String>>> + Send {
        let archive = self.archive.clone();
        async move { Ok(archive) }
    }

    fn fetch(&mut self, folder: &str, uid: u32) -> impl Future<Output = Result<Option<RawMessageCopy>>> + Send {
        let result = if self.fail_fetch.contains(&uid) {
            Err(anyhow::anyhow!("fetch timed out"))
        } else {
            Ok(self
                .server
                .get(folder)
                .and_then(|m| m.get(&uid))
                .map(|(c, raw)| RawMessageCopy { raw: raw.clone(), seen: c.seen, starred: c.starred }))
        };
        async move { result }
    }

    fn move_to(&mut self, folder: &str, target: &str, uids: &[u32]) -> impl Future<Output = Result<()>> + Send {
        let result = if self.fail_move {
            Err(anyhow::anyhow!("MOVE refused"))
        } else {
            for uid in uids {
                if let Some(item) = self.server.get_mut(folder).and_then(|m| m.remove(uid)) {
                    self.server.entry(target.to_string()).or_default().insert(*uid + 1000, item);
                }
            }
            Ok(())
        };
        async move { result }
    }

    fn delete(&mut self, folder: &str, uids: &[u32]) -> impl Future<Output = Result<()>> + Send {
        let result = if self.fail_delete {
            Err(anyhow::anyhow!("EXPUNGE failed"))
        } else {
            self.deletes.push(uids.to_vec());
            for uid in uids {
                self.server.get_mut(folder).map(|m| m.remove(uid));
            }
            Ok(())
        };
        async move { result }
    }

    fn store_local(&mut self, folder: &str, message: &RawMessageCopy) -> Result<u32> {
        let id = imap::header_fields(crate::archive::header_block(&message.raw)).message_id;
        let uid: u32 = id.trim_start_matches(['<', 'm']).split('@').next().unwrap_or_default().parse().unwrap_or(0);
        if self.fail_store.contains(&uid) {
            bail!("disk full");
        }
        self.stores += 1;
        if self.corrupt_store.contains(&uid) {
            let mut damaged = message.clone();
            damaged.raw.extend_from_slice(b"garbage");
            return self.local().store(folder, &damaged);
        }
        self.local().store(folder, message)
    }

    fn read_local(&mut self, folder: &str, uid: u32) -> Result<Option<Vec<u8>>> {
        if self.fail_read {
            bail!("database is locked");
        }
        self.local().read(folder, uid)
    }

    fn find_local(&mut self, folder: &str, message_id: &str) -> Result<Vec<u32>> {
        self.local().find(folder, message_id)
    }

    fn remove_local(&mut self, folder: &str, uid: u32) -> Result<()> {
        self.local().remove(folder, uid)
    }
}

fn local_raws(db: &Mutex<Connection>) -> Vec<Vec<u8>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT raw FROM archive_messages WHERE account = ?1 AND folder = ?2 ORDER BY uid")
        .unwrap();
    stmt.query_map(params![crate::archive::ACCOUNT, local_folder(ACCOUNT, "INBOX")], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn journal_count(db: &Mutex<Connection>) -> i64 {
    db.lock().unwrap().query_row("SELECT COUNT(*) FROM auto_archive_items", [], |r| r.get(0)).unwrap()
}

fn old_mail() -> Vec<Candidate> {
    let old = at(2026, 1, 5, 9, 0, 0);
    vec![
        candidate(1, old, true, false),
        candidate(2, old + 60, true, false),
        candidate(3, old + 120, true, false),
        // Kept by the defaults: unread, flagged, too new.
        candidate(4, old, false, false),
        candidate(5, old, true, true),
        candidate(6, at(2026, 10, 1, 9, 0, 0), true, false),
    ]
}

async fn plan_and_execute(fake: &mut Fake<'_>, db: &Mutex<Connection>, p: &Policy) -> RunLog {
    let planned = plan(fake, db, ACCOUNT, ACCOUNT, p, &cutoffs(p, &now())).await.unwrap();
    execute(fake, db, p, &planned, 1).await
}

#[tokio::test]
async fn the_preview_counts_per_folder_and_moves_nothing() {
    let db = db();
    let mut fake = Fake::new(&db, &old_mail());
    fake.server.entry("Projects".into()).or_default().insert(7, (candidate(7, at(2026, 9, 1, 9, 0, 0), true, false), raw(7)));
    let mut p = policy(Destination::Local);
    p.folders.push(FolderChoice { name: "Projects".into(), older_than: Some(Age { value: 7, unit: AgeUnit::Days }) });
    let planned = plan(&mut fake, &db, ACCOUNT, ACCOUNT, &p, &cutoffs(&p, &now())).await.unwrap();
    assert_eq!(planned.total, 4);
    assert_eq!(planned.folders[0].count, 3);
    assert_eq!(planned.folders[0].target, "Archived/ana@x.cat/INBOX");
    assert_eq!(planned.folders[1].count, 1, "the folder's own age applies to it");
    assert_eq!(planned.fingerprint, fingerprint(ACCOUNT, &p));
    assert_eq!(fake.uids("INBOX").len(), 6, "a preview moves nothing");
    assert_eq!(fake.stores, 0);

    let server = plan(&mut fake, &db, ACCOUNT, ACCOUNT, &policy(Destination::Server), &cutoffs(&p, &now())[..1]).await.unwrap();
    assert_eq!((server.target.as_str(), server.total), ("Archive", 3));
    fake.archive = None;
    let error = plan(&mut fake, &db, ACCOUNT, ACCOUNT, &policy(Destination::Server), &cutoffs(&p, &now())).await.unwrap_err();
    assert!(error.to_string().contains("no Archive folder"), "{error}");
}

#[tokio::test]
async fn to_the_local_archive_each_message_is_copied_checked_and_only_then_removed() {
    let db = db();
    let mut fake = Fake::new(&db, &old_mail());
    let log = plan_and_execute(&mut fake, &db, &policy(Destination::Local)).await;
    assert_eq!((log.moved, log.failed, log.kept), (3, 0, 0), "{log:?}");
    assert_eq!(fake.uids("INBOX"), vec![4, 5, 6]);
    assert_eq!(local_raws(&db), vec![raw(1), raw(2), raw(3)], "the original bytes, exactly");
    assert_eq!(journal_count(&db), 0, "nothing is left between steps");
    // The archive is an account like any other: the copies are listed.
    let listed: i64 = db
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM messages WHERE account = ?1", params![crate::archive::ACCOUNT], |r| r.get(0))
        .unwrap();
    assert_eq!(listed, 3);

    // Running again finds nothing more to do.
    let again = plan_and_execute(&mut fake, &db, &policy(Destination::Local)).await;
    assert_eq!((again.moved, again.failed), (0, 0));
    assert_eq!(local_raws(&db).len(), 3);
}

#[tokio::test]
async fn a_failed_fetch_or_copy_leaves_the_message_on_the_server_and_says_which() {
    let db = db();
    let mut fake = Fake::new(&db, &old_mail());
    fake.fail_fetch.insert(1);
    fake.fail_store.insert(2);
    let log = plan_and_execute(&mut fake, &db, &policy(Destination::Local)).await;
    assert_eq!((log.moved, log.failed), (1, 2));
    let steps: Vec<(u32, &str)> = log.failures.iter().map(|f| (f.uid, f.step.as_str())).collect();
    assert_eq!(steps, vec![(1, "fetch"), (2, "copy")]);
    assert_eq!(log.failures[1].subject, "Message 2");
    assert!(log.failures[1].error.contains("disk full"));
    assert_eq!(fake.uids("INBOX"), vec![1, 2, 4, 5, 6]);
    assert_eq!(local_raws(&db), vec![raw(3)]);
    assert_eq!(log.folders[0], FolderOutcome { folder: "INBOX".into(), selected: 3, moved: 1, kept: 0, failed: 2 });
}

#[tokio::test]
async fn a_copy_that_does_not_match_is_removed_and_the_original_stays() {
    let db = db();
    let mut fake = Fake::new(&db, &old_mail());
    fake.corrupt_store.insert(2);
    let log = plan_and_execute(&mut fake, &db, &policy(Destination::Local)).await;
    assert_eq!((log.moved, log.failed), (2, 1));
    assert_eq!(log.failures[0].step, "verify");
    assert!(fake.uids("INBOX").contains(&2), "never removed from the server");
    assert_eq!(local_raws(&db), vec![raw(1), raw(3)], "the damaged copy is gone");
    assert_eq!(journal_count(&db), 0);

    // A copy that cannot be read back is not trusted either.
    let db = self::db();
    let mut fake = Fake::new(&db, &old_mail());
    fake.fail_read = true;
    let log = plan_and_execute(&mut fake, &db, &policy(Destination::Local)).await;
    assert_eq!((log.moved, log.failed), (0, 3));
    assert!(log.failures.iter().all(|f| f.step == "verify"), "{log:?}");
    assert_eq!(fake.uids("INBOX").len(), 6);
    assert!(fake.deletes.is_empty());
}

#[tokio::test]
async fn a_failed_removal_keeps_the_copy_and_the_next_run_finishes_without_a_second_copy() {
    let db = db();
    let mut fake = Fake::new(&db, &old_mail());
    fake.fail_delete = true;
    let log = plan_and_execute(&mut fake, &db, &policy(Destination::Local)).await;
    assert_eq!((log.moved, log.failed), (0, 3));
    assert!(log.failures.iter().all(|f| f.step == "delete" && f.error.contains("archived copy is kept")));
    assert_eq!(fake.uids("INBOX"), vec![1, 2, 3, 4, 5, 6], "on the server still");
    assert_eq!(local_raws(&db).len(), 3, "and copied here");
    assert_eq!(journal_count(&db), 3, "remembered as verified");

    fake.fail_delete = false;
    let stores = fake.stores;
    let log = plan_and_execute(&mut fake, &db, &policy(Destination::Local)).await;
    assert_eq!((log.moved, log.failed), (3, 0));
    assert_eq!(fake.stores, stores, "nothing is copied twice");
    assert_eq!(local_raws(&db).len(), 3);
    assert_eq!(fake.uids("INBOX"), vec![4, 5, 6]);
    assert_eq!(journal_count(&db), 0);
}

#[tokio::test]
async fn a_stop_between_the_copy_and_its_check_is_finished_from_the_copy_already_made() {
    let db = db();
    let mut fake = Fake::new(&db, &old_mail());
    // As a crash would leave it: the copy written, the journal at "copied".
    let local = local_folder(ACCOUNT, "INBOX");
    let copy = RawMessageCopy { raw: raw(1), seen: true, starred: false };
    let uid = fake.local().store(&local, &copy).unwrap();
    journal_set(&db.lock().unwrap(), ACCOUNT, "INBOX", 1, "m1@x.cat", &local, uid, Stage::Copied, 1).unwrap();
    // And one copied by an earlier run whose journal row was lost.
    fake.local().store(&local, &RawMessageCopy { raw: raw(2), seen: true, starred: false }).unwrap();

    let log = plan_and_execute(&mut fake, &db, &policy(Destination::Local)).await;
    assert_eq!((log.moved, log.failed), (3, 0));
    assert_eq!(fake.stores, 1, "only the third message needed a copy");
    assert_eq!(local_raws(&db), vec![raw(1), raw(2), raw(3)]);
}

#[tokio::test]
async fn a_message_gone_from_the_server_before_its_turn_is_counted_not_failed() {
    let db = db();
    let mut fake = Fake::new(&db, &old_mail());
    let p = policy(Destination::Local);
    let planned = plan(&mut fake, &db, ACCOUNT, ACCOUNT, &p, &cutoffs(&p, &now())).await.unwrap();
    fake.server.get_mut("INBOX").unwrap().remove(&2);
    let log = execute(&mut fake, &db, &p, &planned, 1).await;
    assert_eq!((log.moved, log.gone, log.failed), (2, 1, 0));
}

#[tokio::test]
async fn keeping_the_server_copy_archives_once_and_not_again() {
    let db = db();
    let mut fake = Fake::new(&db, &old_mail());
    let p = Policy { keep_server_copy: true, ..policy(Destination::Local) };
    let log = plan_and_execute(&mut fake, &db, &p).await;
    assert_eq!((log.moved, log.kept), (0, 3));
    assert!(fake.deletes.is_empty());
    assert_eq!(fake.uids("INBOX").len(), 6);
    let planned = plan(&mut fake, &db, ACCOUNT, ACCOUNT, &p, &cutoffs(&p, &now())).await.unwrap();
    assert_eq!(planned.total, 0, "already archived");
    assert_eq!(local_raws(&db).len(), 3);
}

#[tokio::test]
async fn to_the_server_archive_mail_is_moved_and_a_refused_move_is_listed() {
    let db = db();
    let mut fake = Fake::new(&db, &old_mail());
    let log = plan_and_execute(&mut fake, &db, &policy(Destination::Server)).await;
    assert_eq!((log.moved, log.failed, log.target.as_str()), (3, 0, "Archive"));
    assert_eq!(fake.uids("INBOX"), vec![4, 5, 6]);
    assert_eq!(fake.uids("Archive").len(), 3);
    assert!(local_raws(&db).is_empty());

    let db = self::db();
    let mut fake = Fake::new(&db, &old_mail());
    fake.fail_move = true;
    let log = plan_and_execute(&mut fake, &db, &policy(Destination::Server)).await;
    assert_eq!((log.moved, log.failed), (0, 3));
    assert!(log.failures.iter().all(|f| f.step == "move" && f.error.contains("MOVE refused")));
    assert_eq!(fake.uids("INBOX").len(), 6);

    let mut from_archive = policy(Destination::Server);
    from_archive.folders = vec![FolderChoice { name: "Archive".into(), older_than: None }];
    assert!(plan(&mut fake, &db, ACCOUNT, ACCOUNT, &from_archive, &cutoffs(&from_archive, &now())).await.is_err());
}

async fn go<'a>(fake: &mut Fake<'a>, db: &'a Mutex<Connection>, at: i64) -> Result<RunLog> {
    run(fake, db, ACCOUNT, ACCOUNT, "manual", |p| cutoffs(p, &now()), at, || at + 5).await
}

#[tokio::test]
async fn a_run_needs_a_confirmed_policy_and_logs_what_happened() {
    let _turn = SERIAL.lock().await;
    let db = db();
    let mut fake = Fake::new(&db, &old_mail());
    let p = policy(Destination::Local);
    let result = go(&mut fake, &db, 100).await;
    assert!(result.unwrap_err().to_string().contains("confirm"));
    assert!(runs(&db.lock().unwrap(), ACCOUNT).unwrap().is_empty(), "nothing ran, so nothing is logged");

    save(&db.lock().unwrap(), ACCOUNT, &p, Some(&fingerprint(ACCOUNT, &p)), AccountKind::Imap, &folders()).unwrap();
    fake.fail_store.insert(3);
    let result = go(&mut fake, &db, 200).await;
    let log = result.unwrap();
    assert_eq!((log.moved, log.failed, log.trigger.as_str(), log.finished_at), (2, 1, "manual", 205));
    let stored = load(&db.lock().unwrap(), ACCOUNT).unwrap();
    assert_eq!((stored.last_attempt, stored.last_success, stored.last_error), (Some(200), Some(200), None));
    let logged = runs(&db.lock().unwrap(), ACCOUNT).unwrap();
    assert_eq!(logged.len(), 1);
    assert_eq!(logged[0].failures[0].uid, 3);
    assert_eq!(logged[0].id, log.id);

    // A run that cannot reach the server is logged as such and retried.
    fake.fail_search = true;
    let result = go(&mut fake, &db, 300).await;
    let log = result.unwrap();
    assert!(log.error.as_deref().unwrap_or_default().contains("connection reset"), "{log:?}");
    let stored = load(&db.lock().unwrap(), ACCOUNT).unwrap();
    assert_eq!(stored.last_success, Some(200));
    assert!(stored.last_error.is_some());
    assert_eq!(next_run(ACCOUNT, &stored), Some(200 + DAY), "the daily turn still comes; a retry never brings it forward");

    // The log keeps the most recent runs only.
    for n in 0..KEEP_RUNS + 5 {
        let _ = go(&mut fake, &db, 400 + n).await;
    }
    let logged = runs(&db.lock().unwrap(), ACCOUNT).unwrap();
    assert_eq!(logged.len() as i64, KEEP_RUNS);
    assert!(logged.windows(2).all(|w| w[0].id > w[1].id), "newest first");
}

#[tokio::test]
async fn only_one_run_goes_at_a_time() {
    let _turn = SERIAL.lock().await;
    let held = RunGuard::take().unwrap();
    assert!(running());
    assert!(RunGuard::take().is_err());
    drop(held);
    assert!(!running());
}

#[test]
fn removing_the_account_takes_its_policy_log_and_progress() {
    let db = db();
    let conn = db.lock().unwrap();
    let p = policy(Destination::Server);
    save(&conn, ACCOUNT, &p, Some(&fingerprint(ACCOUNT, &p)), AccountKind::Imap, &folders()).unwrap();
    record(&conn, &RunLog { account: ACCOUNT.into(), ..Default::default() }).unwrap();
    journal_set(&conn, ACCOUNT, "INBOX", 1, "m1@x.cat", "Archived/x/INBOX", 1, Stage::Kept, 1).unwrap();
    crate::store::delete_account(&conn, ACCOUNT).unwrap();
    for table in ["auto_archive_policies", "auto_archive_runs", "auto_archive_items"] {
        let left: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "{table}");
    }
}

#[test]
fn a_restored_profile_does_not_archive_on_its_own() {
    let db = db();
    let conn = db.lock().unwrap();
    let p = policy(Destination::Server);
    save(&conn, ACCOUNT, &p, Some(&fingerprint(ACCOUNT, &p)), AccountKind::Imap, &folders()).unwrap();
    crate::profile_archive::hold_restored(&conn).unwrap();
    let stored = load(&conn, ACCOUNT).unwrap();
    assert!(!stored.policy.enabled);
    assert_eq!(next_run(ACCOUNT, &stored), None);
}

#[test]
fn status_lists_the_folders_with_why_some_are_never_archived() {
    let db = db();
    let status = status(&db.lock().unwrap(), ACCOUNT, AccountKind::Graph, &folders()).unwrap();
    assert!(!status.local_supported && !status.confirmed && !status.policy.enabled);
    let refused: Vec<(&str, Option<&str>)> = status.folders.iter().map(|f| (f.name.as_str(), f.refused)).collect();
    assert_eq!(
        refused,
        vec![
            ("INBOX", None),
            ("Projects", None),
            ("Sent", None),
            ("Drafts", Some("drafts")),
            ("Trash", Some("trash")),
            ("Junk", Some("junk")),
            ("Archive", Some("archive")),
        ]
    );
}

#[test]
fn cached_candidates_are_the_synced_rows_older_than_the_cutoff() {
    let db = db();
    let conn = db.lock().unwrap();
    let header = |uid: u32, date: i64| imap::MessageHeader {
        uid,
        date,
        seen: true,
        subject: format!("S{uid}"),
        message_id: format!("m{uid}@x.cat"),
        ..Default::default()
    };
    crate::store::upsert_messages(&conn, ACCOUNT, "INBOX", &[header(1, 100), header(2, 5000), header(3, 0)]).unwrap();
    let found = cached_candidates(&conn, ACCOUNT, "INBOX", 1000).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!((found[0].uid, found[0].message_id.as_str(), found[0].subject.as_str()), (1, "m1@x.cat", "S1"));
}
