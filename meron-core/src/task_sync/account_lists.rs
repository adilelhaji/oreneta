//! Task lists that come with an account (#281, ADR-0070).
//!
//! An Exchange account's Tasks folder (ADR-0058) and the task collections of
//! a CalDAV server added to an account (ADR-0039) arrive with the account, as
//! its calendars do. Each one is an entry of `account_task_lists`, keyed by
//! account and source:
//!
//! - `pending`: not read yet, or its last read failed (`last_error`);
//! - `linked`: a list here, made in the same transaction as its tasks;
//! - `declined`: the person does not want it. It is never read again, not
//!   on opening Tasks and not on upgrading;
//! - `scanned`: only for a server's mark (`caldav-server:<origin>|<user>`),
//!   a server already listed, so it is not listed on its own again.
//!
//! A read goes to the network and only then, in one transaction, writes:
//! and only while the account still exists and the entry still waits. A
//! read that ends after «No l'afegeixis», or after the account is removed,
//! writes nothing.
//!
//! The passwords themselves are the caller's: this module names the
//! keychain entries to write or delete and never touches the keychain, as
//! [`crate::store::delete_account`] does.

use std::collections::BTreeSet;
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use super::lock;
use crate::calendar::caldav::{self, RemoteCalendar, TaskKind};
use crate::carddav::client::{DavRequest, HttpReply, Transport};

pub const PENDING: &str = "pending";
pub const LINKED: &str = "linked";
pub const DECLINED: &str = "declined";
pub const SCANNED: &str = "scanned";

/// The source of an Exchange account's Tasks folder.
pub const EWS: &str = "ews";
const COLLECTION: &str = "caldav:";
const SERVER: &str = "caldav-server:";

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS account_task_lists (
  account    TEXT NOT NULL,
  source     TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('pending', 'linked', 'declined', 'scanned')),
  list_id    TEXT NOT NULL DEFAULT '',
  adopted    INTEGER NOT NULL DEFAULT 0,
  notified   INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, source)
);
CREATE INDEX IF NOT EXISTS idx_account_task_lists_list ON account_task_lists(list_id) WHERE list_id <> '';
";

/// Schema 66: the table, and what the upgrade brings once (ADR-0070, §4).
///
/// - Every Exchange account gets its entry: `linked` to the list it already
///   has, or `pending`, read on opening Tasks.
/// - Every CalDAV server an account keeps calendars on (same origin and
///   user) gets a `pending` mark: the migration cannot go to the network, so
///   the server is listed again the first time Tasks opens.
///
/// Only an entry the upgrade adds on its own (`pending`) is born with
/// `notified = 0`, for the notice with «Treu-la». A list that existed
/// already was added by the person, not by the upgrade, so its entry is
/// born confirmed. Inserts never replace: running this again changes
/// nothing, and a list declined stays declined.
pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    let now = crate::store::now_unix();
    let accounts: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, COALESCE(config, '') FROM accounts")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (account, config) in accounts {
        let ews_url = serde_json::from_str::<serde_json::Value>(&config)
            .ok()
            .and_then(|value| value["ews_url"].as_str().map(str::to_string))
            .unwrap_or_default();
        if ews_url.trim().is_empty() {
            continue;
        }
        let list: Option<String> = conn
            .query_row(
                "SELECT id FROM task_lists WHERE ews_account = ?1 ORDER BY position LIMIT 1",
                params![account],
                |row| row.get(0),
            )
            .optional()?;
        match list {
            Some(list) => conn.execute(
                "INSERT OR IGNORE INTO account_task_lists(account, source, state, list_id, notified, updated_at)
                 VALUES(?1, ?2, 'linked', ?3, 1, ?4)",
                params![account, EWS, list, now],
            )?,
            None => conn.execute(
                "INSERT OR IGNORE INTO account_task_lists(account, source, state, notified, updated_at)
                 VALUES(?1, ?2, 'pending', 0, ?3)",
                params![account, EWS, now],
            )?,
        };
    }
    let calendars: Vec<(String, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT c.account, COALESCE(c.url, ''), c.dav_username FROM calendars c
              WHERE c.kind = 'caldav' AND c.account IN (SELECT id FROM accounts)",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (account, url, username) in calendars {
        // A calendar whose address cannot be read has no server to list.
        let Ok(origin) = origin_of(&url) else { continue };
        conn.execute(
            "INSERT OR IGNORE INTO account_task_lists(account, source, state, notified, updated_at)
             VALUES(?1, ?2, 'pending', 0, ?3)",
            params![account, server_source(&origin, &username), now],
        )?;
    }
    Ok(())
}

// ---- Sources ----------------------------------------------------------------

/// What an entry stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source<'a> {
    /// The Tasks folder of the Exchange account.
    Ews,
    /// A CalDAV collection, by its normalized address.
    Collection(&'a str),
    /// A server already listed, or to be listed again (§4): its origin and
    /// who signs in there.
    Server { origin: &'a str, user: &'a str },
}

pub fn parse_source(source: &str) -> Option<Source<'_>> {
    if source == EWS {
        return Some(Source::Ews);
    }
    if let Some(rest) = source.strip_prefix(SERVER) {
        let (origin, user) = rest.split_once('|')?;
        return Some(Source::Server { origin, user });
    }
    source.strip_prefix(COLLECTION).filter(|url| !url.is_empty()).map(Source::Collection)
}

/// The source of a collection: its normalized address.
pub fn collection_source(url: &str) -> Result<String> {
    Ok(format!("{COLLECTION}{}", normalize_url(url)?))
}

/// The mark of a server: its origin and who signs in there.
pub fn server_source(origin: &str, user: &str) -> String {
    format!("{SERVER}{origin}|{user}")
}

/// A collection's address in one form (§2): scheme and host in lower case,
/// no default port, percent-encoding normalized (unreserved characters
/// decoded, the rest in upper case) and a final slash. Two ways of writing
/// the same collection are the same entry.
pub fn normalize_url(raw: &str) -> Result<String> {
    // The URL reader lower-cases the scheme and host and drops a default port.
    let mut url = url::Url::parse(raw.trim()).context("that collection address is not a URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("that collection address is not a web address");
    }
    let mut path = normalize_percent(url.path());
    if !path.ends_with('/') {
        path.push('/');
    }
    url.set_path(&path);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn normalize_percent(text: &str) -> String {
    fn hex(byte: u8) -> Option<u8> {
        (byte as char).to_digit(16).map(|digit| digit as u8)
    }
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[at + 1]), hex(bytes[at + 2])) {
                let value = high * 16 + low;
                if value.is_ascii_alphanumeric() || matches!(value, b'-' | b'.' | b'_' | b'~') {
                    out.push(value as char);
                } else {
                    out.push_str(&format!("%{value:02X}"));
                }
                at += 3;
                continue;
            }
        }
        // A URL's path is ASCII once read: anything else is percent-encoded.
        out.push(bytes[at] as char);
        at += 1;
    }
    out
}

/// Scheme, host and port of an address, as an origin is written.
pub fn origin_of(url: &str) -> Result<String> {
    let parsed = url::Url::parse(url.trim()).context("that address is not a URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("that address is not a web address");
    }
    Ok(parsed.origin().ascii_serialization())
}

/// Where a CalDAV entry's password waits until its list exists (§3).
pub fn pending_secret_key(account: &str, source: &str) -> String {
    let digest = Sha256::digest(source.as_bytes());
    let short: String = digest.iter().take(16).map(|byte| format!("{byte:02x}")).collect();
    format!("caldav-tasks-pending:{account}:{short}")
}

// ---- Entries ----------------------------------------------------------------

/// One entry, as `tasks.lists` gives it to the interface.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Entry {
    pub account: String,
    pub source: String,
    pub state: String,
    pub list_id: String,
    pub adopted: bool,
    pub notified: bool,
    pub last_error: String,
    pub updated_at: i64,
    /// "ews", "caldav" or "caldav-server".
    pub kind: String,
    /// The collection's address, or the server's origin; empty for Exchange.
    pub url: String,
    /// For a server's mark, who signs in there.
    pub username: String,
}

const COLUMNS: &str = "account, source, state, list_id, adopted, notified, last_error, updated_at";

fn entry_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    let source: String = row.get(1)?;
    let (kind, url, username) = match parse_source(&source) {
        Some(Source::Ews) => ("ews", String::new(), String::new()),
        Some(Source::Collection(url)) => ("caldav", url.to_string(), String::new()),
        Some(Source::Server { origin, user }) => ("caldav-server", origin.to_string(), user.to_string()),
        None => ("unknown", String::new(), String::new()),
    };
    Ok(Entry {
        account: row.get(0)?,
        state: row.get(2)?,
        list_id: row.get(3)?,
        adopted: row.get(4)?,
        notified: row.get(5)?,
        last_error: row.get(6)?,
        updated_at: row.get(7)?,
        kind: kind.to_string(),
        url,
        username,
        source,
    })
}

fn select(conn: &Connection, filter: &str, values: &[&dyn rusqlite::ToSql]) -> Result<Vec<Entry>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM account_task_lists {filter} ORDER BY account, source"))?;
    let rows = stmt.query_map(values, entry_from)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Every entry the interface has something to say about: all but the
/// servers already listed.
pub fn entries(conn: &Connection) -> Result<Vec<Entry>> {
    select(conn, "WHERE state <> 'scanned'", &[])
}

/// Every entry that waits for a read: lists, and servers to list again.
pub fn pending(conn: &Connection) -> Result<Vec<Entry>> {
    select(conn, "WHERE state = 'pending'", &[])
}

pub fn entry(conn: &Connection, account: &str, source: &str) -> Result<Option<Entry>> {
    Ok(select(conn, "WHERE account = ?1 AND source = ?2", &[&account, &source])?.into_iter().next())
}

fn state_of(conn: &Connection, account: &str, source: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT state FROM account_task_lists WHERE account = ?1 AND source = ?2",
            params![account, source],
            |row| row.get(0),
        )
        .optional()?)
}

fn account_exists(conn: &Connection, account: &str) -> Result<bool> {
    Ok(conn.prepare("SELECT 1 FROM accounts WHERE id = ?1")?.exists(params![account])?)
}

/// A new Exchange account's entry (§3): written in the same transaction as
/// the account. A new account never shows the upgrade's notice.
pub fn add_exchange(conn: &Connection, account: &str, now: i64) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO account_task_lists(account, source, state, notified, updated_at)
         VALUES(?1, ?2, 'pending', 1, ?3)",
        params![account, EWS, now],
    )?;
    Ok(())
}

/// Why the last read of a waiting entry failed. An entry no longer waiting
/// keeps what it says.
pub fn record_failure(conn: &Connection, account: &str, source: &str, error: &str) -> Result<()> {
    conn.execute(
        "UPDATE account_task_lists SET last_error = ?3 WHERE account = ?1 AND source = ?2 AND state = 'pending'",
        params![account, source, error],
    )?;
    Ok(())
}

/// «D'acord» on the upgrade's notice: kept in the profile, not the interface.
pub fn acknowledge(conn: &Connection, account: &str, source: &str) -> Result<()> {
    if conn.execute(
        "UPDATE account_task_lists SET notified = 1 WHERE account = ?1 AND source = ?2",
        params![account, source],
    )? == 0
    {
        bail!("that list is no longer one of the account's");
    }
    Ok(())
}

fn delete_list_rows(conn: &Connection, list_id: &str) -> Result<()> {
    conn.execute("DELETE FROM tasks WHERE list_id = ?1", params![list_id])?;
    conn.execute("DELETE FROM task_lists WHERE id = ?1", params![list_id])?;
    Ok(())
}

fn set_declined(conn: &Connection, account: &str, source: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE account_task_lists SET state = 'declined', list_id = '', last_error = '', notified = 1, updated_at = ?3
          WHERE account = ?1 AND source = ?2",
        params![account, source, now],
    )?;
    Ok(())
}

/// «No l'afegeixis» on a waiting entry or a server to list again, and
/// «Treu-la» on a list the upgrade added (§5). A list goes from here with its
/// tasks, nothing on the server is touched, and the entry is remembered as
/// declined. Answers the keychain entries for the caller to delete: the
/// list's own password and the one waiting for a first read. A calendar's
/// password (`caldav:`) is never among them.
pub fn decline(conn: &Connection, account: &str, source: &str, now: i64) -> Result<Vec<String>> {
    let entry = entry(conn, account, source)?.context("that list is no longer one of the account's")?;
    let mut secrets = Vec::new();
    let tx = conn.unchecked_transaction()?;
    match entry.state.as_str() {
        DECLINED => return Ok(secrets),
        SCANNED => bail!("that server was listed already; there is nothing to decline"),
        LINKED if !entry.list_id.is_empty() => {
            if super::binding(&tx, &entry.list_id)?.is_some() {
                secrets.push(super::secret_key(&entry.list_id));
            }
            delete_list_rows(&tx, &entry.list_id)?;
        }
        _ => {}
    }
    if matches!(parse_source(source), Some(Source::Collection(_))) {
        secrets.push(pending_secret_key(account, source));
    }
    set_declined(&tx, account, source, now)?;
    tx.commit()?;
    Ok(secrets)
}

/// Deleting a list, as [`crate::store::task_lists::delete_list`] does; an
/// account's list is then declined, so it does not come back on its own
/// (§5), and an adopted one too.
pub fn delete_list(conn: &Connection, list_id: &str, now: i64) -> Result<()> {
    if list_id == crate::store::task_lists::MAIL_LIST {
        bail!("the mail follow-up list cannot be deleted");
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE account_task_lists SET state = 'declined', list_id = '', last_error = '', notified = 1, updated_at = ?2
          WHERE list_id = ?1 AND state = 'linked'",
        params![list_id, now],
    )?;
    delete_list_rows(&tx, list_id)?;
    tx.commit()?;
    Ok(())
}

/// The account goes (§5): its entries, the lists of its CalDAV servers that
/// came on their own and their tasks. An adopted list stays, as ADR-0039
/// says; the Exchange lists go through `exchange::forget_account`. Answers
/// the keychain entries for the caller to delete. Runs in the caller's
/// transaction.
pub fn forget_account(conn: &Connection, account: &str) -> Result<Vec<String>> {
    let mut secrets = Vec::new();
    for entry in select(conn, "WHERE account = ?1", &[&account])? {
        if entry.kind != "caldav" {
            continue;
        }
        secrets.push(pending_secret_key(account, &entry.source));
        if entry.state == LINKED && !entry.adopted && !entry.list_id.is_empty() {
            if super::binding(conn, &entry.list_id)?.is_some() {
                secrets.push(super::secret_key(&entry.list_id));
            }
            delete_list_rows(conn, &entry.list_id)?;
        }
    }
    conn.execute("DELETE FROM account_task_lists WHERE account = ?1", params![account])?;
    Ok(secrets)
}

/// Every keychain entry waiting for a first read, for deleting a profile
/// (ADR-0038).
pub fn pending_secret_keys(conn: &Connection) -> Result<Vec<String>> {
    Ok(select(conn, "WHERE source LIKE 'caldav:%'", &[])?
        .into_iter()
        .map(|entry| pending_secret_key(&entry.account, &entry.source))
        .collect())
}

// ---- Reading a list for the first time ---------------------------------------

/// What a first read did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Linked {
    /// The list is here, with every task the read found.
    Made(String),
    /// The entry no longer waits for it (the person declined it, or the
    /// account was removed, while it was read): nothing was written.
    Discarded,
}

/// Why a list is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// A waiting entry (§3): written only if it still waits when the read
    /// ends.
    Retry,
    /// «Afegeix una llista» on a declined entry (§5): the person asks for
    /// it. A failure leaves it declined and is the caller's to say.
    ByHand,
}

/// Whether a read may write: the account is still there and the entry is
/// in the state the read is for.
pub(crate) fn may_write(conn: &Connection, account: &str, source: &str, mode: Mode) -> Result<bool> {
    if !account_exists(conn, account)? {
        return Ok(false);
    }
    let state = state_of(conn, account, source)?;
    Ok(match mode {
        Mode::Retry => state.as_deref() == Some(PENDING),
        Mode::ByHand => !matches!(state.as_deref(), Some(LINKED) | Some(SCANNED)),
    })
}

/// The entry now has its list. A new entry (a list added by hand that had
/// none) is born confirmed; an existing one keeps whether its notice was
/// confirmed, so a list the upgrade added still shows it.
pub(crate) fn mark_linked(conn: &Connection, account: &str, source: &str, list_id: &str, adopted: bool, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO account_task_lists(account, source, state, list_id, adopted, notified, last_error, updated_at)
         VALUES(?1, ?2, 'linked', ?3, ?4, 1, '', ?5)
         ON CONFLICT(account, source) DO UPDATE SET state = 'linked', list_id = excluded.list_id,
                adopted = excluded.adopted, last_error = '', updated_at = excluded.updated_at",
        params![account, source, list_id, adopted, now],
    )?;
    Ok(())
}

/// A list kept on the server at `url` already (an ADR-0039 one, linked by
/// hand), compared by normalized address.
pub fn list_for_url(conn: &Connection, url: &str) -> Result<Option<String>> {
    let wanted = normalize_url(url)?;
    let mut stmt = conn.prepare("SELECT id, remote_url FROM task_lists WHERE remote_url <> '' ORDER BY position")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, remote) = row?;
        if normalize_url(&remote).is_ok_and(|remote| remote == wanted) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// One CalDAV collection to read for an account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collection {
    pub account: String,
    /// Its address, normalized.
    pub url: String,
    pub username: String,
    /// The id the new list takes: its password is kept under it before the
    /// list exists (§3).
    pub list_id: String,
}

/// Reads a collection whole and only then, in one transaction, makes the
/// list with its tasks and links the entry (§3). A read that fails makes
/// nothing; a waiting entry keeps waiting, with the reason. The transport
/// must be bound to the collection's origin ([`OriginBound`], #28).
pub fn link_collection(db: &Mutex<Connection>, transport: &dyn Transport, target: &Collection, mode: Mode, now: i64) -> Result<Linked> {
    let source = collection_source(&target.url)?;
    {
        let conn = lock(db);
        if !may_write(&conn, &target.account, &source, mode)? {
            return Ok(Linked::Discarded);
        }
        if list_for_url(&conn, &target.url)?.is_some() {
            bail!("that collection is already a task list here");
        }
    }
    let read = caldav::fetch_todos(transport, &target.url).map(|objects| (caldav::collection_name(transport, &target.url), objects));
    let (name, objects) = match read {
        Ok(read) => read,
        Err(error) => {
            if mode == Mode::Retry {
                record_failure(&lock(db), &target.account, &source, &format!("{error:#}"))?;
            }
            return Err(error);
        }
    };
    let conn = lock(db);
    let written = (|| -> Result<Linked> {
        let tx = conn.unchecked_transaction()?;
        if !may_write(&tx, &target.account, &source, mode)? {
            return Ok(Linked::Discarded);
        }
        crate::store::task_lists::create_list_with_id(&tx, &target.list_id, &name, now)?;
        tx.execute(
            "UPDATE task_lists SET remote_url = ?2, remote_user = ?3, synced_at = ?4, last_error = '' WHERE id = ?1",
            params![target.list_id, target.url, target.username, now],
        )?;
        let binding = super::Binding { list_id: target.list_id.clone(), url: target.url.clone(), username: target.username.clone() };
        super::reconcile_in(&tx, &binding, &objects, now, &mut super::Report::default())?;
        mark_linked(&tx, &target.account, &source, &target.list_id, false, now)?;
        tx.commit()?;
        Ok(Linked::Made(target.list_id.clone()))
    })();
    if let (Err(error), Mode::Retry) = (&written, mode) {
        record_failure(&conn, &target.account, &source, &format!("{error:#}"))?;
    }
    written
}

/// Who signs in to a server for an account, when its waiting list is read
/// again: the user of the server's mark, or of its calendars. Two different
/// ones cannot be told apart, and are said to be.
pub fn username_for(conn: &Connection, account: &str, origin: &str) -> Result<String> {
    let mut users = BTreeSet::new();
    for entry in select(conn, "WHERE account = ?1 AND source LIKE 'caldav-server:%'", &[&account])? {
        if entry.url == origin {
            users.insert(entry.username);
        }
    }
    if users.is_empty() {
        for (_, url, user) in calendars_of(conn, account)? {
            if origin_of(&url).is_ok_and(|found| found == origin) {
                users.insert(user);
            }
        }
    }
    match users.len() {
        1 => Ok(users.into_iter().next().unwrap_or_default()),
        0 => bail!("no sign-in for {origin} is kept with this account; add the list with «Llista de tasques CalDAV…»"),
        _ => bail!("this account signs in to {origin} as more than one user; add the list with «Llista de tasques CalDAV…»"),
    }
}

/// `(id, url, user)` of an account's CalDAV calendars.
fn calendars_of(conn: &Connection, account: &str) -> Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT provider_id, COALESCE(url, ''), dav_username FROM calendars WHERE account = ?1 AND kind = 'caldav' ORDER BY provider_id",
    )?;
    let rows = stmt.query_map(params![account], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A calendar of the account on the same origin and with the same user:
/// whose password a list of that server may use (#28, §4 and §5). Its id
/// and address.
pub fn calendar_for(conn: &Connection, account: &str, origin: &str, username: &str) -> Result<Option<(String, String)>> {
    Ok(calendars_of(conn, account)?
        .into_iter()
        .find(|(_, url, user)| user == username && origin_of(url).is_ok_and(|found| found == origin))
        .map(|(id, url, _)| (id, url)))
}

// ---- What the CalDAV dialog chose ----------------------------------------------

/// What [`record_choice`] left to do.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Choice {
    /// Collections now waiting for their first read, by normalized address.
    pub to_read: Vec<String>,
    /// Collections taken as a list already here (adopted) or linked before:
    /// nothing to read, and no password waiting.
    pub kept: Vec<String>,
    /// Waiting passwords of entries the person unchecked.
    pub dropped_keys: Vec<String>,
}

/// The task collections chosen in the CalDAV dialog (§3): the wanted ones
/// wait for a first read, the unchecked ones are declined, and each server
/// gets its mark as listed, so it is not listed again on its own. A list
/// already here for a collection (an ADR-0039 one) is adopted, not doubled.
pub fn record_choice(
    conn: &Connection,
    account: &str,
    username: &str,
    origins: &[String],
    wanted: &[String],
    declined: &[String],
    now: i64,
) -> Result<Choice> {
    let tx = conn.unchecked_transaction()?;
    if !account_exists(&tx, account)? {
        // Calendars alone keep working as before; lists need their account.
        if wanted.is_empty() && declined.is_empty() {
            return Ok(Choice::default());
        }
        bail!("that account is no longer here");
    }
    let mut choice = Choice::default();
    for origin in origins {
        tx.execute(
            "INSERT INTO account_task_lists(account, source, state, notified, updated_at) VALUES(?1, ?2, 'scanned', 1, ?3)
             ON CONFLICT(account, source) DO UPDATE SET state = 'scanned', last_error = '', updated_at = excluded.updated_at
              WHERE account_task_lists.state = 'pending'",
            params![account, server_source(origin, username), now],
        )?;
    }
    for url in wanted {
        let url = normalize_url(url)?;
        let source = collection_source(&url)?;
        match state_of(&tx, account, &source)?.as_deref() {
            Some(LINKED) => choice.kept.push(url),
            Some(PENDING) => choice.to_read.push(url),
            _ => match list_for_url(&tx, &url)? {
                Some(list) => {
                    mark_linked(&tx, account, &source, &list, true, now)?;
                    choice.kept.push(url);
                }
                None => {
                    tx.execute(
                        "INSERT INTO account_task_lists(account, source, state, notified, updated_at) VALUES(?1, ?2, 'pending', 1, ?3)
                         ON CONFLICT(account, source) DO UPDATE SET state = 'pending', list_id = '', last_error = '',
                                updated_at = excluded.updated_at",
                        params![account, source, now],
                    )?;
                    choice.to_read.push(url);
                }
            },
        }
    }
    for url in declined {
        let source = collection_source(url)?;
        match state_of(&tx, account, &source)?.as_deref() {
            None => {
                tx.execute(
                    "INSERT INTO account_task_lists(account, source, state, notified, updated_at) VALUES(?1, ?2, 'declined', 1, ?3)",
                    params![account, source, now],
                )?;
            }
            Some(PENDING) => {
                set_declined(&tx, account, &source, now)?;
                choice.dropped_keys.push(pending_secret_key(account, &source));
            }
            _ => {}
        }
    }
    tx.commit()?;
    Ok(choice)
}

// ---- A server listed again after the upgrade (§4) --------------------------------

/// A server's mark waiting to be listed again, with the calendar whose
/// password and address it is listed with (`None` when the account keeps no
/// calendar there any more).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rescan {
    pub mark: Entry,
    pub calendar: Option<(String, String)>,
}

/// Every server waiting to be listed again.
pub fn rescans(conn: &Connection) -> Result<Vec<Rescan>> {
    let mut found = Vec::new();
    for mark in pending(conn)?.into_iter().filter(|entry| entry.kind == "caldav-server") {
        let calendar = calendar_for(conn, &mark.account, &mark.url, &mark.username)?;
        found.push(Rescan { mark, calendar });
    }
    Ok(found)
}

/// Which collections of a listing are an account's task lists (§1),
/// asking a collection that takes events and tasks, or does not say,
/// whether it holds one. Every collection with its answer: an error is
/// "cannot say", never "no".
pub fn classify(transport: &dyn Transport, found: &[RemoteCalendar]) -> Vec<(RemoteCalendar, Result<bool>)> {
    found
        .iter()
        .map(|calendar| {
            let answer = match calendar.task_kind() {
                TaskKind::Only => Ok(true),
                TaskKind::No => Ok(false),
                TaskKind::Maybe => caldav::has_todos(transport, &calendar.url),
            };
            (calendar.clone(), answer)
        })
        .collect()
}

/// The collections a listing again found that wait for a first read now,
/// for the caller to keep their password under (§4). A collection on
/// another origin is never one; one the account has an entry for already
/// is left as it is.
pub fn rescan_candidates(conn: &Connection, mark: &Entry, task_lists: &[String]) -> Result<Vec<String>> {
    let mut candidates = Vec::new();
    for url in task_lists {
        if !origin_of(url).is_ok_and(|origin| origin == mark.url) {
            continue;
        }
        let url = normalize_url(url)?;
        if state_of(conn, &mark.account, &collection_source(&url)?)?.is_none() && !candidates.contains(&url) {
            candidates.push(url);
        }
    }
    Ok(candidates)
}

/// What a listing again did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Rescanned {
    /// The mark no longer waited (declined, or the account removed): nothing
    /// was written.
    pub discarded: bool,
    /// Collections now waiting for a first read.
    pub created: Vec<String>,
    /// Lists linked by hand before (ADR-0039) now registered as adopted.
    pub adopted: Vec<String>,
}

/// Writes what a listing again found (§4), in one transaction: an entry per
/// collection of the server's origin, waiting (with the upgrade's notice
/// to come), or adopted when a list here is kept there already; and the mark
/// as listed. Only while the account is there and the mark still waits.
pub fn apply_rescan(conn: &Connection, mark: &Entry, candidates: &[String], now: i64) -> Result<Rescanned> {
    let tx = conn.unchecked_transaction()?;
    if !may_write(&tx, &mark.account, &mark.source, Mode::Retry)? {
        return Ok(Rescanned { discarded: true, ..Default::default() });
    }
    let mut done = Rescanned::default();
    for url in candidates {
        if !origin_of(url).is_ok_and(|origin| origin == mark.url) {
            continue;
        }
        let source = collection_source(url)?;
        if state_of(&tx, &mark.account, &source)?.is_some() {
            continue;
        }
        match list_for_url(&tx, url)? {
            Some(list) => {
                mark_linked(&tx, &mark.account, &source, &list, true, now)?;
                done.adopted.push(url.clone());
            }
            None => {
                tx.execute(
                    "INSERT INTO account_task_lists(account, source, state, notified, updated_at) VALUES(?1, ?2, 'pending', 0, ?3)",
                    params![mark.account, source, now],
                )?;
                done.created.push(url.clone());
            }
        }
    }
    tx.execute(
        "UPDATE account_task_lists SET state = 'scanned', last_error = '', updated_at = ?3 WHERE account = ?1 AND source = ?2",
        params![mark.account, mark.source, now],
    )?;
    tx.commit()?;
    Ok(done)
}

// ---- Where the password may go (#28) ---------------------------------------------

/// A transport that sends nothing outside one origin: the password of an
/// account's calendar, or of a list waiting for its first read, goes only
/// where that collection is (#28, ADR-0070 §3 and §4). Checked on every
/// request, a redirect's included.
pub struct OriginBound<T: Transport> {
    pub inner: T,
    pub origin: String,
}

impl<T: Transport> Transport for OriginBound<T> {
    fn send(&self, request: &DavRequest) -> Result<HttpReply> {
        if !origin_of(&request.url).is_ok_and(|origin| origin == self.origin) {
            bail!("{} is not on {}, where the password may go; nothing was sent there", request.url, self.origin);
        }
        let reply = self.inner.send(request)?;
        if !reply.url.is_empty() && !origin_of(&reply.url).is_ok_and(|origin| origin == self.origin) {
            bail!("{} sent the request on to {}, where the password may not go", self.origin, reply.url);
        }
        Ok(reply)
    }
}

#[cfg(test)]
mod tests;
