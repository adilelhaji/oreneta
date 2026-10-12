//! Chat (#110, #111, ADR-0036).
//!
//! XMPP first: an open standard with servers anyone can run, no provider
//! registration and no spending. Teams, Slack, Rocket.Chat and IceWarp
//! TeamChat are in the ADR's matrix and wait on their registrations.
//!
//! What the store guarantees:
//! - a message is kept once, whether it arrives live, as a copy from another
//!   of the person's devices (carbons) or from the server's archive (MAM);
//! - a message sent here moves only forward — sending, sent, accepted by the
//!   server (XEP-0198), delivered (XEP-0184) — and one whose fate is unknown
//!   after a disconnection is marked uncertain, never sent again on its own;
//!   the archive, when it has it, settles it as accepted.

use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub mod xmpp;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS chat_accounts (
    id TEXT PRIMARY KEY,
    jid TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
    chat_account TEXT NOT NULL,
    conversation TEXT NOT NULL,
    id TEXT NOT NULL,
    stanza_id TEXT,
    direction TEXT NOT NULL,
    sender TEXT NOT NULL,
    body TEXT NOT NULL,
    stamp INTEGER NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (chat_account, conversation, id)
);
CREATE INDEX IF NOT EXISTS chat_messages_order ON chat_messages(chat_account, conversation, stamp);
CREATE INDEX IF NOT EXISTS chat_messages_archive ON chat_messages(chat_account, stanza_id);
CREATE TABLE IF NOT EXISTS chat_reads (
    chat_account TEXT NOT NULL,
    conversation TEXT NOT NULL,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (chat_account, conversation)
);
";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatAccount {
    pub id: String,
    /// The person's address, e.g. `ana@chat.example`.
    pub jid: String,
    /// The server to connect to; empty means the address's own domain.
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
}

fn default_port() -> u16 {
    5222
}

pub fn secret_key(id: &str) -> String {
    format!("chat:{id}")
}

pub fn save_account(conn: &Connection, account: &ChatAccount, now: i64) -> Result<()> {
    let jid = account.jid.trim();
    ensure!(
        jid.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.')),
        "a chat address looks like name@server.example"
    );
    ensure!(!account.id.trim().is_empty(), "an id is needed");
    conn.execute(
        "INSERT INTO chat_accounts(id, jid, host, port, created_at) VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET jid = ?2, host = ?3, port = ?4",
        params![account.id, jid.to_lowercase(), account.host.trim(), account.port, now],
    )?;
    Ok(())
}

pub fn accounts(conn: &Connection) -> Result<Vec<ChatAccount>> {
    let mut stmt = conn.prepare("SELECT id, jid, host, port FROM chat_accounts ORDER BY created_at, id")?;
    let rows = stmt.query_map([], |r| {
        Ok(ChatAccount { id: r.get(0)?, jid: r.get(1)?, host: r.get(2)?, port: r.get::<_, i64>(3)? as u16 })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn account(conn: &Connection, id: &str) -> Result<ChatAccount> {
    accounts(conn)?.into_iter().find(|a| a.id == id).context("no such chat account")
}

/// Removes the account and everything kept for it here.
pub fn remove_account(conn: &Connection, id: &str) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM chat_messages WHERE chat_account = ?1", [id])?;
    tx.execute("DELETE FROM chat_reads WHERE chat_account = ?1", [id])?;
    tx.execute("DELETE FROM chat_accounts WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

// ---- Messages ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChatMessage {
    pub account: String,
    /// The other person's bare address.
    pub conversation: String,
    /// The sender's own id for it (origin-id), the same on every copy.
    pub id: String,
    /// The server archive's id, once known.
    pub stanza_id: Option<String>,
    /// `in` or `out`.
    pub direction: String,
    pub sender: String,
    pub body: String,
    pub stamp: i64,
    /// Out: `sending`, `sent`, `accepted`, `delivered`, `uncertain`, `failed`.
    /// In: `received`.
    pub state: String,
}

fn rank(state: &str) -> i32 {
    match state {
        "failed" | "uncertain" => 0,
        "sending" => 1,
        "sent" => 2,
        "accepted" => 3,
        "delivered" => 4,
        _ => 0,
    }
}

/// Keeps a message once, however many times and ways it arrives. A copy of
/// one sent here (from the archive or another device) proves the server has
/// it. Returns whether anything changed.
pub fn record(conn: &Connection, message: &ChatMessage) -> Result<bool> {
    if let Some(archive) = &message.stanza_id {
        let known: Option<String> = conn
            .query_row(
                "SELECT id FROM chat_messages WHERE chat_account = ?1 AND stanza_id = ?2",
                params![message.account, archive],
                |r| r.get(0),
            )
            .optional()?;
        if known.is_some() {
            return Ok(false);
        }
    }
    let existing: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT state, stanza_id FROM chat_messages WHERE chat_account = ?1 AND conversation = ?2 AND id = ?3",
            params![message.account, message.conversation, message.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match existing {
        Some((state, stanza_id)) => {
            let mut changed = false;
            if stanza_id.is_none() && message.stanza_id.is_some() {
                conn.execute(
                    "UPDATE chat_messages SET stanza_id = ?4 WHERE chat_account = ?1 AND conversation = ?2 AND id = ?3",
                    params![message.account, message.conversation, message.id, message.stanza_id],
                )?;
                changed = true;
            }
            // Our own message seen back from the server: it was accepted.
            if message.direction == "out" && rank(&state) < rank("accepted") {
                set_state(conn, &message.account, &message.id, "accepted")?;
                changed = true;
            }
            Ok(changed)
        }
        None => {
            conn.execute(
                "INSERT INTO chat_messages(chat_account, conversation, id, stanza_id, direction, sender, body, stamp, state)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    message.account,
                    message.conversation,
                    message.id,
                    message.stanza_id,
                    message.direction,
                    message.sender,
                    message.body,
                    message.stamp,
                    message.state
                ],
            )?;
            Ok(true)
        }
    }
}

/// Notes a message being sent from here, before it goes anywhere.
pub fn queue(conn: &Connection, account: &str, conversation: &str, id: &str, sender: &str, body: &str, now: i64) -> Result<()> {
    ensure!(!body.trim().is_empty(), "nothing to send");
    ensure!(body.len() <= 64 * 1024, "the message is too long");
    record(
        conn,
        &ChatMessage {
            account: account.into(),
            conversation: conversation.into(),
            id: id.into(),
            stanza_id: None,
            direction: "out".into(),
            sender: sender.into(),
            body: body.into(),
            stamp: now,
            state: "sending".into(),
        },
    )?;
    Ok(())
}

/// Moves a sent message's state forward; never back, except that a message
/// not yet accepted can become uncertain or failed.
pub fn set_state(conn: &Connection, account: &str, id: &str, state: &str) -> Result<()> {
    let current: Option<String> = conn
        .query_row(
            "SELECT state FROM chat_messages WHERE chat_account = ?1 AND id = ?2 AND direction = 'out'",
            params![account, id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(current) = current else { return Ok(()) };
    let allowed = match state {
        "uncertain" | "failed" => matches!(current.as_str(), "sending" | "sent"),
        // A retried message starts again.
        "sending" => matches!(current.as_str(), "uncertain" | "failed"),
        _ => rank(state) > rank(&current),
    };
    if allowed {
        conn.execute(
            "UPDATE chat_messages SET state = ?3 WHERE chat_account = ?1 AND id = ?2 AND direction = 'out'",
            params![account, id, state],
        )?;
    }
    Ok(())
}

/// After a disconnection, what was sending or sent without the server's
/// word is uncertain: maybe it arrived, maybe not. It is never sent again on
/// its own; the archive settles those it has.
pub fn after_disconnect(conn: &Connection, account: &str) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE chat_messages SET state = 'uncertain'
          WHERE chat_account = ?1 AND direction = 'out' AND state IN ('sending', 'sent')",
        [account],
    )?)
}

/// The newest archive id, where catching up starts.
pub fn last_archive_id(conn: &Connection, account: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT stanza_id FROM chat_messages WHERE chat_account = ?1 AND stanza_id IS NOT NULL
              ORDER BY stamp DESC, rowid DESC LIMIT 1",
            [account],
            |r| r.get(0),
        )
        .optional()?)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Conversation {
    pub conversation: String,
    pub last_body: String,
    pub last_stamp: i64,
    pub last_direction: String,
    pub unread: i64,
}

pub fn conversations(conn: &Connection, account: &str) -> Result<Vec<Conversation>> {
    let mut stmt = conn.prepare(
        "SELECT m.conversation, m.body, m.stamp, m.direction,
                (SELECT COUNT(*) FROM chat_messages u
                  WHERE u.chat_account = m.chat_account AND u.conversation = m.conversation AND u.direction = 'in'
                    AND u.stamp > COALESCE((SELECT read_at FROM chat_reads r
                                             WHERE r.chat_account = m.chat_account AND r.conversation = m.conversation), 0))
           FROM chat_messages m
          WHERE m.chat_account = ?1
            AND m.rowid = (SELECT rowid FROM chat_messages l WHERE l.chat_account = m.chat_account
                             AND l.conversation = m.conversation ORDER BY l.stamp DESC, l.rowid DESC LIMIT 1)
          ORDER BY m.stamp DESC",
    )?;
    let rows = stmt.query_map([account], |r| {
        Ok(Conversation {
            conversation: r.get(0)?,
            last_body: r.get(1)?,
            last_stamp: r.get(2)?,
            last_direction: r.get(3)?,
            unread: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// One conversation, oldest first, at most `limit` of the newest messages.
pub fn history(conn: &Connection, account: &str, conversation: &str, limit: i64) -> Result<Vec<ChatMessage>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM (SELECT chat_account, conversation, id, stanza_id, direction, sender, body, stamp, state, rowid
                          FROM chat_messages WHERE chat_account = ?1 AND conversation = ?2
                          ORDER BY stamp DESC, rowid DESC LIMIT ?3)
          ORDER BY stamp, rowid",
    )?;
    let rows = stmt.query_map(params![account, conversation, limit], |r| {
        Ok(ChatMessage {
            account: r.get(0)?,
            conversation: r.get(1)?,
            id: r.get(2)?,
            stanza_id: r.get(3)?,
            direction: r.get(4)?,
            sender: r.get(5)?,
            body: r.get(6)?,
            stamp: r.get(7)?,
            state: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn mark_read(conn: &Connection, account: &str, conversation: &str, at: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO chat_reads(chat_account, conversation, read_at) VALUES(?1, ?2, ?3)
         ON CONFLICT(chat_account, conversation) DO UPDATE SET read_at = MAX(read_at, ?3)",
        params![account, conversation, at],
    )?;
    Ok(())
}

/// A message of ours, for sending again by the person's choice.
pub fn outgoing(conn: &Connection, account: &str, id: &str) -> Result<ChatMessage> {
    history_where(conn, "chat_account = ?1 AND id = ?2 AND direction = 'out'", params![account, id])?
        .pop()
        .context("no such message")
}

fn history_where(conn: &Connection, filter: &str, args: impl rusqlite::Params) -> Result<Vec<ChatMessage>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT chat_account, conversation, id, stanza_id, direction, sender, body, stamp, state
           FROM chat_messages WHERE {filter}"
    ))?;
    let rows = stmt.query_map(args, |r| {
        Ok(ChatMessage {
            account: r.get(0)?,
            conversation: r.get(1)?,
            id: r.get(2)?,
            stanza_id: r.get(3)?,
            direction: r.get(4)?,
            sender: r.get(5)?,
            body: r.get(6)?,
            stamp: r.get(7)?,
            state: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests;
