//! Moving keychain entries from the inherited `meron` service to `oreneta`
//! (#248, ADR-0063).
//!
//! Every write goes to [`SERVICE`]. A read looks there first and falls back to
//! [`LEGACY_SERVICE`]; an entry found only under the old name is copied,
//! read back, compared, and only then deleted from the old service. Any step
//! that fails leaves the old entry in place, serving the account, and is tried
//! again on the next start. Nothing here is persisted: which entries are
//! settled is known for the life of the process only.
//!
//! Log messages and errors name entries and steps, never values.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use anyhow::{Context, Result};

use crate::log::Level;

/// The keychain service every secret is written under.
pub(crate) const SERVICE: &str = "oreneta";

/// The inherited service, only read and deleted from.
pub(crate) const LEGACY_SERVICE: &str = "meron";

/// The raw keychain operations, per service. The platform backend implements
/// it in `secrets`; the tests below use an in-memory fake.
pub(crate) trait CredentialStore {
    fn read(&self, service: &'static str, key: &str) -> Result<Option<String>>;
    fn write(&self, service: &'static str, key: &str, blob: &str) -> Result<()>;
    /// Removes an entry. A missing entry is not an error.
    fn delete(&self, service: &'static str, key: &str) -> Result<()>;
}

/// Where migration messages go: the core log in production, a buffer in tests.
pub(crate) type Log<'a> = &'a dyn Fn(Level, &str);

/// What this run knows about an entry's legacy copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Legacy {
    /// There is none: never was, or it has been deleted.
    Gone,
    /// Not settled this run: a read, copy or delete step failed, or the two
    /// entries differ. Reads do not retry it; the next store, which replaces
    /// the value, still retires the legacy copy, and otherwise the next start
    /// looks again.
    Deferred,
    /// A store could not retire it either: nothing more this run.
    Held,
    /// A copy failed verification and could not be removed: the legacy entry
    /// is served first for the rest of the run, so the copy never shadows it.
    Unverified,
}

/// What one call did about the legacy copy, for the start-up summary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// The entry was copied, verified, and the legacy copy deleted.
    Moved,
    /// The legacy copy is kept: a step failed or the entries differ. It is
    /// looked at again on the next start.
    Deferred,
}

/// Counts from [`Migration::migrate_all`]. Never carries a value. An entry
/// already under `oreneta` whose identical legacy copy is deleted counts as
/// checked, not moved.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Summary {
    pub checked: usize,
    pub moved: usize,
    pub deferred: usize,
    pub unreadable: usize,
}

/// Why a written entry did not verify.
enum Mismatch {
    /// It read back, with another value or none: the copy is damaged.
    Damaged(&'static str),
    /// It could not be read back: nothing is known about it.
    Unreadable(String),
}

impl Mismatch {
    fn reason(&self) -> String {
        match self {
            Mismatch::Damaged(why) => (*why).to_owned(),
            Mismatch::Unreadable(error) => error.clone(),
        }
    }
}

/// Per-process migration state: what is known about each entry's legacy
/// copy, and one lock per entry so a copy, a store and a delete of the same
/// entry never interleave.
#[derive(Default)]
pub(crate) struct Migration {
    legacy: Mutex<HashMap<String, Legacy>>,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Migration {
    /// The state shared by every keychain call of this process.
    pub(crate) fn global() -> &'static Migration {
        static MIGRATION: OnceLock<Migration> = OnceLock::new();
        MIGRATION.get_or_init(Migration::default)
    }

    fn entry_lock(&self, key: &str) -> Arc<Mutex<()>> {
        guard(&self.locks).entry(key.to_owned()).or_default().clone()
    }

    fn legacy(&self, key: &str) -> Option<Legacy> {
        guard(&self.legacy).get(key).copied()
    }

    fn settle(&self, key: &str, state: Legacy) {
        guard(&self.legacy).insert(key.to_owned(), state);
    }

    /// Read an entry: `oreneta` first, then `meron`. The first read of an
    /// entry in a run also moves it, or deletes a legacy duplicate.
    pub(crate) fn load(
        &self,
        keychain: &dyn CredentialStore,
        log: Log<'_>,
        key: &str,
    ) -> Result<Option<String>> {
        self.load_reporting(keychain, log, key).map(|(blob, _)| blob)
    }

    fn load_reporting(
        &self,
        keychain: &dyn CredentialStore,
        log: Log<'_>,
        key: &str,
    ) -> Result<(Option<String>, Option<Outcome>)> {
        let lock = self.entry_lock(key);
        let _held = guard(&lock);
        let known = self.legacy(key);
        if known == Some(Legacy::Unverified) {
            let legacy = keychain
                .read(LEGACY_SERVICE, key)
                .with_context(|| format!("read the {LEGACY_SERVICE} entry {key}"))?;
            if let Some(blob) = legacy {
                return Ok((Some(blob), None));
            }
        }
        if let Some(blob) = keychain.read(SERVICE, key)? {
            let outcome = match known {
                Some(_) => None,
                None => {
                    let state = self.retire(keychain, log, key, &blob);
                    self.settle(key, state);
                    (state != Legacy::Gone).then_some(Outcome::Deferred)
                }
            };
            return Ok((Some(blob), outcome));
        }
        if known == Some(Legacy::Gone) {
            return Ok((None, None));
        }
        let legacy = match keychain.read(LEGACY_SERVICE, key) {
            Ok(legacy) => legacy,
            Err(error) => {
                if known.is_none() {
                    log(
                        Level::Warn,
                        &format!(
                            "could not read the {LEGACY_SERVICE} entry {key}; it is not moved \
                             until the next start: {error:#}"
                        ),
                    );
                    self.settle(key, Legacy::Deferred);
                }
                return Err(error).with_context(|| format!("read the {LEGACY_SERVICE} entry {key}"));
            }
        };
        let Some(blob) = legacy else {
            self.settle(key, Legacy::Gone);
            return Ok((None, None));
        };
        if known.is_some() {
            return Ok((Some(blob), None));
        }
        let state = self.copy(keychain, log, key, &blob);
        self.settle(key, state);
        let outcome = match state {
            Legacy::Gone => Outcome::Moved,
            _ => Outcome::Deferred,
        };
        Ok((Some(blob), Some(outcome)))
    }

    /// Write an entry under `oreneta`. While a legacy copy may still exist,
    /// the write is read back and, once it matches, the legacy copy is
    /// deleted: this write replaces its value. A write that reads back
    /// different is an error, and the legacy copy is kept.
    pub(crate) fn store(
        &self,
        keychain: &dyn CredentialStore,
        log: Log<'_>,
        key: &str,
        blob: &str,
    ) -> Result<()> {
        let lock = self.entry_lock(key);
        let _held = guard(&lock);
        keychain.write(SERVICE, key, blob)?;
        if matches!(self.legacy(key), Some(Legacy::Gone | Legacy::Held)) {
            return Ok(());
        }
        let state = match keychain.read(LEGACY_SERVICE, key) {
            Ok(None) => Legacy::Gone,
            Ok(Some(_)) => match verified(keychain, key, blob) {
                Ok(()) => match self.delete_legacy(keychain, log, key) {
                    Legacy::Gone => Legacy::Gone,
                    _ => Legacy::Held,
                },
                Err(mismatch) => {
                    let why = mismatch.reason();
                    log(
                        Level::Warn,
                        &format!(
                            "the {SERVICE} entry {key} did not read back as written ({why}); \
                             the {LEGACY_SERVICE} entry is kept until the next start"
                        ),
                    );
                    let Mismatch::Damaged(_) = mismatch else {
                        self.settle(key, Legacy::Held);
                        return Ok(());
                    };
                    // As in a move: a damaged value must not stay in front of
                    // the intact legacy one.
                    let state = match keychain.delete(SERVICE, key) {
                        Ok(()) => Legacy::Held,
                        Err(error) => {
                            log(
                                Level::Error,
                                &format!(
                                    "could not remove the damaged {SERVICE} entry {key}; the \
                                     {LEGACY_SERVICE} entry is served first for the rest of this \
                                     run: {error:#}"
                                ),
                            );
                            Legacy::Unverified
                        }
                    };
                    self.settle(key, state);
                    anyhow::bail!("the {SERVICE} entry {key} did not read back as written ({why})");
                }
            },
            Err(error) => {
                log(
                    Level::Warn,
                    &format!(
                        "could not check for a {LEGACY_SERVICE} entry {key}; it is looked at \
                         again on the next start: {error:#}"
                    ),
                );
                Legacy::Held
            }
        };
        self.settle(key, state);
        Ok(())
    }

    /// Delete an entry from both services, the legacy one first: if that
    /// fails nothing else is touched, so no lone legacy copy is ever left for
    /// a later read to bring back.
    pub(crate) fn delete(&self, keychain: &dyn CredentialStore, key: &str) -> Result<()> {
        let lock = self.entry_lock(key);
        let _held = guard(&lock);
        keychain
            .delete(LEGACY_SERVICE, key)
            .with_context(|| format!("delete the {LEGACY_SERVICE} entry {key}"))?;
        self.settle(key, Legacy::Gone);
        keychain.delete(SERVICE, key)
    }

    /// The SQLCipher key for the store, read like any entry. A read error is
    /// returned, never taken for a missing key. A malformed key under
    /// `oreneta` never hides a good one under `meron`: that one is used and
    /// copied over it. A key is minted only when neither service holds a good
    /// one.
    pub(crate) fn db_key(
        &self,
        keychain: &dyn CredentialStore,
        log: Log<'_>,
        key: &str,
        valid: &dyn Fn(&str) -> bool,
        mint: &dyn Fn() -> String,
    ) -> Result<String> {
        let current = self.load(keychain, log, key)?;
        if let Some(found) = current.as_deref().filter(|found| valid(*found)) {
            return Ok(found.to_owned());
        }
        if current.is_some() {
            let legacy = keychain
                .read(LEGACY_SERVICE, key)
                .with_context(|| format!("read the {LEGACY_SERVICE} entry {key}"))?;
            if let Some(legacy) = legacy.filter(|legacy| valid(legacy.as_str())) {
                log(
                    Level::Warn,
                    &format!(
                        "the {SERVICE} entry {key} is malformed; the {LEGACY_SERVICE} one is \
                         used and copied over it"
                    ),
                );
                // The good key is in hand and still under meron: a failed
                // repair must not keep the store from opening.
                if let Err(error) = self.store(keychain, log, key, &legacy) {
                    log(
                        Level::Warn,
                        &format!(
                            "could not repair the {SERVICE} entry {key}; the {LEGACY_SERVICE} one \
                             is kept and used: {error:#}"
                        ),
                    );
                }
                return Ok(legacy);
            }
        }
        let fresh = mint();
        self.store(keychain, log, key, &fresh)?;
        Ok(fresh)
    }

    /// Settle every named entry now rather than on its first read, so entries
    /// a session never reads still move. Returns counts only.
    pub(crate) fn migrate_all(
        &self,
        keychain: &dyn CredentialStore,
        log: Log<'_>,
        keys: &[String],
    ) -> Summary {
        let mut summary = Summary::default();
        for key in keys {
            summary.checked += 1;
            match self.load_reporting(keychain, log, key) {
                Ok((_, Some(Outcome::Moved))) => summary.moved += 1,
                Ok((_, Some(Outcome::Deferred))) => summary.deferred += 1,
                Ok((_, None)) => {}
                Err(error) => {
                    log(Level::Warn, &format!("could not read the keychain entry {key}: {error:#}"));
                    summary.unreadable += 1;
                }
            }
        }
        if summary.moved + summary.deferred + summary.unreadable > 0 {
            let level = if summary.deferred + summary.unreadable > 0 { Level::Warn } else { Level::Info };
            log(
                level,
                &format!(
                    "keychain entries checked: {}; moved from {LEGACY_SERVICE} to {SERVICE}: {}; \
                     kept under {LEGACY_SERVICE} until the next start: {}; unreadable: {}",
                    summary.checked, summary.moved, summary.deferred, summary.unreadable
                ),
            );
        }
        summary
    }

    /// Copy a legacy entry under `oreneta`, verify it, then delete the legacy
    /// one. Returns what is now known about the legacy copy.
    fn copy(&self, keychain: &dyn CredentialStore, log: Log<'_>, key: &str, blob: &str) -> Legacy {
        if let Err(error) = keychain.write(SERVICE, key, blob) {
            log(
                Level::Warn,
                &format!(
                    "could not write the {SERVICE} entry {key}; the {LEGACY_SERVICE} entry \
                     is kept and the move is tried again on the next start: {error:#}"
                ),
            );
            return Legacy::Deferred;
        }
        if let Err(mismatch) = verified(keychain, key, blob) {
            log(
                Level::Warn,
                &format!(
                    "the {SERVICE} copy of {key} did not read back as written ({}); \
                     the {LEGACY_SERVICE} entry is kept and the move is tried again on the next start",
                    mismatch.reason()
                ),
            );
            // The copy is read first from now on, so an unverified one must
            // not stay in front of the original.
            if let Err(error) = keychain.delete(SERVICE, key) {
                log(
                    Level::Error,
                    &format!(
                        "could not remove the unverified {SERVICE} copy of {key}; the \
                         {LEGACY_SERVICE} entry is served first for the rest of this run: {error:#}"
                    ),
                );
                return Legacy::Unverified;
            }
            return Legacy::Deferred;
        }
        let state = self.delete_legacy(keychain, log, key);
        if state == Legacy::Gone {
            log(
                Level::Info,
                &format!("moved {key} from the {LEGACY_SERVICE} to the {SERVICE} keychain service"),
            );
        }
        state
    }

    /// An entry exists under `oreneta`: delete the legacy copy if it holds the
    /// same value, keep it (and say so) if it holds another.
    fn retire(&self, keychain: &dyn CredentialStore, log: Log<'_>, key: &str, current: &str) -> Legacy {
        match keychain.read(LEGACY_SERVICE, key) {
            Ok(None) => Legacy::Gone,
            Ok(Some(legacy)) if legacy == current => self.delete_legacy(keychain, log, key),
            Ok(Some(_)) => {
                log(
                    Level::Warn,
                    &format!(
                        "the {LEGACY_SERVICE} and {SERVICE} entries {key} differ; the {SERVICE} \
                         one is used and the {LEGACY_SERVICE} one is kept, not deleted"
                    ),
                );
                Legacy::Deferred
            }
            Err(error) => {
                log(
                    Level::Warn,
                    &format!(
                        "could not check for a {LEGACY_SERVICE} entry {key}; it is looked at \
                         again on the next start: {error:#}"
                    ),
                );
                Legacy::Deferred
            }
        }
    }

    fn delete_legacy(&self, keychain: &dyn CredentialStore, log: Log<'_>, key: &str) -> Legacy {
        match keychain.delete(LEGACY_SERVICE, key) {
            Ok(()) => Legacy::Gone,
            Err(error) => {
                log(
                    Level::Warn,
                    &format!(
                        "the {SERVICE} entry {key} is in place but the {LEGACY_SERVICE} one \
                         could not be deleted; tried again on the next start: {error:#}"
                    ),
                );
                Legacy::Deferred
            }
        }
    }
}

/// Read the `oreneta` entry back and compare it byte for byte with what was
/// written. The reason never quotes either value.
fn verified(
    keychain: &dyn CredentialStore,
    key: &str,
    blob: &str,
) -> std::result::Result<(), Mismatch> {
    match keychain.read(SERVICE, key) {
        Ok(Some(copy)) if copy == blob => Ok(()),
        Ok(Some(_)) => Err(Mismatch::Damaged("it holds a different value")),
        Ok(None) => Err(Mismatch::Damaged("it is missing")),
        Err(error) => Err(Mismatch::Unreadable(format!("{error:#}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Op {
        Read,
        Write,
        Delete,
    }

    /// One injected failure: the matching calls after the first `skip` fail,
    /// `times` of them (`usize::MAX` for always).
    struct Fault {
        op: Op,
        service: &'static str,
        skip: usize,
        times: usize,
    }

    /// An in-memory keychain with injectable failures. Its errors name the
    /// entry like the real backends do, never the value.
    #[derive(Default)]
    struct FakeStore {
        entries: Mutex<BTreeMap<(&'static str, String), String>>,
        faults: Mutex<Vec<Fault>>,
        calls: Mutex<Vec<(Op, &'static str)>>,
        /// Writes under this service store a damaged value.
        corrupt_writes: Mutex<Option<&'static str>>,
        /// Called inside every write, to widen race windows in tests.
        on_write: Mutex<Option<Box<dyn Fn() + Send>>>,
    }

    impl FakeStore {
        fn with(entries: &[(&'static str, &str, &str)]) -> Self {
            let store = FakeStore::default();
            for (service, key, blob) in entries {
                guard(&store.entries).insert((*service, key.to_string()), blob.to_string());
            }
            store
        }

        fn fail(&self, op: Op, service: &'static str, skip: usize, times: usize) {
            guard(&self.faults).push(Fault { op, service, skip, times });
        }

        fn heal(&self) {
            guard(&self.faults).clear();
            *guard(&self.corrupt_writes) = None;
        }

        fn get(&self, service: &'static str, key: &str) -> Option<String> {
            guard(&self.entries).get(&(service, key.to_string())).cloned()
        }

        fn count(&self, op: Op, service: &'static str) -> usize {
            guard(&self.calls).iter().filter(|call| **call == (op, service)).count()
        }

        fn check(&self, op: Op, service: &'static str, key: &str) -> Result<()> {
            guard(&self.calls).push((op, service));
            for fault in guard(&self.faults).iter_mut() {
                if fault.op != op || fault.service != service {
                    continue;
                }
                if fault.skip > 0 {
                    fault.skip -= 1;
                    continue;
                }
                if fault.times > 0 {
                    fault.times = fault.times.saturating_sub(1);
                    anyhow::bail!("injected {op:?} failure on {service} entry {key}");
                }
            }
            Ok(())
        }
    }

    impl CredentialStore for FakeStore {
        fn read(&self, service: &'static str, key: &str) -> Result<Option<String>> {
            self.check(Op::Read, service, key)?;
            Ok(self.get(service, key))
        }

        fn write(&self, service: &'static str, key: &str, blob: &str) -> Result<()> {
            self.check(Op::Write, service, key)?;
            if let Some(hook) = guard(&self.on_write).as_ref() {
                hook();
            }
            let stored = if *guard(&self.corrupt_writes) == Some(service) {
                blob[..blob.len() / 2].to_string()
            } else {
                blob.to_string()
            };
            guard(&self.entries).insert((service, key.to_string()), stored);
            Ok(())
        }

        fn delete(&self, service: &'static str, key: &str) -> Result<()> {
            self.check(Op::Delete, service, key)?;
            guard(&self.entries).remove(&(service, key.to_string()));
            Ok(())
        }
    }

    const KEY: &str = "ana@exemple.cat";
    const SECRET: &str = r#"{"password":"Contrasenya-Secreta-41","refresh_token":"rt-Secret-7777"}"#;
    const NEWER: &str = r#"{"password":"Contrasenya-Nova-42","refresh_token":"rt-Secret-8888"}"#;
    const DB_KEY: &str = "__meron_db_key__";
    const GOOD_DB_KEY: &str = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
    const MINTED_DB_KEY: &str = "badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0";
    /// Fragments that must never appear in a log line or an error.
    const NEEDLES: &[&str] = &["Contrasenya", "rt-Secret", "Secreta", "Nova-42", "c0ffee", "badc0de"];

    fn hex_key(value: &str) -> bool {
        value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
    }

    fn mint() -> String {
        MINTED_DB_KEY.to_owned()
    }

    #[derive(Default)]
    struct Logs(Mutex<Vec<(Level, String)>>);

    impl Logs {
        fn sink(&self) -> impl Fn(Level, &str) + '_ {
            move |level, message| guard(&self.0).push((level, message.to_string()))
        }

        fn lines(&self) -> Vec<(Level, String)> {
            guard(&self.0).clone()
        }

        fn warnings(&self) -> usize {
            self.lines().iter().filter(|(level, _)| matches!(level, Level::Warn | Level::Error)).count()
        }
    }

    /// No secret value in any log line or error text. Assertions compare
    /// values with `assert!` so a failure never prints one either.
    fn assert_clean(logs: &Logs, errors: &[String]) {
        for (_, line) in logs.lines() {
            for needle in NEEDLES {
                assert!(!line.contains(needle), "a log line carries a secret value");
            }
        }
        for error in errors {
            for needle in NEEDLES {
                assert!(!error.contains(needle), "an error carries a secret value");
            }
        }
    }

    fn holds(store: &FakeStore, service: &'static str, value: &str) -> bool {
        store.get(service, KEY).as_deref() == Some(value)
    }

    fn load_error(migration: &Migration, store: &FakeStore, log: Log<'_>, key: &str) -> String {
        match migration.load(store, log, key) {
            Ok(_) => panic!("an unreadable keychain is an error, not an empty secret"),
            Err(error) => format!("{error:#}"),
        }
    }

    #[test]
    fn a_fresh_install_writes_only_under_oreneta() {
        let store = FakeStore::default();
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        assert!(migration.load(&store, &log, KEY).unwrap().is_none(), "nothing stored yet");
        migration.store(&store, &log, KEY, SECRET).unwrap();

        assert!(holds(&store, SERVICE, SECRET));
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert_eq!(store.count(Op::Write, LEGACY_SERVICE), 0, "the legacy service is never written");
        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert_eq!(logs.warnings(), 0);
        assert_clean(&logs, &[]);
    }

    #[test]
    fn an_existing_entry_moves_whole_and_the_legacy_one_is_deleted() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        let loaded = migration.load(&store, &log, KEY).unwrap();
        assert!(loaded.as_deref() == Some(SECRET), "the account gets its secret on the first read");
        assert!(holds(&store, SERVICE, SECRET), "the same value is under oreneta");
        assert!(store.get(LEGACY_SERVICE, KEY).is_none(), "and nothing under meron");

        let legacy_reads = store.count(Op::Read, LEGACY_SERVICE);
        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert_eq!(store.count(Op::Read, LEGACY_SERVICE), legacy_reads, "a settled entry is not looked up again");
        assert_eq!(store.count(Op::Write, SERVICE), 1);
        assert_eq!(logs.warnings(), 0);
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_failed_oreneta_read_is_an_error_and_touches_nothing() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        store.fail(Op::Read, SERVICE, 0, 1);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        let error = load_error(&migration, &store, &log, KEY);
        assert!(holds(&store, LEGACY_SERVICE, SECRET));
        assert_eq!(store.count(Op::Write, SERVICE), 0);
        assert_eq!(store.count(Op::Delete, LEGACY_SERVICE), 0);
        assert_clean(&logs, &[error]);
    }

    #[test]
    fn a_failed_legacy_read_loses_nothing_and_is_retried() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        store.fail(Op::Read, LEGACY_SERVICE, 0, 1);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        let error = load_error(&migration, &store, &log, KEY);
        assert!(holds(&store, LEGACY_SERVICE, SECRET));
        assert!(store.get(SERVICE, KEY).is_none());
        assert_eq!(logs.warnings(), 1);

        // The read works again: the account is served from meron this run.
        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(store.get(SERVICE, KEY).is_none(), "the move waits for the next start");

        let next_start = Migration::default();
        assert!(next_start.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(holds(&store, SERVICE, SECRET));
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert_clean(&logs, &[error]);
    }

    #[test]
    fn a_failed_write_keeps_the_legacy_entry_serving_and_is_retried_next_start() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        store.fail(Op::Write, SERVICE, 0, usize::MAX);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(holds(&store, LEGACY_SERVICE, SECRET), "nothing deleted");
        assert!(store.get(SERVICE, KEY).is_none());
        assert_eq!(logs.warnings(), 1, "the failure is logged");

        // Later reads in the same run serve the old entry without retrying.
        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert_eq!(store.count(Op::Write, SERVICE), 1);
        assert_eq!(logs.warnings(), 1);

        store.heal();
        let next_start = Migration::default();
        assert!(next_start.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(holds(&store, SERVICE, SECRET));
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_copy_that_reads_back_different_is_removed_and_the_original_kept() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        *guard(&store.corrupt_writes) = Some(SERVICE);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(holds(&store, LEGACY_SERVICE, SECRET), "the original stays");
        assert!(store.get(SERVICE, KEY).is_none(), "the damaged copy does not shadow it");
        assert!(logs.lines().iter().any(|(_, line)| line.contains("different value")));
        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));

        store.heal();
        let next_start = Migration::default();
        assert!(next_start.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(holds(&store, SERVICE, SECRET));
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_copy_that_cannot_be_read_back_is_removed_and_the_original_kept() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        // The first oreneta read is the lookup; the second is the verify.
        store.fail(Op::Read, SERVICE, 1, 1);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(holds(&store, LEGACY_SERVICE, SECRET));
        assert!(store.get(SERVICE, KEY).is_none());

        let next_start = Migration::default();
        assert!(next_start.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(holds(&store, SERVICE, SECRET));
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_damaged_copy_that_cannot_be_removed_never_costs_the_original() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        *guard(&store.corrupt_writes) = Some(SERVICE);
        store.fail(Op::Delete, SERVICE, 0, usize::MAX);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(logs.lines().iter().any(|(level, _)| *level == Level::Error));
        // For the rest of the run the original is served, not the damaged copy.
        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));

        // Next start: two different entries. Neither is deleted (ADR-0063,
        // accepted residual risk of this double failure).
        let next_start = Migration::default();
        next_start.load(&store, &log, KEY).unwrap();
        assert!(holds(&store, LEGACY_SERVICE, SECRET));
        assert!(store.get(SERVICE, KEY).is_some());
        assert_eq!(store.count(Op::Delete, LEGACY_SERVICE), 0);

        // A store in that run writes a good value and retires the original.
        store.heal();
        next_start.store(&store, &log, KEY, NEWER).unwrap();
        assert!(holds(&store, SERVICE, NEWER));
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_failed_legacy_delete_is_finished_on_the_next_start() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        store.fail(Op::Delete, LEGACY_SERVICE, 0, 1);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(holds(&store, SERVICE, SECRET), "the verified copy is in place");
        assert!(holds(&store, LEGACY_SERVICE, SECRET), "the original is still there");
        assert_eq!(logs.warnings(), 1);

        let next_start = Migration::default();
        assert!(next_start.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(holds(&store, SERVICE, SECRET));
        assert!(store.get(LEGACY_SERVICE, KEY).is_none(), "the identical duplicate is deleted");
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_failed_legacy_check_on_an_already_moved_entry_deletes_nothing() {
        let store = FakeStore::with(&[(SERVICE, KEY, SECRET), (LEGACY_SERVICE, KEY, SECRET)]);
        store.fail(Op::Read, LEGACY_SERVICE, 0, 1);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert!(holds(&store, LEGACY_SERVICE, SECRET));
        assert_eq!(store.count(Op::Delete, LEGACY_SERVICE), 0);
        assert_eq!(logs.warnings(), 1);

        let next_start = Migration::default();
        next_start.load(&store, &log, KEY).unwrap();
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_partial_previous_move_with_different_values_keeps_both_until_a_store() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET), (SERVICE, KEY, NEWER)]);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        // The real order: the sweep (or a read) sees them first.
        let summary = migration.migrate_all(&store, &log, &[KEY.to_string()]);
        assert_eq!(summary.deferred, 1);
        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(NEWER));
        assert!(holds(&store, LEGACY_SERVICE, SECRET), "an entry that differs is never deleted on a read");
        assert!(holds(&store, SERVICE, NEWER));

        // A store replaces the value, so the superseded legacy one goes.
        migration.store(&store, &log, KEY, NEWER).unwrap();
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert!(holds(&store, SERVICE, NEWER));
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_store_replaces_and_retires_the_legacy_entry() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        migration.store(&store, &log, KEY, NEWER).unwrap();
        assert!(holds(&store, SERVICE, NEWER));
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(NEWER));
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_store_after_a_failed_legacy_delete_retires_it_once_per_run() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        // The move's delete fails, then the store's delete fails too.
        store.fail(Op::Delete, LEGACY_SERVICE, 0, 2);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        migration.load(&store, &log, KEY).unwrap();
        migration.store(&store, &log, KEY, NEWER).unwrap();
        assert!(holds(&store, LEGACY_SERVICE, SECRET), "both deletes failed");
        let deletes = store.count(Op::Delete, LEGACY_SERVICE);
        migration.store(&store, &log, KEY, NEWER).unwrap();
        assert_eq!(store.count(Op::Delete, LEGACY_SERVICE), deletes, "no retry loop within the run");

        // Next start: the entries differ, so a read keeps both; the next store retires it.
        let next_start = Migration::default();
        assert!(next_start.load(&store, &log, KEY).unwrap().as_deref() == Some(NEWER));
        assert!(holds(&store, LEGACY_SERVICE, SECRET));
        next_start.store(&store, &log, KEY, NEWER).unwrap();
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_failed_store_leaves_the_legacy_entry_alone() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        store.fail(Op::Write, SERVICE, 0, 1);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        let error = migration.store(&store, &log, KEY, NEWER).expect_err("the caller learns the write failed");
        assert!(holds(&store, LEGACY_SERVICE, SECRET));
        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET), "the account keeps working");
        assert_clean(&logs, &[format!("{error:#}")]);
    }

    #[test]
    fn a_store_that_cannot_be_read_back_keeps_the_legacy_entry() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        // The verify read after the write fails.
        store.fail(Op::Read, SERVICE, 0, 1);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        migration.store(&store, &log, KEY, NEWER).unwrap();
        assert!(holds(&store, LEGACY_SERVICE, SECRET), "unverified, so nothing is deleted");
        assert_eq!(logs.warnings(), 1);
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_store_that_reads_back_different_is_an_error_and_keeps_the_legacy_entry() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        *guard(&store.corrupt_writes) = Some(SERVICE);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();

        let error = migration.store(&store, &log, KEY, NEWER).expect_err("a damaged write is reported");
        assert!(holds(&store, LEGACY_SERVICE, SECRET));
        assert!(store.get(SERVICE, KEY).is_none(), "the damaged value is removed");
        store.heal();
        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET), "the intact one is served");

        // When the damaged value cannot be removed, the legacy one is still served first.
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        *guard(&store.corrupt_writes) = Some(SERVICE);
        store.fail(Op::Delete, SERVICE, 0, usize::MAX);
        let migration = Migration::default();
        let second = migration.store(&store, &log, KEY, NEWER).expect_err("a damaged write is reported");
        assert!(store.get(SERVICE, KEY).is_some());
        assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
        assert_clean(&logs, &[format!("{error:#}"), format!("{second:#}")]);
    }

    #[test]
    fn a_failed_store_key_repair_still_opens_with_the_legacy_key() {
        let store = FakeStore::with(&[(SERVICE, DB_KEY, "not-a-key"), (LEGACY_SERVICE, DB_KEY, GOOD_DB_KEY)]);
        store.fail(Op::Write, SERVICE, 0, usize::MAX);
        let logs = Logs::default();
        let log = logs.sink();
        let key = Migration::default().db_key(&store, &log, DB_KEY, &hex_key, &mint).unwrap();
        assert!(key == GOOD_DB_KEY);
        assert!(store.get(LEGACY_SERVICE, DB_KEY).as_deref() == Some(GOOD_DB_KEY), "kept");
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_delete_removes_both_and_a_failed_legacy_delete_leaves_nothing_to_resurrect() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET), (SERVICE, KEY, SECRET)]);
        let migration = Migration::default();
        let logs = Logs::default();
        let log = logs.sink();

        store.fail(Op::Delete, LEGACY_SERVICE, 0, 1);
        let error = migration.delete(&store, KEY).expect_err("a delete that did not happen is reported");
        assert!(holds(&store, SERVICE, SECRET), "the current entry is untouched when the legacy one stays");

        migration.delete(&store, KEY).unwrap();
        assert!(store.get(SERVICE, KEY).is_none());
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert!(migration.load(&store, &log, KEY).unwrap().is_none(), "nothing comes back");
        assert_clean(&logs, &[format!("{error:#}")]);
    }

    #[test]
    fn a_delete_whose_oreneta_step_fails_never_leaves_a_lone_legacy_copy() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET), (SERVICE, KEY, SECRET)]);
        store.fail(Op::Delete, SERVICE, 0, 1);
        let migration = Migration::default();
        let logs = Logs::default();

        let error = migration.delete(&store, KEY).expect_err("the failure is reported");
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert!(holds(&store, SERVICE, SECRET));
        assert_clean(&logs, &[format!("{error:#}")]);
    }

    #[test]
    fn the_start_up_sweep_moves_every_named_entry_and_reports_counts_only() {
        let store = FakeStore::with(&[
            (LEGACY_SERVICE, "a@x.cat", SECRET),
            (LEGACY_SERVICE, "b@x.cat", NEWER),
            (SERVICE, "c@x.cat", SECRET),
            (LEGACY_SERVICE, "d@x.cat", SECRET),
        ]);
        // d's copy fails; e has no secret at all.
        store.fail(Op::Write, SERVICE, 2, 1);
        let logs = Logs::default();
        let migration = Migration::default();
        let log = logs.sink();
        let keys: Vec<String> = ["a@x.cat", "b@x.cat", "c@x.cat", "d@x.cat", "e@x.cat"].map(String::from).to_vec();

        let summary = migration.migrate_all(&store, &log, &keys);
        assert_eq!(summary, Summary { checked: 5, moved: 2, deferred: 1, unreadable: 0 });
        assert!(store.get(LEGACY_SERVICE, "a@x.cat").is_none() && store.get(LEGACY_SERVICE, "b@x.cat").is_none());
        assert!(store.get(SERVICE, "b@x.cat").as_deref() == Some(NEWER));
        assert!(store.get(LEGACY_SERVICE, "d@x.cat").as_deref() == Some(SECRET), "the failed one is kept");
        assert!(store.get(SERVICE, "e@x.cat").is_none(), "no secret, nothing written");
        let (level, summary_line) = logs.lines().into_iter().last().unwrap();
        assert_eq!(level, Level::Warn, "a deferred entry makes the summary a warning");
        assert!(summary_line.contains("moved from meron to oreneta: 2"), "{summary_line}");

        let next_start = Migration::default();
        let summary = next_start.migrate_all(&store, &log, &keys);
        assert_eq!(summary, Summary { checked: 5, moved: 1, deferred: 0, unreadable: 0 });
        assert!(store.get(LEGACY_SERVICE, "d@x.cat").is_none());
        assert_eq!(logs.lines().into_iter().last().unwrap().0, Level::Info, "an all-good sweep is not a warning");
        assert_clean(&logs, &[]);
    }

    #[test]
    fn the_sweep_logs_and_counts_an_unreadable_entry() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        store.fail(Op::Read, SERVICE, 0, 1);
        let logs = Logs::default();
        let log = logs.sink();
        let summary = Migration::default().migrate_all(&store, &log, &[KEY.to_string()]);
        assert_eq!(summary, Summary { checked: 1, moved: 0, deferred: 0, unreadable: 1 });
        assert_eq!(logs.warnings(), 2, "the entry's error and the summary");
        assert!(holds(&store, LEGACY_SERVICE, SECRET));
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_settled_profile_sweeps_silently() {
        let store = FakeStore::with(&[(SERVICE, KEY, SECRET)]);
        let logs = Logs::default();
        let log = logs.sink();
        let summary = Migration::default().migrate_all(&store, &log, &[KEY.to_string()]);
        assert_eq!(summary, Summary { checked: 1, moved: 0, deferred: 0, unreadable: 0 });
        assert!(logs.lines().is_empty());
    }

    #[test]
    fn the_store_key_moves_and_is_never_minted_on_a_read_error() {
        let logs = Logs::default();
        let log = logs.sink();

        // Moved like any entry.
        let store = FakeStore::with(&[(LEGACY_SERVICE, DB_KEY, GOOD_DB_KEY)]);
        let key = Migration::default().db_key(&store, &log, DB_KEY, &hex_key, &mint).unwrap();
        assert!(key == GOOD_DB_KEY);
        assert!(store.get(SERVICE, DB_KEY).as_deref() == Some(GOOD_DB_KEY));
        assert!(store.get(LEGACY_SERVICE, DB_KEY).is_none());

        // A read error on either service mints nothing and writes nothing.
        for service in [SERVICE, LEGACY_SERVICE] {
            let store = FakeStore::with(&[(LEGACY_SERVICE, DB_KEY, GOOD_DB_KEY)]);
            store.fail(Op::Read, service, 0, 1);
            let result = Migration::default().db_key(&store, &log, DB_KEY, &hex_key, &mint);
            assert!(result.is_err(), "an unreadable {service} key is an error");
            assert_eq!(store.count(Op::Write, SERVICE), 0);
            assert!(store.get(LEGACY_SERVICE, DB_KEY).as_deref() == Some(GOOD_DB_KEY));
        }

        // Nothing anywhere: a key is minted, under oreneta only.
        let store = FakeStore::default();
        let key = Migration::default().db_key(&store, &log, DB_KEY, &hex_key, &mint).unwrap();
        assert!(key == MINTED_DB_KEY);
        assert!(store.get(SERVICE, DB_KEY).as_deref() == Some(MINTED_DB_KEY));
        assert_eq!(store.count(Op::Write, LEGACY_SERVICE), 0);
        assert_clean(&logs, &[]);
    }

    #[test]
    fn a_malformed_oreneta_store_key_never_hides_the_good_legacy_one() {
        let store = FakeStore::with(&[(SERVICE, DB_KEY, "not-a-key"), (LEGACY_SERVICE, DB_KEY, GOOD_DB_KEY)]);
        let logs = Logs::default();
        let log = logs.sink();
        let migration = Migration::default();

        let key = migration.db_key(&store, &log, DB_KEY, &hex_key, &mint).unwrap();
        assert!(key == GOOD_DB_KEY, "the store keeps opening with its real key");
        assert!(store.get(SERVICE, DB_KEY).as_deref() == Some(GOOD_DB_KEY), "and the copy is repaired");
        assert!(store.get(LEGACY_SERVICE, DB_KEY).is_none());

        // Both malformed: replaced, as before this change.
        let store = FakeStore::with(&[(SERVICE, DB_KEY, "not-a-key"), (LEGACY_SERVICE, DB_KEY, "nor-this")]);
        let key = Migration::default().db_key(&store, &log, DB_KEY, &hex_key, &mint).unwrap();
        assert!(key == MINTED_DB_KEY);
        assert!(store.get(LEGACY_SERVICE, DB_KEY).is_none());
        assert_clean(&logs, &[]);
    }

    #[test]
    fn concurrent_first_reads_move_an_entry_once() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        let logs = Logs::default();
        let migration = Migration::default();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    let log = logs.sink();
                    assert!(migration.load(&store, &log, KEY).unwrap().as_deref() == Some(SECRET));
                });
            }
        });
        assert_eq!(store.count(Op::Write, SERVICE), 1);
        assert!(holds(&store, SERVICE, SECRET));
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert_clean(&logs, &[]);
    }

    /// A token refreshed while the move is copying the old value must win:
    /// the per-entry lock keeps the copy from landing after it.
    #[test]
    fn a_store_during_a_move_is_never_overwritten_by_the_old_value() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, KEY, SECRET)]);
        let (entered, wait_entered) = std::sync::mpsc::channel::<()>();
        let entered = Mutex::new(Some(entered));
        *guard(&store.on_write) = Some(Box::new(move || {
            if let Some(entered) = guard(&entered).take() {
                let _ = entered.send(());
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }));
        let logs = Logs::default();
        let migration = Migration::default();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let log = logs.sink();
                migration.load(&store, &log, KEY).unwrap();
            });
            wait_entered.recv().unwrap();
            let log = logs.sink();
            migration.store(&store, &log, KEY, NEWER).unwrap();
        });
        assert!(holds(&store, SERVICE, NEWER), "the refreshed value survives the move");
        assert!(store.get(LEGACY_SERVICE, KEY).is_none());
        assert_clean(&logs, &[]);
    }
}
