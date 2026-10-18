//! The periodic mail check of each account (#270).
//!
//! Push keeps working on its own: the IMAP IDLE watchers (the Inbox, and any
//! folder shown as a board column) are never touched here. The periodic check
//! covers what push does not — every other folder of an IMAP account, and the
//! whole of a POP3, Exchange (EWS) or Microsoft Graph account, none of which
//! has a watcher — at the interval the account chose, or never when it chose
//! to check by hand only.
//!
//! The interval is an account preference (`mail_check_interval_minutes` in
//! the account's `prefs`, so it travels with backups and profile archives
//! like every other preference); `0` means "manual only".

use std::collections::{HashMap, HashSet};

/// What an account with no choice of its own does: the same default the
/// mobile app's background refresh has (`BackgroundRefresh.kt`).
pub const DEFAULT_INTERVAL_MINUTES: u64 = 15;
/// "Check by hand only": no periodic check at all.
pub const MANUAL: u64 = 0;
pub const MIN_INTERVAL_MINUTES: u64 = 5;
pub const MAX_INTERVAL_MINUTES: u64 = 1440;
/// How many of a folder's newest messages a periodic check refreshes, as a
/// `messages.sync` without a limit does.
pub const SYNC_LIMIT: u32 = 50;
/// How often the scheduler looks for a due account.
pub const TICK_SECONDS: u64 = 60;

/// The interval to store for what was asked: "manual only" stays as it is,
/// anything else is kept within bounds so a typo cannot hammer a server or
/// silently never check.
pub fn normalize(minutes: u64) -> u64 {
    if minutes == MANUAL {
        MANUAL
    } else {
        minutes.clamp(MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES)
    }
}

/// How an account receives mail without being asked, which decides what the
/// periodic check has to cover.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// IMAP: IDLE pushes the folders being watched; the rest need checking.
    Imap,
    /// POP3: one Inbox, downloaded only when checked.
    Pop3,
    /// Exchange (EWS) and Microsoft Graph: no push in this app yet, so every
    /// folder needs checking.
    Unpushed,
    /// The local archive: no server, nothing to check.
    Local,
}

/// The folders a periodic check of an account refreshes, in the order given.
/// `watched` says whether push already covers a folder.
pub fn folders_to_check(delivery: Delivery, folders: &[String], watched: impl Fn(&str) -> bool) -> Vec<String> {
    match delivery {
        Delivery::Local => Vec::new(),
        Delivery::Pop3 => vec![crate::pop3::INBOX.to_string()],
        Delivery::Unpushed => dedupe(folders.iter().cloned()),
        Delivery::Imap => dedupe(folders.iter().filter(|f| !watched(f)).cloned()),
    }
}

fn dedupe(folders: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    folders.filter(|f| !f.is_empty() && seen.insert(f.clone())).collect()
}

/// When each account was last checked, and which checks are still running.
/// Kept in memory: after a restart the first periodic check comes one interval
/// after start, the app having already synced the Inbox at start.
#[derive(Debug, Default)]
pub struct Schedule {
    last: HashMap<String, i64>,
    running: HashSet<String>,
}

impl Schedule {
    /// Whether `account` is due at `now` (seconds) with `interval` minutes:
    /// never for "manual only", never while its previous check still runs,
    /// and otherwise once the interval has passed since its last check — or
    /// since `started`, for an account not checked yet in this run.
    pub fn due(&self, account: &str, interval: u64, started: i64, now: i64) -> bool {
        if interval == MANUAL || self.running.contains(account) {
            return false;
        }
        let since = self.last.get(account).copied().unwrap_or(started);
        now.saturating_sub(since) >= (interval as i64).saturating_mul(60)
    }

    /// Records that a check of `account` starts at `now`.
    pub fn start(&mut self, account: &str, now: i64) {
        self.last.insert(account.to_string(), now);
        self.running.insert(account.to_string());
    }

    pub fn finish(&mut self, account: &str) {
        self.running.remove(account);
    }

    /// Forgets accounts that are gone, so a re-added one starts afresh.
    pub fn retain(&mut self, accounts: &HashSet<String>) {
        self.last.retain(|account, _| accounts.contains(account));
        self.running.retain(|account| accounts.contains(account));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_stays_manual_and_the_rest_is_bounded() {
        assert_eq!(normalize(0), MANUAL);
        assert_eq!(normalize(1), 5);
        assert_eq!(normalize(15), 15);
        assert_eq!(normalize(100_000), 1440);
    }

    #[test]
    fn push_covered_folders_are_left_to_push() {
        let folders: Vec<String> = ["INBOX", "Sent", "Archive", "Sent", ""].iter().map(|s| s.to_string()).collect();
        let watched = |f: &str| f == "INBOX";
        assert_eq!(folders_to_check(Delivery::Imap, &folders, watched), vec!["Sent", "Archive"]);
        // Nothing pushes for Exchange or Graph: every folder, the Inbox too.
        assert_eq!(folders_to_check(Delivery::Unpushed, &folders, watched), vec!["INBOX", "Sent", "Archive"]);
        // POP3 has its Inbox only, which is downloaded when checked.
        assert_eq!(folders_to_check(Delivery::Pop3, &folders, watched), vec!["INBOX"]);
        assert!(folders_to_check(Delivery::Local, &folders, watched).is_empty());
    }

    #[test]
    fn an_account_is_due_once_its_interval_has_passed() {
        let mut schedule = Schedule::default();
        let started = 1_000;
        assert!(!schedule.due("a", 15, started, started + 14 * 60));
        assert!(schedule.due("a", 15, started, started + 15 * 60));
        schedule.start("a", started + 15 * 60);
        // Not again while it runs, however long it takes.
        assert!(!schedule.due("a", 15, started, started + 60 * 60));
        schedule.finish("a");
        assert!(!schedule.due("a", 15, started, started + 29 * 60));
        assert!(schedule.due("a", 15, started, started + 30 * 60));
        // A shorter interval chosen later applies from the last check.
        assert!(schedule.due("a", 5, started, started + 20 * 60));
    }

    #[test]
    fn manual_only_is_never_due() {
        let schedule = Schedule::default();
        assert!(!schedule.due("a", MANUAL, 0, i64::MAX / 2));
    }

    #[test]
    fn removed_accounts_are_forgotten() {
        let mut schedule = Schedule::default();
        schedule.start("gone", 100);
        schedule.start("kept", 100);
        schedule.retain(&["kept".to_string()].into_iter().collect());
        // The removed one is no longer "running": it is due again from the
        // start of the run; the kept one still runs.
        assert!(schedule.due("gone", 5, 0, 400));
        assert!(!schedule.due("kept", 5, 0, 400));
    }
}
