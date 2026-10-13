//! Automatic archiving by age (#112, ADR-0054).
//!
//! Off until the person turns it on for an account, and turning it on needs
//! the preview of what the policy would move to have been seen and
//! confirmed: the confirmation is a fingerprint of the policy, so changing
//! anything that decides what moves asks again. What is promised:
//! - only messages older than the policy's age, by their date in local time,
//!   from the folders chosen; Drafts, Outbox, Trash, Junk and the Archive
//!   folder itself are never a source;
//! - flagged and unread mail stays unless the person says otherwise, and a
//!   message whose date is unknown is never taken;
//! - to the local archive (ADR-0014) a message is copied, the copy read back
//!   and compared byte for byte with the server's, and only then removed
//!   from the server — a stop at any point leaves at worst a copy in both
//!   places, which the next run recognises and finishes, never a loss and
//!   never a second copy;
//! - every run leaves a log entry with its counts and, item by item, what
//!   did not go and why.

use std::future::Future;
use std::sync::Mutex;

use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, Months, TimeZone};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::imap::{self, RawMessageCopy};

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS auto_archive_policies (
    account TEXT PRIMARY KEY,
    policy TEXT NOT NULL,
    confirmed TEXT,
    last_attempt INTEGER,
    last_success INTEGER,
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS auto_archive_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    log TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auto_archive_runs_account ON auto_archive_runs(account, id);
CREATE TABLE IF NOT EXISTS auto_archive_items (
    account TEXT NOT NULL,
    folder TEXT NOT NULL,
    uid INTEGER NOT NULL,
    message_id TEXT NOT NULL DEFAULT '',
    local_folder TEXT NOT NULL,
    local_uid INTEGER,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account, folder, uid)
);
";

/// How often a policy that is on runs, while the app is open.
pub const EVERY_SECONDS: i64 = 24 * 3600;
/// How long after a run that could not start the next one is tried.
pub const RETRY_SECONDS: i64 = 3600;
pub const MAX_DAYS: u32 = 3650;
pub const MAX_MONTHS: u32 = 120;
/// Run log entries kept per account.
pub const KEEP_RUNS: i64 = 30;
/// Failed items listed in one log entry; the count says how many there were.
pub const MAX_LISTED_FAILURES: usize = 200;
/// Messages moved by one server request.
const CHUNK: usize = 50;
/// Where archived mail goes in the local archive: `Archived/<account>/<folder>`.
pub const LOCAL_ROOT: &str = "Archived";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgeUnit {
    Days,
    Months,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Age {
    pub value: u32,
    pub unit: AgeUnit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderChoice {
    pub name: String,
    /// This folder's own age, when it differs from the policy's.
    #[serde(default)]
    pub older_than: Option<Age>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Destination {
    /// The account's own Archive folder, moved there on the server.
    Server,
    /// The local archive on this computer (ADR-0014).
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Policy {
    pub enabled: bool,
    pub older_than: Age,
    pub folders: Vec<FolderChoice>,
    pub destination: Destination,
    /// Local destination only: leave the server's copy where it is.
    #[serde(default)]
    pub keep_server_copy: bool,
    #[serde(default)]
    pub include_starred: bool,
    #[serde(default)]
    pub include_unread: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            enabled: false,
            older_than: Age { value: 6, unit: AgeUnit::Months },
            folders: vec![FolderChoice { name: "INBOX".into(), older_than: None }],
            destination: Destination::Server,
            keep_server_copy: false,
            include_starred: false,
            include_unread: false,
        }
    }
}

/// What kind of account a policy is for, as far as archiving is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountKind {
    Imap,
    Graph,
    Ews,
    /// POP3 and the local archive: their mail is on this computer already.
    LocalStore,
}

impl AccountKind {
    pub fn of(creds: &imap::Creds) -> Self {
        if creds.is_local_store() {
            AccountKind::LocalStore
        } else if creds.is_graph() {
            AccountKind::Graph
        } else if creds.is_ews() {
            AccountKind::Ews
        } else {
            AccountKind::Imap
        }
    }

    /// Whether original bytes can be read from the server, which a copy to
    /// the local archive needs.
    pub fn can_copy_locally(self) -> bool {
        matches!(self, AccountKind::Imap)
    }
}

/// Why a folder can never be a source, or None when it can.
pub fn refusal(folder: &imap::Folder) -> Option<&'static str> {
    let role = folder.special_use.as_deref().unwrap_or_default().to_ascii_lowercase();
    let name = folder.name.as_str();
    let last = name.rsplit(['/', '.']).next().unwrap_or(name);
    let any = |check: fn(&str) -> bool| check(name) || check(last);
    if role == "drafts" || any(imap::looks_like_drafts) {
        Some("drafts")
    } else if role == "trash" || any(imap::looks_like_trash) {
        Some("trash")
    } else if role == "junk" || any(imap::looks_like_junk) {
        Some("junk")
    } else if role == "outbox" || name.eq_ignore_ascii_case("outbox") || last.eq_ignore_ascii_case("outbox") {
        Some("outbox")
    } else if role == "archive" || role == "all" || any(imap::looks_like_archive) {
        Some("archive")
    } else {
        None
    }
}

fn check_age(age: Age) -> Result<()> {
    match age.unit {
        AgeUnit::Days => ensure!((1..=MAX_DAYS).contains(&age.value), "choose between 1 and {MAX_DAYS} days"),
        AgeUnit::Months => {
            ensure!((1..=MAX_MONTHS).contains(&age.value), "choose between 1 and {MAX_MONTHS} months")
        }
    }
    Ok(())
}

/// Checks a policy against the account and its folders. A folder the list
/// does not have is refused too: archiving names folders as they are.
pub fn validate(policy: &Policy, kind: AccountKind, folders: &[imap::Folder]) -> Result<()> {
    ensure!(
        kind != AccountKind::LocalStore,
        "this account keeps its mail on this computer already; there is nothing to archive"
    );
    check_age(policy.older_than)?;
    ensure!(!policy.folders.is_empty(), "choose at least one folder to archive from");
    let mut seen = std::collections::HashSet::new();
    for choice in &policy.folders {
        ensure!(seen.insert(choice.name.as_str()), "{} is chosen twice", choice.name);
        if let Some(age) = choice.older_than {
            check_age(age)?;
        }
        let folder = folders
            .iter()
            .find(|f| f.name == choice.name)
            .with_context(|| format!("this account has no folder {}", choice.name))?;
        if let Some(reason) = refusal(folder) {
            bail!("{} is never archived automatically ({reason})", choice.name);
        }
    }
    if policy.destination == Destination::Local {
        ensure!(
            kind.can_copy_locally(),
            "this account cannot copy messages to the local archive; archive to its Archive folder instead"
        );
    }
    ensure!(
        policy.destination == Destination::Local || !policy.keep_server_copy,
        "keeping the server copy only applies to the local archive"
    );
    Ok(())
}

/// What the person confirms: everything that decides what moves and where,
/// for this account. Whether the policy is on is not part of it.
pub fn fingerprint(account: &str, policy: &Policy) -> String {
    use sha2::Digest;
    let mut canonical = policy.clone();
    canonical.enabled = false;
    canonical.folders.sort_by(|a, b| a.name.cmp(&b.name));
    let text = serde_json::to_string(&(account, canonical)).unwrap_or_default();
    sha2::Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The first instant that is *not* old enough: the start of the local day
/// `age` before today. A message dated before it is older than `age`.
pub fn cutoff<Tz: TimeZone>(now: &DateTime<Tz>, age: Age) -> i64 {
    let today = now.date_naive();
    let day = match age.unit {
        AgeUnit::Days => today - chrono::Days::new(age.value as u64),
        AgeUnit::Months => today.checked_sub_months(Months::new(age.value)).unwrap_or(today),
    };
    let midnight = day.and_hms_opt(0, 0, 0).expect("midnight exists");
    let zone = now.timezone();
    match zone.from_local_datetime(&midnight) {
        chrono::LocalResult::Single(t) => t.timestamp(),
        chrono::LocalResult::Ambiguous(first, _) => first.timestamp(),
        // A day that starts in a clock change's gap starts when the clock does.
        chrono::LocalResult::None => (1..=180)
            .find_map(|minutes| zone.from_local_datetime(&(midnight + chrono::Duration::minutes(minutes))).earliest())
            .map(|t| t.timestamp())
            .unwrap_or_else(|| midnight.and_utc().timestamp()),
    }
}

/// Each chosen folder with its cutoff at `now`.
pub fn cutoffs<Tz: TimeZone>(policy: &Policy, now: &DateTime<Tz>) -> Vec<(String, i64)> {
    policy
        .folders
        .iter()
        .map(|choice| (choice.name.clone(), cutoff(now, choice.older_than.unwrap_or(policy.older_than))))
        .collect()
}

/// A message that might be archived.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Candidate {
    pub uid: u32,
    /// Send time, epoch seconds; 0 when unknown.
    pub date: i64,
    pub seen: bool,
    pub starred: bool,
    pub message_id: String,
    pub subject: String,
}

impl From<&imap::MessageHeader> for Candidate {
    fn from(header: &imap::MessageHeader) -> Self {
        Candidate {
            uid: header.uid,
            date: header.date,
            seen: header.seen,
            starred: header.starred,
            message_id: header.message_id.clone(),
            subject: header.subject.clone(),
        }
    }
}

/// The messages the policy takes from these candidates.
pub fn select(candidates: &[Candidate], cutoff: i64, policy: &Policy) -> Vec<Candidate> {
    let mut chosen: Vec<Candidate> = candidates
        .iter()
        .filter(|c| c.date > 0 && c.date < cutoff)
        .filter(|c| policy.include_starred || !c.starred)
        .filter(|c| policy.include_unread || c.seen)
        .cloned()
        .collect();
    chosen.sort_by_key(|c| (c.date, c.uid));
    chosen.dedup_by_key(|c| c.uid);
    chosen
}

/// The local archive folder mail from `folder` of `account_label` goes to.
pub fn local_folder(account_label: &str, folder: &str) -> String {
    let clean = |s: &str| s.trim().replace(['\r', '\n'], " ");
    format!("{LOCAL_ROOT}/{}/{}", clean(account_label), clean(folder))
}

// ---- Stored policy, schedule and log ----------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Stored {
    pub policy: Policy,
    /// The fingerprint the person confirmed, if any.
    pub confirmed: Option<String>,
    pub last_attempt: Option<i64>,
    pub last_success: Option<i64>,
    pub last_error: Option<String>,
}

pub fn load(conn: &Connection, account: &str) -> Result<Stored> {
    let row = conn
        .query_row(
            "SELECT policy, confirmed, last_attempt, last_success, last_error FROM auto_archive_policies WHERE account = ?1",
            params![account],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                ))
            },
        )
        .optional()?;
    Ok(match row {
        Some((policy, confirmed, last_attempt, last_success, last_error)) => Stored {
            policy: serde_json::from_str(&policy).unwrap_or_default(),
            confirmed,
            last_attempt,
            last_success,
            last_error,
        },
        None => Stored { policy: Policy::default(), confirmed: None, last_attempt: None, last_success: None, last_error: None },
    })
}

/// Whether the stored policy is the one that was confirmed.
pub fn is_confirmed(account: &str, stored: &Stored) -> bool {
    stored.confirmed.as_deref() == Some(fingerprint(account, &stored.policy).as_str())
}

/// Saves a policy. Turning it on needs `confirm` to be the fingerprint of
/// its preview; a change to a confirmed policy without one leaves it
/// unconfirmed, and so off.
pub fn save(
    conn: &Connection,
    account: &str,
    policy: &Policy,
    confirm: Option<&str>,
    kind: AccountKind,
    folders: &[imap::Folder],
) -> Result<Stored> {
    validate(policy, kind, folders)?;
    let print = fingerprint(account, policy);
    let previous = load(conn, account)?;
    let confirmed = match confirm {
        Some(token) => {
            ensure!(token == print, "the policy changed after its preview; preview it again before confirming");
            Some(print)
        }
        None => previous.confirmed.filter(|c| *c == print),
    };
    ensure!(
        !policy.enabled || confirmed.is_some(),
        "preview what this policy will move and confirm it before turning it on"
    );
    conn.execute(
        "INSERT INTO auto_archive_policies(account, policy, confirmed) VALUES(?1, ?2, ?3)
         ON CONFLICT(account) DO UPDATE SET policy = ?2, confirmed = ?3",
        params![account, serde_json::to_string(policy)?, confirmed],
    )?;
    load(conn, account)
}

/// When the next scheduled run is due, or None when the policy is off.
pub fn next_run(account: &str, stored: &Stored) -> Option<i64> {
    if !stored.policy.enabled || !is_confirmed(account, stored) {
        return None;
    }
    let by_schedule = stored.last_success.map_or(0, |t| t + EVERY_SECONDS);
    let failed_last = match (stored.last_attempt, stored.last_success) {
        (Some(attempt), Some(success)) => attempt > success,
        (Some(_), None) => true,
        _ => false,
    };
    let by_retry = if failed_last { stored.last_attempt.unwrap_or(0) + RETRY_SECONDS } else { 0 };
    Some(by_schedule.max(by_retry))
}

/// Accounts whose scheduled run is due at `now`.
pub fn due(conn: &Connection, now: i64) -> Result<Vec<String>> {
    let accounts: Vec<String> = conn
        .prepare("SELECT account FROM auto_archive_policies ORDER BY account")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for account in accounts {
        let stored = load(conn, &account)?;
        if next_run(&account, &stored).is_some_and(|at| at <= now) {
            out.push(account);
        }
    }
    Ok(out)
}

/// One message that did not go, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemFailure {
    pub folder: String,
    pub uid: u32,
    pub subject: String,
    /// "fetch", "copy", "verify", "delete" or "move".
    pub step: String,
    pub error: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderOutcome {
    pub folder: String,
    pub selected: usize,
    pub moved: usize,
    pub kept: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunLog {
    #[serde(default)]
    pub id: i64,
    pub account: String,
    pub started_at: i64,
    pub finished_at: i64,
    /// "scheduled" or "manual".
    pub trigger: String,
    pub destination: Option<Destination>,
    /// Where the mail went: the server folder, or the local archive's root.
    pub target: String,
    /// Archived and gone from the source folder.
    pub moved: usize,
    /// Copied to the local archive with the server's copy kept on purpose.
    pub kept: usize,
    pub failed: usize,
    /// Selected but no longer on the server when its turn came.
    pub gone: usize,
    pub folders: Vec<FolderOutcome>,
    pub failures: Vec<ItemFailure>,
    /// The run could not start or stopped as a whole.
    pub error: Option<String>,
}

fn record(conn: &Connection, log: &RunLog) -> Result<i64> {
    conn.execute(
        "INSERT INTO auto_archive_runs(account, started_at, finished_at, log) VALUES(?1, ?2, ?3, ?4)",
        params![log.account, log.started_at, log.finished_at, serde_json::to_string(log)?],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "DELETE FROM auto_archive_runs WHERE account = ?1 AND id NOT IN
           (SELECT id FROM auto_archive_runs WHERE account = ?1 ORDER BY id DESC LIMIT ?2)",
        params![log.account, KEEP_RUNS],
    )?;
    Ok(id)
}

/// The account's run log, newest first.
pub fn runs(conn: &Connection, account: &str) -> Result<Vec<RunLog>> {
    let mut stmt = conn.prepare("SELECT id, log FROM auto_archive_runs WHERE account = ?1 ORDER BY id DESC")?;
    let rows = stmt.query_map(params![account], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, log) = row?;
        if let Ok(mut log) = serde_json::from_str::<RunLog>(&log) {
            log.id = id;
            out.push(log);
        }
    }
    Ok(out)
}

// ---- The progress journal ------------------------------------------------

/// How far one message got. Rows exist only while a message is between
/// steps, or for good when its server copy was kept on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// A local copy was written and not yet compared.
    Copied,
    /// The local copy matched the server's, byte for byte.
    Verified,
    /// Archived with the server copy kept: later runs leave it alone.
    Kept,
}

impl Stage {
    fn as_str(self) -> &'static str {
        match self {
            Stage::Copied => "copied",
            Stage::Verified => "verified",
            Stage::Kept => "kept",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        match s {
            "copied" => Some(Stage::Copied),
            "verified" => Some(Stage::Verified),
            "kept" => Some(Stage::Kept),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalRow {
    pub message_id: String,
    pub local_folder: String,
    pub local_uid: Option<u32>,
    pub stage: Stage,
}

pub fn journal_get(conn: &Connection, account: &str, folder: &str, uid: u32) -> Result<Option<JournalRow>> {
    Ok(conn
        .query_row(
            "SELECT message_id, local_folder, local_uid, state FROM auto_archive_items
              WHERE account = ?1 AND folder = ?2 AND uid = ?3",
            params![account, folder, uid],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<u32>>(2)?, r.get::<_, String>(3)?)),
        )
        .optional()?
        .and_then(|(message_id, local_folder, local_uid, state)| {
            Stage::parse(&state).map(|stage| JournalRow { message_id, local_folder, local_uid, stage })
        }))
}

#[allow(clippy::too_many_arguments)]
fn journal_set(
    conn: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
    message_id: &str,
    local_folder: &str,
    local_uid: u32,
    stage: Stage,
    now: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO auto_archive_items(account, folder, uid, message_id, local_folder, local_uid, state, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(account, folder, uid) DO UPDATE SET message_id = ?4, local_folder = ?5, local_uid = ?6,
           state = ?7, updated_at = ?8",
        params![account, folder, uid, message_id, local_folder, local_uid, stage.as_str(), now],
    )?;
    Ok(())
}

fn journal_clear(conn: &Connection, account: &str, folder: &str, uids: &[u32]) -> Result<()> {
    for uid in uids {
        conn.execute(
            "DELETE FROM auto_archive_items WHERE account = ?1 AND folder = ?2 AND uid = ?3",
            params![account, folder, uid],
        )?;
    }
    Ok(())
}

// ---- Running ---------------------------------------------------------------

/// Everything a run does outside its own bookkeeping, so tests can stand in
/// for the server and the local archive and fail any step on purpose.
pub trait Steps: Send {
    /// Messages in `folder` that may be older than `cutoff`; `select`
    /// narrows them.
    fn candidates(&mut self, folder: &str, cutoff: i64) -> impl Future<Output = Result<Vec<Candidate>>> + Send;
    /// The account's Archive folder on the server, if it has one.
    fn archive_folder(&mut self) -> impl Future<Output = Result<Option<String>>> + Send;
    /// A message's original bytes, or None when it is no longer there.
    fn fetch(&mut self, folder: &str, uid: u32) -> impl Future<Output = Result<Option<RawMessageCopy>>> + Send;
    /// Moves on the server, as the archive action does.
    fn move_to(&mut self, folder: &str, target: &str, uids: &[u32]) -> impl Future<Output = Result<()>> + Send;
    /// Removes from the server for good (after a verified local copy).
    fn delete(&mut self, folder: &str, uids: &[u32]) -> impl Future<Output = Result<()>> + Send;
    /// Writes a message into the local archive; returns its uid there.
    fn store_local(&mut self, folder: &str, message: &RawMessageCopy) -> Result<u32>;
    /// Reads back a local archive message's bytes.
    fn read_local(&mut self, folder: &str, uid: u32) -> Result<Option<Vec<u8>>>;
    /// Local archive messages in `folder` with this Message-ID.
    fn find_local(&mut self, folder: &str, message_id: &str) -> Result<Vec<u32>>;
    /// Removes a local copy that did not pass its check.
    fn remove_local(&mut self, folder: &str, uid: u32) -> Result<()>;
}

/// The local archive half of [`Steps`], on the profile's database.
pub struct LocalArchive<'a> {
    pub db: &'a Mutex<Connection>,
    pub media_root: std::path::PathBuf,
}

impl LocalArchive<'_> {
    pub fn store(&self, folder: &str, message: &RawMessageCopy) -> Result<u32> {
        let conn = self.db.lock().unwrap();
        crate::archive::ensure_account(&conn, crate::store::now_unix())?;
        crate::archive::store_message(
            &conn,
            crate::archive::ACCOUNT,
            folder,
            &message.raw,
            message.seen,
            message.starred,
            &self.media_root,
        )
    }

    pub fn read(&self, folder: &str, uid: u32) -> Result<Option<Vec<u8>>> {
        crate::archive::raw(&self.db.lock().unwrap(), crate::archive::ACCOUNT, folder, uid)
    }

    pub fn find(&self, folder: &str, message_id: &str) -> Result<Vec<u32>> {
        if message_id.trim().is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT uid FROM messages WHERE account = ?1 AND folder = ?2
                AND lower(json_extract(json, '$.message_id')) = lower(?3) ORDER BY uid",
        )?;
        let rows = stmt.query_map(params![crate::archive::ACCOUNT, folder, message_id], |r| r.get::<_, u32>(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn remove(&self, folder: &str, uid: u32) -> Result<()> {
        let conn = self.db.lock().unwrap();
        conn.execute(
            "DELETE FROM archive_messages WHERE account = ?1 AND folder = ?2 AND uid = ?3",
            params![crate::archive::ACCOUNT, folder, uid],
        )?;
        crate::store::delete_messages_by_uid(&conn, crate::archive::ACCOUNT, folder, &[uid])?;
        Ok(())
    }
}

/// What the policy would move from one folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedFolder {
    pub folder: String,
    pub cutoff: i64,
    /// Where it goes: the server folder or the local archive folder.
    pub target: String,
    #[serde(skip)]
    pub selected: Vec<Candidate>,
    pub count: usize,
    pub oldest: Option<i64>,
    pub newest: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Plan {
    pub account: String,
    pub destination: Destination,
    pub target: String,
    pub folders: Vec<PlannedFolder>,
    pub total: usize,
    pub fingerprint: String,
}

/// Works out what the policy would move now, without moving anything. The
/// preview shows this and a run carries it out.
pub async fn plan<S: Steps>(
    steps: &mut S,
    db: &Mutex<Connection>,
    account: &str,
    account_label: &str,
    policy: &Policy,
    cutoffs: &[(String, i64)],
) -> Result<Plan> {
    let target = match policy.destination {
        Destination::Server => steps
            .archive_folder()
            .await?
            .context("this account has no Archive folder; choose the local archive instead")?,
        Destination::Local => format!("{LOCAL_ROOT}/{}", account_label.trim()),
    };
    let mut folders = Vec::new();
    for (folder, cut) in cutoffs {
        ensure!(
            policy.destination == Destination::Local || *folder != target,
            "{folder} is the Archive folder itself"
        );
        let candidates = steps.candidates(folder, *cut).await.with_context(|| format!("look in {folder}"))?;
        let mut selected = select(&candidates, *cut, policy);
        if policy.destination == Destination::Local && policy.keep_server_copy {
            // Already archived with the server copy kept: not again.
            let conn = db.lock().unwrap();
            let mut keep = Vec::new();
            for candidate in selected {
                let done = journal_get(&conn, account, folder, candidate.uid)?.is_some_and(|row| {
                    row.stage == Stage::Kept && row.message_id.eq_ignore_ascii_case(&candidate.message_id)
                });
                if !done {
                    keep.push(candidate);
                }
            }
            selected = keep;
        }
        folders.push(PlannedFolder {
            folder: folder.clone(),
            cutoff: *cut,
            target: match policy.destination {
                Destination::Server => target.clone(),
                Destination::Local => local_folder(account_label, folder),
            },
            count: selected.len(),
            oldest: selected.iter().map(|c| c.date).min(),
            newest: selected.iter().map(|c| c.date).max(),
            selected,
        });
    }
    Ok(Plan {
        account: account.to_string(),
        destination: policy.destination,
        total: folders.iter().map(|f| f.count).sum(),
        target,
        folders,
        fingerprint: fingerprint(account, policy),
    })
}

/// Copies one message to the local archive and checks the copy. Nothing on
/// the server is touched here.
#[allow(clippy::too_many_arguments)]
fn copy_one_local<S: Steps>(
    steps: &mut S,
    db: &Mutex<Connection>,
    account: &str,
    folder: &str,
    local: &str,
    candidate: &Candidate,
    message: &RawMessageCopy,
    now: i64,
) -> std::result::Result<(), (&'static str, String)> {
    let fail = |step: &'static str| move |error: anyhow::Error| (step, format!("{error:#}"));
    let journal = journal_get(&db.lock().unwrap(), account, folder, candidate.uid).map_err(fail("copy"))?;
    // A copy from an earlier run, the same bytes: no second copy.
    let mut existing = None;
    if let Some(row) = journal.as_ref().filter(|row| row.local_folder == local)
        && let Some(uid) = row.local_uid
        && steps.read_local(local, uid).map_err(fail("verify"))?.as_deref() == Some(message.raw.as_slice())
    {
        existing = Some(uid);
    }
    if existing.is_none() {
        for uid in steps.find_local(local, &candidate.message_id).map_err(fail("copy"))? {
            if steps.read_local(local, uid).map_err(fail("verify"))?.as_deref() == Some(message.raw.as_slice()) {
                existing = Some(uid);
                break;
            }
        }
    }
    let uid = match existing {
        Some(uid) => uid,
        None => {
            let uid = steps.store_local(local, message).map_err(fail("copy"))?;
            journal_set(
                &db.lock().unwrap(),
                account,
                folder,
                candidate.uid,
                &candidate.message_id,
                local,
                uid,
                Stage::Copied,
                now,
            )
            .map_err(fail("copy"))?;
            let back = steps.read_local(local, uid);
            if !matches!(&back, Ok(Some(bytes)) if *bytes == message.raw) {
                let _ = steps.remove_local(local, uid);
                let _ = journal_clear(&db.lock().unwrap(), account, folder, &[candidate.uid]);
                return Err((
                    "verify",
                    match back {
                        Err(error) => format!("{error:#}"),
                        Ok(_) => "the archived copy did not match the original, so it was removed and the message left on the server".into(),
                    },
                ));
            }
            uid
        }
    };
    journal_set(
        &db.lock().unwrap(),
        account,
        folder,
        candidate.uid,
        &candidate.message_id,
        local,
        uid,
        Stage::Verified,
        now,
    )
    .map_err(fail("copy"))?;
    Ok(())
}

/// Carries out a plan. Never fails as a whole once started: what did not
/// go is in the log, item by item.
pub async fn execute<S: Steps>(
    steps: &mut S,
    db: &Mutex<Connection>,
    policy: &Policy,
    plan: &Plan,
    now: i64,
) -> RunLog {
    let account = plan.account.as_str();
    let mut log = RunLog {
        account: account.to_string(),
        started_at: now,
        destination: Some(plan.destination),
        target: plan.target.clone(),
        ..Default::default()
    };
    for planned in &plan.folders {
        let folder = planned.folder.as_str();
        let mut outcome = FolderOutcome { folder: folder.to_string(), selected: planned.selected.len(), ..Default::default() };
        let fail = |log: &mut RunLog, outcome: &mut FolderOutcome, c: &Candidate, step: &str, error: String| {
            outcome.failed += 1;
            log.failed += 1;
            if log.failures.len() < MAX_LISTED_FAILURES {
                log.failures.push(ItemFailure {
                    folder: folder.to_string(),
                    uid: c.uid,
                    subject: c.subject.clone(),
                    step: step.to_string(),
                    error,
                });
            }
        };
        match plan.destination {
            Destination::Server => {
                for chunk in planned.selected.chunks(CHUNK) {
                    let uids: Vec<u32> = chunk.iter().map(|c| c.uid).collect();
                    match steps.move_to(folder, &planned.target, &uids).await {
                        Ok(()) => {
                            outcome.moved += uids.len();
                            log.moved += uids.len();
                            let _ = crate::store::delete_messages_by_uid(&db.lock().unwrap(), account, folder, &uids);
                        }
                        Err(error) => {
                            let text = format!("{error:#}");
                            for c in chunk {
                                fail(&mut log, &mut outcome, c, "move", text.clone());
                            }
                        }
                    }
                }
            }
            Destination::Local => {
                let local = planned.target.as_str();
                for chunk in planned.selected.chunks(CHUNK) {
                    let mut verified: Vec<&Candidate> = Vec::new();
                    for c in chunk {
                        let message = match steps.fetch(folder, c.uid).await {
                            Ok(Some(message)) => message,
                            Ok(None) => {
                                log.gone += 1;
                                let _ = journal_clear(&db.lock().unwrap(), account, folder, &[c.uid]);
                                continue;
                            }
                            Err(error) => {
                                fail(&mut log, &mut outcome, c, "fetch", format!("{error:#}"));
                                continue;
                            }
                        };
                        match copy_one_local(steps, db, account, folder, local, c, &message, now) {
                            Ok(()) => verified.push(c),
                            Err((step, error)) => fail(&mut log, &mut outcome, c, step, error),
                        }
                    }
                    if verified.is_empty() {
                        continue;
                    }
                    let uids: Vec<u32> = verified.iter().map(|c| c.uid).collect();
                    if policy.keep_server_copy {
                        let conn = db.lock().unwrap();
                        for c in &verified {
                            if let Ok(Some(row)) = journal_get(&conn, account, folder, c.uid) {
                                let _ = journal_set(
                                    &conn,
                                    account,
                                    folder,
                                    c.uid,
                                    &c.message_id,
                                    local,
                                    row.local_uid.unwrap_or_default(),
                                    Stage::Kept,
                                    now,
                                );
                            }
                        }
                        outcome.kept += uids.len();
                        log.kept += uids.len();
                        continue;
                    }
                    match steps.delete(folder, &uids).await {
                        Ok(()) => {
                            let conn = db.lock().unwrap();
                            let _ = journal_clear(&conn, account, folder, &uids);
                            let _ = crate::store::delete_messages_by_uid(&conn, account, folder, &uids);
                            outcome.moved += uids.len();
                            log.moved += uids.len();
                        }
                        Err(error) => {
                            let text = format!(
                                "the archived copy is kept, but removing it from the server failed: {error:#}"
                            );
                            for c in verified {
                                fail(&mut log, &mut outcome, c, "delete", text.clone());
                            }
                        }
                    }
                }
            }
        }
        log.folders.push(outcome);
    }
    log
}

/// Only one run at a time, scheduled or asked for.
static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether a run is going on now.
pub fn running() -> bool {
    RUNNING.load(std::sync::atomic::Ordering::SeqCst)
}

/// Held for the length of a run; lets the next one start when dropped.
struct RunGuard;

impl RunGuard {
    fn take() -> Result<Self> {
        use std::sync::atomic::Ordering;
        ensure!(
            RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok(),
            "archiving is already running; try again when it finishes"
        );
        Ok(RunGuard)
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// One run for an account, recorded in its log whatever happens.
#[allow(clippy::too_many_arguments)]
pub async fn run<S: Steps>(
    steps: &mut S,
    db: &Mutex<Connection>,
    account: &str,
    account_label: &str,
    trigger: &str,
    cutoffs_at: impl FnOnce(&Policy) -> Vec<(String, i64)>,
    now: i64,
    finished: impl Fn() -> i64,
) -> Result<RunLog> {
    let _guard = RunGuard::take()?;
    let stored = load(&db.lock().unwrap(), account)?;
    ensure!(
        is_confirmed(account, &stored),
        "preview what this policy will move and confirm it before it runs"
    );
    db.lock().unwrap().execute(
        "UPDATE auto_archive_policies SET last_attempt = ?2 WHERE account = ?1",
        params![account, now],
    )?;
    let cutoffs = cutoffs_at(&stored.policy);
    let planned = plan(steps, db, account, account_label, &stored.policy, &cutoffs).await;
    let mut log = match planned {
        Ok(plan) => execute(steps, db, &stored.policy, &plan, now).await,
        Err(error) => RunLog {
            account: account.to_string(),
            started_at: now,
            destination: Some(stored.policy.destination),
            error: Some(format!("{error:#}")),
            ..Default::default()
        },
    };
    log.trigger = trigger.to_string();
    log.finished_at = finished();
    let conn = db.lock().unwrap();
    log.id = record(&conn, &log)?;
    match &log.error {
        None => conn.execute(
            "UPDATE auto_archive_policies SET last_success = ?2, last_error = NULL WHERE account = ?1",
            params![account, now],
        )?,
        Some(error) => conn.execute(
            "UPDATE auto_archive_policies SET last_error = ?2 WHERE account = ?1",
            params![account, error],
        )?,
    };
    Ok(log)
}

/// What Settings shows for an account.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub policy: Policy,
    pub confirmed: bool,
    pub last_attempt: Option<i64>,
    pub last_success: Option<i64>,
    pub last_error: Option<String>,
    pub next_run: Option<i64>,
    pub running: bool,
    /// Whether the local archive can be the destination for this account.
    pub local_supported: bool,
    /// The account's folders and, for those never archived, why.
    pub folders: Vec<FolderOption>,
    pub runs: Vec<RunLog>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderOption {
    pub name: String,
    pub display_name: String,
    pub refused: Option<&'static str>,
}

pub fn status(conn: &Connection, account: &str, kind: AccountKind, folders: &[imap::Folder]) -> Result<Status> {
    let stored = load(conn, account)?;
    Ok(Status {
        next_run: next_run(account, &stored),
        confirmed: is_confirmed(account, &stored),
        policy: stored.policy,
        last_attempt: stored.last_attempt,
        last_success: stored.last_success,
        last_error: stored.last_error,
        running: running(),
        local_supported: kind.can_copy_locally(),
        folders: folders
            .iter()
            .map(|f| FolderOption {
                name: f.name.clone(),
                display_name: if f.display_name.is_empty() { f.name.clone() } else { f.display_name.clone() },
                refused: refusal(f),
            })
            .collect(),
        runs: runs(conn, account)?,
    })
}

/// Candidates from the synced copy, for servers that cannot be searched by
/// date (Graph, EWS): only mail already synced here is considered.
pub fn cached_candidates(conn: &Connection, account: &str, folder: &str, cutoff: i64) -> Result<Vec<Candidate>> {
    let mut stmt = conn.prepare(
        "SELECT uid, date, seen, starred, COALESCE(json_extract(json, '$.message_id'), ''), COALESCE(subject, '')
           FROM messages WHERE account = ?1 AND folder = ?2 AND date > 0 AND date < ?3",
    )?;
    let rows = stmt.query_map(params![account, folder, cutoff], |r| {
        Ok(Candidate {
            uid: r.get(0)?,
            date: r.get(1)?,
            seen: r.get::<_, i64>(2)? != 0,
            starred: r.get::<_, i64>(3)? != 0,
            message_id: r.get(4)?,
            subject: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A restored profile never archives on its own (ADR-0010).
pub fn hold_restored(conn: &Connection) -> Result<()> {
    let exists = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auto_archive_policies'")?
        .exists([])?;
    if exists {
        let rows: Vec<(String, String)> = conn
            .prepare("SELECT account, policy FROM auto_archive_policies")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (account, policy) in rows {
            let mut policy: Policy = serde_json::from_str(&policy).unwrap_or_default();
            policy.enabled = false;
            conn.execute(
                "UPDATE auto_archive_policies SET policy = ?2 WHERE account = ?1",
                params![account, serde_json::to_string(&policy)?],
            )?;
        }
    }
    Ok(())
}

/// [`Steps`] on the real account, through the engine's sessions, and the
/// real local archive.
pub struct EngineSteps {
    pub engine: std::sync::Arc<crate::engine::Engine>,
    pub account: String,
    pub media_root: std::path::PathBuf,
}

impl EngineSteps {
    fn local(&self) -> LocalArchive<'_> {
        LocalArchive { db: &self.engine.db, media_root: self.media_root.clone() }
    }
}

impl Steps for EngineSteps {
    fn candidates(&mut self, folder: &str, cutoff: i64) -> impl Future<Output = Result<Vec<Candidate>>> + Send {
        let folder = folder.to_string();
        async move {
            let searched = {
                let folder = folder.clone();
                self.engine
                    .with_read_session(&self.account, move |session| {
                        let folder = folder.clone();
                        Box::pin(async move { session.search_sent_before(&folder, cutoff).await })
                    })
                    .await?
            };
            let Some(uids) = searched else {
                return cached_candidates(&self.engine.db.lock().unwrap(), &self.account, &folder, cutoff);
            };
            let mut out = Vec::new();
            for chunk in uids.chunks(200) {
                let chunk = chunk.to_vec();
                let folder = folder.clone();
                let headers = self
                    .engine
                    .with_read_session(&self.account, move |session| {
                        let (folder, chunk) = (folder.clone(), chunk.clone());
                        Box::pin(async move { session.fetch_headers_by_uid(&folder, &chunk).await })
                    })
                    .await?;
                out.extend(headers.iter().map(Candidate::from));
            }
            Ok(out)
        }
    }

    async fn archive_folder(&mut self) -> Result<Option<String>> {
        let cached = crate::store::folder_for_role(&self.engine.db.lock().unwrap(), &self.account, "archive")?;
        if cached.is_some() {
            return Ok(cached);
        }
        self.engine
            .with_read_session(&self.account, |session| Box::pin(async move { session.find_archive_folder().await }))
            .await
    }

    fn fetch(&mut self, folder: &str, uid: u32) -> impl Future<Output = Result<Option<RawMessageCopy>>> + Send {
        let folder = folder.to_string();
        async move {
            let mut copies = self
                .engine
                .with_read_session(&self.account, move |session| {
                    let folder = folder.clone();
                    Box::pin(async move { session.fetch_raw_messages_for_copy(&folder, &[uid]).await })
                })
                .await?;
            Ok(if copies.is_empty() { None } else { Some(copies.swap_remove(0)) })
        }
    }

    fn move_to(&mut self, folder: &str, target: &str, uids: &[u32]) -> impl Future<Output = Result<()>> + Send {
        let (folder, target, uids) = (folder.to_string(), target.to_string(), uids.to_vec());
        async move {
            self.engine
                .with_write_session(&self.account, move |session| {
                    let (folder, target, uids) = (folder.clone(), target.clone(), uids.clone());
                    Box::pin(async move { session.move_to_folder(&folder, &target, &uids).await })
                })
                .await
        }
    }

    fn delete(&mut self, folder: &str, uids: &[u32]) -> impl Future<Output = Result<()>> + Send {
        let (folder, uids) = (folder.to_string(), uids.to_vec());
        async move {
            self.engine
                .with_write_session(&self.account, move |session| {
                    let (folder, uids) = (folder.clone(), uids.clone());
                    Box::pin(async move { session.expunge_uids(&folder, &uids).await })
                })
                .await
        }
    }

    fn store_local(&mut self, folder: &str, message: &RawMessageCopy) -> Result<u32> {
        self.local().store(folder, message)
    }

    fn read_local(&mut self, folder: &str, uid: u32) -> Result<Option<Vec<u8>>> {
        self.local().read(folder, uid)
    }

    fn find_local(&mut self, folder: &str, message_id: &str) -> Result<Vec<u32>> {
        self.local().find(folder, message_id)
    }

    fn remove_local(&mut self, folder: &str, uid: u32) -> Result<()> {
        self.local().remove(folder, uid)
    }
}

/// The name archived mail is filed under in the local archive.
pub fn account_label(conn: &Connection, account: &str) -> Result<String> {
    let email: Option<String> = conn
        .query_row("SELECT email FROM accounts WHERE id = ?1", params![account], |r| r.get(0))
        .optional()?;
    Ok(email.filter(|e| !e.trim().is_empty()).unwrap_or_else(|| account.to_string()))
}

#[cfg(test)]
mod tests;
