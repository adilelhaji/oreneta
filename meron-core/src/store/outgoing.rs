//! What became of every message this profile tried to send.
//!
//! A send has three outcomes, not two: the server took it, the server refused
//! it, or the connection failed after the message had left and nobody knows.
//! Each attempt is written down before the first byte goes and updated as the
//! answer comes in, so a crash, a lost connection or a failed Sent-folder copy
//! never turns into a second copy at the recipient or a message quietly lost.
//! Nothing here touches the network: the engine reads this to decide, and the
//! interface reads it to tell the reader the truth.
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS outgoing_attempts (
  id            TEXT PRIMARY KEY,
  account       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK(kind IN ('now', 'scheduled')),
  message_id    TEXT NOT NULL,
  subject       TEXT NOT NULL,
  recipients    TEXT NOT NULL,
  payload       TEXT NOT NULL,
  state         TEXT NOT NULL CHECK(state IN ('sending', 'accepted', 'archived', 'rejected', 'uncertain', 'resolved')),
  error         TEXT NOT NULL DEFAULT '',
  archive_error TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outgoing_attempts_account_state_idx ON outgoing_attempts(account, state);
";

/// Where an attempt stands. The transitions are few and one-way:
///
/// ```text
/// sending ─┬─> accepted ──> archived
///          ├─> rejected
///          └─> uncertain ──> resolved
/// ```
///
/// `accepted` with an `archive_error` is a message that went but has no copy
/// in Sent; it is still a sent message. `uncertain` is the only state a
/// person has to settle: the engine never moves it on by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptState {
    /// Written before the first byte goes. Found at startup, it means the
    /// process died mid-send, which is `uncertain` by another name.
    Sending,
    /// The server said yes. The message is on its way whatever happens next.
    Accepted,
    /// Accepted, and the Sent copy is filed.
    Archived,
    /// The server said no, or was never reached. Safe to try again.
    Rejected,
    /// The message left and no answer came back. May have gone; may not.
    Uncertain,
    /// An uncertain outcome a person has looked at and settled.
    Resolved,
}

impl AttemptState {
    pub fn as_str(self) -> &'static str {
        match self {
            AttemptState::Sending => "sending",
            AttemptState::Accepted => "accepted",
            AttemptState::Archived => "archived",
            AttemptState::Rejected => "rejected",
            AttemptState::Uncertain => "uncertain",
            AttemptState::Resolved => "resolved",
        }
    }

    fn parse(text: &str) -> Result<Self> {
        Ok(match text {
            "sending" => AttemptState::Sending,
            "accepted" => AttemptState::Accepted,
            "archived" => AttemptState::Archived,
            "rejected" => AttemptState::Rejected,
            "uncertain" => AttemptState::Uncertain,
            "resolved" => AttemptState::Resolved,
            other => anyhow::bail!("unknown outgoing attempt state {other:?}"),
        })
    }

    /// Whether the message may already be with the recipient, so sending
    /// the same message again could deliver it twice.
    ///
    /// `sending` counts: an attempt still marked that way while nothing is
    /// in flight belongs to a process that died, and its message may have
    /// gone. `resolved` does not: a person has already made that call.
    pub fn may_have_gone(self) -> bool {
        matches!(
            self,
            AttemptState::Sending | AttemptState::Accepted | AttemptState::Archived | AttemptState::Uncertain
        )
    }
}

/// Which path asked for the send. Kept so the interface can send the reader
/// to the right place to deal with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptKind {
    Now,
    Scheduled,
}

impl AttemptKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AttemptKind::Now => "now",
            AttemptKind::Scheduled => "scheduled",
        }
    }

    fn parse(text: &str) -> Result<Self> {
        Ok(match text {
            "now" => AttemptKind::Now,
            "scheduled" => AttemptKind::Scheduled,
            other => anyhow::bail!("unknown outgoing attempt kind {other:?}"),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingAttempt {
    pub id: String,
    pub account: String,
    pub kind: AttemptKind,
    pub message_id: String,
    pub subject: String,
    pub recipients: String,
    /// The send request as the composer wrote it, minus any passphrase: the
    /// message itself, so an uncertain send can be looked at or deliberately
    /// sent again after a restart.
    pub payload: String,
    pub state: AttemptState,
    pub error: String,
    pub archive_error: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl OutgoingAttempt {
    /// The attempt as the interface reads it. `message` is the stored
    /// request, so the interface can offer to send it again without the
    /// engine having to remember it in some second place.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "account": self.account,
            "kind": self.kind.as_str(),
            "messageId": self.message_id,
            "subject": self.subject,
            "to": self.recipients,
            "state": self.state.as_str(),
            "error": self.error,
            "archiveError": self.archive_error,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "message": serde_json::from_str::<Value>(&self.payload).unwrap_or(Value::Null),
        })
    }
}

const COLUMNS: &str =
    "id, account, kind, message_id, subject, recipients, payload, state, error, archive_error, created_at, updated_at";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<OutgoingAttempt> {
    let kind: String = row.get(2)?;
    let state: String = row.get(7)?;
    let convert = |err: anyhow::Error| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, err.into());
    Ok(OutgoingAttempt {
        id: row.get(0)?,
        account: row.get(1)?,
        kind: AttemptKind::parse(&kind).map_err(convert)?,
        message_id: row.get(3)?,
        subject: row.get(4)?,
        recipients: row.get(5)?,
        payload: row.get(6)?,
        state: AttemptState::parse(&state).map_err(convert)?,
        error: row.get(8)?,
        archive_error: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

/// One attempt, by id.
pub fn attempt(conn: &Connection, id: &str) -> Result<Option<OutgoingAttempt>> {
    let sql = format!("SELECT {COLUMNS} FROM outgoing_attempts WHERE id = ?1");
    Ok(conn.query_row(&sql, params![id], from_row).optional()?)
}

/// Writes an attempt down as about to go.
///
/// Replaces an earlier attempt with the same id: a message refused last time
/// and tried again is one message, not two records. The caller checks first
/// whether the earlier attempt [`AttemptState::may_have_gone`]; this does not
/// second-guess a caller who has decided to send again anyway.
///
/// The passphrase, if the request carried one, is not written: it has no
/// business in a table that outlives the send.
#[allow(clippy::too_many_arguments)]
pub fn begin_attempt(
    conn: &Connection,
    id: &str,
    account: &str,
    kind: AttemptKind,
    message_id: &str,
    request: &Value,
    now: i64,
) -> Result<()> {
    let mut stored = request.clone();
    if let Some(object) = stored.as_object_mut() {
        object.remove("passphrase");
    }
    let subject = request.get("subject").and_then(Value::as_str).unwrap_or_default();
    let recipients = request.get("to").and_then(Value::as_str).unwrap_or_default();
    conn.execute(
        "INSERT OR REPLACE INTO outgoing_attempts
            (id, account, kind, message_id, subject, recipients, payload, state, error, archive_error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'sending', '', '', ?8, ?8)",
        params![
            id,
            account,
            kind.as_str(),
            message_id,
            subject,
            recipients,
            serde_json::to_string(&stored).context("serialize outgoing attempt")?,
            now
        ],
    )?;
    Ok(())
}

fn set_state(conn: &Connection, id: &str, state: AttemptState, now: i64) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE outgoing_attempts SET state = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, state.as_str(), now],
    )?;
    Ok(changed > 0)
}

/// The server took the message.
pub fn mark_accepted(conn: &Connection, id: &str, now: i64) -> Result<()> {
    set_state(conn, id, AttemptState::Accepted, now)?;
    Ok(())
}

/// The Sent copy is filed too.
pub fn mark_archived(conn: &Connection, id: &str, now: i64) -> Result<()> {
    set_state(conn, id, AttemptState::Archived, now)?;
    Ok(())
}

/// The message went but the Sent copy did not. The state stays `accepted`:
/// a message the server took is a sent message, whatever the local folder
/// says, and this must never read as "not sent".
pub fn mark_archive_failed(conn: &Connection, id: &str, error: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE outgoing_attempts SET archive_error = ?2, updated_at = ?3 WHERE id = ?1 AND state = 'accepted'",
        params![id, error, now],
    )?;
    Ok(())
}

/// The server said no, or was never reached. Safe to try again.
pub fn mark_rejected(conn: &Connection, id: &str, error: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE outgoing_attempts SET state = 'rejected', error = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, error, now],
    )?;
    Ok(())
}

/// The message left and no answer came. Only a person settles this.
pub fn mark_uncertain(conn: &Connection, id: &str, error: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE outgoing_attempts SET state = 'uncertain', error = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, error, now],
    )?;
    Ok(())
}

/// A person has looked at something that needed them and settled it,
/// whichever way: an uncertain send, or a sent message whose Sent copy
/// failed. Answers whether there was anything to settle; an attempt that
/// needed nobody is left exactly as it was.
pub fn resolve(conn: &Connection, id: &str, now: i64) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE outgoing_attempts SET state = 'resolved', updated_at = ?2
          WHERE id = ?1 AND (state = 'uncertain' OR (state = 'accepted' AND archive_error <> ''))",
        params![id, now],
    )?;
    Ok(changed > 0)
}

/// Everything still marked as going when nothing is: the process died with
/// these in flight. Each becomes uncertain, with a reason that says so.
/// Called once at startup, before any send can begin. Answers how many.
pub fn mark_interrupted_uncertain(conn: &Connection, now: i64) -> Result<usize> {
    let changed = conn.execute(
        "UPDATE outgoing_attempts
            SET state = 'uncertain',
                error = 'the application stopped while this message was being sent',
                updated_at = ?1
          WHERE state = 'sending'",
        params![now],
    )?;
    Ok(changed)
}

/// What needs a person: uncertain sends, and accepted ones whose Sent copy
/// failed. Oldest first, for one account or all of them.
pub fn unsettled(conn: &Connection, account: Option<&str>) -> Result<Vec<OutgoingAttempt>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM outgoing_attempts
          WHERE (?1 IS NULL OR account = ?1)
            AND (state = 'uncertain' OR (state = 'accepted' AND archive_error <> ''))
          ORDER BY created_at"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![account], from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Forgets settled history older than `before`: rejected, archived and
/// resolved attempts. Uncertain ones and accepted-but-unfiled ones are never
/// pruned here; they wait for a person. Answers how many were dropped.
pub fn prune_settled(conn: &Connection, before: i64) -> Result<usize> {
    let changed = conn.execute(
        "DELETE FROM outgoing_attempts
          WHERE updated_at < ?1
            AND (state IN ('rejected', 'archived', 'resolved')
                 OR (state = 'accepted' AND archive_error = ''))",
        params![before],
    )?;
    Ok(changed)
}

#[cfg(test)]
mod tests;
