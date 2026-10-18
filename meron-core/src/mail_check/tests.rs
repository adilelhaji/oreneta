use super::*;
use crate::imap::Folder;
use std::sync::{Arc, Mutex};

fn folder(name: &str, special_use: Option<&str>) -> Folder {
    Folder { name: name.into(), special_use: special_use.map(str::to_string), ..Default::default() }
}

fn names(list: &[&str]) -> HashSet<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn candidate(account: &str, delivery: Delivery, paused: bool, interval: Result<u64, String>) -> Candidate {
    Candidate { account: account.into(), delivery, paused, interval }
}

#[test]
fn manual_stays_manual_and_the_rest_is_bounded() {
    assert_eq!(normalize(0), MANUAL);
    assert_eq!(normalize(1), 5);
    assert_eq!(normalize(15), 15);
    assert_eq!(normalize(100_000), 1440);
}

#[test]
fn a_new_account_starts_at_fifteen_minutes() {
    let prefs: serde_json::Value = serde_json::from_str(&new_account_prefs()).unwrap();
    assert_eq!(prefs["mail_check_interval_minutes"], NEW_ACCOUNT_INTERVAL_MINUTES);
    assert_eq!(NEW_ACCOUNT_INTERVAL_MINUTES, 15);
}

#[test]
fn trash_junk_and_gmail_all_mail_are_never_checked() {
    for f in [
        folder("Bin", Some("trash")),
        folder("Bulk", Some("junk")),
        folder("Everything", Some("all")),
        folder("[Gmail]/All Mail", None),
        folder("[Google Mail]/All Mail", None),
        folder("Trash", None),
        folder("INBOX.Junk", None),
    ] {
        assert!(excluded(&f), "{} should be excluded", f.name);
    }
    for f in [
        folder("INBOX", None),
        folder("Sent", Some("sent")),
        folder("Archive", Some("archive")),
        folder("Projects/All Mail", None),
        folder("Clients", None),
    ] {
        assert!(!excluded(&f), "{} should be checked", f.name);
    }
}

#[test]
fn imap_checks_the_selectable_unwatched_folders_only() {
    let cached = vec![
        folder("INBOX", None),
        folder("[Gmail]", None),
        folder("[Gmail]/All Mail", Some("all")),
        folder("[Gmail]/Sent Mail", Some("sent")),
        folder("[Gmail]/Spam", Some("junk")),
        folder("Board", None),
        folder("Deleted elsewhere", None),
        folder("Clients", None),
        folder("Clients", None),
    ];
    // What the server lists now as selectable: the container `[Gmail]` and the
    // folder deleted from another client are not in it.
    let live = names(&["INBOX", "[Gmail]/All Mail", "[Gmail]/Sent Mail", "[Gmail]/Spam", "Board", "Clients"]);
    let watched = |f: &str| f == "INBOX" || f == "Board";
    assert_eq!(
        folders_to_check(Delivery::Imap, &cached, &live, watched),
        vec!["[Gmail]/Sent Mail", "Clients"]
    );
}

#[test]
fn accounts_without_push_check_every_folder_the_inbox_too() {
    let cached = vec![folder("INBOX", None), folder("Sent Items", Some("sent")), folder("Deleted Items", Some("trash"))];
    let live = names(&["INBOX", "Sent Items", "Deleted Items"]);
    // A watcher entry for an account without push does not count.
    assert_eq!(
        folders_to_check(Delivery::Unpushed, &cached, &live, |_| true),
        vec!["INBOX", "Sent Items"]
    );
    assert_eq!(folders_to_check(Delivery::Pop3, &[], &HashSet::new(), |_| false), vec!["INBOX"]);
    assert!(folders_to_check(Delivery::Local, &cached, &live, |_| false).is_empty());
}

#[test]
fn an_account_counts_its_interval_from_when_it_is_first_seen() {
    let mut schedule = Schedule::default();
    // Not seen yet: never due, whatever the clock says.
    assert!(!schedule.due("a", 15, 1_000_000));
    schedule.see("a", 1_000);
    assert!(!schedule.due("a", 15, 1_000 + 14 * 60));
    assert!(schedule.due("a", 15, 1_000 + 15 * 60));
    // Seeing it again does not move its time.
    schedule.see("a", 1_000 + 10 * 60);
    assert!(schedule.due("a", 15, 1_000 + 15 * 60));
    schedule.start("a", 1_000 + 15 * 60);
    // Not again while it runs, however long it takes.
    assert!(!schedule.due("a", 15, 1_000 + 60 * 60));
    schedule.finish("a");
    assert!(!schedule.due("a", 15, 1_000 + 29 * 60));
    assert!(schedule.due("a", 15, 1_000 + 30 * 60));
    // A shorter interval chosen later applies from the last check.
    assert!(schedule.due("a", 5, 1_000 + 20 * 60));
    assert!(!schedule.due("a", MANUAL, i64::MAX / 2));
}

#[test]
fn removed_accounts_are_forgotten() {
    let mut schedule = Schedule::default();
    schedule.start("gone", 100);
    schedule.start("kept", 100);
    schedule.retain(&names(&["kept"]));
    // The removed one is unknown again; the kept one still runs.
    assert!(!schedule.due("gone", 5, 100_000));
    schedule.see("gone", 100_000);
    assert!(schedule.due("gone", 5, 100_000 + 5 * 60));
    assert!(!schedule.due("kept", 5, 100_000));
}

#[test]
fn a_tick_skips_what_must_not_be_checked_and_starts_what_is_due() {
    let mut schedule = Schedule::default();
    let candidates = vec![
        candidate("imap", Delivery::Imap, false, Ok(15)),
        candidate("manual", Delivery::Imap, false, Ok(MANUAL)),
        candidate("paused", Delivery::Imap, true, Ok(5)),
        candidate("archive", Delivery::Local, false, Ok(5)),
        candidate("broken", Delivery::Pop3, false, Err("database is locked".into())),
        candidate("pop", Delivery::Pop3, false, Ok(5)),
    ];
    // The first tick only notes the accounts: nothing has waited an interval.
    let (due, unreadable) = plan_tick(&mut schedule, &candidates, 0);
    assert!(due.is_empty());
    assert_eq!(unreadable, vec!["broken: database is locked".to_string()]);
    // Five minutes on, only the POP3 account (5 min) is due.
    let (due, _) = plan_tick(&mut schedule, &candidates, 5 * 60);
    assert_eq!(due, vec![("pop".to_string(), Delivery::Pop3)]);
    // It is now running: the next tick does not start it again.
    let (due, _) = plan_tick(&mut schedule, &candidates, 15 * 60);
    assert_eq!(due, vec![("imap".to_string(), Delivery::Imap)]);
    // "Manual only", paused and the local archive were never started.
    for account in ["manual", "paused", "archive", "broken"] {
        assert!(!schedule.running.contains(account), "{account}");
    }
}

#[test]
fn switching_back_from_manual_counts_from_then() {
    let mut schedule = Schedule::default();
    let on = vec![candidate("a", Delivery::Imap, false, Ok(5))];
    let off = vec![candidate("a", Delivery::Imap, false, Ok(MANUAL))];
    plan_tick(&mut schedule, &on, 0);
    plan_tick(&mut schedule, &off, 60);
    // Back on long after: the interval counts from now, not from the start.
    let (due, _) = plan_tick(&mut schedule, &on, 10_000);
    assert!(due.is_empty());
    let (due, _) = plan_tick(&mut schedule, &on, 10_000 + 5 * 60);
    assert_eq!(due.len(), 1);
}

#[test]
fn a_check_is_finished_however_it_ends() {
    let schedule = Arc::new(Mutex::new(Schedule::default()));
    schedule.lock().unwrap().start("a", 0);
    {
        let _running = Running::new(schedule.clone(), "a");
    }
    assert!(!schedule.lock().unwrap().running.contains("a"));

    schedule.lock().unwrap().start("b", 0);
    let shared = schedule.clone();
    let panicked = std::thread::spawn(move || {
        let _running = Running::new(shared, "b");
        panic!("a check that fails badly");
    })
    .join();
    assert!(panicked.is_err());
    assert!(!schedule.lock().unwrap().running.contains("b"));
}

#[test]
fn a_check_gives_one_error_naming_how_many_folders_failed() {
    let mut outcome = Outcome::default();
    outcome.record("INBOX", Ok(40));
    outcome.record("Clients", Err("SELECT Clients: NO".into()));
    outcome.record("Sent", Err("connection reset".into()));
    assert_eq!(outcome.synced, 40);
    assert_eq!(
        outcome.error_message(3).as_deref(),
        Some("periodic check: 2 of 3 folders failed; sync Clients: SELECT Clients: NO")
    );
    assert_eq!(Outcome::default().error_message(3), None);
}
