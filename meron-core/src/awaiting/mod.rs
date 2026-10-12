//! Waiting for a reply (#45, ADR-0025).
//!
//! The person marks a message they sent as one they expect an answer to.
//! Whether it has been answered is read from the mail itself each time it is
//! asked, never from a subject line:
//!
//! - **answered** when a later message in the account answers it directly
//!   (`In-Reply-To` names it) or belongs to its conversation, and comes from
//!   someone it was sent to;
//! - **possibly answered** when such a message comes from someone else, or
//!   from an address nobody reads replies at (an automatic answer, a
//!   bounce): shown, for the person to say whether it counts;
//! - **waiting** otherwise.
//!
//! The person's own addresses never answer their own message. Records are
//! keyed by Message-ID, so they survive moves, re-downloads and restarts.
//! A reminder is a local notice and nothing else: nothing is ever sent.

use std::collections::HashSet;

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[cfg(test)]
mod tests;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS awaiting_replies (
  account     TEXT NOT NULL,
  message_id  TEXT NOT NULL,   -- normalized: lower case, no angle brackets
  thread_key  TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  recipients  TEXT NOT NULL DEFAULT '[]',   -- JSON array of addresses
  sent_at     INTEGER NOT NULL,
  remind_at   INTEGER,
  reminded_at INTEGER,
  -- 'waiting' until the person settles it: 'done' or 'cancelled'.
  state       TEXT NOT NULL DEFAULT 'waiting',
  -- Messages the person said are not an answer (JSON array of ids).
  not_replies TEXT NOT NULL DEFAULT '[]',
  -- A message the person said is the answer, when the mail could not tell.
  confirmed   TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (account, message_id)
);
";

pub fn normalize_id(id: &str) -> String {
    id.trim().trim_start_matches('<').trim_end_matches('>').trim().to_lowercase()
}

/// What answers, or may answer, the message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub message_id: String,
    pub from: String,
    pub date: i64,
    /// "direct" (`In-Reply-To` names it) or "conversation".
    pub link: String,
    /// Why it is only possible, when it is: "notRecipient" or "automated".
    pub doubt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub account: String,
    pub message_id: String,
    pub thread_key: String,
    pub subject: String,
    pub recipients: Vec<String>,
    pub sent_at: i64,
    pub remind_at: Option<i64>,
    /// "waiting", "answered", "possible", "done" or "cancelled".
    pub status: String,
    pub answer: Option<Evidence>,
    /// Possible answers the person has not ruled on.
    pub possible: Vec<Evidence>,
    /// Past its reminder and still waiting.
    pub overdue: bool,
}

/// One message the person sent, as the store has it.
struct Sent {
    message_id: String,
    thread_key: String,
    subject: String,
    recipients: Vec<String>,
    date: i64,
}

fn addresses(json: Option<String>) -> Vec<String> {
    crate::store::parse_recipients_json(json).into_iter().map(|r| r.addr.trim().to_lowercase()).filter(|a| !a.is_empty()).collect()
}

/// The newest message of a conversation sent from one of the account's own
/// addresses, in any folder.
fn newest_sent(conn: &Connection, account: &str, thread_key: &str, mine: &HashSet<String>) -> Result<Option<Sent>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(json_extract(json, '$.message_id'), ''), COALESCE(subject, ''),
                lower(COALESCE(from_addr, '')), json_extract(json, '$.to'), json_extract(json, '$.cc'), date
           FROM messages
          WHERE account = ?1 AND uid <> 0 AND COALESCE(NULLIF(thread_key, ''), 'uid:' || uid) = ?2
          ORDER BY date DESC, uid DESC",
    )?;
    let mut rows = stmt.query(params![account, thread_key])?;
    while let Some(row) = rows.next()? {
        let from: String = row.get(2)?;
        let message_id = normalize_id(&row.get::<_, String>(0)?);
        if !mine.contains(&from) || message_id.is_empty() {
            continue;
        }
        let mut recipients = addresses(row.get(3)?);
        recipients.extend(addresses(row.get(4)?));
        recipients.retain(|addr| !mine.contains(addr));
        recipients.dedup();
        return Ok(Some(Sent { message_id, thread_key: thread_key.to_string(), subject: row.get(1)?, recipients, date: row.get(5)? }));
    }
    Ok(None)
}

/// Starts waiting for a reply to the newest message the person sent in a
/// conversation. Marking it again only changes the reminder.
pub fn add(conn: &Connection, account: &str, thread_key: &str, remind_at: Option<i64>, now: i64) -> Result<Item> {
    let mine = crate::store::self_addrs(conn, account);
    let sent = newest_sent(conn, account, thread_key, &mine)?
        .context("you have not written in this conversation, so there is nothing to wait for a reply to")?;
    if remind_at.is_some_and(|at| at <= now) {
        bail!("a reminder has to be in the future");
    }
    conn.execute(
        "INSERT INTO awaiting_replies(account, message_id, thread_key, subject, recipients, sent_at, remind_at, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(account, message_id) DO UPDATE SET remind_at = excluded.remind_at, reminded_at = NULL,
           state = 'waiting'",
        params![
            account,
            sent.message_id,
            sent.thread_key,
            sent.subject,
            serde_json::to_string(&sent.recipients)?,
            sent.date,
            remind_at,
            now
        ],
    )?;
    item(conn, account, &sent.message_id, now)?.context("the record was not kept")
}

struct Row {
    account: String,
    message_id: String,
    thread_key: String,
    subject: String,
    recipients: Vec<String>,
    sent_at: i64,
    remind_at: Option<i64>,
    state: String,
    not_replies: Vec<String>,
    confirmed: String,
}

const COLUMNS: &str =
    "account, message_id, thread_key, subject, recipients, sent_at, remind_at, state, not_replies, confirmed";

fn read(row: &rusqlite::Row) -> rusqlite::Result<Row> {
    let list = |text: String| serde_json::from_str::<Vec<String>>(&text).unwrap_or_default();
    Ok(Row {
        account: row.get(0)?,
        message_id: row.get(1)?,
        thread_key: row.get(2)?,
        subject: row.get(3)?,
        recipients: list(row.get(4)?),
        sent_at: row.get(5)?,
        remind_at: row.get(6)?,
        state: row.get(7)?,
        not_replies: list(row.get(8)?),
        confirmed: row.get(9)?,
    })
}

/// Every later message that answers or may answer a record, judged.
fn evidence(conn: &Connection, row: &Row) -> Result<Vec<Evidence>> {
    let mine = crate::store::self_addrs(conn, &row.account);
    let mut stmt = conn.prepare(
        "SELECT COALESCE(json_extract(json, '$.message_id'), ''), lower(COALESCE(from_addr, '')), date,
                COALESCE(json_extract(json, '$.in_reply_to'), ''),
                COALESCE(NULLIF(thread_key, ''), 'uid:' || uid) = ?3
           FROM messages
          WHERE account = ?1 AND uid <> 0 AND date >= ?4
            AND (COALESCE(NULLIF(thread_key, ''), 'uid:' || uid) = ?3
                 OR lower(COALESCE(json_extract(json, '$.in_reply_to'), '')) LIKE ?2 ESCAPE '\\')
          ORDER BY date, uid",
    )?;
    let like = format!("%{}%", row.message_id.replace('%', "").replace('_', "\\_"));
    let rows = stmt.query_map(params![row.account, like, row.thread_key, row.sent_at], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?, r.get::<_, bool>(4)?))
    })?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for found in rows {
        let (id, from, date, in_reply_to, same_conversation) = found?;
        let id = normalize_id(&id);
        // The person's own messages, the message itself, and the same
        // message seen in two folders are not answers.
        if mine.contains(&from) || id == row.message_id || (!id.is_empty() && !seen.insert(id.clone())) {
            continue;
        }
        let direct = normalize_id(&in_reply_to) == row.message_id;
        if !direct && !same_conversation {
            continue;
        }
        let doubt = if crate::priority::looks_automated(&from) {
            "automated"
        } else if !row.recipients.contains(&from) {
            "notRecipient"
        } else {
            ""
        };
        out.push(Evidence {
            message_id: id,
            from,
            date,
            link: if direct { "direct" } else { "conversation" }.to_string(),
            doubt: doubt.to_string(),
        });
    }
    Ok(out)
}

fn judge(conn: &Connection, row: Row, now: i64) -> Result<Item> {
    let found = evidence(conn, &row)?;
    let answer = if !row.confirmed.is_empty() {
        found.iter().find(|e| e.message_id == row.confirmed).cloned()
    } else {
        found.iter().find(|e| e.doubt.is_empty() && !row.not_replies.contains(&e.message_id)).cloned()
    };
    let possible: Vec<Evidence> = if answer.is_some() {
        Vec::new()
    } else {
        found.into_iter().filter(|e| !e.doubt.is_empty() && !row.not_replies.contains(&e.message_id)).collect()
    };
    let status = match row.state.as_str() {
        "done" | "cancelled" => row.state.clone(),
        _ if answer.is_some() => "answered".to_string(),
        _ if !possible.is_empty() => "possible".to_string(),
        _ => "waiting".to_string(),
    };
    let overdue = status == "waiting" && row.remind_at.is_some_and(|at| at <= now);
    Ok(Item {
        account: row.account,
        message_id: row.message_id,
        thread_key: row.thread_key,
        subject: row.subject,
        recipients: row.recipients,
        sent_at: row.sent_at,
        remind_at: row.remind_at,
        status,
        answer,
        possible,
        overdue,
    })
}

pub fn item(conn: &Connection, account: &str, message_id: &str, now: i64) -> Result<Option<Item>> {
    let row = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM awaiting_replies WHERE account = ?1 AND message_id = ?2"),
            params![account, normalize_id(message_id)],
            read,
        )
        .optional()?;
    row.map(|row| judge(conn, row, now)).transpose()
}

/// What is being waited on, oldest first; settled records only when asked.
pub fn list(conn: &Connection, account: Option<&str>, include_settled: bool, now: i64) -> Result<Vec<Item>> {
    let rows: Vec<Row> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM awaiting_replies
              WHERE (?1 IS NULL OR account = ?1) AND (?2 OR state = 'waiting')
              ORDER BY sent_at"
        ))?;
        let rows = stmt.query_map(params![account, include_settled], read)?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    rows.into_iter().map(|row| judge(conn, row, now)).collect()
}

/// The person settles a record: "waiting" (again), "done" or "cancelled".
pub fn set_state(conn: &Connection, account: &str, message_id: &str, state: &str) -> Result<()> {
    if !matches!(state, "waiting" | "done" | "cancelled") {
        bail!("unknown state {state}");
    }
    let changed = conn.execute(
        "UPDATE awaiting_replies SET state = ?3 WHERE account = ?1 AND message_id = ?2",
        params![account, normalize_id(message_id), state],
    )?;
    if changed == 0 {
        bail!("nothing is being waited on for that message");
    }
    Ok(())
}

/// The person rules on a message: it is the answer, or it is not one.
pub fn rule_on(conn: &Connection, account: &str, message_id: &str, candidate: &str, is_answer: bool) -> Result<()> {
    let id = normalize_id(message_id);
    let candidate = normalize_id(candidate);
    let row = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM awaiting_replies WHERE account = ?1 AND message_id = ?2"),
            params![account, id],
            read,
        )
        .optional()?
        .context("nothing is being waited on for that message")?;
    if is_answer {
        let mut not_replies = row.not_replies;
        not_replies.retain(|other| other != &candidate);
        conn.execute(
            "UPDATE awaiting_replies SET confirmed = ?3, not_replies = ?4 WHERE account = ?1 AND message_id = ?2",
            params![account, id, candidate, serde_json::to_string(&not_replies)?],
        )?;
    } else {
        let mut not_replies = row.not_replies;
        if !not_replies.contains(&candidate) {
            not_replies.push(candidate.clone());
        }
        let confirmed = if row.confirmed == candidate { String::new() } else { row.confirmed };
        conn.execute(
            "UPDATE awaiting_replies SET confirmed = ?3, not_replies = ?4 WHERE account = ?1 AND message_id = ?2",
            params![account, id, confirmed, serde_json::to_string(&not_replies)?],
        )?;
    }
    Ok(())
}

pub fn remove(conn: &Connection, account: &str, message_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM awaiting_replies WHERE account = ?1 AND message_id = ?2",
        params![account, normalize_id(message_id)],
    )?;
    Ok(())
}

/// Records whose reminder has come and that are still waiting. Each is
/// returned once: it is marked reminded as it is handed out.
pub fn due_reminders(conn: &Connection, now: i64) -> Result<Vec<Item>> {
    let rows: Vec<Row> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM awaiting_replies
              WHERE state = 'waiting' AND remind_at IS NOT NULL AND remind_at <= ?1 AND reminded_at IS NULL"
        ))?;
        let rows = stmt.query_map([now], read)?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut due = Vec::new();
    for row in rows {
        conn.execute(
            "UPDATE awaiting_replies SET reminded_at = ?3 WHERE account = ?1 AND message_id = ?2",
            params![row.account, row.message_id, now],
        )?;
        let item = judge(conn, row, now)?;
        // Answered meanwhile: nothing to remind of.
        if item.status == "waiting" || item.status == "possible" {
            due.push(item);
        }
    }
    Ok(due)
}
