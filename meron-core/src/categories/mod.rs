//! Inbox categories the reader defines, with the reason for every placement
//! (#91, ADR-0023).
//!
//! A category is a tab of the inbox: a name, a colour and, optionally, the
//! conditions that bring mail into it. Where a conversation goes is decided by
//! stated rules, in this order, and the one that decided is kept as its
//! reason:
//!
//! 1. the reader put this conversation there;
//! 2. the reader put mail from this sender there;
//! 3. the first category, in the reader's order, whose conditions hold;
//! 4. nothing matched: it is in "Other", which is always shown.
//!
//! None of it leaves the machine. A category is not a label (several per
//! conversation, possibly linked to a server) and not priority (the optional
//! "worth interrupting for" grouping): each has its own tables and its own
//! filter, so one can never be read as the other.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::rules::{Condition, Match, Subject};

#[cfg(test)]
mod tests;

pub const MAX_CATEGORIES: usize = 12;
pub const MAX_CONDITIONS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    /// As `#rrggbb`.
    pub colour: String,
    #[serde(default = "any")]
    pub match_mode: Match,
    /// Empty for a category filled only by hand.
    #[serde(default)]
    pub conditions: Vec<Condition>,
}

fn any() -> Match {
    Match::Any
}

/// Why a conversation is where it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Reason {
    /// The reader put this conversation here.
    Conversation,
    /// The reader put mail from this sender here.
    Sender { addr: String },
    /// These conditions of the category held (their positions).
    Conditions { held: Vec<usize> },
    /// No category's conditions held.
    NothingMatched,
}

/// A placement: the category id, empty for "Other", and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Verdict {
    pub category: String,
    pub reason: Reason,
}

/// What the reader said, if anything, about one conversation and its sender.
/// A correction naming a category that no longer exists says nothing.
#[derive(Debug, Clone, Default)]
pub struct Corrections<'a> {
    pub conversation: Option<&'a str>,
    pub sender: Option<&'a str>,
}

fn exists(categories: &[Category], id: &str) -> bool {
    id.is_empty() || categories.iter().any(|c| c.id == id)
}

/// The conditions of a category that hold for a message, when the category
/// matches it. A category without conditions matches nothing on its own.
fn held(category: &Category, subject: &Subject) -> Option<Vec<usize>> {
    if category.conditions.is_empty() {
        return None;
    }
    let held: Vec<usize> = category
        .conditions
        .iter()
        .enumerate()
        .filter(|(_, c)| crate::rules::holds(c, subject))
        .map(|(i, _)| i)
        .collect();
    let matched = match category.match_mode {
        Match::All => held.len() == category.conditions.len(),
        Match::Any => !held.is_empty(),
    };
    matched.then_some(held)
}

pub fn judge(categories: &[Category], corrections: &Corrections, from_addr: &str, subject: &Subject) -> Verdict {
    if let Some(id) = corrections.conversation.filter(|id| exists(categories, id)) {
        return Verdict { category: id.to_string(), reason: Reason::Conversation };
    }
    if let Some(id) = corrections.sender.filter(|id| exists(categories, id)) {
        return Verdict { category: id.to_string(), reason: Reason::Sender { addr: from_addr.trim().to_lowercase() } };
    }
    for category in categories {
        if let Some(held) = held(category, subject) {
            return Verdict { category: category.id.clone(), reason: Reason::Conditions { held } };
        }
    }
    Verdict { category: String::new(), reason: Reason::NothingMatched }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invalid {
    TooMany,
    NoName,
    SameName(String),
    SameId,
    TooManyConditions,
    EmptyCondition,
    Colour,
}

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Invalid::TooMany => write!(f, "at most {MAX_CATEGORIES} categories"),
            Invalid::NoName => f.write_str("a category needs a name"),
            Invalid::SameName(name) => write!(f, "two categories are called \"{name}\""),
            Invalid::SameId => f.write_str("two categories share an id"),
            Invalid::TooManyConditions => write!(f, "at most {MAX_CONDITIONS} conditions per category"),
            Invalid::EmptyCondition => f.write_str("a condition needs something to look for"),
            Invalid::Colour => f.write_str("a colour is written #rrggbb"),
        }
    }
}

pub fn validate(categories: &[Category]) -> Result<(), Invalid> {
    if categories.len() > MAX_CATEGORIES {
        return Err(Invalid::TooMany);
    }
    let mut names = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    for category in categories {
        let name = category.name.trim();
        if name.is_empty() || category.id.trim().is_empty() {
            return Err(Invalid::NoName);
        }
        if !names.insert(name.to_lowercase()) {
            return Err(Invalid::SameName(name.to_string()));
        }
        if !ids.insert(category.id.as_str()) {
            return Err(Invalid::SameId);
        }
        if category.conditions.len() > MAX_CONDITIONS {
            return Err(Invalid::TooManyConditions);
        }
        if category.conditions.iter().any(|c| c.value.trim().is_empty()) {
            return Err(Invalid::EmptyCondition);
        }
        let colour = category.colour.as_bytes();
        if colour.len() != 7 || colour[0] != b'#' || !colour[1..].iter().all(u8::is_ascii_hexdigit) {
            return Err(Invalid::Colour);
        }
    }
    Ok(())
}

// ---- Storage ---------------------------------------------------------------

/// `messages.category` holds the verdict: NULL until judged, '' for Other.
/// The corrections are kept apart from it, keyed by what survives a sync (the
/// conversation key and the sender), so a message fetched again is judged
/// again to the same place.
pub fn migrate(conn: &Connection) -> Result<()> {
    let has_column = conn
        .prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'category'")?
        .exists([])?;
    if !has_column {
        conn.execute_batch("ALTER TABLE messages ADD COLUMN category TEXT;")?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS inbox_categories (
           id       TEXT PRIMARY KEY,
           position INTEGER NOT NULL,
           json     TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS category_threads (
           account    TEXT NOT NULL,
           thread_key TEXT NOT NULL,
           category   TEXT NOT NULL,
           PRIMARY KEY (account, thread_key)
         );
         CREATE TABLE IF NOT EXISTS category_senders (
           account  TEXT NOT NULL,
           addr     TEXT NOT NULL,
           category TEXT NOT NULL,
           PRIMARY KEY (account, addr)
         );
         CREATE INDEX IF NOT EXISTS messages_category_idx ON messages(account, folder, category);",
    )?;
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<Category>> {
    let mut stmt = conn.prepare("SELECT json FROM inbox_categories ORDER BY position")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        // One unreadable entry does not take the others with it.
        if let Ok(category) = serde_json::from_str(&row?) {
            out.push(category);
        }
    }
    Ok(out)
}

/// Replaces the set, in order. Corrections that named a category no longer
/// in it are dropped with it, and every message is judged again.
pub fn save(conn: &Connection, categories: &[Category]) -> Result<()> {
    if let Err(invalid) = validate(categories) {
        bail!("{invalid}");
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM inbox_categories", [])?;
    for (position, category) in categories.iter().enumerate() {
        tx.execute(
            "INSERT INTO inbox_categories(id, position, json) VALUES(?1, ?2, ?3)",
            params![category.id, position as i64, serde_json::to_string(category)?],
        )?;
    }
    let ids: Vec<String> = categories.iter().map(|c| c.id.clone()).collect();
    let keep = serde_json::to_string(&ids)?;
    for table in ["category_threads", "category_senders"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE category <> '' AND category NOT IN (SELECT value FROM json_each(?1))"),
            [&keep],
        )?;
    }
    tx.execute("UPDATE messages SET category = NULL", [])?;
    tx.commit()?;
    Ok(())
}

const THREAD_KEY: &str = "COALESCE(NULLIF(thread_key, ''), 'uid:' || uid)";

/// Puts a conversation, or all mail from a sender, in a category ('' is
/// Other); `None` hands it back to the rules.
pub fn correct_conversation(conn: &Connection, account: &str, thread_key: &str, category: Option<&str>) -> Result<()> {
    match category {
        Some(id) => {
            known(conn, id)?;
            conn.execute(
                "INSERT OR REPLACE INTO category_threads(account, thread_key, category) VALUES(?1, ?2, ?3)",
                params![account, thread_key, id],
            )?
        }
        None => conn.execute(
            "DELETE FROM category_threads WHERE account = ?1 AND thread_key = ?2",
            params![account, thread_key],
        )?,
    };
    conn.execute(
        &format!("UPDATE messages SET category = NULL WHERE account = ?1 AND {THREAD_KEY} = ?2"),
        params![account, thread_key],
    )?;
    Ok(())
}

pub fn correct_sender(conn: &Connection, account: &str, addr: &str, category: Option<&str>) -> Result<()> {
    let addr = addr.trim().to_lowercase();
    if addr.is_empty() {
        bail!("this conversation has no sender address");
    }
    match category {
        Some(id) => {
            known(conn, id)?;
            conn.execute(
                "INSERT OR REPLACE INTO category_senders(account, addr, category) VALUES(?1, ?2, ?3)",
                params![account, addr, id],
            )?
        }
        None => conn.execute("DELETE FROM category_senders WHERE account = ?1 AND addr = ?2", params![account, addr])?,
    };
    conn.execute(
        "UPDATE messages SET category = NULL WHERE account = ?1 AND lower(COALESCE(from_addr, '')) = ?2",
        params![account, addr],
    )?;
    Ok(())
}

fn known(conn: &Connection, id: &str) -> Result<()> {
    if !id.is_empty() && !list(conn)?.iter().any(|c| c.id == id) {
        bail!("there is no such category");
    }
    Ok(())
}

fn conversation_correction(conn: &Connection, account: &str, thread_key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT category FROM category_threads WHERE account = ?1 AND thread_key = ?2",
            params![account, thread_key],
            |row| row.get(0),
        )
        .optional()?)
}

fn sender_correction(conn: &Connection, account: &str, addr: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT category FROM category_senders WHERE account = ?1 AND addr = ?2",
            params![account, addr.trim().to_lowercase()],
            |row| row.get(0),
        )
        .optional()?)
}

struct Row {
    thread_key: String,
    subject: String,
    from_name: String,
    from_addr: String,
    to: Vec<String>,
    cc: Vec<String>,
}

const ROW_COLUMNS: &str = "COALESCE(NULLIF(thread_key, ''), 'uid:' || uid), COALESCE(subject, ''),
    COALESCE(from_name, ''), COALESCE(from_addr, ''), json_extract(json, '$.to'), json_extract(json, '$.cc')";

fn read_row(row: &rusqlite::Row) -> rusqlite::Result<Row> {
    let addrs = |json: Option<String>| {
        crate::store::parse_recipients_json(json)
            .into_iter()
            .map(|r| format!("{} {}", r.name, r.addr).trim().to_string())
            .collect()
    };
    Ok(Row {
        thread_key: row.get(0)?,
        subject: row.get(1)?,
        from_name: row.get(2)?,
        from_addr: row.get(3)?,
        to: addrs(row.get(4)?),
        cc: addrs(row.get(5)?),
    })
}

fn verdict_for(conn: &Connection, categories: &[Category], account: &str, row: &Row) -> Result<Verdict> {
    let conversation = conversation_correction(conn, account, &row.thread_key)?;
    let sender = sender_correction(conn, account, &row.from_addr)?;
    let subject = Subject {
        from_name: &row.from_name,
        from_addr: &row.from_addr,
        to: row.to.clone(),
        cc: row.cc.clone(),
        subject: &row.subject,
    };
    let corrections = Corrections { conversation: conversation.as_deref(), sender: sender.as_deref() };
    Ok(judge(categories, &corrections, &row.from_addr, &subject))
}

/// Judges the account's conversations that hold mail not judged yet (all of
/// them when `only_unjudged` is false). A conversation is judged in each
/// folder by its newest message there, and every message of it in that folder
/// takes the verdict: the list and the counts then agree on where it is.
/// Everything this needs is already here; nothing is asked of a server.
pub fn rejudge(conn: &Connection, account: &str, only_unjudged: bool) -> Result<usize> {
    // The usual case, answered without reading the mailbox: nothing new.
    if only_unjudged
        && !conn
            .prepare("SELECT 1 FROM messages WHERE account = ?1 AND uid <> 0 AND category IS NULL LIMIT 1")?
            .exists([account])?
    {
        return Ok(0);
    }
    let categories = list(conn)?;
    // (folder, conversation) -> (newest message id, its messages, any unjudged)
    let mut groups: Vec<(i64, Vec<i64>, bool)> = Vec::new();
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT id, folder, {THREAD_KEY}, category IS NULL FROM messages
              WHERE account = ?1 AND uid <> 0
              ORDER BY folder, {THREAD_KEY}, date DESC, uid DESC"
        ))?;
        let mut rows = stmt.query([account])?;
        let mut last: Option<(String, String)> = None;
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let key = (row.get::<_, String>(1)?, row.get::<_, String>(2)?);
            let unjudged: bool = row.get(3)?;
            if last.as_ref() != Some(&key) {
                groups.push((id, Vec::new(), false));
                last = Some(key);
            }
            let group = groups.last_mut().expect("a group was just opened");
            group.1.push(id);
            group.2 |= unjudged;
        }
    }
    let tx = conn.unchecked_transaction()?;
    let mut judged = 0;
    {
        let mut newest = tx.prepare(&format!("SELECT {ROW_COLUMNS} FROM messages WHERE id = ?1"))?;
        let mut update = tx.prepare("UPDATE messages SET category = ?2 WHERE id = ?1")?;
        for (first, ids, unjudged) in groups {
            if only_unjudged && !unjudged {
                continue;
            }
            let row = newest.query_row([first], read_row)?;
            let verdict = verdict_for(&tx, &categories, account, &row)?;
            for id in &ids {
                update.execute(params![id, verdict.category])?;
            }
            judged += ids.len();
        }
    }
    tx.commit()?;
    Ok(judged)
}

/// Where the newest message of a conversation is, and why.
pub fn reason(conn: &Connection, account: &str, folder: &str, thread_key: &str) -> Result<Option<Verdict>> {
    let row = conn
        .query_row(
            &format!(
                "SELECT {ROW_COLUMNS} FROM messages WHERE account = ?1 AND folder = ?2 AND {THREAD_KEY} = ?3
                  ORDER BY date DESC, uid DESC LIMIT 1"
            ),
            params![account, folder, thread_key],
            read_row,
        )
        .optional()?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(verdict_for(conn, &list(conn)?, account, &row)?))
}

/// How many conversations of a folder each category holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Count {
    /// '' is Other.
    pub category: String,
    pub conversations: i64,
    pub unread: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Counts {
    pub counts: Vec<Count>,
    /// Conversations of the folder kept here, all categories together.
    pub conversations: i64,
    /// Of the folder's messages, how many are kept on this computer: the
    /// counts are of these, not of what the server may hold beyond them.
    pub messages: i64,
}

/// Counts by category, judging first what has not been judged. A
/// conversation is counted where its newest message is, as the list shows it.
pub fn counts(conn: &Connection, account: &str, folder: &str) -> Result<Counts> {
    rejudge(conn, account, true)?;
    let mut stmt = conn.prepare(&format!(
        "WITH newest AS (
           SELECT {THREAD_KEY} AS thread, category, seen,
                  ROW_NUMBER() OVER (PARTITION BY {THREAD_KEY} ORDER BY date DESC, uid DESC) AS n
             FROM messages WHERE account = ?1 AND folder = ?2 AND uid <> 0
         ), unread AS (
           SELECT DISTINCT {THREAD_KEY} AS thread FROM messages
            WHERE account = ?1 AND folder = ?2 AND uid <> 0 AND seen = 0
         )
         SELECT COALESCE(category, ''), COUNT(*), SUM(thread IN (SELECT thread FROM unread))
           FROM newest WHERE n = 1 GROUP BY COALESCE(category, '')"
    ))?;
    let counts: Vec<Count> = stmt
        .query_map(params![account, folder], |row| {
            Ok(Count { category: row.get(0)?, conversations: row.get(1)?, unread: row.get(2)? })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let messages = conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE account = ?1 AND folder = ?2 AND uid <> 0",
        params![account, folder],
        |row| row.get(0),
    )?;
    Ok(Counts { conversations: counts.iter().map(|c| c.conversations).sum(), counts, messages })
}
