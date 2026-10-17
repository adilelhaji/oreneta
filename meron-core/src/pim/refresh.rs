//! Keeping calendars and address books fresh without being asked (ADR-0045).
//!
//! The desktop refreshes a calendar window when a view opens it and a book
//! when the reader presses sync; it has no timer of its own. A phone is
//! looked at in glances, so it also refreshes on an interval: one standing
//! window around today per account, and every book, each when its last good
//! read is older than its interval. The answer carries the reminders that
//! came due ([`super::reminders`]), because a background run has no event
//! channel to hear them on and must post them itself.
//!
//! "Due" is read from the store (a calendar's `synced_at`, a book's
//! `last_sync_at`), so a run in a fresh process — a background task —
//! decides the same as the foreground. A failed attempt is remembered for the
//! process, so a server that keeps refusing is asked once an interval rather
//! than once a tick.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::calendar::SyncOutcome;
use super::Emit;
use crate::calendar;
use crate::engine::Engine;
use crate::imap::Creds;
use crate::store;

/// How old an account's calendars may get before they are read again.
pub const CALENDAR_EVERY: i64 = 15 * 60;
/// How old a book may get before it is read again. Contacts change far less
/// often than a diary, and a whole book is read each time.
pub const BOOKS_EVERY: i64 = 60 * 60;

/// The window kept fresh: from yesterday to five weeks ahead, in whole UTC
/// days so every run in a day asks for the same window. Wide enough for any
/// reminder a person sets and for the agenda's first screens.
pub fn standing_window(now: i64) -> (i64, i64) {
    let day = now - now.rem_euclid(86_400);
    (day - 86_400, day + 35 * 86_400)
}

/// What a run may do. `sync: false` only looks for reminders (no network);
/// `force` reads regardless of when things were last read; `calendars` and
/// `books` say which of the two to read (a Contacts screen's refresh asks
/// for its books alone).
#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub sync: bool,
    pub force: bool,
    pub calendars: bool,
    pub books: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { sync: true, force: false, calendars: true, books: true }
    }
}

/// Last attempt per calendar account or book, for this process.
fn attempts() -> &'static Mutex<HashMap<String, i64>> {
    static ATTEMPTS: std::sync::OnceLock<Mutex<HashMap<String, i64>>> = std::sync::OnceLock::new();
    ATTEMPTS.get_or_init(Default::default)
}

/// Whether `key` may be tried at `now`, recording the attempt if so.
fn try_attempt(key: &str, last_good: i64, every: i64, now: i64, force: bool) -> bool {
    if !force && now - last_good < every {
        return false;
    }
    let mut attempts = attempts().lock().unwrap();
    if !force && attempts.get(key).is_some_and(|at| now - at < every) {
        return false;
    }
    attempts.insert(key.to_string(), now);
    true
}

/// Whether an account has calendars a server answers for: its own (Exchange,
/// Google), or CalDAV and subscribed ones under it. Local calendars have
/// nothing to fetch.
fn has_remote_calendars(engine: &Arc<Engine>, account: &str, creds: &Creds) -> bool {
    if calendar::route::Route::of(creds) != calendar::route::Route::None {
        return true;
    }
    let db = engine.db.lock().unwrap();
    calendar::get_calendars(&db, account)
        .unwrap_or_default()
        .iter()
        .any(|c| matches!(c.kind, calendar::CalendarKind::CalDav | calendar::CalendarKind::Subscribed))
}

/// When an account's calendars were last read well: the newest `synced_at`
/// of its calendars that come from somewhere.
fn calendars_synced_at(engine: &Arc<Engine>, account: &str) -> i64 {
    let db = engine.db.lock().unwrap();
    calendar::get_calendars(&db, account)
        .unwrap_or_default()
        .iter()
        .filter(|c| c.kind != calendar::CalendarKind::Local)
        .map(|c| c.synced_at)
        .max()
        .unwrap_or(0)
}

/// One run: reminders due now, then (with `sync`) every calendar account and
/// book that is due, then the reminders those reads brought in.
///
/// Answers `{ reminders, calendars, books }`: the reminders raised (already
/// recorded, so the caller must post them), and one entry per calendar
/// account and book that was read, with `ok` and the `error` if it failed.
/// A calendar read also reports `calendar.synced` / `calendar.syncError`
/// through `emit`, like any other.
pub async fn run(engine: &Arc<Engine>, emit: &Emit, accounts: &[(String, Creds)], now: i64, options: Options) -> Value {
    let ids: Vec<String> = accounts.iter().map(|(id, _)| id.clone()).collect();
    let mut reminders = super::reminders::take_due(engine, &ids, now);
    let mut calendars = Vec::new();
    let mut books = Vec::new();

    if options.sync && options.calendars {
        let (from, to) = standing_window(now);
        for (account, creds) in accounts {
            if engine.is_paused(account) || !has_remote_calendars(engine, account, creds) {
                continue;
            }
            let last = calendars_synced_at(engine, account);
            if !try_attempt(&format!("calendar:{account}"), last, CALENDAR_EVERY, now, options.force) {
                continue;
            }
            match super::calendar::sync_now(engine, emit, account, from, to).await {
                SyncOutcome::Synced => calendars.push(json!({ "account": account, "ok": true })),
                SyncOutcome::Failed(message) => {
                    calendars.push(json!({ "account": account, "ok": false, "error": message }))
                }
                SyncOutcome::Skipped | SyncOutcome::Cancelled => {}
            }
        }
    }

    if options.sync && options.books {
        // A Google account's contacts come with it, as on the desktop once
        // the reader asks; here nobody is there to ask, so its book is made.
        for (account, creds) in accounts {
            if creds.auth_type == "gmail_oauth" && !engine.is_paused(account) {
                let _ = super::people::ensure_google_source(engine, account, &creds.user);
            }
        }
        let sources = store::contact_sources(&engine.db.lock().unwrap()).unwrap_or_default();
        for source in sources {
            if !source.enabled || (!source.account.is_empty() && engine.is_paused(&source.account)) {
                continue;
            }
            // An Exchange contact folder is read with its account's book,
            // which lists the folders first (ADR-0066).
            if super::exchange_book::is_folder_book(&source) {
                continue;
            }
            if !try_attempt(&format!("book:{}", source.id), source.last_sync_at, BOOKS_EVERY, now, options.force) {
                continue;
            }
            let outcome = super::people::sync_source(engine, &source.id).await;
            books.push(json!({
                "id": source.id,
                "account": source.account,
                "kind": source.kind,
                "ok": outcome.is_ok(),
                "error": outcome.err().map(|e| format!("{e:#}")),
            }));
        }
    }
    if !calendars.is_empty() {
        reminders.extend(super::reminders::take_due(engine, &ids, now));
    }
    super::reminders::forget_old(engine, now);
    json!({ "reminders": reminders, "calendars": calendars, "books": books })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_standing_window_is_whole_days_around_today() {
        let now = 1_800_000_000;
        let (from, to) = standing_window(now);
        assert_eq!(from % 86_400, 0);
        assert!(from < now - 86_400 + 86_400 && to > now + 34 * 86_400);
        assert_eq!(standing_window(now + 60), (from, to), "the same all day");
    }

    #[test]
    fn an_attempt_waits_its_interval_unless_forced() {
        let key = "test:attempt";
        let now = 1_800_000_000;
        assert!(!try_attempt(key, now - 60, CALENDAR_EVERY, now, false), "read a minute ago");
        assert!(try_attempt(key, 0, CALENDAR_EVERY, now, false), "never read");
        assert!(!try_attempt(key, 0, CALENDAR_EVERY, now + 60, false), "a failure is not retried every tick");
        assert!(try_attempt(key, 0, CALENDAR_EVERY, now + CALENDAR_EVERY, false));
        assert!(try_attempt(key, now, CALENDAR_EVERY, now + 1, true), "forced");
    }
}
