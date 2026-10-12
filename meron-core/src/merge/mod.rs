//! Personalized mass mail (#90, ADR-0026).
//!
//! One message per recipient, each addressed to that recipient alone: no
//! shared To, no BCC, nobody's address in anybody else's message. The core
//! renders every message, the preview shows exactly those messages, and
//! starting a batch stores exactly those messages. A message is never sent
//! twice on a guess: each is a #29 attempt under its own Message-ID, and one
//! whose outcome is unknown is never tried again on its own.

use std::collections::{BTreeSet, HashMap, HashSet};

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[cfg(test)]
mod tests;

pub const MAX_RECIPIENTS: usize = 500;
/// Seconds between two messages of a batch, unless asked otherwise.
pub const DEFAULT_SPACING: i64 = 3;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS merge_batches (
  id         TEXT PRIMARY KEY,
  account    TEXT NOT NULL,
  from_addr  TEXT NOT NULL DEFAULT '',
  subject    TEXT NOT NULL DEFAULT '',   -- the template, for the list
  spacing    INTEGER NOT NULL,
  -- 'sending', 'paused', 'cancelled' or 'done'
  state      TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS merge_items (
  batch_id   TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  to_addr    TEXT NOT NULL,
  to_name    TEXT NOT NULL DEFAULT '',
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  message_id TEXT NOT NULL,
  -- 'pending', 'sending', 'accepted', 'rejected', 'uncertain' or 'cancelled'
  state      TEXT NOT NULL DEFAULT 'pending',
  error      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (batch_id, idx)
);
";

/// One recipient row: the address, the name, and any other columns given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub line: usize,
    pub email: String,
    pub name: String,
    pub columns: HashMap<String, String>,
}

fn split_csv(line: &str, separator: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            c if c == separator && !quoted => out.push(std::mem::take(&mut field).trim().to_string()),
            c => field.push(c),
        }
    }
    out.push(field.trim().to_string());
    out
}

/// Reads "Name <address>" or a bare address.
fn one_address(text: &str) -> (String, String) {
    let text = text.trim();
    if let (Some(open), Some(close)) = (text.rfind('<'), text.rfind('>')) {
        if close > open {
            let name = text[..open].trim().trim_matches('"').trim().to_string();
            return (name, text[open + 1..close].trim().to_string());
        }
    }
    (String::new(), text.to_string())
}

/// Reads the recipient list: one recipient per line ("Name <address>" or an
/// address), or a table whose first line names its columns, one of them
/// "email" (separated by commas, semicolons or tabs).
pub fn parse_recipients(text: &str) -> Vec<Row> {
    let lines: Vec<(usize, &str)> =
        text.lines().enumerate().map(|(i, l)| (i + 1, l.trim())).filter(|(_, l)| !l.is_empty()).collect();
    let Some(&(_, first)) = lines.first() else { return Vec::new() };
    let separator = ['\t', ';', ','].into_iter().find(|s| first.contains(*s));
    let header: Option<Vec<String>> = separator
        .map(|s| split_csv(first, s).into_iter().map(|h| h.to_lowercase()).collect::<Vec<_>>())
        .filter(|h| h.iter().any(|c| c == "email"));
    match (header, separator) {
        (Some(header), Some(separator)) => lines[1..]
            .iter()
            .map(|&(line, text)| {
                let cells = split_csv(text, separator);
                let columns: HashMap<String, String> =
                    header.iter().cloned().zip(cells.into_iter().chain(std::iter::repeat(String::new()))).collect();
                Row {
                    line,
                    email: columns.get("email").cloned().unwrap_or_default(),
                    name: columns.get("name").cloned().unwrap_or_default(),
                    columns,
                }
            })
            .collect(),
        _ => lines
            .iter()
            .map(|&(line, text)| {
                let (name, email) = one_address(text);
                Row { line, email, name, columns: HashMap::new() }
            })
            .collect(),
    }
}

fn first_name(name: &str) -> String {
    let name = name.trim();
    let given = match name.find(',') {
        Some(comma) => name[comma + 1..].trim(),
        None => name,
    };
    given.split_whitespace().next().unwrap_or("").to_string()
}

pub struct Sender {
    pub name: String,
    pub email: String,
}

const BUILT_IN: &[&str] = &["to.name", "to.firstName", "to.email", "me.name", "me.firstName", "me.email"];

fn value_of(name: &str, row: &Row, me: &Sender) -> Option<String> {
    let value = match name {
        "to.name" => row.name.clone(),
        "to.firstName" => first_name(&row.name),
        "to.email" => row.email.clone(),
        "me.name" => me.name.clone(),
        "me.firstName" => first_name(&me.name),
        "me.email" => me.email.clone(),
        other => row.columns.get(&other.to_lowercase())?.clone(),
    };
    Some(value)
}

/// Every placeholder written in a text, in order of first appearance.
fn placeholders(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("{{") {
        let after = &rest[open + 2..];
        let Some(close) = after.find("}}") else { break };
        let name = after[..close].trim().to_string();
        if !name.is_empty() && !found.contains(&name) {
            found.push(name);
        }
        rest = &after[close + 2..];
    }
    found
}

fn fill(text: &str, row: &Row, me: &Sender) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("{{") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        let Some(close) = after.find("}}") else {
            out.push_str(&rest[open..]);
            return out;
        };
        let name = after[..close].trim();
        match value_of(name, row, me) {
            Some(value) if !value.is_empty() => out.push_str(&value),
            _ => out.push_str(&rest[open..open + 2 + close + 2]),
        }
        rest = &after[close + 2..];
    }
    out.push_str(rest);
    out
}

/// One personalized message, as it would be sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    pub index: usize,
    pub line: usize,
    pub to: String,
    pub name: String,
    pub subject: String,
    pub body: String,
    /// Why this one cannot go as it is: "invalidAddress", "duplicate", or
    /// "missing:<placeholder>".
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub messages: Vec<Rendered>,
    /// Problems with the whole batch: "noRecipients", "tooMany", "noSubject",
    /// "unknown:<placeholder>".
    pub problems: Vec<String>,
    /// Whether it can be sent as it is.
    pub ready: bool,
}

fn looks_like_address(addr: &str) -> bool {
    let Some((local, domain)) = addr.split_once('@') else { return false };
    !local.is_empty() && domain.contains('.') && !addr.chars().any(|c| c.is_whitespace() || c == ',' || c == ';' || c == '<' || c == '>')
}

pub fn preview(recipients: &str, subject: &str, body: &str, me: &Sender) -> Preview {
    let rows = parse_recipients(recipients);
    let mut problems = Vec::new();
    if rows.is_empty() {
        problems.push("noRecipients".to_string());
    }
    if rows.len() > MAX_RECIPIENTS {
        problems.push("tooMany".to_string());
    }
    if subject.trim().is_empty() {
        problems.push("noSubject".to_string());
    }
    let columns: HashSet<String> = rows.iter().flat_map(|r| r.columns.keys().cloned()).collect();
    let used: BTreeSet<String> = placeholders(subject).into_iter().chain(placeholders(body)).collect();
    for name in &used {
        if !BUILT_IN.contains(&name.as_str()) && !columns.contains(&name.to_lowercase()) {
            problems.push(format!("unknown:{name}"));
        }
    }
    let mut seen = HashSet::new();
    let messages: Vec<Rendered> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let mut own = Vec::new();
            if !looks_like_address(&row.email) {
                own.push("invalidAddress".to_string());
            } else if !seen.insert(row.email.to_lowercase()) {
                own.push("duplicate".to_string());
            }
            for name in &used {
                let known = BUILT_IN.contains(&name.as_str()) || columns.contains(&name.to_lowercase());
                if known && value_of(name, row, me).unwrap_or_default().trim().is_empty() {
                    own.push(format!("missing:{name}"));
                }
            }
            Rendered {
                index,
                line: row.line,
                to: row.email.clone(),
                name: row.name.clone(),
                subject: fill(subject, row, me),
                body: fill(body, row, me),
                problems: own,
            }
        })
        .collect();
    let ready = problems.is_empty() && messages.iter().all(|m| m.problems.is_empty());
    Preview { messages, problems, ready }
}

// ---- Batches ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub index: i64,
    pub to: String,
    pub name: String,
    pub subject: String,
    pub body: String,
    pub message_id: String,
    pub state: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub account: String,
    pub from: String,
    pub subject: String,
    pub spacing: i64,
    pub state: String,
    pub reason: String,
    pub created_at: i64,
    pub items: Vec<Item>,
}

/// Stores a batch from a preview that is ready, and only if it is still the
/// one the person reviewed: the same number of messages.
pub fn create(
    conn: &Connection,
    id: &str,
    account: &str,
    from: &str,
    subject_template: &str,
    preview: &Preview,
    reviewed: usize,
    spacing: i64,
    now: i64,
) -> Result<()> {
    if !preview.ready {
        bail!("this mailing still has problems to fix before it can go");
    }
    if preview.messages.len() != reviewed {
        bail!("the recipients changed since the preview: review it again");
    }
    let domain = from.rsplit_once('@').map(|(_, d)| d).filter(|d| !d.is_empty()).unwrap_or("oreneta.invalid");
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO merge_batches(id, account, from_addr, subject, spacing, state, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, 'sending', ?6)",
        params![id, account, from, subject_template, spacing.max(0), now],
    )?;
    for message in &preview.messages {
        tx.execute(
            "INSERT INTO merge_items(batch_id, idx, to_addr, to_name, subject, body, message_id, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                message.index as i64,
                message.to,
                message.name,
                message.subject,
                message.body,
                format!("<merge-{id}-{}@{domain}>", message.index),
                now
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn batch(conn: &Connection, id: &str) -> Result<Option<Batch>> {
    let head = conn
        .query_row(
            "SELECT id, account, from_addr, subject, spacing, state, reason, created_at FROM merge_batches WHERE id = ?1",
            [id],
            |r| {
                Ok(Batch {
                    id: r.get(0)?,
                    account: r.get(1)?,
                    from: r.get(2)?,
                    subject: r.get(3)?,
                    spacing: r.get(4)?,
                    state: r.get(5)?,
                    reason: r.get(6)?,
                    created_at: r.get(7)?,
                    items: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut head) = head else { return Ok(None) };
    let mut stmt = conn.prepare(
        "SELECT idx, to_addr, to_name, subject, body, message_id, state, error FROM merge_items
          WHERE batch_id = ?1 ORDER BY idx",
    )?;
    head.items = stmt
        .query_map([id], |r| {
            Ok(Item {
                index: r.get(0)?,
                to: r.get(1)?,
                name: r.get(2)?,
                subject: r.get(3)?,
                body: r.get(4)?,
                message_id: r.get(5)?,
                state: r.get(6)?,
                error: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(head))
}

pub fn batches(conn: &Connection) -> Result<Vec<Batch>> {
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM merge_batches ORDER BY created_at DESC")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ids.iter().filter_map(|id| batch(conn, id).ok().flatten()).collect())
}

/// The next message to send, marked as sending, while the batch is sending.
/// `None` when there is nothing to do: the batch is paused, cancelled or done
/// (and marked done when nothing is left).
pub fn claim_next(conn: &Connection, id: &str, now: i64) -> Result<Option<Item>> {
    let state: Option<String> =
        conn.query_row("SELECT state FROM merge_batches WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    if state.as_deref() != Some("sending") {
        return Ok(None);
    }
    let next = batch(conn, id)?.and_then(|b| b.items.into_iter().find(|i| i.state == "pending"));
    match next {
        Some(item) => {
            conn.execute(
                "UPDATE merge_items SET state = 'sending', updated_at = ?3 WHERE batch_id = ?1 AND idx = ?2",
                params![id, item.index, now],
            )?;
            Ok(Some(item))
        }
        None => {
            conn.execute("UPDATE merge_batches SET state = 'done', reason = '' WHERE id = ?1", [id])?;
            Ok(None)
        }
    }
}

/// What a send's answer means for one message.
pub enum Outcome {
    Accepted,
    /// Refused by the server: it did not go.
    Rejected(String),
    /// Refused for now; the batch pauses and the message stays to send.
    Deferred(String),
    /// Nobody knows whether it went: never tried again on its own.
    Uncertain(String),
}

/// Whether a refusal is the server asking to wait (SMTP 4xx, a rate limit),
/// rather than a no.
pub fn is_deferral(error: &str) -> bool {
    let lower = error.to_lowercase();
    ["421", "450", "451", "452", "4.7.", "rate limit", "too many", "try again later", "throttl"]
        .iter()
        .any(|sign| lower.contains(sign))
}

pub fn settle(conn: &Connection, id: &str, index: i64, outcome: Outcome, now: i64) -> Result<()> {
    let (state, error) = match &outcome {
        Outcome::Accepted => ("accepted", String::new()),
        Outcome::Rejected(e) => ("rejected", e.clone()),
        Outcome::Deferred(e) => ("pending", e.clone()),
        Outcome::Uncertain(e) => ("uncertain", e.clone()),
    };
    conn.execute(
        "UPDATE merge_items SET state = ?3, error = ?4, updated_at = ?5 WHERE batch_id = ?1 AND idx = ?2",
        params![id, index, state, error, now],
    )?;
    if let Outcome::Deferred(reason) = outcome {
        conn.execute(
            "UPDATE merge_batches SET state = 'paused', reason = ?2 WHERE id = ?1 AND state = 'sending'",
            params![id, format!("the server asked to wait: {reason}")],
        )?;
    }
    Ok(())
}

/// Stops sending: what has not gone is marked cancelled. A message already
/// on its way is not called back; it settles as it settles.
pub fn cancel(conn: &Connection, id: &str, now: i64) -> Result<()> {
    conn.execute("UPDATE merge_batches SET state = 'cancelled', reason = '' WHERE id = ?1", [id])?;
    conn.execute(
        "UPDATE merge_items SET state = 'cancelled', updated_at = ?2 WHERE batch_id = ?1 AND state = 'pending'",
        params![id, now],
    )?;
    Ok(())
}

/// Carries on with a paused batch. `retry_rejected` also puts the refused
/// ones back in line, because the person asked; uncertain ones never.
pub fn resume(conn: &Connection, id: &str, retry_rejected: bool) -> Result<()> {
    let changed = conn.execute(
        "UPDATE merge_batches SET state = 'sending', reason = '' WHERE id = ?1 AND state IN ('paused', 'done')",
        [id],
    )?;
    if changed == 0 {
        bail!("only a paused or finished mailing can carry on");
    }
    if retry_rejected {
        conn.execute("UPDATE merge_items SET state = 'pending', error = '' WHERE batch_id = ?1 AND state = 'rejected'", [id])?;
    }
    Ok(())
}

/// After a restart: a batch that was sending is paused, and a message that
/// was on its way is settled from its #29 attempt, or left uncertain.
pub fn recover(conn: &Connection, now: i64) -> Result<Vec<String>> {
    let stuck: Vec<(String, i64, String)> = conn
        .prepare("SELECT batch_id, idx, message_id FROM merge_items WHERE state = 'sending'")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (batch_id, index, message_id) in stuck {
        let attempt = crate::store::outgoing::attempt(conn, &message_id)?;
        let outcome = match attempt.map(|a| a.state) {
            Some(crate::store::outgoing::AttemptState::Accepted | crate::store::outgoing::AttemptState::Archived) => {
                Outcome::Accepted
            }
            Some(crate::store::outgoing::AttemptState::Rejected) => Outcome::Rejected(String::new()),
            // Never begun: it did not go, so it simply waits its turn again.
            None => {
                conn.execute(
                    "UPDATE merge_items SET state = 'pending', updated_at = ?3 WHERE batch_id = ?1 AND idx = ?2",
                    params![batch_id, index, now],
                )?;
                continue;
            }
            _ => Outcome::Uncertain("Oreneta stopped while this message was being sent".to_string()),
        };
        settle(conn, &batch_id, index, outcome, now)?;
    }
    let paused: Vec<String> = conn
        .prepare("SELECT id FROM merge_batches WHERE state = 'sending'")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    conn.execute(
        "UPDATE merge_batches SET state = 'paused', reason = 'Oreneta stopped while this was being sent' WHERE state = 'sending'",
        [],
    )?;
    Ok(paused)
}
