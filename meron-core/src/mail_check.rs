//! The periodic mail check of each account (#270, ADR-0071).
//!
//! Push keeps working on its own: the IMAP IDLE watchers (the Inbox, and any
//! folder shown as a board column) are never touched here. The periodic check
//! covers what push does not — the other selectable folders of an IMAP
//! account, and the folders of a POP3, Exchange (EWS) or Microsoft Graph
//! account, none of which has a watcher — at the interval the account chose,
//! or never when it chose to check by hand only. Trash, junk and Gmail's All
//! Mail are never checked: what lands there is not mail anybody waits for, and
//! All Mail repeats every other folder.
//!
//! The interval is an account preference (`mail_check_interval_minutes` in
//! the account's `prefs`, so it travels with backups and profile archives
//! like every other preference); `0` means "manual only". An account that
//! existed before this preference has none and stays manual; an account
//! created now starts at [`NEW_ACCOUNT_INTERVAL_MINUTES`] (ADR-0071, 1B).

use std::collections::{HashMap, HashSet};

/// "Check by hand only": no periodic check at all. Also what an account with
/// no choice of its own reads as — every account that existed before #270.
pub const MANUAL: u64 = 0;
/// What a newly added account starts with: the default of the mobile app's
/// background refresh (`BackgroundRefresh.kt`).
pub const NEW_ACCOUNT_INTERVAL_MINUTES: u64 = 15;
pub const MIN_INTERVAL_MINUTES: u64 = 5;
pub const MAX_INTERVAL_MINUTES: u64 = 1440;
/// How many of a folder's newest messages a periodic check refreshes, as a
/// `messages.sync` without a limit does.
pub const SYNC_LIMIT: u32 = 50;
/// How often the scheduler looks for a due account.
pub const TICK_SECONDS: u64 = 60;
/// The longest one account's check may take; a stalled server must not keep
/// the account from ever being checked again.
pub const CHECK_TIMEOUT_SECONDS: u64 = 10 * 60;

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

/// The `prefs` a new mail account row is created with.
pub fn new_account_prefs() -> String {
    serde_json::json!({ "mail_check_interval_minutes": NEW_ACCOUNT_INTERVAL_MINUTES }).to_string()
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

/// Whether a folder is left out of every periodic check: trash, junk and
/// Gmail's All Mail, recognised by their role (RFC 6154) or, when the server
/// does not say, by their name — as automatic archiving recognises them
/// (ADR-0054).
pub fn excluded(folder: &crate::imap::Folder) -> bool {
    let role = folder.special_use.as_deref().unwrap_or_default().to_ascii_lowercase();
    let name = folder.name.as_str();
    let last = name.rsplit(['/', '.']).next().unwrap_or(name);
    let any = |check: fn(&str) -> bool| check(name) || check(last);
    let gmail_all = {
        let lower = name.to_ascii_lowercase();
        (lower.starts_with("[gmail]") || lower.starts_with("[google mail]")) && last.eq_ignore_ascii_case("All Mail")
    };
    role == "trash"
        || role == "junk"
        || role == "all"
        || gmail_all
        || any(crate::imap::looks_like_trash)
        || any(crate::imap::looks_like_junk)
}

/// The folders a periodic check of an account refreshes, in the order given:
/// the known folders (`cached`) the server still lists as selectable
/// (`live`), less the excluded ones and, for IMAP, those push already covers
/// (`watched`). POP3 has its Inbox only.
pub fn folders_to_check(
    delivery: Delivery,
    cached: &[crate::imap::Folder],
    live: &HashSet<String>,
    watched: impl Fn(&str) -> bool,
) -> Vec<String> {
    match delivery {
        Delivery::Local => Vec::new(),
        Delivery::Pop3 => vec![crate::pop3::INBOX.to_string()],
        Delivery::Unpushed | Delivery::Imap => {
            let mut seen = HashSet::new();
            cached
                .iter()
                .filter(|f| !f.name.is_empty() && live.contains(&f.name) && !excluded(f))
                .filter(|f| delivery != Delivery::Imap || !watched(&f.name))
                .filter(|f| seen.insert(f.name.clone()))
                .map(|f| f.name.clone())
                .collect()
        }
    }
}

/// When each account was last checked, and which checks are still running.
/// Kept in memory: after a restart the first periodic check comes one interval
/// after start, the app having already synced the Inbox at start. An account
/// seen for the first time (added, or switched off "manual only") counts from
/// then, not from the start of the run.
#[derive(Debug, Default)]
pub struct Schedule {
    last: HashMap<String, i64>,
    running: HashSet<String>,
}

impl Schedule {
    /// Notes an account the scheduler has not seen yet in this run, so its
    /// interval counts from `now`. An account already known keeps its time.
    pub fn see(&mut self, account: &str, now: i64) {
        self.last.entry(account.to_string()).or_insert(now);
    }

    /// Whether `account` is due at `now` (seconds) with `interval` minutes:
    /// never for "manual only", never while its previous check still runs,
    /// never before it has been seen, and otherwise once the interval has
    /// passed since its last check.
    pub fn due(&self, account: &str, interval: u64, now: i64) -> bool {
        if interval == MANUAL || self.running.contains(account) {
            return false;
        }
        let Some(since) = self.last.get(account).copied() else { return false };
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

    /// Forgets an account that is now "manual only", so switching it back on
    /// counts the interval from then rather than checking at once.
    pub fn forget(&mut self, account: &str) {
        if !self.running.contains(account) {
            self.last.remove(account);
        }
    }

    /// Forgets accounts that are gone, so a re-added one starts afresh.
    pub fn retain(&mut self, accounts: &HashSet<String>) {
        self.last.retain(|account, _| accounts.contains(account));
        self.running.retain(|account| accounts.contains(account));
    }
}

/// One account as the scheduler sees it on a tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub account: String,
    pub delivery: Delivery,
    pub paused: bool,
    /// The stored interval, or why it could not be read.
    pub interval: Result<u64, String>,
}

/// The accounts to check on this tick, each marked as started. Never the
/// local archive, a paused account, an account whose interval cannot be read
/// (said once per tick in `unreadable`, never guessed) or a "manual only"
/// one; an account seen for the first time counts its interval from `now`.
/// Accounts no longer present are forgotten.
pub fn plan_tick(schedule: &mut Schedule, candidates: &[Candidate], now: i64) -> (Vec<(String, Delivery)>, Vec<String>) {
    let present: HashSet<String> = candidates.iter().map(|c| c.account.clone()).collect();
    schedule.retain(&present);
    let mut due = Vec::new();
    let mut unreadable = Vec::new();
    for candidate in candidates {
        if candidate.delivery == Delivery::Local || candidate.paused {
            continue;
        }
        let interval = match &candidate.interval {
            Ok(interval) => *interval,
            Err(error) => {
                unreadable.push(format!("{}: {error}", candidate.account));
                continue;
            }
        };
        if interval == MANUAL {
            schedule.forget(&candidate.account);
            continue;
        }
        schedule.see(&candidate.account, now);
        if schedule.due(&candidate.account, interval, now) {
            schedule.start(&candidate.account, now);
            due.push((candidate.account.clone(), candidate.delivery));
        }
    }
    (due, unreadable)
}

/// Marks a check of `account` finished however it ends — normally, by
/// timeout, or by a panic in the check — so the account is checked again.
pub struct Running {
    schedule: std::sync::Arc<std::sync::Mutex<Schedule>>,
    account: String,
}

impl Running {
    pub fn new(schedule: std::sync::Arc<std::sync::Mutex<Schedule>>, account: &str) -> Self {
        Running { schedule, account: account.to_string() }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        // A poisoned lock still holds the schedule: finishing must not be
        // skipped because another check panicked while holding it.
        let mut schedule = match self.schedule.lock() {
            Ok(schedule) => schedule,
            Err(poisoned) => poisoned.into_inner(),
        };
        schedule.finish(&self.account);
    }
}

/// What one account's check found: how many folders it synced, how many
/// failed and the first failure, for the single notice a check may give.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub synced: usize,
    pub failed: usize,
    pub first_error: Option<String>,
}

impl Outcome {
    pub fn record(&mut self, folder: &str, result: Result<usize, String>) {
        match result {
            Ok(count) => self.synced += count,
            Err(error) => {
                self.failed += 1;
                if self.first_error.is_none() {
                    self.first_error = Some(format!("sync {folder}: {error}"));
                }
            }
        }
    }

    /// The one error notice of the check, or `None` when nothing failed.
    pub fn error_message(&self, checked: usize) -> Option<String> {
        let first = self.first_error.as_deref()?;
        Some(format!("periodic check: {} of {checked} folders failed; {first}", self.failed))
    }
}

#[cfg(test)]
mod tests;
